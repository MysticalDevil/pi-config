/**
 * Project Trust Bypass for project-independent CLI commands.
 *
 * Pi's built-in package/config command path may ask "Trust directory?" whenever
 * the current directory has trust-gated project inputs. That is correct for
 * commands that may read or mutate project-local settings/packages, but it is
 * noisy for self-update commands that are documented as updating Pi only.
 *
 * For documented self-update commands, decline project trust for this process so
 * they do not prompt. Users can still pass `--approve` to include project-local
 * inputs, or `--no-approve` for Pi's explicit built-in bypass.
 */

import type { ExtensionAPI, ProjectTrustEventResult } from "@earendil-works/pi-coding-agent";
import { shouldDeclineProjectTrustForCliCommand } from "./lib/project-trust-bypass-helpers.ts";

export default function (pi: ExtensionAPI) {
  pi.on("project_trust", async (): Promise<ProjectTrustEventResult> => {
    if (shouldDeclineProjectTrustForCliCommand(process.argv)) {
      return { trusted: "no" };
    }

    return { trusted: "undecided" };
  });
}
