/**
 * btw.ts — /btw side-question slash command.
 *
 * Mirrors @juicesharp/rpiv-btw btw.ts exactly.
 * Asks the same primary model a one-off side question using the cloned primary
 * conversation as context. Answer rendered in a bottom-slot overlay (never
 * enters main agent's messages). History persists per-session via globalThis.
 *
 * Fix over rpiv-btw: DSML stripping in btw-ui.ts setAnswer().
 */

import { completeSimple, type AssistantMessage, type Message, type StopReason, type UserMessage } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { showBtwOverlay } from "./btw-ui.js";

// ── System prompt ─────────────────────────────────────────────────────

const BTW_SYSTEM_PROMPT = [
  "You are a concise side assistant. The user is mid-task with a coding agent and needs a quick answer.",
  "",
  "Rules:",
  "1. Answer in plain text — you have no tools.",
  "2. Keep responses brief and actionable.",
  "3. Reference the main conversation context when relevant.",
  "4. Use markdown for code blocks and links.",
  "5. Do NOT output DSML, XML, or tool-call markup.",
].join("\n");

// ── Types ─────────────────────────────────────────────────────────────

export interface BtwTurn {
  userMessage: UserMessage;
  assistantMessage: AssistantMessage;
}

interface BtwState {
  histories: Map<string, BtwTurn[]>;
  snapshots: Map<string, { messages: Message[] }>;
}

export interface BtwExecResult {
  ok: boolean;
  answer?: string;
  userMessage?: UserMessage;
  assistantMessage?: AssistantMessage;
  error?: string;
  stopReason?: StopReason;
  aborted?: boolean;
}

// ── Storage ───────────────────────────────────────────────────────────

const BTW_STATE_KEY = Symbol.for("rpiv-btw");

function getState(): BtwState {
  const g = globalThis as unknown as Record<symbol, BtwState | undefined>;
  let state = g[BTW_STATE_KEY];
  if (!state) {
    state = { histories: new Map(), snapshots: new Map() };
    g[BTW_STATE_KEY] = state;
  }
  return state;
}

function getSessionFile(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile() ?? `:${ctx.sessionManager.getSessionId()}`;
}

function getSessionHistory(ctx: ExtensionContext): Array<{ question: string; answer: string }> {
  const turns = getState().histories.get(getSessionFile(ctx)) ?? [];
  return turns.map((t) => ({
    question: typeof t.userMessage.content === "string"
      ? t.userMessage.content
      : t.userMessage.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n"),
    answer: t.assistantMessage.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text).join("\n"),
  }));
}

function pushSessionTurn(ctx: ExtensionContext, turn: BtwTurn): void {
  const key = getSessionFile(ctx);
  const state = getState();
  let turns = state.histories.get(key);
  if (!turns) { turns = []; state.histories.set(key, turns); }
  turns.push(turn);
}

export function clearSessionHistory(ctx: ExtensionContext): void {
  getState().histories.set(getSessionFile(ctx), []);
}

function getSnapshot(ctx: ExtensionContext): Message[] | undefined {
  return getState().snapshots.get(getSessionFile(ctx))?.messages;
}

function setSnapshot(ctx: ExtensionContext, messages: Message[]): void {
  getState().snapshots.set(getSessionFile(ctx), { messages });
}

export function invalidateSnapshot(ctx: ExtensionContext): void {
  getState().snapshots.delete(getSessionFile(ctx));
}

// ── Conversation context ───────────────────────────────────────────────

function readBranchMessages(ctx: ExtensionContext): Message[] {
  const cached = getSnapshot(ctx);
  if (cached) return cached;
  const branch = ctx.sessionManager.getBranch() as SessionEntry[];
  const agentMessages = branch
    .filter((e): e is SessionEntry & { type: "message" } => e.type === "message")
    .map((e) => e.message);
  return convertToLlm(agentMessages);
}

function buildBtwMessages(ctx: ExtensionContext, userMessage: UserMessage): Message[] {
  const branchMessages = readBranchMessages(ctx);
  const key = getSessionFile(ctx);
  const turns = getState().histories.get(key) ?? [];
  const historyMessages: Message[] = turns.flatMap((h) => [h.userMessage, h.assistantMessage]);
  return [...branchMessages, ...historyMessages, userMessage];
}

// ── Side agent call ───────────────────────────────────────────────────

export async function executeBtw(
  question: string,
  ctx: ExtensionContext,
  controller: AbortController,
): Promise<BtwExecResult> {
  const model = ctx.model;
  if (!model) return { ok: false, error: "/btw requires an active model" };

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return { ok: false, error: `Model misconfigured: ${auth.error}` };
  if (!auth.apiKey) return { ok: false, error: "No API key available" };

  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: question }],
    timestamp: Date.now(),
  };
  const messages = buildBtwMessages(ctx, userMessage);

  try {
    const response = await completeSimple(
      model,
      { systemPrompt: BTW_SYSTEM_PROMPT, messages, tools: [] },
      { apiKey: auth.apiKey, headers: auth.headers, signal: controller.signal },
    );

    if (response.stopReason === "aborted") {
      return { ok: false, aborted: true };
    }
    if (response.stopReason === "error") {
      return { ok: false, error: response.errorMessage ?? "unknown", stopReason: response.stopReason };
    }

    const answerText = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("\n")
      .trim();

    if (!answerText) return { ok: false, error: "Empty response" };

    return { ok: true, answer: answerText, userMessage, assistantMessage: response, stopReason: response.stopReason };
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, aborted: true };
    return { ok: false, error: String(err) };
  }
}

// ── Hooks ─────────────────────────────────────────────────────────────

export function registerMessageEndSnapshot(pi: ExtensionAPI): void {
  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;
    const branch = ctx.sessionManager.getBranch() as SessionEntry[];
    const agentMessages = branch
      .filter((e): e is SessionEntry & { type: "message" } => e.type === "message")
      .map((e) => e.message);
    setSnapshot(ctx, convertToLlm(agentMessages));
  });
}

export function registerInvalidationHooks(pi: ExtensionAPI): void {
  pi.on("session_compact", async (_e, ctx) => invalidateSnapshot(ctx));
  pi.on("session_tree", async (_e, ctx) => invalidateSnapshot(ctx));
}

// ── Command handler ───────────────────────────────────────────────────

export function registerBtwCommand(pi: ExtensionAPI): void {
  pi.registerCommand("btw", {
    description: "Ask a side question without polluting the main conversation",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) { ctx.ui.notify("/btw requires interactive mode", "error"); return; }
      const question = args.trim();
      if (!question) { ctx.ui.notify("Usage: /btw <question>", "warning"); return; }
      if (!ctx.model) { ctx.ui.notify("/btw requires an active model", "error"); return; }

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

      if (result.ok && result.answer && result.userMessage && result.assistantMessage) {
        overlayCtl.setAnswer(result.answer);
        pushSessionTurn(ctx, {
          userMessage: result.userMessage,
          assistantMessage: result.assistantMessage,
        });
      } else if (result.aborted) {
        // user pressed Esc — overlay already dismissed
      } else if (result.error) {
        overlayCtl.setError(result.error);
      }

      await overlayPromise;
    },
  });
}
