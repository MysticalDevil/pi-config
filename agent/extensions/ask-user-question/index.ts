/**
 * ask-user-question — Structured questionnaire tool for Pi Agent.
 *
 * Entry point. Registers the ask_user_question tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserQuestionTool } from "./tool.ts";

export default function (pi: ExtensionAPI): void {
  registerAskUserQuestionTool(pi);
}
