/**
 * /btw (By The Way) — Inject side-note context mid-conversation
 *
 * Like Claude Code: adds context to the current turn without
 * starting a new one. Delivered at the right time:
 *   - Default: steer (after current tool batch, before next LLM call)
 *   - --follow: wait until all tools complete
 *   - --silent: inject but don't show in chat
 *
 * Usage:
 *   /btw 记得检查错误处理
 *   /btw --follow 这里也需要测试
 *   /btw --silent 模型只需要知道这个
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("btw", {
    description:
      "Inject side-note context mid-conversation (usage: /btw [--follow|--silent] <message>)",
    handler: async (args, ctx) => {
      let text = (args ?? "").trim();

      // Parse flags
      let mode: "steer" | "followUp" = "steer";
      let silent = false;
      const tokens = text.split(/\s+/);
      const flags: string[] = [];

      while (tokens[0]?.startsWith("--")) {
        flags.push(tokens.shift()!);
      }
      text = tokens.join(" ");

      if (!text) {
        ctx.ui.notify("Usage: /btw [--follow|--silent] <message>", "error");
        return;
      }

      if (flags.includes("--follow")) mode = "followUp";
      if (flags.includes("--silent")) silent = true;

      // Inject as custom context — does NOT start a new turn
      pi.sendMessage(
        {
          customType: "btw",
          content: text,
          display: !silent,
        },
        {
          deliverAs: mode,
          triggerTurn: false,
        },
      );

      const preview = text.length > 60 ? text.slice(0, 60) + "..." : text;
      ctx.ui.notify(`BTW: ${preview}`, "info");
    },
  });
}
