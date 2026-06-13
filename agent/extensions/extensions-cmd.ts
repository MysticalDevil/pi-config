/**
 * /extensions command — List, enable, disable extensions
 *
 * Works by renaming .ts files to .ts.disabled and back.
 * Requires /reload for changes to take effect.
 *
 * Usage:
 *   /extensions                    — list all extensions with status
 *   /extensions disable <name>     — disable an extension
 *   /extensions enable <name>      — re-enable an extension
 */

import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isSafeExtensionName, sortExtensionEntries } from "./lib/extensions-cmd-helpers.ts";

interface ExtInfo {
  name: string;
  enabled: boolean;
  source: "global" | "project";
}

export function scanExtensions(cwd: string): ExtInfo[] {
  const dirs = [
    { path: join(cwd, ".pi", "extensions"), source: "project" as const },
    { path: join(getAgentDir(), "extensions"), source: "global" as const },
  ];

  const result: ExtInfo[] = [];

  function record(ext: ExtInfo): void {
    result.push(ext);
  }

  for (const { path, source } of dirs) {
    if (!existsSync(path)) continue;

    let entries: string[];
    try {
      entries = readdirSync(path);
    } catch {
      continue;
    }

    for (const entry of entries) {
      // Handle directory extensions (e.g. sandbox/index.ts)
      let entryStat: ReturnType<typeof statSync> | undefined;
      try {
        entryStat = statSync(join(path, entry));
      } catch {
        continue;
      }

      if (entryStat.isDirectory()) {
        if (!isSafeExtensionName(entry)) continue;
        const indexFile = join(path, entry, "index.ts");
        const disabledFile = join(path, entry, "index.ts.disabled");
        if (existsSync(indexFile)) {
          record({ name: entry, enabled: true, source });
        } else if (existsSync(disabledFile)) {
          record({ name: entry, enabled: false, source });
        }
        continue;
      }

      // Handle file extensions
      if (entry.endsWith(".ts")) {
        const name = entry.replace(/\.ts$/, "");
        if (!isSafeExtensionName(name)) continue;
        record({
          name,
          enabled: true,
          source,
        });
      } else if (entry.endsWith(".ts.disabled")) {
        const name = entry.replace(/\.ts\.disabled$/, "");
        if (!isSafeExtensionName(name)) continue;
        record({
          name,
          enabled: false,
          source,
        });
      }
    }
  }

  return sortExtensionEntries(result);
}

function toggleExtension(
  cwd: string,
  name: string,
  enable: boolean,
  preferSource?: "global" | "project",
): string | null {
  if (!isSafeExtensionName(name)) return null;

  const dirs = [
    { path: join(cwd, ".pi", "extensions"), source: "project" as const },
    { path: join(getAgentDir(), "extensions"), source: "global" as const },
  ];

  // Default to project-first; reverse if global is preferred
  const ordered = preferSource === "global" ? [...dirs].reverse() : dirs;

  for (const { path } of ordered) {
    // Try file extension
    const tsFile = join(path, `${name}.ts`);
    const disabledFile = join(path, `${name}.ts.disabled`);

    if (existsSync(tsFile) && !enable) {
      renameSync(tsFile, disabledFile);
      return "disabled";
    }
    if (existsSync(disabledFile) && enable) {
      renameSync(disabledFile, tsFile);
      return "enabled";
    }

    // Try directory extension
    const dirPath = join(path, name);
    if (statSync(dirPath, { throwIfNoEntry: false })?.isDirectory()) {
      const indexFile = join(dirPath, "index.ts");
      const disabledIndex = join(dirPath, "index.ts.disabled");

      if (existsSync(indexFile) && !enable) {
        renameSync(indexFile, disabledIndex);
        return "disabled";
      }
      if (existsSync(disabledIndex) && enable) {
        renameSync(disabledIndex, indexFile);
        return "enabled";
      }
    }
  }

  return null;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("extensions", {
    description:
      "List, enable, or disable extensions (usage: /extensions [enable|disable] <name>[@source])",
    handler: async (args, ctx) => {
      const tokens = (args || "").trim().split(/\s+/).filter(Boolean);

      // List mode
      if (tokens.length === 0) {
        const exts = scanExtensions(ctx.cwd);
        if (exts.length === 0) {
          ctx.ui.notify("No extensions found", "info");
          return;
        }

        const lines = exts.map((e) => {
          const icon = e.enabled ? "✅" : "❌";
          const src = e.source === "project" ? " (project)" : "";
          return `${icon} ${e.name}${src}`;
        });

        ctx.ui.notify(
          `Extensions (${exts.length}):\n${lines.join("\n")}\n\nUse /extensions disable <name> or enable <name>`,
          "info",
        );
        return;
      }

      // Toggle mode
      const action = tokens[0].toLowerCase();
      const rawName = tokens[1];

      if (!rawName) {
        ctx.ui.notify(
          "Usage: /extensions enable <name>[@source] | /extensions disable <name>[@source]",
          "error",
        );
        return;
      }

      if (action !== "enable" && action !== "disable") {
        ctx.ui.notify(`Unknown action: ${action}. Use enable or disable.`, "error");
        return;
      }

      const match = rawName.match(/^(.+?)@(project|global)$/);
      const name = match ? match[1] : rawName;
      if (!isSafeExtensionName(name)) {
        ctx.ui.notify(`Invalid extension name: ${name}`, "error");
        return;
      }

      const exts = scanExtensions(ctx.cwd);
      const matching = exts.filter((e) => e.name === name);

      if (matching.length > 1 && !match) {
        const lines = matching.map((e) => `  ${e.enabled ? "✅" : "❌"} ${e.name} (${e.source})`);
        ctx.ui.notify(
          `Multiple extensions named "${name}":\n${lines.join("\n")}\nUse /extensions ${action} ${name}@project or ${name}@global`,
          "warning",
        );
        return;
      }

      const preferSource =
        match?.[2] === "project"
          ? ("project" as const)
          : match?.[2] === "global"
            ? ("global" as const)
            : matching[0]?.source;
      const result = toggleExtension(ctx.cwd, name, action === "enable", preferSource);

      if (!result) {
        ctx.ui.notify(`Extension "${name}" not found or already ${action}d`, "warning");
        return;
      }

      ctx.ui.notify(`Extension "${name}" ${result}. Reloading...`, "info");
      await ctx.reload();
      return;
    },
  });
}
