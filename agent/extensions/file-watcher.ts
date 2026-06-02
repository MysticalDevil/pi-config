/**
 * File Watcher — Notify model when git-tracked files change externally
 *
 * Polls `git status --porcelain` every 2s to detect changes
 * that happen outside the agent (git pull, manual edits).
 * Respects .gitignore — no sessions, node_modules, etc.
 * Falls back to noop when not in a git repo.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Default polling interval in ms. Override via ~/.pi/agent/settings.json:
// { "fileWatcher": { "pollIntervalMs": 5000 } }
const DEFAULT_POLL_INTERVAL = 3000;

import { parseStatusLine } from "./lib/shared";

function makeBaseline(cwd: string): Map<string, string | null> {
  const map = new Map<string, string | null>();
  try {
    const out = execSync("git status --porcelain=v1", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of out.trim().split("\n")) {
      if (!line) continue;

      const parsed = parseStatusLine(line);
      if (!parsed) continue;

      // git status --porcelain=v1 reports untracked dirs as "?? dirname/"
      if (parsed.file.endsWith("/")) continue;

      const isDeleted = parsed.status.includes("D") && !parsed.status.includes("?");
      const fullPath = join(cwd, parsed.file);

      if (isDeleted || !existsSync(fullPath)) {
        map.set(parsed.file, null);
        continue;
      }

      try {
        const hash = execFileSync("git", ["hash-object", "--", parsed.file], {
          cwd,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        map.set(parsed.file, hash);
      } catch {
        map.set(parsed.file, null);
      }
    }
  } catch {
    /* not a git repo */
  }
  return map;
}

function getHead(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function diffGit(before: Map<string, string | null>, after: Map<string, string | null>): string[] {
  const changes: string[] = [];
  for (const [path, hash] of after) {
    const beforeHash = before.get(path);
    if (beforeHash === undefined) {
      if (hash === null) continue;
      changes.push(`+ ${path}`);
    } else if (beforeHash === null) {
      if (hash !== null) changes.push(`~ ${path}`);
    } else if (hash === null) {
      changes.push(`- ${path}`);
    } else if (beforeHash !== hash) {
      changes.push(`~ ${path}`);
    }
  }
  for (const [path, hash] of before) {
    if (!after.has(path)) {
      if (hash !== null) changes.push(`- ${path}`);
    }
  }
  return changes;
}

export default function (pi: ExtensionAPI) {
  let cwd = "";
  let baseline = new Map<string, string | null>();
  let headBaseline: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  type GlobalWithWatcher = typeof globalThis & {
    __fileWatcherTimer?: ReturnType<typeof setInterval>;
  };

  // Global guard: prevent duplicate watchers across reloads
  if ((globalThis as GlobalWithWatcher).__fileWatcherTimer) {
    clearInterval((globalThis as GlobalWithWatcher).__fileWatcherTimer);
  }

  function poll() {
    if (!cwd) return;
    const current = makeBaseline(cwd);
    const currentHead = getHead(cwd);

    const changes = diffGit(baseline, current);
    if (headBaseline !== currentHead) {
      const before = headBaseline ? headBaseline.slice(0, 8) : "none";
      const after = currentHead ? currentHead.slice(0, 8) : "none";
      changes.unshift(`↻ HEAD ${before} → ${after}`);
    }

    baseline = current;
    headBaseline = currentHead;

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
    headBaseline = getHead(cwd);
    if (timer) clearInterval(timer);

    // Read poll interval from settings
    let interval = DEFAULT_POLL_INTERVAL;
    try {
      const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
      if (existsSync(settingsPath)) {
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        if (
          typeof settings.fileWatcher?.pollIntervalMs === "number" &&
          settings.fileWatcher.pollIntervalMs >= 1000
        ) {
          interval = settings.fileWatcher.pollIntervalMs;
        }
      }
    } catch {
      /* use default on parse error */
    }

    timer = setInterval(poll, interval);
    (globalThis as GlobalWithWatcher).__fileWatcherTimer = timer;
  });

  pi.on("session_shutdown", () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    baseline.clear();
    headBaseline = null;
  });
}
