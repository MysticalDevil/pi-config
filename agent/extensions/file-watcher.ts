/**
 * Workspace Watcher — Notify model when workspace files change
 *
 * Git repositories use git status/HEAD so .gitignore semantics are preserved.
 * Non-git directories fall back to a bounded filesystem scan.
 *
 * The notification deliberately says "workspace" changes rather than "external"
 * changes: polling cannot reliably distinguish agent writes from manual edits.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseStatusLine } from "./lib/shared.ts";

// Override via ~/.pi/agent/settings.json:
// { "fileWatcher": { "pollIntervalMs": 5000, "maxChanges": 20, "maxScanFiles": 3000 } }
const DEFAULT_POLL_INTERVAL = 3000;
const DEFAULT_MAX_CHANGES = 15;
const DEFAULT_MAX_SCAN_FILES = 2000;
const DEFAULT_MAX_SCAN_DEPTH = 5;

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "target",
  "coverage",
  ".cache",
  ".turbo",
  "__pycache__",
  ".venv",
  "venv",
  "agent/sessions",
]);

interface WatcherSettings {
  pollIntervalMs: number;
  maxChanges: number;
  maxScanFiles: number;
  maxScanDepth: number;
}

interface FileEntry {
  fingerprint: string | null;
}

interface Snapshot {
  backend: "git" | "filesystem";
  entries: Map<string, FileEntry>;
  head: string | null;
  truncated: boolean;
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function isGitRepo(cwd: string): boolean {
  return runGit(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

function gitHead(cwd: string): string | null {
  return runGit(cwd, ["rev-parse", "HEAD"]);
}

function gitFileFingerprint(cwd: string, file: string, fallback: string): string {
  return runGit(cwd, ["hash-object", "--", file]) ?? fallback;
}

function gitSnapshot(cwd: string): Snapshot {
  const entries = new Map<string, FileEntry>();
  const out = runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);

  if (out) {
    for (const line of out.split("\n")) {
      if (!line) continue;

      const parsed = parseStatusLine(line);
      if (!parsed || shouldIgnoreWatcherPath(parsed.file)) continue;

      const isDeleted = parsed.status.includes("D") && !parsed.status.includes("?");
      const fullPath = join(cwd, parsed.file);
      const fingerprint =
        isDeleted || !existsSync(fullPath)
          ? null
          : gitFileFingerprint(cwd, parsed.file, parsed.status);
      entries.set(parsed.file, { fingerprint });
    }
  }

  return {
    backend: "git",
    entries,
    head: gitHead(cwd),
    truncated: false,
  };
}

export function shouldIgnoreWatcherPath(relativePath: string): boolean {
  if (!relativePath || relativePath === ".") return false;

  const normalized = relativePath.replaceAll("\\", "/");
  const parts = normalized.split("/");
  const firstPart = parts[0];
  if (firstPart.startsWith(".") && firstPart !== ".github" && firstPart !== ".gitignore") {
    return true;
  }

  for (const ignored of IGNORED_DIRS) {
    if (normalized === ignored || normalized.startsWith(`${ignored}/`)) return true;
  }

  return parts.some((part) => IGNORED_DIRS.has(part));
}

function filesystemSnapshot(cwd: string, settings: WatcherSettings): Snapshot {
  const entries = new Map<string, FileEntry>();
  let visited = 0;
  let truncated = false;

  function walk(dir: string, depth: number): void {
    if (truncated || depth > settings.maxScanDepth) return;

    let children: string[];
    try {
      children = readdirSync(dir);
    } catch {
      return;
    }

    for (const child of children) {
      if (truncated) return;
      const fullPath = join(dir, child);
      const relPath = relative(cwd, fullPath).replaceAll("\\", "/");
      if (shouldIgnoreWatcherPath(relPath)) continue;

      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }

      if (!stat.isFile()) continue;
      visited++;
      if (visited > settings.maxScanFiles) {
        truncated = true;
        return;
      }
      entries.set(relPath, { fingerprint: `${stat.size}:${Math.trunc(stat.mtimeMs)}` });
    }
  }

  walk(cwd, 0);
  return { backend: "filesystem", entries, head: null, truncated };
}

function takeSnapshot(cwd: string, settings: WatcherSettings): Snapshot {
  return isGitRepo(cwd) ? gitSnapshot(cwd) : filesystemSnapshot(cwd, settings);
}

function diffSnapshots(before: Snapshot | null, after: Snapshot): string[] {
  if (!before || before.backend !== after.backend) return [];

  const changes: string[] = [];
  if (before.head !== after.head) {
    const oldHead = before.head ? before.head.slice(0, 8) : "none";
    const newHead = after.head ? after.head.slice(0, 8) : "none";
    changes.push(`↻ HEAD ${oldHead} → ${newHead}`);
  }

  for (const [file, entry] of after.entries) {
    const previous = before.entries.get(file);
    if (!previous) {
      if (entry.fingerprint !== null) changes.push(`+ ${file}`);
      continue;
    }
    if (previous.fingerprint === entry.fingerprint) continue;
    changes.push(entry.fingerprint === null ? `- ${file}` : `~ ${file}`);
  }

  for (const file of before.entries.keys()) {
    if (after.entries.has(file)) continue;
    changes.push(before.backend === "git" ? `✓ ${file} clean` : `- ${file}`);
  }

  if (!before.truncated && after.truncated) changes.push("… filesystem scan truncated");
  return changes;
}

function readSettings(): WatcherSettings {
  const defaults: WatcherSettings = {
    pollIntervalMs: DEFAULT_POLL_INTERVAL,
    maxChanges: DEFAULT_MAX_CHANGES,
    maxScanFiles: DEFAULT_MAX_SCAN_FILES,
    maxScanDepth: DEFAULT_MAX_SCAN_DEPTH,
  };

  try {
    const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
    if (!existsSync(settingsPath)) return defaults;

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      fileWatcher?: Partial<WatcherSettings>;
    };
    const watcher = settings.fileWatcher ?? {};
    return {
      pollIntervalMs:
        typeof watcher.pollIntervalMs === "number" && watcher.pollIntervalMs >= 1000
          ? watcher.pollIntervalMs
          : defaults.pollIntervalMs,
      maxChanges:
        typeof watcher.maxChanges === "number" && watcher.maxChanges > 0
          ? watcher.maxChanges
          : defaults.maxChanges,
      maxScanFiles:
        typeof watcher.maxScanFiles === "number" && watcher.maxScanFiles > 0
          ? watcher.maxScanFiles
          : defaults.maxScanFiles,
      maxScanDepth:
        typeof watcher.maxScanDepth === "number" && watcher.maxScanDepth > 0
          ? watcher.maxScanDepth
          : defaults.maxScanDepth,
    };
  } catch {
    return defaults;
  }
}

function formatChanges(changes: string[], maxChanges: number): string {
  const shown = changes.slice(0, maxChanges);
  const remaining = changes.length - shown.length;
  const suffix = remaining > 0 ? `\n… ${remaining} more change${remaining === 1 ? "" : "s"}` : "";
  return `Workspace file changes:\n${shown.join("\n")}${suffix}`;
}

export default function (pi: ExtensionAPI) {
  let cwd = "";
  let settings = readSettings();
  let baseline: Snapshot | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  type GlobalWithWatcher = typeof globalThis & {
    __fileWatcherTimer?: ReturnType<typeof setInterval>;
  };

  // Global guard: prevent duplicate watchers across reloads
  if ((globalThis as GlobalWithWatcher).__fileWatcherTimer) {
    clearInterval((globalThis as GlobalWithWatcher).__fileWatcherTimer);
  }

  function poll(): void {
    if (!cwd) return;

    const current = takeSnapshot(cwd, settings);
    const changes = diffSnapshots(baseline, current);
    baseline = current;

    if (changes.length === 0) return;
    pi.sendMessage(
      {
        customType: "file-watcher",
        content: formatChanges(changes, settings.maxChanges),
        display: false,
      },
      { deliverAs: "nextTurn", triggerTurn: false },
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    settings = readSettings();
    baseline = takeSnapshot(cwd, settings);
    if (timer) clearInterval(timer);

    timer = setInterval(poll, settings.pollIntervalMs);
    (globalThis as GlobalWithWatcher).__fileWatcherTimer = timer;
  });

  pi.on("session_shutdown", () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    baseline = null;
  });
}
