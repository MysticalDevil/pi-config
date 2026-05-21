/**
 * /btw (By The Way) — Side-agent Q&A in a bottom overlay panel.
 *
 * Spawns a tool-less LLM call via completeSimple() with a read-only
 * snapshot of the current conversation. The answer renders in a bottom-
 * anchored overlay — never pollutes the main transcript.
 *
 * Based on patterns from @juicesharp/rpiv-btw.
 *
 * Usage: /btw <question>
 * Keys: Esc cancel | ↑↓ scroll | x clear history
 */

import { completeSimple, type Message, type UserMessage } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// ── System prompt for the side agent ─────────────────────────────────

const BTW_SYSTEM_PROMPT = [
  "You are a concise side assistant.",
  "The user is mid-task with a coding agent. Answer briefly.",
  "Do NOT suggest tools or code changes — you are read-only.",
  "Reference the conversation when relevant.",
].join("\n");

// ── Storage ──────────────────────────────────────────────────────────

interface BtwTurn { question: string; answer: string }
const STORE_KEY = Symbol.for("pi-btw");
interface BtwStore {
  histories: Map<string, BtwTurn[]>;
  snapshots: Map<string, string>;
}

function store(): BtwStore {
  const g = globalThis as unknown as Record<symbol, BtwStore | undefined>;
  if (!g[STORE_KEY]) g[STORE_KEY] = { histories: new Map(), snapshots: new Map() };
  return g[STORE_KEY]!;
}
function sessionKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile() ?? `_:${ctx.sessionManager.getSessionId()}`;
}

// ── Conversation snapshot ────────────────────────────────────────────

function snapshotConversation(ctx: ExtensionContext): Message[] {
  const key = sessionKey(ctx);
  const cached = store().snapshots.get(key);
  if (cached) return JSON.parse(cached) as Message[];

  const branch = ctx.sessionManager.getBranch() as SessionEntry[];
  const msgs = branch
    .filter((e): e is SessionEntry & { type: "message" } => e.type === "message")
    .map((e) => e.message);
  return convertToLlm(msgs);
}

// ── Side agent via completeSimple ─────────────────────────────────────

async function runSideAgent(
  question: string,
  ctx: ExtensionCommandContext,
  signal: AbortSignal,
): Promise<{ answer: string } | { error: string } | { aborted: true }> {
  if (!ctx.model) return { error: "No active model" };

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) {
    return { error: `Model auth failed: ${auth.error ?? "no API key"}` };
  }

  const history = store().histories.get(sessionKey(ctx)) ?? [];
  const conversation = snapshotConversation(ctx);

  const historyMsgs: Message[] = history.flatMap((h) => [
    { role: "user" as const, content: [{ type: "text" as const, text: h.question }], timestamp: 0 },
    { role: "assistant" as const, content: [{ type: "text" as const, text: h.answer }], timestamp: 0 },
  ]);

  const userMsg: UserMessage = {
    role: "user",
    content: [{ type: "text", text: question }],
    timestamp: Date.now(),
  };

  const messages = [...conversation, ...historyMsgs, userMsg];

  try {
    const response = await completeSimple(
      ctx.model,
      { systemPrompt: BTW_SYSTEM_PROMPT, messages, tools: [] },
      { apiKey: auth.apiKey, headers: auth.headers, signal },
    );

    if (response.stopReason === "aborted") return { aborted: true };
    if (response.stopReason === "error") {
      return { error: `Call failed: ${response.errorMessage ?? "unknown"}` };
    }

    const answer = (response.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
      .trim();

    return answer ? { answer } : { error: "Empty response" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (signal.aborted) return { aborted: true };
    return { error: `Call threw: ${msg}` };
  }
}

// ── Overlay component ────────────────────────────────────────────────

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

  setAnswer(text: string): void { this.mode = "answer"; this.answer = text; }
  setError(msg: string): void { this.mode = "error"; this.error = msg; }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) { this.controller.abort(); this.done(); return; }
    if (matchesKey(data, "up")) { this.scrollOffset = Math.max(0, this.scrollOffset - 1); return; }
    if (matchesKey(data, "down")) { this.scrollOffset += 1; return; }
    if (data === "x") { this.history = []; this.onClear(); this.scrollOffset = 0; return; }
  }

  render(width: number): string[] {
    const th = this.theme;
    const pad = "  ";

    // Banner
    const qTrunc = truncateToWidth(`/btw ${this.question}`, width - pad.length, "…");
    const padded = pad + qTrunc + " ".repeat(Math.max(0, width - visibleLen(pad + qTrunc)));
    const banner = th.bg("customMessageBg", th.fg("customMessageText", padded));

    // History
    const histLines = this.history.map((h) =>
      `${pad}${th.fg("accent", "/btw")} ${th.fg("muted", truncateToWidth(h.question.replace(/\s+/g, " "), width - pad.length - 6, "…"))}`,
    );

    // Echo
    const echo = `${pad}${th.fg("accent", "/btw")} ${th.fg("muted", truncateToWidth(this.question.replace(/\s+/g, " "), width - pad.length - 6, "…"))}`;

    // Answer body
    const aPad = "    ";
    const bodyW = Math.max(1, width - aPad.length);
    let body: string[] = [];
    if (this.mode === "pending") {
      body = [th.fg("warning", aPad + "…")];
    } else if (this.mode === "error") {
      body = this.error.split("\n").flatMap((ln) =>
        wrapTextWithAnsi(th.fg("error", ln || " "), bodyW).map((l) => aPad + l));
    } else {
      body = this.answer.split("\n").flatMap((ln) =>
        wrapTextWithAnsi(ln || " ", bodyW).map((l) => aPad + l));
    }

    // Footer
    const parts: string[] = [];
    if (this.mode !== "pending") parts.push("↑↓ scroll");
    if (this.history.length > 0) parts.push("x clear");
    parts.push("Esc dismiss");
    const footer = `${pad}${truncateToWidth(th.fg("dim", parts.join(" · ")), width - pad.length, "…")}`;

    const lines = [banner, "", ...histLines, echo, "", ...body, "", footer];

    // Clip
    const maxRows = 30;
    if (lines.length <= maxRows) return lines;
    const excess = lines.length - maxRows;
    this.scrollOffset = Math.min(this.scrollOffset, excess);
    return lines.slice(excess - this.scrollOffset, excess - this.scrollOffset + maxRows);
  }

  invalidate(): void {}
}

function visibleLen(s: string): number {
  let len = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\x1b") { while (i < s.length && s[i] !== "m") i++; }
    else len++;
  }
  return len;
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Snapshot at end of each turn
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const branch = ctx.sessionManager.getBranch() as SessionEntry[];
    const msgs = branch
      .filter((e): e is SessionEntry & { type: "message" } => e.type === "message")
      .map((e) => e.message);
    store().snapshots.set(sessionKey(ctx), JSON.stringify(convertToLlm(msgs)));
  });

  // Invalidate on compact / tree
  pi.on("session_compact", async (_e, ctx) => store().snapshots.delete(sessionKey(ctx)));
  pi.on("session_tree", async (_e, ctx) => store().snapshots.delete(sessionKey(ctx)));

  // /btw command
  pi.registerCommand("btw", {
    description: "Ask a side question without polluting the main conversation",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) { ctx.ui.notify("/btw requires interactive mode", "error"); return; }
      const question = (args ?? "").trim();
      if (!question) { ctx.ui.notify("Usage: /btw <question>", "warning"); return; }
      if (!ctx.model) { ctx.ui.notify("/btw requires an active model", "error"); return; }

      const history = [...(store().histories.get(sessionKey(ctx)) ?? [])];
      const controller = new AbortController();

      // Resolve controller via promise for safe async access
      let resolveReady!: (c: BtwOverlay) => void;
      const ready = new Promise<BtwOverlay>((r) => { resolveReady = r; });

      const overlayPromise = ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        const ov = new BtwOverlay(question, history, theme, done, controller, () => {
          store().histories.set(sessionKey(ctx), []);
        });
        resolveReady(ov);
        return ov;
      }, { overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "85%", margin: { left: 0, right: 0, bottom: 0 } } });

      const overlay = await ready;

      // Run side agent via subprocess
      const result = await runSideAgent(question, ctx, controller.signal);

      if ("answer" in result) {
        overlay.setAnswer(result.answer);
        const hist = store().histories.get(sessionKey(ctx)) ?? [];
        hist.push({ question, answer: result.answer });
        store().histories.set(sessionKey(ctx), hist);
      } else if ("error" in result) {
        overlay.setError(result.error);
      }
      // aborted → overlay already dismissed via done()

      await overlayPromise;
    },
  });
}
