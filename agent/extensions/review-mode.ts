/**
 * Review Mode - Code Review Extension (like Codex Review Mode)
 *
 * After the agent makes changes, this extension:
 * 1. Captures git diff of changes made during the session
 * 2. Presents a structured review showing each changed file
 * 3. Allows interactive accept/reject per file
 * 4. Can auto-commit accepted changes
 *
 * Features:
 *   - /review              — review all changes made in this session
 *   - /review --auto       — auto-review after each turn
 *   - /review --commit     — commit reviewed changes
 *   - /review --revert     — revert specific changes
 *   - Diff-based change tracking per turn
 *
 * Usage:
 *   /review                — interactive diff review
 *   /review --auto         — toggle auto-review mode
 *   /review --summary      — show summary of all changes
 *   Ctrl+Alt+R             — quick review toggle
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

interface FileChange {
	file: string;
	status: "added" | "modified" | "deleted" | "renamed";
	additions: number;
	deletions: number;
	accepted: boolean;
	rejected: boolean;
	turnIndex: number;
}

interface ReviewState {
	autoReview: boolean;
	changes: FileChange[];
	acceptedFiles: Set<string>;
	rejectedFiles: Set<string>;
}

export default function (pi: ExtensionAPI) {
	const state: ReviewState = {
		autoReview: false,
		changes: [],
		acceptedFiles: new Set(),
		rejectedFiles: new Set(),
	};

	let turnIndex = 0;

	function persistState(): void {
		pi.appendEntry("review-state", {
			autoReview: state.autoReview,
			acceptedFiles: Array.from(state.acceptedFiles),
			rejectedFiles: Array.from(state.rejectedFiles),
		});
	}

	async function getChanges(cwd: string): Promise<FileChange[]> {
		// Get git diff stats
		const { stdout, code } = await pi.exec("git", ["diff", "--stat", "HEAD"], {
			cwd,
		});
		if (code !== 0 || !stdout.trim()) return [];

		const changes: FileChange[] = [];
		const lines = stdout.trim().split("\n");

		for (const line of lines) {
			const match = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s+(\+*)(-*)/);
			if (!match) continue;

			const file = match[1].trim();
			const additions = (match[3] || "").length;
			const deletions = (match[4] || "").length;
			const fullPath = path.join(cwd, file);

			let status: FileChange["status"] = "modified";
			if (!fs.existsSync(fullPath)) status = "deleted";
			else {
				// Check if file was newly created
				const { stdout: logOut } = await pi.exec(
					"git",
					["log", "--oneline", "--", file],
					{ cwd },
				);
				if (logOut.trim() === "") {
					const { stdout: stagedOut } = await pi.exec(
						"git",
						["ls-files", "--", file],
						{ cwd },
					);
					if (!stagedOut.trim()) status = "added";
				}
			}

			changes.push({
				file,
				status,
				additions,
				deletions,
				accepted: false,
				rejected: false,
				turnIndex,
			});
		}

		return changes;
	}

	async function getFileDiff(cwd: string, file: string): Promise<string> {
		const { stdout } = await pi.exec("git", ["diff", "--", file], { cwd });
		return stdout || "(no diff available)";
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (state.changes.length === 0) return;

		const pending = state.changes.filter(
			(c) =>
				!state.acceptedFiles.has(c.file) && !state.rejectedFiles.has(c.file),
		).length;

		if (pending === 0) {
			const accepted = state.acceptedFiles.size;
			ctx.ui.setStatus(
				"review",
				ctx.ui.theme.fg("success", `✅ ${accepted} files reviewed`),
			);
		} else {
			const total = state.changes.length;
			ctx.ui.setStatus(
				"review",
				ctx.ui.theme.fg("warning", `📝 Review: ${pending}/${total} pending`),
			);
		}
	}

	function clearStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("review", undefined);
	}

	// Track turns
	pi.on("turn_start", async (event) => {
		turnIndex = event.turnIndex;
	});

	// Auto-review after each turn
	pi.on("turn_end", async (_event, ctx) => {
		if (!state.autoReview) return;

		const changes = await getChanges(ctx.cwd);
		if (changes.length === 0) return;

		// Merge with existing changes
		for (const change of changes) {
			const existing = state.changes.find((c) => c.file === change.file);
			if (existing) {
				existing.additions += change.additions;
				existing.deletions += change.deletions;
			} else {
				state.changes.push(change);
			}
		}

		updateStatus(ctx);
		persistState();
	});

	// Restore state
	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === "review-state") {
				const data = entry.data as
					| {
							autoReview?: boolean;
							acceptedFiles?: string[];
							rejectedFiles?: string[];
					  }
					| undefined;
				if (data) {
					state.autoReview = data.autoReview ?? false;
					state.acceptedFiles = new Set(data.acceptedFiles || []);
					state.rejectedFiles = new Set(data.rejectedFiles || []);
				}
			}
		}
	});

	// /review command
	pi.registerCommand("review", {
		description:
			"Review code changes (usage: /review [--auto|--summary|--commit|--revert <file>])",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/);

			// Toggle auto-review
			if (tokens[0] === "--auto") {
				state.autoReview = !state.autoReview;
				ctx.ui.notify(
					state.autoReview
						? "Auto-review enabled (after each turn)"
						: "Auto-review disabled",
					"info",
				);
				persistState();
				return;
			}

			// Show summary
			if (tokens[0] === "--summary") {
				const changes = await getChanges(ctx.cwd);
				if (changes.length === 0) {
					ctx.ui.notify("No changes to review.", "info");
					return;
				}

				const totalAdd = changes.reduce((s, c) => s + c.additions, 0);
				const totalDel = changes.reduce((s, c) => s + c.deletions, 0);
				const items = changes.map((c) => {
					const icon =
						c.status === "added" ? "+" : c.status === "deleted" ? "-" : "~";
					return `${icon} ${c.file} (+${c.additions}/-${c.deletions})`;
				});

				ctx.ui.notify(
					`Changes: ${changes.length} files, +${totalAdd}/-${totalDel}\n${items.join("\n")}`,
					"info",
				);
				return;
			}

			// Commit accepted changes
			if (tokens[0] === "--commit") {
				if (state.acceptedFiles.size === 0) {
					ctx.ui.notify("No accepted changes to commit.", "warning");
					return;
				}

				const files = Array.from(state.acceptedFiles);
				await pi.exec("git", ["add", ...files], { cwd: ctx.cwd });
				await pi.exec(
					"git",
					["commit", "-m", `[pi-review] accept ${files.length} file(s)`],
					{
						cwd: ctx.cwd,
					},
				);

				state.changes = state.changes.filter(
					(c) => !state.acceptedFiles.has(c.file),
				);
				state.acceptedFiles.clear();
				state.rejectedFiles.clear();
				persistState();
				clearStatus(ctx);
				ctx.ui.notify(`Committed ${files.length} file(s)`, "info");
				return;
			}

			// Revert specific file
			if (tokens[0] === "--revert" && tokens[1]) {
				const file = tokens[1];
				await pi.exec("git", ["checkout", "--", file], { cwd: ctx.cwd });
				state.changes = state.changes.filter((c) => c.file !== file);
				state.acceptedFiles.delete(file);
				state.rejectedFiles.delete(file);
				persistState();
				updateStatus(ctx);
				ctx.ui.notify(`Reverted: ${file}`, "info");
				return;
			}

			// Interactive review
			const changes = await getChanges(ctx.cwd);
			if (changes.length === 0) {
				ctx.ui.notify("No changes to review.", "info");
				return;
			}

			// Merge with existing state
			for (const change of changes) {
				if (!state.changes.find((c) => c.file === change.file)) {
					state.changes.push(change);
				}
			}

			// Interactive review per file
			for (const change of state.changes) {
				if (
					state.acceptedFiles.has(change.file) ||
					state.rejectedFiles.has(change.file)
				)
					continue;

				const diff = await getFileDiff(ctx.cwd, change.file);
				const diffLines = diff.split("\n");
				const diffPreview = diffLines.slice(0, 30);

				// Show diff in custom UI
				const decision = await new Promise<string>((resolve) => {
					ctx.ui
						.custom((_tui, theme, _kb, done) => {
							const lines: string[] = [];
							const icon =
								change.status === "added"
									? "+"
									: change.status === "deleted"
										? "-"
										: "~";
							lines.push("");
							lines.push(
								theme.fg("accent", theme.bold(` ${icon} ${change.file} `)),
							);
							lines.push(theme.fg("borderMuted", "─".repeat(50)));
							lines.push(
								theme.fg(
									"muted",
									`+${change.additions}/-${change.deletions} lines`,
								),
							);
							lines.push("");

							for (const dline of diffPreview) {
								if (dline.startsWith("+")) {
									lines.push(theme.fg("success", dline));
								} else if (dline.startsWith("-")) {
									lines.push(theme.fg("error", dline));
								} else if (dline.startsWith("@@")) {
									lines.push(theme.fg("accent", dline));
								} else {
									lines.push(theme.fg("dim", dline));
								}
							}

							if (diffLines.length > 30) {
								lines.push(
									theme.fg("dim", `... ${diffLines.length - 30} more lines`),
								);
							}

							lines.push("");
							lines.push(
								theme.fg("accent", " [a]ccept  [r]eject  [v]iew full  [q]uit "),
							);
							lines.push("");

							return {
								render(_width: number) {
									return lines;
								},
								invalidate() {},
								handleInput(data: string) {
									if (data === "a" || data === "A") {
										done(undefined);
										resolve("accept");
									} else if (data === "r" || data === "R") {
										done(undefined);
										resolve("reject");
									} else if (data === "v" || data === "V") {
										done(undefined);
										resolve("view");
									} else if (data === "q" || data === "Q" || data === "\x1b") {
										done(undefined);
										resolve("quit");
									}
								},
							};
						})
						.catch(() => resolve("quit"));
				});

				if (decision === "quit") break;
				if (decision === "accept") {
					state.acceptedFiles.add(change.file);
					state.rejectedFiles.delete(change.file);
				} else if (decision === "reject") {
					state.rejectedFiles.add(change.file);
					state.acceptedFiles.delete(change.file);
					// Revert the file
					await pi.exec("git", ["checkout", "--", change.file], {
						cwd: ctx.cwd,
					});
				} else if (decision === "view") {
					// Show full diff
					const fullDiff = await getFileDiff(ctx.cwd, change.file);
					await ctx.ui.custom((_tui, theme, _kb, done) => {
						const lines = fullDiff.split("\n");
						const displayLines = lines.map((l) => {
							if (l.startsWith("+")) return theme.fg("success", l);
							if (l.startsWith("-")) return theme.fg("error", l);
							if (l.startsWith("@@")) return theme.fg("accent", l);
							return theme.fg("dim", l);
						});
						displayLines.push("");
						displayLines.push(theme.fg("dim", "Press any key to continue..."));
						return {
							render() {
								return displayLines;
							},
							invalidate() {},
							handleInput() {
								done(undefined);
							},
						};
					});
				}
			}

			persistState();
			updateStatus(ctx);

			// Summary
			const accepted = state.changes.filter((c) =>
				state.acceptedFiles.has(c.file),
			).length;
			const rejected = state.changes.filter((c) =>
				state.rejectedFiles.has(c.file),
			).length;
			const pending = state.changes.filter(
				(c) =>
					!state.acceptedFiles.has(c.file) && !state.rejectedFiles.has(c.file),
			).length;

			ctx.ui.notify(
				`Review: ${accepted} accepted, ${rejected} rejected, ${pending} pending\nUse /review --commit to commit accepted changes.`,
				"info",
			);
		},
	});

	// Shortcut
	pi.registerShortcut(Key.ctrlAlt("r"), {
		description: "Review code changes",
		handler: async (_ctx) => {
			// Trigger review command
			pi.sendUserMessage("/review", { triggerTurn: false });
		},
	});
}
