/**
 * Memory - Cross-Session Persistent Memory (like Claude's Memory)
 *
 * Allows the agent and user to save and recall key information across sessions.
 * Memories are stored in ~/.pi/agent/memories.json and are automatically
 * injected into the system prompt of new sessions.
 *
 * Features:
 *   - LLM can save/recall memories via the `memory` tool
 *   - User can manage memories via /memory command
 *   - Memories are injected into system prompt automatically
 *   - Support for tagging and relevance filtering
 *
 * Usage:
 *   /memory                    — list all memories
 *   /memory add <text>         — add a memory
 *   /memory remove <id>        — remove a memory
 *   /memory search <query>     — search memories
 *   /memory clear              — clear all memories
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Memory {
	id: string;
	text: string;
	tags: string[];
	createdAt: number;
	updatedAt: number;
}

const MEMORY_FILE = path.join(process.env.HOME || "~", ".pi", "agent", "memories.json");

const MemoryParams = Type.Object({
	action: Type.String({ description: "Action: save, recall, list, remove, clear" }),
	text: Type.Optional(Type.String({ description: "Memory text (for save) or search query (for recall)" })),
	id: Type.Optional(Type.String({ description: "Memory ID (for remove)" })),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorizing (for save)" })),
});

function loadMemories(): Memory[] {
	try {
		if (!fs.existsSync(MEMORY_FILE)) return [];
		const data = fs.readFileSync(MEMORY_FILE, "utf-8");
		return JSON.parse(data) as Memory[];
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw e;
	}
}

function saveMemories(memories: Memory[]): void {
	const dir = path.dirname(MEMORY_FILE);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(MEMORY_FILE, JSON.stringify(memories, null, 2), "utf-8");
}

function generateId(): string {
	return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatMemoriesForPrompt(memories: Memory[]): string {
	if (memories.length === 0) return "";

	const recent = memories.slice(-20); // Last 20 most relevant
	const lines = recent.map((m) => {
		const tags = m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
		return `- ${m.text}${tags}`;
	});

	return `\n## Saved Memories (from previous sessions)\n\n${lines.join("\n")}\n\nUse these when relevant. To save new memories, use the memory tool.\n`;
}

export default function (pi: ExtensionAPI) {
	// Inject memories into system prompt
	pi.on("before_agent_start", async (event) => {
		const memories = loadMemories();
		if (memories.length === 0) return;

		const promptText = formatMemoriesForPrompt(memories);
		if (!promptText) return;

		return {
			systemPrompt: event.systemPrompt + promptText,
		};
	});

	// Register memory tool for LLM
	pi.registerTool({
		name: "memory",
		label: "Memory",
		description: "Manage persistent cross-session memories. Actions: save (store a fact), recall (search), list (show all), remove (delete by id), clear (remove all).",
		parameters: MemoryParams,
		promptSnippet: "Save or recall persistent memories across sessions",
		promptGuidelines: [
			"Use memory save when the user shares important facts, preferences, or decisions that should be remembered across sessions.",
			"Use memory recall to search for relevant saved memories before starting work.",
			"Use memory list to see what's already saved.",
		],

		async execute(_toolCallId, params) {
			const memories = loadMemories();

			switch (params.action) {
				case "save": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text is required for save action." }],
							details: {},
						};
					}
					const newMem: Memory = {
						id: generateId(),
						text: params.text,
						tags: params.tags || [],
						createdAt: Date.now(),
						updatedAt: Date.now(),
					};
					memories.push(newMem);
					saveMemories(memories);
					return {
						content: [{ type: "text", text: `✅ Saved: "${params.text}" (${newMem.id})` }],
						details: { action: "save", memory: newMem },
					};
				}

				case "recall": {
					const query = params.text?.toLowerCase() || "";
					const results = query
						? memories.filter((m) => m.text.toLowerCase().includes(query) || m.tags.some((t) => t.toLowerCase().includes(query)))
						: memories.slice(-20);

					if (results.length === 0) {
						return {
							content: [{ type: "text", text: query ? `No memories matching "${query}".` : "No memories saved yet." }],
							details: { action: "recall", matches: 0 },
						};
					}

					const text = results.map((m) => {
						const tags = m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
						return `[${m.id}] ${m.text}${tags}`;
					}).join("\n");

					return {
						content: [{ type: "text", text: `📚 ${results.length} memories:\n\n${text}` }],
						details: { action: "recall", matches: results.length, memories: results },
					};
				}

				case "list": {
					if (memories.length === 0) {
						return {
							content: [{ type: "text", text: "No memories saved yet." }],
							details: { action: "list", count: 0 },
						};
					}
					const text = memories.map((m) => {
						const tags = m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
						return `[${m.id}] ${m.text}${tags}`;
					}).join("\n");
					return {
						content: [{ type: "text", text: `📚 ${memories.length} memories:\n\n${text}` }],
						details: { action: "list", count: memories.length },
					};
				}

				case "remove": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id is required for remove action." }],
							details: {},
						};
					}
					const idx = memories.findIndex((m) => m.id === params.id);
					if (idx === -1) {
						return {
							content: [{ type: "text", text: `No memory found with id "${params.id}".` }],
							details: {},
						};
					}
					const removed = memories.splice(idx, 1)[0];
					saveMemories(memories);
					return {
						content: [{ type: "text", text: `🗑 Removed: "${removed.text}"` }],
						details: { action: "remove", removed },
					};
				}

				case "clear": {
					const count = memories.length;
					saveMemories([]);
					return {
						content: [{ type: "text", text: `🗑 Cleared all ${count} memories.` }],
						details: { action: "clear", count },
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}. Use: save, recall, list, remove, clear.` }],
						details: {},
					};
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("memory ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			return { type: "text", text } as any;
		},
	});

	// User-facing /memory command
	pi.registerCommand("memory", {
		description: "Manage persistent memories (usage: /memory [add <text>|search <q>|remove <id>|clear|list])",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/);
			const subcommand = tokens[0] || "list";
			const rest = tokens.slice(1).join(" ");

			const memories = loadMemories();

			switch (subcommand) {
				case "add": {
					if (!rest) {
						ctx.ui.notify("Usage: /memory add <text> [tag1,tag2,...]", "error");
						return;
					}
					const parts = rest.split(/\s+\[/);
					const text = parts[0];
					const tags = parts.length > 1 ? parts[1].replace("]", "").split(",").map((t) => t.trim()) : [];
					const newMem: Memory = {
						id: generateId(),
						text,
						tags,
						createdAt: Date.now(),
						updatedAt: Date.now(),
					};
					memories.push(newMem);
					saveMemories(memories);
					ctx.ui.notify(`Saved: "${text}"`, "info");
					break;
				}

				case "search": {
					const query = rest.toLowerCase();
					const results = query
						? memories.filter((m) => m.text.toLowerCase().includes(query) || m.tags.some((t) => t.toLowerCase().includes(query)))
						: memories;

					if (results.length === 0) {
						ctx.ui.notify(query ? `No matches for "${query}"` : "No memories", "info");
						return;
					}

					const items = results.map((m) => {
						const tags = m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
						return `[${m.id.slice(0, 12)}] ${m.text}${tags}`;
					});
					ctx.ui.notify(`${results.length} memories:\n${items.join("\n")}`, "info");
					break;
				}

				case "remove": {
					if (!rest) {
						ctx.ui.notify("Usage: /memory remove <id>", "error");
						return;
					}
					const idx = memories.findIndex((m) => m.id.startsWith(rest));
					if (idx === -1) {
						ctx.ui.notify(`No memory with id starting with "${rest}"`, "warning");
						return;
					}
					const removed = memories.splice(idx, 1)[0];
					saveMemories(memories);
					ctx.ui.notify(`Removed: "${removed.text}"`, "info");
					break;
				}

				case "clear": {
					const ok = await ctx.ui.confirm("Clear all memories?", `Delete all ${memories.length} saved memories?`);
					if (!ok) return;
					saveMemories([]);
					ctx.ui.notify(`Cleared ${memories.length} memories`, "info");
					break;
				}

				case "list":
				default: {
					if (memories.length === 0) {
						ctx.ui.notify("No memories saved. The agent can save memories using the memory tool.", "info");
						return;
					}
					const items = memories.map((m) => {
						const tags = m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
						return `[${m.id.slice(0, 12)}] ${m.text}${tags}`;
					});
					ctx.ui.notify(`${memories.length} memories:\n${items.join("\n")}`, "info");
					break;
				}
			}
		},
	});
}
