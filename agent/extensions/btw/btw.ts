/**
 * btw.ts — /btw side-agent core: conversation snapshot, history,
 * in-process model call with reasoning suppressed.
 *
 * The side agent uses complete() with reasoning: "off" to prevent
 * DSML/reasoning output from leaking into the UI. History is process-scoped
 * via globalThis; snapshots are captured at message_end and invalidated on
 * compact/tree navigation.
 */

import { complete, type Message, type UserMessage } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { type BtwHistoryEntry, type BtwOverlay, showBtwOverlay } from "./btw-ui.js";

// ── System prompt (loaded at module init) ─────────────────────────────

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BTW_SYSTEM_PROMPT = readFileSync(
  fileURLToPath(new URL("./prompts/btw-system.txt", import.meta.url)),
  "utf-8",
).trimEnd();

// ── Global state ──────────────────────────────────────────────────────

const STORE_KEY = Symbol.for("pi-btw");

interface BtwStore {
  histories: Map<string, BtwHistoryEntry[]>;
  snapshots: Map<string, Message[]>;
}

function store(): BtwStore {
  const g = globalThis as unknown as Record<symbol, BtwStore | undefined>;
  if (!g[STORE_KEY]) g[STORE_KEY] = { histories: new Map(), snapshots: new Map() };
  return g[STORE_KEY]!;
}

function sessionKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile() ?? `:${ctx.sessionManager.getSessionId()}`;
}

// ── Snapshot ──────────────────────────────────────────────────────────

function snapshotConversation(ctx: ExtensionContext): Message[] {
  const cached = store().snapshots.get(sessionKey(ctx));
  if (cached) return cached;
  // Cold start: read live branch
  const branch = ctx.sessionManager.getBranch() as SessionEntry[];
  const msgs = branch
    .filter((e): e is SessionEntry & { type: "message" } => e.type === "message")
    .map((e) => e.message);
  return convertToLlm(msgs);
}

// ── Side agent call ───────────────────────────────────────────────────

async function runSideAgent(
  question: string,
  ctx: ExtensionCommandContext,
  overlay: BtwOverlay,
  signal: AbortSignal,
): Promise<void> {
  if (!ctx.model) {
    overlay.setError("No active model");
    return;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) {
    overlay.setError(`Auth failed: ${auth.error ?? "no API key"}`);
    return;
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

  try {
    const response = await complete(
      ctx.model,
      { systemPrompt: BTW_SYSTEM_PROMPT, messages: [...conversation, ...historyMsgs, userMsg] },
      { apiKey: auth.apiKey, headers: auth.headers, signal, reasoning: "off" },
    );

    if (signal.aborted) return;

    if (response.stopReason === "error") {
      overlay.setError(`Call failed: ${response.errorMessage ?? "unknown"}`);
      return;
    }

    const answer = (response.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text!)
      .join("\n")
      .trim();

    if (!answer) {
      overlay.setError("Empty response");
      return;
    }

    overlay.finalizeAnswer();
    store().histories.set(sessionKey(ctx), [...history, { question, answer }]);
  } catch (err) {
    if (signal.aborted) return;
    overlay.setError(`Call threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Hooks ─────────────────────────────────────────────────────────────

export function registerMessageEndSnapshot(pi: ExtensionAPI): void {
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const branch = ctx.sessionManager.getBranch() as SessionEntry[];
    const msgs = branch
      .filter((e): e is SessionEntry & { type: "message" } => e.type === "message")
      .map((e) => e.message);
    store().snapshots.set(sessionKey(ctx), convertToLlm(msgs));
  });
}

export function registerInvalidationHooks(pi: ExtensionAPI): void {
  pi.on("session_compact", async (_e, ctx) => store().snapshots.delete(sessionKey(ctx)));
  pi.on("session_tree", async (_e, ctx) => store().snapshots.delete(sessionKey(ctx)));
}

// ── Command ───────────────────────────────────────────────────────────

export function registerBtwCommand(pi: ExtensionAPI): void {
  pi.registerCommand("btw", {
    description: "Ask a side question without polluting the main conversation",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) { ctx.ui.notify("/btw requires interactive mode", "error"); return; }
      const question = (args ?? "").trim();
      if (!question) { ctx.ui.notify("Usage: /btw <question>", "warning"); return; }
      if (!ctx.model) { ctx.ui.notify("/btw requires an active model", "error"); return; }

      const history = [...(store().histories.get(sessionKey(ctx)) ?? [])];
      const controller = new AbortController();

      const { overlayPromise, overlay } = showBtwOverlay({
        ctx,
        question,
        history,
        controller,
        onClear: () => store().histories.set(sessionKey(ctx), []),
      });

      // Wait for overlay to be ready, then fire the side agent call
      const ov = await overlay;
      await runSideAgent(question, ctx, ov, controller.signal);
      await overlayPromise;
    },
  });
}
