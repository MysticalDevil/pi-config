/**
 * File Watcher — Notify model when external changes happen
 *
 * Watches the project directory for file changes that happen
 * outside the agent's control (git pull, manual edits, etc.).
 * When changes are detected, notifies the model via context injection.
 *
 * Uses a polling approach (every 2s by default) to avoid the
 * complexity and CPU overhead of fs.watch recursive.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const POLL_INTERVAL = 2000; // 2s between scans
const MAX_FILES = 200;

interface FileEntry {
  path: string;
  mtime: number;
  size: number;
}

function scanDir(dir: string, maxFiles: number): FileEntry[] {
  const files: FileEntry[] = [];
  const ignored = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "target",
    "__pycache__",
    ".venv",
  ]);

  function walk(current: string) {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= maxFiles) return;
      if (ignored.has(e.name)) continue;
      if (e.name.startsWith(".")) continue;
      const full = join(current, e.name);
      try {
        const s = statSync(full);
        if (e.isDirectory()) {
          walk(full);
        } else {
          files.push({ path: full, mtime: s.mtimeMs, size: s.size });
        }
      } catch {
        /* skip unreadable */
      }
    }
  }
  walk(dir);
  return files;
}

function diffSnapshots(before: FileEntry[], after: FileEntry[]): string[] {
  const beforeMap = new Map(before.map((f) => [f.path, f]));
  const afterMap = new Map(after.map((f) => [f.path, f]));
  const changes: string[] = [];

  for (const [path, f] of afterMap) {
    const prev = beforeMap.get(path);
    if (!prev) {
      changes.push(`+ ${path}`);
    } else if (prev.mtime !== f.mtime) {
      const delta = f.size - prev.size;
      const sizeStr = delta > 0 ? `+${delta}B` : delta < 0 ? `${delta}B` : "";
      changes.push(`~ ${path}${sizeStr ? ` (${sizeStr})` : ""}`);
    }
  }
  for (const [path] of beforeMap) {
    if (!afterMap.has(path)) {
      changes.push(`- ${path}`);
    }
  }
  return changes;
}

export default function (pi: ExtensionAPI) {
  let cwd = "";
  let baseline: FileEntry[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let watching = false;

  function startWatching() {
    if (watching) return;
    if (!existsSync(cwd)) return;

    baseline = scanDir(cwd, MAX_FILES);
    watching = true;

    timer = setInterval(() => {
      const current = scanDir(cwd, MAX_FILES);
      const changes = diffSnapshots(baseline, current);
      baseline = current;

      if (changes.length > 0 && changes.length < 20) {
        const relPaths = changes.map((c) => {
          const parts = c.split(" ");
          const filepath = parts.slice(1).join(" ");
          return `${parts[0]} ${relative(cwd, filepath)}`;
        });
        pi.sendMessage(
          {
            customType: "file-watcher",
            content: `Files changed externally:\n${relPaths.join("\n")}`,
            display: false,
          },
          { triggerTurn: false },
        );
      }
    }, POLL_INTERVAL);
  }

  function stopWatching() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    watching = false;
    baseline = [];
  }

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    startWatching();
  });

  pi.on("session_shutdown", () => stopWatching());
}
