/**
 * /btw — Side-agent Q&A extension.
 *
 * Entry point. Registers the /btw command, conversation snapshot hook,
 * and compaction/tree invalidation hooks.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBtwCommand, registerInvalidationHooks, registerMessageEndSnapshot } from "./btw";

export default function (pi: ExtensionAPI): void {
  registerBtwCommand(pi);
  registerMessageEndSnapshot(pi);
  registerInvalidationHooks(pi);
}
