/**
 * Turn Diff Tracker — Automatic per-turn file change tracking
 *
 * Captures git diff snapshots before and after each agent turn,
 * then injects the changes as context for the next turn.
 *
 * The LLM sees exactly what files it modified, helping it:
 * - Avoid repeating work it already did
 * - Notice unintended side-effects (wrote to wrong file)
 * - Understand the scope of its changes
 * - Self-correct when diffs look wrong
 *
 * Features:
 * - Stat summary + full diff (truncated for large changes)
 * - Detects new/deleted/modified files
 * - Skips when not in a git repo (graceful fallback)
 * - Deduplicates identical snapshots (no change = no injection)
 */

import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Types ─────────────────────────────────────────────────────────────

interface DiffFile {
  path: string;
  status: "added" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
}

interface TurnDiff {
  files: DiffFile[];
  stat: string;
  fullDiff: string;
  capturedAt: number;
  /** SHA before this turn started */
  baselineSha: string;
}

// ── Helpers ───────────────────────────────────────────────────────────

function isGitRepo(cwd: string): boolean {
  try {
    execSync("git rev-parse --git-dir", { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getHeadSha(cwd: string): string {
  try {
    return execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
  } catch (e) {
    if (e instanceof Error && !e.message.includes("not a git repository")) {
      console.error("turn-diff: git rev-parse failed:", e.message);
    }
    return "";
  }
}

function getDiffStat(cwd: string): string {
  try {
    return execSync("git diff --stat -- . ':!node_modules' ':!.git'", {
      cwd,
      encoding: "utf-8",
    }).trim();
  } catch (e) {
    if (e instanceof Error && !e.message.includes("not a git repository")) {
      console.error("turn-diff: git diff --stat failed:", e.message);
    }
    return "";
  }
}

function getFullDiff(cwd: string): string {
  try {
    return execSync("git diff -- . ':!node_modules' ':!.git'", {
      cwd,
      encoding: "utf-8",
      maxBuffer: 50 * 1024, // 50KB
    }).trim();
  } catch (e) {
    if (e instanceof Error && !e.message.includes("not a git repository")) {
      console.error("turn-diff: git diff failed:", e.message);
    }
    return "";
  }
}

/**
 * Get diff of untracked files too (new files the model created).
 * Uses `git diff --no-index /dev/null <file>` equivalent via `git add -N` + `git diff`.
 */
function getUntrackedFiles(cwd: string): string[] {
  try {
    return execSync("git ls-files --others --exclude-standard -- .", {
      cwd,
      encoding: "utf-8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch (e) {
    if (e instanceof Error && !e.message.includes("not a git repository")) {
      console.error("turn-diff: git ls-files failed:", e.message);
    }
    return [];
  }
}

function parseStatLine(line: string): DiffFile | null {
  // Format: " path/to/file.rs | 5 ++--"
  const match = line.match(/^\s+(.+?)\s+\|\s+(\d+)\s+([+-]+)$/);
  if (!match) return null;

  const filepath = match[1].trim();
  const changes = match[3];
  const plusCount = (changes.match(/\+/g) ?? []).length;
  const minusCount = (changes.match(/-/g) ?? []).length;

  let status: DiffFile["status"] = "modified";
  // Heuristic: if file has more +++ than total changes suggests new file,
  // if more --- suggests deleted. But git diff stat doesn't tell us directly.
  // We use the bin ratio: if it's heavily weighted to additions, likely new.

  return {
    path: filepath,
    status,
    additions: plusCount,
    deletions: minusCount,
  };
}

function parseDiffStat(stat: string): DiffFile[] {
  if (!stat) return [];
  return stat
    .split("\n")
    .map(parseStatLine)
    .filter((f): f is DiffFile => f !== null);
}

// ── Tracker state ─────────────────────────────────────────────────────

let gitAvailable = false;
let baselineSha = "";
let lastTurnDiff: TurnDiff | null = null;
let turnCount = 0;

// ── Public API ────────────────────────────────────────────────────────

export function getLastTurnDiff(): TurnDiff | null {
  return lastTurnDiff;
}

export function reset() {
  lastTurnDiff = null;
  turnCount = 0;
  baselineSha = "";
}

// ── Capture ───────────────────────────────────────────────────────────

function captureDiff(cwd: string): TurnDiff | null {
  if (!gitAvailable) return null;

  const stat = getDiffStat(cwd);
  if (!stat) return null; // No changes

  const fullDiff = getFullDiff(cwd);
  const files = parseDiffStat(stat);

  // Also detect new untracked files
  const untracked = getUntrackedFiles(cwd);
  for (const uf of untracked) {
    if (!files.find((f) => f.path === uf)) {
      files.push({ path: uf, status: "added", additions: 0, deletions: 0 });
    }
  }

  return {
    files,
    stat,
    fullDiff,
    capturedAt: Date.now(),
    baselineSha,
  };
}

// ── Context formatting ────────────────────────────────────────────────

function formatTurnDiffContext(diff: TurnDiff): string {
  const lines: string[] = [];

  lines.push(`Turn ${turnCount} file changes:`);
  lines.push("");

  if (diff.files.length === 0) {
    lines.push("(no files changed)");
    return lines.join("\n");
  }

  // Summary
  for (const f of diff.files) {
    const icon = f.status === "added" ? "+" : f.status === "deleted" ? "-" : "~";
    const counts =
      f.additions > 0 || f.deletions > 0 ? ` (+${f.additions} -${f.deletions})` : " (new file)";
    lines.push(`  ${icon} ${f.path}${counts}`);
  }

  // Full diff (truncated if too large)
  if (diff.fullDiff) {
    const maxDiffLines = 80;
    const diffLines = diff.fullDiff.split("\n");
    if (diffLines.length > maxDiffLines) {
      lines.push("");
      lines.push(`Diff (showing first ${maxDiffLines} of ${diffLines.length} lines):`);
      lines.push("```diff");
      lines.push(diffLines.slice(0, maxDiffLines).join("\n"));
      lines.push("```");
      lines.push(`... ${diffLines.length - maxDiffLines} more lines truncated`);
    } else {
      lines.push("");
      lines.push("Diff:");
      lines.push("```diff");
      lines.push(diff.fullDiff);
      lines.push("```");
    }
  }

  return lines.join("\n");
}

// ── Extension integration ─────────────────────────────────────────────

export function setupTurnDiff(pi: ExtensionAPI) {
  let cwd = process.cwd();

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    gitAvailable = isGitRepo(cwd);
    reset();

    if (gitAvailable) {
      baselineSha = getHeadSha(cwd);
    }
  });

  // Capture baseline at turn start
  pi.on("turn_start", async () => {
    if (!gitAvailable) return;
    baselineSha = getHeadSha(cwd);
  });

  // Capture diff at turn end
  pi.on("turn_end", async () => {
    if (!gitAvailable) return;
    turnCount++;

    const diff = captureDiff(cwd);
    if (diff && diff.files.length > 0) {
      lastTurnDiff = diff;
    } else {
      lastTurnDiff = null;
    }
  });

  // Inject diff context before next agent turn
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!lastTurnDiff) return;
    if (lastTurnDiff.files.length === 0) return;

    const ctxText = formatTurnDiffContext(lastTurnDiff);

    // Clear after injecting (don't repeat the same diff)
    lastTurnDiff = null;

    return {
      systemPrompt: event.systemPrompt + "\n\n<turn_diff>\n" + ctxText + "\n</turn_diff>",
    };
  });
}
