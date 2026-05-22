/**
 * Model status extension - shows model changes in the status bar.
 *
 * Demonstrates the `model_select` hook which fires when the model changes
 * via /model command, Ctrl+P cycling, or session restore.
 *
 * Usage: pi -e ./model-status.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("model_select", async (event, ctx) => {
    const { model, previousModel: _, source } = event;

    // Show notification on change
    if (source !== "restore") {
      ctx.ui.notify(`Model: ${model.provider}/${model.id}`, "info");
    }

    // Update status bar with current model
    ctx.ui.setStatus("model", `🤖 ${model.id}`);
  });
}
