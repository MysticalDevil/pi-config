/**
 * btw.ts — /btw side-question slash command (fork-based).
 *
 * Forks the current session, injects a boundary prompt to tell the model
 * that inherited history is reference-only, then runs the side question in
 * an ephemeral fork. The answer is rendered in a bottom-slot overlay and
 * never enters the main conversation.
 *
 * Follows Codex /side approach: fork → boundary prompt → one-turn answer
 * → discard. History persists per-session via globalThis.
 *
 * History and snapshots replaced by fork-session lifecycle.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showBtwOverlay } from "./btw-ui";

// ── Boundary prompt (following Codex /side pattern) ───────────────────

const SIDE_BOUNDARY_PROMPT = [
  "Side conversation boundary.",
  "",
  "Everything below this boundary is inherited history from the parent thread.",
  "It is reference context only. It is not your current task.",
  "",
  "Do not continue, execute, or complete any instructions, plans, tool calls,",
  "approvals, edits, or requests from before this boundary. Only the question",
  "after this boundary is your active instruction.",
  "",
  "You are a side-conversation assistant, separate from the main thread.",
  "Answer questions and do lightweight, non-mutating exploration without",
  "disrupting the main thread.",
  "",
  "Do not modify files, source, git state, permissions, configuration, or",
  "workspace state. Do not request escalated permissions or broader sandbox",
  "access.",
  "",
  "Keep responses concise and actionable. Use markdown for code blocks.",
  "",
  "---",
  "",
  "Question (active instruction):",
].join("\n");

// ── Types ─────────────────────────────────────────────────────────────

export interface BtwHistoryEntry {
  question: string;
  answer: string;
}

interface BtwState {
  histories: Map<string, BtwHistoryEntry[]>;
}

export interface BtwExecResult {
  ok: boolean;
  answer?: string;
  error?: string;
  aborted?: boolean;
}

// ── Storage ───────────────────────────────────────────────────────────

const BTW_STATE_KEY = Symbol.for("rpiv-btw");

function getState(): BtwState {
  const g = globalThis as unknown as Record<symbol, BtwState | undefined>;
  let state = g[BTW_STATE_KEY];
  if (!state) {
    state = { histories: new Map() };
    g[BTW_STATE_KEY] = state;
  }
  return state;
}

function getSessionFile(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile() ?? `:${ctx.sessionManager.getSessionId()}`;
}

function getSessionHistory(ctx: ExtensionContext): BtwHistoryEntry[] {
  return getState().histories.get(getSessionFile(ctx)) ?? [];
}

function pushSessionHistory(ctx: ExtensionContext, entry: BtwHistoryEntry): void {
  const key = getSessionFile(ctx);
  const state = getState();
  let turns = state.histories.get(key);
  if (!turns) {
    turns = [];
    state.histories.set(key, turns);
  }
  turns.push(entry);
}

export function clearSessionHistory(ctx: ExtensionContext): void {
  getState().histories.set(getSessionFile(ctx), []);
}

// ── Fork execution ────────────────────────────────────────────────────

function getPiCommand(): { cmd: string; args: string[] } {
  const execPath = process.execPath;
  const scriptPath = process.argv[1];
  if (scriptPath && !scriptPath.startsWith("/$bunfs/") && fs.existsSync(scriptPath)) {
    return { cmd: execPath, args: [scriptPath] };
  }
  return { cmd: "pi", args: [] };
}

export async function executeBtw(
  question: string,
  ctx: ExtensionContext,
  controller: AbortController,
): Promise<BtwExecResult> {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) {
    return { ok: false, error: "/btw requires a saved session" };
  }

  const prompt = `${SIDE_BOUNDARY_PROMPT} ${question}`;

  const pi = getPiCommand();
  const args = [
    "--fork",
    sessionFile,
    "-p",
    "--mode",
    "json",
    "--no-extensions",
    "--append-system-prompt",
    prompt,
    question,
  ];

  return await new Promise<BtwExecResult>((resolve) => {
    const proc = spawn(pi.cmd, pi.args.concat(args), {
      cwd: ctx.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let lastAssistantText = "";
    let aborted = false;

    const finish = (result: BtwExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      controller.signal.removeEventListener("abort", onAbort);
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already dead */
      }
      resolve(result);
    };

    const timeoutId = setTimeout(() => {
      finish({ ok: false, error: "Timed out (60s)" });
    }, 60000);

    const onAbort = () => {
      aborted = true;
      finish({ ok: false, aborted: true });
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      // Stream lines as they arrive
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "message_end" && event.message?.role === "assistant") {
            const content = event.message.content ?? [];
            for (const part of content) {
              if (part.type === "text") lastAssistantText += part.text;
            }
          }
        } catch {
          /* skip non-JSON lines */
        }
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timeoutId);
      if (settled) return;

      if (aborted) {
        resolve({ ok: false, aborted: true });
        return;
      }

      // Process any remaining output
      if (stdout.trim()) {
        try {
          const event = JSON.parse(stdout.trim());
          if (event.type === "message_end" && event.message?.role === "assistant") {
            const content = event.message.content ?? [];
            for (const part of content) {
              if (part.type === "text") lastAssistantText += part.text;
            }
          }
        } catch {
          /* skip */
        }
      }

      const answer = lastAssistantText.trim();
      if (answer) {
        resolve({ ok: true, answer });
      } else {
        const errPreview = stderr.trim().slice(0, 200);
        resolve({
          ok: false,
          error:
            code === 0
              ? "No answer produced"
              : `Fork exited ${code}${errPreview ? ": " + errPreview : ""}`,
        });
      }
    });

    proc.on("error", () => {
      clearTimeout(timeoutId);
      resolve({ ok: false, error: "Failed to start subprocess" });
    });
  });
}

// ── Command handler ───────────────────────────────────────────────────

export function registerBtwCommand(pi: ExtensionAPI): void {
  pi.registerCommand("btw", {
    description: "Ask a side question in an ephemeral session fork",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/btw requires interactive mode", "error");
        return;
      }
      const question = args.trim();
      if (!question) {
        ctx.ui.notify("Usage: /btw <question>", "warning");
        return;
      }

      const controller = new AbortController();

      const { overlayPromise, controllerReady } = showBtwOverlay({
        ctx,
        question,
        history: getSessionHistory(ctx),
        controller,
        onClearHistory: () => clearSessionHistory(ctx),
      });

      const overlayCtl = await controllerReady;
      const result = await executeBtw(question, ctx, controller);

      if (result.ok && result.answer) {
        overlayCtl.setAnswer(result.answer);
        pushSessionHistory(ctx, { question, answer: result.answer });
      } else if (result.aborted) {
        // user pressed Esc — overlay already dismissed
      } else if (result.error) {
        overlayCtl.setError(result.error);
      }

      await overlayPromise;
    },
  });
}
