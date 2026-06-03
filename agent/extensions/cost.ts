/**
 * /cost - Cost & Usage Tracking (like Claude Code's /cost)
 *
 * Tracks token usage, cost, and context window usage across the session.
 * Shows detailed breakdown by model, per-turn stats, and cumulative totals.
 *
 * Usage:
 *   /cost              — show cumulative session cost/usage
 *   /cost --detail     — show per-turn breakdown
 *   /cost --watch      — toggle live cost widget in footer
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

interface TurnStats {
  turnIndex: number;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

export interface AssistantUsageStats {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

export function getAssistantUsageStats(msg: AssistantMessage): AssistantUsageStats {
  const usage = msg.usage;
  return {
    model: msg.responseModel ?? msg.model,
    inputTokens: usage.input ?? 0,
    outputTokens: usage.output ?? 0,
    cacheReadTokens: usage.cacheRead ?? 0,
    cacheWriteTokens: usage.cacheWrite ?? 0,
    cost: usage.cost?.total ?? 0,
  };
}

interface SessionCostData {
  turns: TurnStats[];
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
  startedAt: number;
}

export default function (pi: ExtensionAPI) {
  let stats: SessionCostData = {
    turns: [],
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalCost: 0,
    startedAt: Date.now(),
  };

  let showWidget = false;

  function formatTokens(t: number): string {
    if (t >= 1_000_000) return `${(t / 1_000_000).toFixed(1)}M`;
    if (t >= 1_000) return `${(t / 1_000).toFixed(1)}K`;
    return t.toString();
  }

  function formatCost(c: number): string {
    if (c >= 1) return `$${c.toFixed(2)}`;
    if (c >= 0.01) return `${(c * 100).toFixed(1)}¢`;
    return `${(c * 100).toFixed(3)}¢`;
  }

  function persistState(): void {
    pi.appendEntry("cost-data", stats);
  }

  function updateWidget(ctx: ExtensionContext): void {
    if (!showWidget) {
      ctx.ui.setStatus("cost", undefined);
      return;
    }

    const usage = ctx.getContextUsage();
    const ctxTokens = usage?.tokens ?? 0;
    const ctxPct = usage && usage.limit ? ((ctxTokens / usage.limit) * 100).toFixed(0) : "?";

    const line = [
      ctx.ui.theme.fg("accent", `📊 ${stats.turns.length}t`),
      ctx.ui.theme.fg("muted", `↓${formatTokens(stats.totalInput)}`),
      ctx.ui.theme.fg("muted", `↑${formatTokens(stats.totalOutput)}`),
      `💵 ${formatCost(stats.totalCost)}`,
      ctx.ui.theme.fg("dim", `ctx:${ctxPct}%`),
    ].join(" ");

    ctx.ui.setStatus("cost", line);
  }

  // Track turns
  pi.on("turn_start", async (event) => {
    stats.turns.push({
      turnIndex: event.turnIndex,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
    });
  });

  // Capture usage from assistant messages
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const msg = event.message as AssistantMessage;
    const usage = msg.usage;
    if (!usage) return;

    const usageStats = getAssistantUsageStats(msg);

    // Update current turn
    const currentTurn = stats.turns[stats.turns.length - 1];
    if (currentTurn) {
      currentTurn.inputTokens += usageStats.inputTokens;
      currentTurn.outputTokens += usageStats.outputTokens;
      currentTurn.cacheReadTokens += usageStats.cacheReadTokens;
      currentTurn.cacheWriteTokens += usageStats.cacheWriteTokens;
      currentTurn.cost += usageStats.cost;
      currentTurn.model = usageStats.model;
    }

    // Update totals
    stats.totalInput += usageStats.inputTokens;
    stats.totalOutput += usageStats.outputTokens;
    stats.totalCacheRead += usageStats.cacheReadTokens;
    stats.totalCacheWrite += usageStats.cacheWriteTokens;
    stats.totalCost += usageStats.cost;

    persistState();
    updateWidget(ctx);
  });

  // Restore state on session start
  function restoreCostData(entries: Array<{ type: string; customType?: string; data?: unknown }>) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === "cost-data") {
        const data = entry.data as SessionCostData | undefined;
        if (data) {
          stats = data;
          return;
        }
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    restoreCostData(ctx.sessionManager.getEntries());
    updateWidget(ctx);
  });

  // Update widget on tree navigation
  pi.on("session_tree", async (_event, ctx) => {
    restoreCostData(ctx.sessionManager.getBranch());
    updateWidget(ctx);
  });

  // Update widget on model change
  pi.on("model_select", async (_event, ctx) => {
    updateWidget(ctx);
  });

  // /cost command
  pi.registerCommand("cost", {
    description: "Show session cost and token usage (usage: /cost [--detail] [--watch])",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/);
      const detail = tokens.includes("--detail");

      if (tokens.includes("--watch")) {
        showWidget = !showWidget;
        ctx.ui.notify(showWidget ? "Cost widget enabled (footer)" : "Cost widget disabled", "info");
        updateWidget(ctx);
        return;
      }

      if (!ctx.hasUI) return;

      const usage = ctx.getContextUsage();
      const ctxTokens = usage?.tokens ?? 0;
      const ctxLimit = usage?.limit ?? 0;

      const lines: string[] = [];
      lines.push("");
      lines.push(ctx.ui.theme.fg("accent", ctx.ui.theme.bold(" Session Cost & Usage ")));
      lines.push(ctx.ui.theme.fg("borderMuted", "─".repeat(45)));
      lines.push("");

      // Summary
      lines.push(ctx.ui.theme.bold("Cumulative:"));
      lines.push(`  Input:     ${formatTokens(stats.totalInput).padStart(8)} tokens`);
      lines.push(`  Output:    ${formatTokens(stats.totalOutput).padStart(8)} tokens`);
      if (stats.totalCacheRead > 0) {
        lines.push(`  Cache Read:  ${formatTokens(stats.totalCacheRead).padStart(6)} tokens`);
      }
      if (stats.totalCacheWrite > 0) {
        lines.push(`  Cache Write: ${formatTokens(stats.totalCacheWrite).padStart(6)} tokens`);
      }
      lines.push(
        `  Total:     ${formatTokens(stats.totalInput + stats.totalOutput).padStart(8)} tokens`,
      );
      lines.push(`  Cost:      ${formatCost(stats.totalCost).padStart(8)}`);
      lines.push(`  Turns:     ${stats.turns.length.toString().padStart(8)}`);
      lines.push("");

      // Context window
      if (ctxLimit > 0) {
        const pct = ((ctxTokens / ctxLimit) * 100).toFixed(1);
        const barLen = Math.min(30, Math.round((ctxTokens / ctxLimit) * 30));
        const bar = "█".repeat(barLen) + "░".repeat(30 - barLen);
        const color =
          ctxTokens / ctxLimit > 0.8 ? "warning" : ctxTokens / ctxLimit > 0.5 ? "accent" : "muted";
        lines.push(ctx.ui.theme.bold("Context Window:"));
        lines.push(
          `  ${ctx.ui.theme.fg(color, bar)} ${formatTokens(ctxTokens)}/${formatTokens(ctxLimit)} (${pct}%)`,
        );
        lines.push("");
      }

      // Per-turn detail
      if (detail && stats.turns.length > 0) {
        lines.push(ctx.ui.theme.bold("Per Turn:"));
        lines.push("");
        lines.push(
          `  ${"Turn".padEnd(6)} ${"Input".padStart(8)} ${"Output".padStart(8)} ${"Cost".padStart(8)} ${"Model"}`,
        );
        lines.push(
          `  ${"────".padEnd(6)} ${"─────".padStart(8)} ${"──────".padStart(8)} ${"────".padStart(8)} ${"─────"}`,
        );
        for (const turn of stats.turns.slice(-10)) {
          const model = turn.model ? turn.model.slice(0, 20) : "?";
          lines.push(
            `  #${String(turn.turnIndex).padEnd(4)} ${formatTokens(turn.inputTokens).padStart(8)} ${formatTokens(turn.outputTokens).padStart(8)} ${formatCost(turn.cost).padStart(8)} ${model}`,
          );
        }
      }

      // Show in custom UI with scroll support
      let scrollOffset = 0;

      await ctx.ui.custom((tui, _theme, _kb, done) => {
        return {
          render(_width: number) {
            const availHeight = Math.max(
              5,
              ((tui as unknown as { getHeight?: () => number }).getHeight?.() ?? 40) - 2,
            );
            const maxScroll = Math.max(0, lines.length - availHeight);
            if (scrollOffset > maxScroll) scrollOffset = maxScroll;
            if (scrollOffset < 0) scrollOffset = 0;

            if (lines.length <= availHeight) {
              return lines;
            }

            const visible = lines.slice(scrollOffset, scrollOffset + availHeight);
            const pct = maxScroll > 0 ? `${Math.round((scrollOffset / maxScroll) * 100)}%` : "ALL";
            return [
              ...visible,
              _theme.fg("dim", `── ${pct} — ↑↓ PgUp PgDn Home End — Esc/Enter to close`),
            ];
          },
          invalidate() {},
          handleInput(data: string) {
            if (data === "\x1b" || data === "\r") {
              done(undefined);
              return;
            }
            // Scroll controls
            if (data === "\x1b[A" || data === "k") {
              // Up
              scrollOffset = Math.max(0, scrollOffset - 1);
              tui.requestRender();
              return;
            }
            if (data === "\x1b[B" || data === "j") {
              // Down
              scrollOffset++;
              tui.requestRender();
              return;
            }
            if (data === "\x1b[5~") {
              // PageUp
              scrollOffset = Math.max(0, scrollOffset - 10);
              tui.requestRender();
              return;
            }
            if (data === "\x1b[6~") {
              // PageDown
              scrollOffset += 10;
              tui.requestRender();
              return;
            }
            if (data === "\x1b[H" || data === "g") {
              // Home
              scrollOffset = 0;
              tui.requestRender();
              return;
            }
            if (data === "\x1b[F" || data === "G") {
              // End
              scrollOffset = Infinity; // clamped in render
              tui.requestRender();
              return;
            }
          },
        };
      });
    },
  });
}
