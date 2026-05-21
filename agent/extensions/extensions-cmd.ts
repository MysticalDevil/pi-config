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

interface ExtInfo {
	name: string;
	enabled: boolean;
	source: "global" | "project";
}

function scanExtensions(cwd: string): ExtInfo[] {
	const dirs = [
		{ path: join(getAgentDir(), "extensions"), source: "global" as const },
		{ path: join(cwd, ".pi", "extensions"), source: "project" as const },
	];

	const result: ExtInfo[] = [];

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
				const indexFile = join(path, entry, "index.ts");
				const disabledFile = join(path, entry, "index.ts.disabled");
				if (existsSync(indexFile)) {
					result.push({ name: entry, enabled: true, source });
				} else if (existsSync(disabledFile)) {
					result.push({ name: entry, enabled: false, source });
				}
				continue;
			}

			// Handle file extensions
			if (entry.endsWith(".ts")) {
				result.push({
					name: entry.replace(/\.ts$/, ""),
					enabled: true,
					source,
				});
			} else if (entry.endsWith(".ts.disabled")) {
				result.push({
					name: entry.replace(/\.ts\.disabled$/, ""),
					enabled: false,
					source,
				});
			}
		}
	}

	return result;
}

function toggleExtension(
	cwd: string,
	name: string,
	enable: boolean,
): string | null {
	const dirs = [
		{ path: join(getAgentDir(), "extensions"), source: "global" },
		{ path: join(cwd, ".pi", "extensions"), source: "project" },
	];

	for (const { path } of dirs) {
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
			"List, enable, or disable extensions (usage: /extensions [enable|disable] <name>)",
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
			const name = tokens[1];

			if (!name) {
				ctx.ui.notify(
					"Usage: /extensions enable <name> | /extensions disable <name>",
					"error",
				);
				return;
			}

			if (action !== "enable" && action !== "disable") {
				ctx.ui.notify(
					`Unknown action: ${action}. Use enable or disable.`,
					"error",
				);
				return;
			}

			const result = toggleExtension(ctx.cwd, name, action === "enable");

			if (!result) {
				ctx.ui.notify(
					`Extension "${name}" not found or already ${action}d`,
					"warning",
				);
				return;
			}

			ctx.ui.notify(`Extension "${name}" ${result}. Reloading...`, "info");
			await ctx.reload();
			return;
		},
	});
}
