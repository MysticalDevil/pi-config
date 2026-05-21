/**
 * File Watcher — Notify model when git-tracked files change externally
 *
 * Polls `git status --porcelain` every 2s to detect changes
 * that happen outside the agent (git pull, manual edits).
 * Respects .gitignore — no sessions, node_modules, etc.
 * Falls back to noop when not in a git repo.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const POLL_INTERVAL = 3000;

function parseStatusLine(line: string): { status: string; filepath: string } | null {
  if (line.length < 4) return null;
  const status = line.slice(0, 2);
  let filepath = line.slice(3).trim();
  if (!filepath) return null;
  const renameArrow = filepath.indexOf(" -> ");
  if (renameArrow >= 0) {
    filepath = filepath.slice(renameArrow + 4).trim();
  }
  return { status, filepath };
}

function makeBaseline(cwd: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const out = execSync("git status --porcelain=v1", { cwd, encoding: "utf-8" });
    for (const line of out.trim().split("\n")) {
      if (!line) continue;

      const parsed = parseStatusLine(line);
      if (!parsed) continue;
      if (parsed.status.includes("D")) continue;
      if (parsed.filepath.startsWith("agent/sessions/")) continue;

      const fullPath = join(cwd, parsed.filepath);
      if (!existsSync(fullPath)) continue;

      try {
        const hash = execFileSync("git", ["hash-object", "--", parsed.filepath], {
          cwd,
          encoding: "utf-8",
        }).trim();
        map.set(parsed.filepath, hash);
      } catch {
        continue;
      }
    }
  } catch {
    /* not a git repo */
  }
  return map;
}

function diffGit(before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = [];
  for (const [path, hash] of after) {
    if (!before.has(path)) {
      changes.push(`+ ${path}`);
    } else if (before.get(path) !== hash) {
      changes.push(`~ ${path}`);
    }
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changes.push(`- ${path}`);
  }
  return changes;
}

export default function (pi: ExtensionAPI) {
  let cwd = "";
  let baseline = new Map<string, string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  // Global guard: prevent duplicate watchers across reloads
  if ((globalThis as any).__fileWatcherTimer) {
    clearInterval((globalThis as any).__fileWatcherTimer);
  }

  function poll() {
    if (!cwd) return;
    const current = makeBaseline(cwd);
    if (current.size === 0) return;
    if (baseline.size === 0) {
      baseline = current;
      return;
    }

    const changes = diffGit(baseline, current);
    baseline = current;

    if (changes.length > 0 && changes.length <= 15) {
      pi.sendMessage(
        {
          customType: "file-watcher",
          content: `External file changes:\n${changes.join("\n")}`,
          display: false,
        },
        { triggerTurn: false },
      );
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    baseline = makeBaseline(cwd);
    timer = setInterval(poll, POLL_INTERVAL);
    (globalThis as any).__fileWatcherTimer = timer;
  });

  pi.on("session_shutdown", () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    baseline.clear();
  });
}
