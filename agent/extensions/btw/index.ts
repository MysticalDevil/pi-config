/**
 * /btw — Side-conversation extension (fork-based).
 *
 * Entry point. Registers the /btw command that forks the current
 * session, injects a boundary prompt, runs the side question in
 * an ephemeral fork, and renders the answer in a bottom-slot overlay.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBtwCommand } from "./btw";

export default function (pi: ExtensionAPI): void {
  registerBtwCommand(pi);
}
