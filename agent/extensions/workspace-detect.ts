/**
 * Workspace Detection — Auto-detect project tooling and inject context
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectAll, formatContext, type ProjectInfo } from "./lib/project-detect";

let workspaceContext = "";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const info = detectAll(ctx.cwd);
    workspaceContext = formatContext(info);
    if (workspaceContext) {
      ctx.ui.setStatus(
        "workspace",
        ctx.ui.theme.fg(
          "dim",
          info.languages.length > 0 && info.languages[0] !== "unknown"
            ? "📁 " +
                info.languages.join("/") +
                (info.packageManager ? " (" + info.packageManager + ")" : "")
            : "📁 generic project",
        ),
      );
    }
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!workspaceContext) return;
    return {
      systemPrompt: event.systemPrompt + "\n\n<workspace>\n" + workspaceContext + "\n</workspace>",
    };
  });
}
