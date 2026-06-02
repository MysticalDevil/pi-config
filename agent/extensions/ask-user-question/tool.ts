/**
 * tool.ts — ask_user_question tool registration.
 *
 * Mirrors @juicesharp/rpiv-ask-user-question ask-user-question.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { QuestionnaireDialog } from "./dialog";
import { buildErrorResult, buildResponse } from "./response";
import {
  type QuestionParams,
  type QuestionnaireResult,
  QuestionParamsSchema,
  MAX_OPTIONS,
  MIN_OPTIONS,
  MAX_QUESTIONS,
} from "./types";
import { validateQuestionnaire } from "./validate";

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User Question",
    description: `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users will always be able to type a custom answer ("Type something." row is appended automatically to every single-select question) or pick "Chat about this" to abandon the questionnaire and continue in free-form conversation. Do NOT author "Other" / "Type something." / "Chat about this" labels yourself — duplicates are rejected at runtime.
- Use multiSelect: true to allow multiple answers to be selected for a question. The "Type something." row is suppressed on multi-select questions, and is ALSO suppressed on single-select questions where any option carries a \`preview\` (the side-by-side layout has no room for inline custom text — "Chat about this" remains as the free-form escape hatch).
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`,
    promptSnippet: `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`,
    promptGuidelines: [
      `Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to ${MAX_QUESTIONS} questions per invocation.`,
      `Each question MUST have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer ("Type something." row is appended automatically to single-select questions) or pick "Chat about this" to abandon the questionnaire.`,
      `Set multiSelect: true when multiple answers are valid; this suppresses the "Type something." row. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. NOTE: any non-empty preview on a single-select question ALSO suppresses the "Type something." row (no room in the side-by-side layout); "Chat about this" remains the escape hatch. If you recommend a specific option, make it the first option and append "(Recommended)" to its label.`,
      "Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
    ],
    parameters: QuestionParamsSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const typed = params as unknown as QuestionParams;
      if (!ctx.hasUI) {
        return buildErrorResult("UI not available (non-interactive mode)", {
          answers: [],
          cancelled: true,
          error: "no_ui",
        });
      }

      const validation = validateQuestionnaire(typed);
      if (!validation.ok) {
        return buildErrorResult(validation.message!, {
          answers: [],
          cancelled: true,
          error: validation.error,
        });
      }

      const result = await ctx.ui.custom<QuestionnaireResult>(
        (tui, theme, _kb, done) => {
          const dialog = new QuestionnaireDialog({
            questions: typed.questions,
            theme,
            width: (tui.terminal as { columns: number }).columns,
            done,
          });
          return dialog;
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "bottom-center",
            width: "100%",
            maxHeight: "100%",
            margin: { left: 0, right: 0, bottom: 0 },
          },
        },
      );

      return buildResponse(result);
    },

    renderCall(args, theme, _context) {
      const qs = Array.isArray(args.questions)
        ? (args.questions as Array<{ header?: string }>)
        : [];
      if (qs.length === 0)
        return new Text(
          theme.fg("toolTitle", theme.bold("ask ")) + theme.fg("error", "(no questions)"),
          0,
          0,
        );
      const headers = qs.map((q) => q.header || "?").join(", ");
      return new Text(
        theme.fg("toolTitle", theme.bold("ask ")) + theme.fg("accent", headers),
        0,
        0,
      );
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as
        | {
            answers?: Array<{ kind: string; question: string; answer: string | null }>;
            cancelled?: boolean;
            error?: string;
          }
        | undefined;
      if (!details) return new Text(theme.fg("muted", "…"), 0, 0);
      if (details.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      const answers = details.answers ?? [];
      const summary = answers
        .map((a) => {
          const icon =
            a.kind === "chat" ? "💬" : a.kind === "custom" ? "✏️" : a.kind === "multi" ? "☑" : "✓";
          const q = a.question.length > 50 ? a.question.slice(0, 47) + "…" : a.question;
          return `${icon} ${q} = ${a.answer ?? "(multi)"}`;
        })
        .join("\n");
      return new Text(
        theme.fg("success", `✓ ${answers.length} answered\n`) + theme.fg("muted", summary),
        0,
        0,
      );
    },
  });
}
