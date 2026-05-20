/**
 * /btw (By The Way) Extension
 *
 * 在 Agent 工作过程中随时追加补充说明/上下文。
 * 类似于 Claude 的中途追加功能。
 *
 * 使用方式:
 *   /btw 记得也要检查错误处理
 *   /btw 优先使用 async/await 而不是 .then()
 *   /btw --silent 这个文件暂时跳过
 *
 * 行为:
 *   - 默认: 将消息作为 steer 注入（当前工具执行完后立即处理）
 *   - --follow: 等待当前完整轮次结束后再注入
 *   - --silent: 注入但不显示在对话中（仅作为隐藏上下文）
 *   - --system: 追加到 system prompt 仅用于下一轮
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("btw", {
    description:
      "Append extra context/instructions mid-conversation (usage: /btw [--follow|--silent|--system] <message>)",
    handler: async (args, ctx) => {
      let text = args.trim();

      if (!text) {
        ctx.ui.notify("Usage: /btw [--follow|--silent|--system] <message>", "error");
        return;
      }

      // Parse flags
      let mode: "steer" | "followUp" = "steer";
      let silent = false;
      let systemOnly = false;

      const tokens = text.split(/\s+/);
      const flags: string[] = [];
      while (tokens[0]?.startsWith("--")) {
        flags.push(tokens.shift()!);
      }
      text = tokens.join(" ");

      if (!text) {
        ctx.ui.notify("Message required after flags", "error");
        return;
      }

      if (flags.includes("--follow")) mode = "followUp";
      if (flags.includes("--silent")) silent = true;
      if (flags.includes("--system")) systemOnly = true;

      // Check if agent is currently running
      const isStreaming = !ctx.isIdle() || ctx.hasPendingMessages();

      if (systemOnly) {
        // Inject as a one-time system prompt append for next turn
        pi.sendMessage(
          {
            customType: "btw-system-hint",
            content: `[BTW] ${text}`,
            display: !silent,
          },
          { deliverAs: mode, triggerTurn: !isStreaming },
        );
        ctx.ui.notify(`BTW (system): ${text.slice(0, 60)}${text.length > 60 ? "..." : ""}`, "info");
        return;
      }

      // Send as user message (appears as if user typed it)
      if (!isStreaming) {
        // Agent idle: send directly with a btw prefix
        pi.sendUserMessage([{ type: "text", text: `💡 BTW: ${text}` }]);
      } else {
        // Agent streaming: queue with specified delivery mode
        pi.sendUserMessage([{ type: "text", text: `💡 BTW: ${text}` }], { deliverAs: mode });
      }

      const modeLabel = mode === "steer" ? "立即" : "本轮后";
      const display = silent ? " (silent)" : "";
      ctx.ui.notify(
        `BTW${display} [${modeLabel}]: ${text.slice(0, 60)}${text.length > 60 ? "..." : ""}`,
        "info",
      );
    },
  });
}
