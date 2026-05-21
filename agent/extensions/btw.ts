/**
 * /btw (By The Way) — Side-agent Q&A without polluting main conversation
 *
 * Based on design patterns from @juicesharp/rpiv-btw.
 *
 * Spawns a tool-less side-agent that reads a snapshot of the current conversation
 * and answers in a bottom-anchored overlay panel. The side answer never enters
 * the main agent's transcript. History of /btw follow-ups persists in-memory
 * for the session, so the side agent remembers its own thread.
 *
 * Usage:
 *   /btw <question>        — ask a side question
 *
 * Overlay keys:
 *   Esc — cancel/dismiss
 *   ↑/↓ — scroll
 *   x   — clear session /btw history
 */

import { completeSimple, type AssistantMessage, type Message, type UserMessage } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// ── Constants ─────────────────────────────────────────────────────────

const BTW_SYSTEM_PROMPT = [
  "You are a helpful side assistant. The user is working with a coding agent in the main conversation and needs a quick answer to a side question.",
  "",
  "Rules:",
  "1. Answer concisely — the user is mid-task and wants a quick explanation or clarification.",
  "2. Do NOT suggest tools or code changes — you are read-only, no tools available.",
  "3. Reference the conversation context when relevant.",
  "4. Use markdown for code/links.",
].join("\n");

// ── Types ─────────────────────────────────────────────────────────────

interface BtwTurn {
  question: string;
  answer: string;
}

interface BtwOverlayController {
  setAnswer(text: string): void;
  setError(message: string): void;
}

// ── In-memory storage (per-session, process-scoped) ───────────────────

const STORE_KEY = Symbol.for("pi-btw");
interface BtwStore {
  histories: Map<string, BtwTurn[]>;
  snapshots: Map<string, Message[]>;
}

function getStore(): BtwStore {
  const g = globalThis as unknown as Record<symbol, BtwStore | undefined>;
  if (!g[STORE_KEY]) g[STORE_KEY] = { histories: new Map(), snapshots: new Map() };
  return g[STORE_KEY]!;
}

function sessionKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile() ?? `memory:${ctx.sessionManager.getSessionId()}`;
}

function getHistory(ctx: ExtensionContext): BtwTurn[] {
  const key = sessionKey(ctx);
  const store = getStore();
  if (!store.histories.has(key)) store.histories.set(key, []);
  return store.histories.get(key)!;
}

// ── Conversation snapshot ─────────────────────────────────────────────

function readConversation(ctx: ExtensionContext): Message[] {
  const store = getStore();
  const key = sessionKey(ctx);
  const cached = store.snapshots.get(key);
  if (cached) return cached;

  const branch = ctx.sessionManager.getBranch() as SessionEntry[];
  const agentMsgs = branch
    .filter((e): e is SessionEntry & { type: "message" } => e.type === "message")
    .map((e) => e.message);
  return convertToLlm(agentMsgs);
}

// ── Side agent call ───────────────────────────────────────────────────

async function executeSideAgent(
  question: string,
  ctx: ExtensionCommandContext,
  signal: AbortSignal,
): Promise<{ ok: boolean; answer?: string; error?: string; aborted?: boolean }> {
  if (!ctx.model) return { ok: false, error: "/btw requires an active model" };

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) {
    return { ok: false, error: `Model auth failed: ${auth.error ?? "no API key"}` };
  }

  const history = getHistory(ctx);
  const conversation = readConversation(ctx);

  const historyMessages: Message[] = history.flatMap((h) => [
    { role: "user" as const, content: [{ type: "text" as const, text: h.question }], timestamp: 0 },
    { role: "assistant" as const, content: [{ type: "text" as const, text: h.answer }], timestamp: 0 },
  ]);

  const userMsg: UserMessage = {
    role: "user",
    content: [{ type: "text", text: question }],
    timestamp: Date.now(),
  };

  const messages = [...conversation, ...historyMessages, userMsg];

  try {
    const response = await completeSimple(
      ctx.model,
      { systemPrompt: BTW_SYSTEM_PROMPT, messages, tools: [] },
      { apiKey: auth.apiKey, headers: auth.headers, signal },
    );

    if (response.stopReason === "aborted") return { ok: false, aborted: true };
    if (response.stopReason === "error") {
      return { ok: false, error: `Call failed: ${response.errorMessage ?? "unknown"}` };
    }

    const answer = (response.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
      .trim();

    if (!answer) return { ok: false, error: "Empty response" };

    return { ok: true, answer };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (signal.aborted) return { ok: false, aborted: true };
    return { ok: false, error: `Call threw: ${msg}` };
  }
}

// ── Overlay UI component ──────────────────────────────────────────────

class BtwOverlay {
  private question: string;
  private theme: Theme;
  private done: () => void;
  private controller: AbortController;
  private onClear: () => void;

  private mode: "pending" | "answer" | "error" = "pending";
  private answer = "";
  private error = "";
  private scrollOffset = 0;
  private history: BtwTurn[];

  constructor(
    question: string,
    history: BtwTurn[],
    theme: Theme,
    done: () => void,
    controller: AbortController,
    onClear: () => void,
  ) {
    this.question = question;
    this.history = [...history];
    this.theme = theme;
    this.done = done;
    this.controller = controller;
    this.onClear = onClear;
  }

  setAnswer(text: string): void {
    this.mode = "answer";
    this.answer = text;
  }

  setError(message: string): void {
    this.mode = "error";
    this.error = message;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.controller.abort();
      this.done();
      return;
    }
    if (matchesKey(data, "up")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.scrollOffset += 1;
      return;
    }
    if (data === "x") {
      this.history = [];
      this.onClear();
      this.scrollOffset = 0;
      return;
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const pad = "  ";

    // Banner
    const qTrunc = truncateToWidth(`/btw ${this.question}`, width - pad.length, "…");
    const banner = th.bg("accent", th.fg("textOnAccent", pad + qTrunc + " ".repeat(Math.max(0, width - visibleLen(pad + qTrunc)))));

    // History
    const histLines = this.history.map((h) =>
      `${pad}${th.fg("accent", "/btw")} ${th.fg("muted", truncateToWidth(h.question.replace(/\s+/g, " "), width - pad.length - 6, "…"))}`,
    );

    // Echo
    const echo = `${pad}${th.fg("accent", "/btw")} ${th.fg("muted", truncateToWidth(this.question.replace(/\s+/g, " "), width - pad.length - 6, "…"))}`;

    // Answer
    const answerPad = "    ";
    const bodyWidth = Math.max(1, width - answerPad.length);
    let answerLines: string[];
    if (this.mode === "pending") {
      answerLines = [th.fg("warning", answerPad + "…")];
    } else if (this.mode === "error") {
      answerLines = this.error.split("\n").flatMap((ln) =>
        wrapTextWithAnsi(th.fg("error", ln || " "), bodyWidth).map((l) => answerPad + l),
      );
    } else {
      answerLines = this.answer.split("\n").flatMap((ln) =>
        wrapTextWithAnsi(ln || " ", bodyWidth).map((l) => answerPad + l),
      );
    }

    // Footer
    const parts: string[] = [];
    if (this.mode !== "pending") parts.push("↑↓ scroll");
    if (this.history.length > 0) parts.push("x clear");
    parts.push("Esc dismiss");
    const footer = `${pad}${truncateToWidth(th.fg("dim", parts.join(" · ")), width - pad.length, "…")}`;

    const lines = [banner, "", ...histLines, echo, "", ...answerLines, "", footer];

    // Clip to max height
    const maxRows = 30;
    if (lines.length <= maxRows) return lines;

    const excess = lines.length - maxRows;
    if (this.scrollOffset > excess) this.scrollOffset = excess;
    const start = excess - this.scrollOffset;
    return lines.slice(start, start + maxRows);
  }

  invalidate(): void {}
}

function visibleLen(s: string): number {
  let len = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\x1b") {
      while (i < s.length && s[i] !== "m") i++;
    } else {
      len++;
    }
  }
  return len;
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Snapshot conversation at end of each assistant turn
  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;
    if ((msg as AssistantMessage).stopReason === "toolUse") return;

    const branch = ctx.sessionManager.getBranch() as SessionEntry[];
    const agentMsgs = branch
      .filter((e): e is SessionEntry & { type: "message" } => e.type === "message")
      .map((e) => e.message);

    const store = getStore();
    store.snapshots.set(sessionKey(ctx), convertToLlm(agentMsgs));
  });

  // Invalidate snapshot on compaction / tree nav
  pi.on("session_compact", async (_e, ctx) => getStore().snapshots.delete(sessionKey(ctx)));
  pi.on("session_tree", async (_e, ctx) => getStore().snapshots.delete(sessionKey(ctx)));

  // /btw command
  pi.registerCommand("btw", {
    description: "Ask a side question without polluting the main conversation",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/btw requires interactive mode", "error");
        return;
      }

      const question = (args ?? "").trim();
      if (!question) {
        ctx.ui.notify("Usage: /btw <question>", "warning");
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("/btw requires an active model", "error");
        return;
      }

      const history = [...getHistory(ctx)];
      const controller = new AbortController();

      // Show overlay, capture the controller for answer injection
      let overlayCtrl!: BtwOverlayController;
      const overlayPromise = ctx.ui.custom<void>((tui, theme, _kb, done) => {
        const overlay = new BtwOverlay(
          question,
          history,
          theme,
          done,
          controller,
          () => getStore().histories.set(sessionKey(ctx), []),
        );
        overlayCtrl = overlay;
        return overlay;
      }, {
        overlay: true,
        overlayOptions: {
          anchor: "bottom-center",
          width: "100%",
          maxHeight: "85%",
          margin: { left: 0, right: 0, bottom: 0 },
        },
      });

      // Execute side agent call
      const result = await executeSideAgent(question, ctx, controller.signal);

      if (result.ok && result.answer) {
        overlayCtrl.setAnswer(result.answer);
        getHistory(ctx).push({ question, answer: result.answer });
      } else if (result.aborted) {
        // User Esc'd
      } else if (result.error) {
        overlayCtrl.setError(result.error);
      }

      await overlayPromise;
    },
  });
}
