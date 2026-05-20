/**
 * /add-dir & /add-context - Dynamic Context Injection
 * (like Claude Code's /add-dir)
 *
 * Dynamically add directories, file globs, or specific files to the
 * current session context without modifying AGENTS.md.
 *
 * Usage:
 *   /add-dir src/components        — add all files in directory
 *   /add-dir src/ --depth 2        — limit directory depth
 *   /add-dir src/**\/*.ts          — glob pattern
 *   /add-context README.md         — add a specific file
 *   /add-context package.json tsconfig.json  — add multiple files
 *   /context                        — show currently loaded context
 *   /context --clear                — clear all dynamically added context
 *   /context --remove src/old       — remove specific path
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ContextEntry {
  path: string;
  type: "file" | "directory";
  addedAt: number;
  content?: string;
}

const MAX_FILE_SIZE = 100 * 1024; // 100KB
const MAX_TOTAL_SIZE = 500 * 1024; // 500KB total
const IGNORED_PATTERNS = [
  "node_modules",
  ".git",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  "target",
  ".cache",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.lock",
  "package-lock.json",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.ico",
  "*.svg",
  "*.woff",
  "*.woff2",
  "*.ttf",
  "*.eot",
];

function shouldIgnore(filePath: string): boolean {
  const basename = path.basename(filePath);
  for (const pattern of IGNORED_PATTERNS) {
    if (pattern.includes("*")) {
      if (basename.endsWith(pattern.slice(1))) return true;
    } else if (basename === pattern) {
      return true;
    } else if (filePath.includes(`/${pattern}/`) || filePath.includes(`\\${pattern}\\`)) {
      return true;
    }
  }
  return false;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "___DOUBLESTAR___")
    .replace(/\*/g, "[^/]*")
    .replace(/___DOUBLESTAR___/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function collectFiles(
  cwd: string,
  targetPath: string,
  depth: number,
  files: Map<string, true>,
): void {
  const fullPath = path.resolve(cwd, targetPath);

  if (!fs.existsSync(fullPath)) return;

  const stat = fs.statSync(fullPath);

  if (stat.isFile()) {
    if (!shouldIgnore(fullPath)) {
      files.set(fullPath, true);
    }
    return;
  }

  if (stat.isDirectory()) {
    walkDir(fullPath, depth, files);
  }
}

function walkDir(
  dir: string,
  maxDepth: number,
  files: Map<string, true>,
  currentDepth: number = 0,
): void {
  if (currentDepth > maxDepth) return;

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code === "ENOENT" ||
      (e as NodeJS.ErrnoException).code === "EACCES"
    )
      return;
    throw e;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    if (shouldIgnore(fullPath)) continue;

    try {
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        files.set(fullPath, true);
      } else if (stat.isDirectory()) {
        walkDir(fullPath, maxDepth, files, currentDepth + 1);
      }
    } catch (e) {
      if (
        (e as NodeJS.ErrnoException).code === "ENOENT" ||
        (e as NodeJS.ErrnoException).code === "EACCES"
      )
        continue;
      throw e;
    }
  }
}

function readFileContent(filePath: string): string | undefined {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      return `[File too large: ${(stat.size / 1024).toFixed(0)}KB]`;
    }
    return fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

function buildContextBlock(entries: ContextEntry[], cwd: string): string {
  const lines: string[] = [];
  let totalSize = 0;

  lines.push("[DYNAMICALLY ADDED CONTEXT]");
  lines.push("");

  for (const entry of entries) {
    if (entry.type === "file" && entry.content !== undefined) {
      const relPath = path.relative(cwd, entry.path);
      if (totalSize + entry.content.length > MAX_TOTAL_SIZE) {
        lines.push(`--- ${relPath} ---`);
        lines.push(`[Truncated: total context size limit reached]`);
        break;
      }
      lines.push(`--- ${relPath} ---`);
      lines.push(entry.content);
      lines.push("");
      totalSize += entry.content.length;
    } else if (entry.type === "directory") {
      const relPath = path.relative(cwd, entry.path);
      lines.push(`[DIRECTORY] ${relPath}/`);
      const dirFiles: string[] = [];
      try {
        const walkEntries = fs.readdirSync(entry.path);
        for (const f of walkEntries.slice(0, 50)) {
          const fp = path.join(entry.path, f);
          try {
            const s = fs.statSync(fp);
            dirFiles.push(`  ${s.isDirectory() ? f + "/" : f}`);
          } catch (e) {
            if (e.code !== "ENOENT" && e.code !== "EACCES") throw e;
          }
        }
      } catch (e) {
        if (e.code !== "ENOENT" && e.code !== "EACCES") throw e;
      }
      lines.push(...dirFiles.slice(0, 30));
      if (dirFiles.length > 30) lines.push(`  ... ${dirFiles.length - 30} more entries`);
      lines.push("");
    }
  }

  lines.push("[/DYNAMICALLY ADDED CONTEXT]");
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  let contextEntries: ContextEntry[] = [];
  let currentContextText: string = "";

  function persistState(): void {
    pi.appendEntry("dynamic-context", {
      entries: contextEntries.map((e) => ({ path: e.path, type: e.type, addedAt: e.addedAt })),
    });
  }

  function rebuildContext(cwd: string): void {
    // Re-read file contents
    for (const entry of contextEntries) {
      if (entry.type === "file") {
        entry.content = readFileContent(entry.path);
      }
    }
    currentContextText = buildContextBlock(contextEntries, cwd);
  }

  // Inject context into system prompt
  pi.on("before_agent_start", async (event) => {
    if (contextEntries.length === 0) return;

    rebuildContext(event.systemPromptOptions.cwd);
    if (!currentContextText) return;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + currentContextText,
    };
  });

  // Restore state on session start
  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "dynamic-context") {
        const data = entry.data as
          | { entries: Array<{ path: string; type: "file" | "directory"; addedAt: number }> }
          | undefined;
        if (data?.entries) {
          contextEntries = data.entries.map((e) => ({
            path: e.path,
            type: e.type,
            addedAt: e.addedAt,
            content: undefined,
          }));
          rebuildContext(ctx.cwd);
        }
      }
    }
  });

  // /add-dir command
  pi.registerCommand("add-dir", {
    description: "Add directory or glob to session context (usage: /add-dir <path> [--depth N])",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/);
      if (tokens.length === 0) {
        ctx.ui.notify("Usage: /add-dir <path> [--depth N]", "error");
        return;
      }

      let targetPath = tokens[0];
      let depth = 3; // default depth

      const depthIdx = tokens.indexOf("--depth");
      if (depthIdx !== -1 && depthIdx + 1 < tokens.length) {
        depth = parseInt(tokens[depthIdx + 1], 10) || 3;
        targetPath = tokens.slice(0, depthIdx).join(" ");
      }

      const files = new Map<string, true>();
      collectFiles(ctx.cwd, targetPath, depth, files);

      if (files.size === 0) {
        ctx.ui.notify(`No matching files found: ${targetPath}`, "warning");
        return;
      }

      const added: ContextEntry[] = [];
      for (const [filePath] of files) {
        const existing = contextEntries.findIndex((e) => e.path === filePath);
        if (existing !== -1) {
          contextEntries.splice(existing, 1);
        }
        const content = readFileContent(filePath);
        added.push({
          path: filePath,
          type: "file",
          addedAt: Date.now(),
          content,
        });
      }

      contextEntries.push(...added);
      rebuildContext(ctx.cwd);
      persistState();

      ctx.ui.notify(`Added ${added.length} file(s) from "${targetPath}" (depth ${depth})`, "info");
    },
  });

  // /add-context command
  pi.registerCommand("add-context", {
    description: "Add specific file(s) to session context (usage: /add-context <file> [file2 ...])",
    handler: async (args, ctx) => {
      const paths = args.trim().split(/\s+/).filter(Boolean);
      if (paths.length === 0) {
        ctx.ui.notify("Usage: /add-context <file> [file2 ...]", "error");
        return;
      }

      const added: ContextEntry[] = [];
      const notFound: string[] = [];

      for (const p of paths) {
        const fullPath = path.resolve(ctx.cwd, p);
        if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
          notFound.push(p);
          continue;
        }
        if (shouldIgnore(fullPath)) {
          ctx.ui.notify(`Skipped (ignored): ${p}`, "warning");
          continue;
        }

        const existing = contextEntries.findIndex((e) => e.path === fullPath);
        if (existing !== -1) {
          contextEntries.splice(existing, 1);
        }

        const content = readFileContent(fullPath);
        added.push({
          path: fullPath,
          type: "file",
          addedAt: Date.now(),
          content,
        });
      }

      if (added.length > 0) {
        contextEntries.push(...added);
        rebuildContext(ctx.cwd);
        persistState();
        ctx.ui.notify(`Added ${added.length} file(s) to context`, "info");
      }

      if (notFound.length > 0) {
        ctx.ui.notify(`Not found: ${notFound.join(", ")}`, "warning");
      }
    },
  });

  // /context command
  pi.registerCommand("context", {
    description: "Show or manage dynamic context (usage: /context [--clear|--remove <path>])",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/);

      if (tokens[0] === "--clear") {
        const count = contextEntries.length;
        contextEntries = [];
        currentContextText = "";
        persistState();
        ctx.ui.notify(`Cleared ${count} context entries`, "info");
        return;
      }

      if (tokens[0] === "--remove" && tokens[1]) {
        const target = path.resolve(ctx.cwd, tokens[1]);
        const idx = contextEntries.findIndex((e) => e.path === target || e.path.startsWith(target));
        if (idx === -1) {
          ctx.ui.notify(`No context entry matching: ${tokens[1]}`, "warning");
          return;
        }
        const removed = contextEntries.splice(idx, 1)[0];
        rebuildContext(ctx.cwd);
        persistState();
        ctx.ui.notify(`Removed: ${path.relative(ctx.cwd, removed.path)}`, "info");
        return;
      }

      // Show current context
      if (contextEntries.length === 0) {
        ctx.ui.notify(
          "No dynamically added context. Use /add-dir or /add-context to add files.",
          "info",
        );
        return;
      }

      const items = contextEntries.map((e) => {
        const relPath = path.relative(ctx.cwd, e.path);
        const size = e.content ? ` (${(e.content.length / 1024).toFixed(1)}KB)` : "";
        return `${e.type === "directory" ? "📁" : "📄"} ${relPath}${size}`;
      });

      const totalSize = contextEntries.reduce((sum, e) => sum + (e.content?.length || 0), 0);
      const summary = `${contextEntries.length} entries, ${(totalSize / 1024).toFixed(1)}KB total`;

      ctx.ui.notify(`Dynamic Context — ${summary}:\n${items.join("\n")}`, "info");
    },
  });
}
