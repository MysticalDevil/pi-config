/**
 * Confirm Destructive Actions Extension
 *
 * Prompts for confirmation before destructive session actions (clear, switch, branch).
 * Demonstrates how to cancel session events using the before_* events.
 */

import type {
  ExtensionAPI,
  SessionBeforeSwitchEvent,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_before_switch", async (event: SessionBeforeSwitchEvent, ctx) => {
    if (!ctx.hasUI) return;

    if (event.reason === "new") {
      const confirmed = await ctx.ui.confirm(
        "Clear session?",
        "This will delete all messages in the current session.",
      );

      if (!confirmed) {
        ctx.ui.notify("Clear cancelled", "info");
        return { cancel: true };
      }
      return;
    }

    // reason === "resume" - check if there are agent responses or tool results
    const entries = ctx.sessionManager.getEntries();
    const hasAgentActivity = entries.some(
      (e): e is SessionMessageEntry =>
        e.type === "message" && (e.message.role === "assistant" || e.message.role === "toolResult"),
    );

    if (hasAgentActivity) {
      const confirmed = await ctx.ui.confirm(
        "Switch session?",
        "The current session has agent activity. Switch anyway?",
      );

      if (!confirmed) {
        ctx.ui.notify("Switch cancelled", "info");
        return { cancel: true };
      }
    }
  });

  pi.on("session_before_fork", async (event, ctx) => {
    if (!ctx.hasUI) return;

    const confirmed = await ctx.ui.confirm(
      "Create fork?",
      `Fork the session from entry ${event.entryId.slice(0, 8)}?`,
    );

    if (!confirmed) {
      ctx.ui.notify("Fork cancelled", "info");
      return { cancel: true };
    }
  });
}
