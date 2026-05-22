/**
 * response.ts — Response envelope formatting for ask_user_question.
 *
 * Mirrors @juicesharp/rpiv-ask-user-question tool/response-envelope.ts
 * and tool/format-answer.ts.
 */

import type { QuestionAnswer, QuestionnaireResult } from "./types";

export function formatAnswer(answer: QuestionAnswer): string {
  switch (answer.kind) {
    case "option":
      return `User selected "${answer.answer}" for "${answer.question}"${answer.notes ? ` (note: ${answer.notes})` : ""}${answer.preview ? `\nSelected preview:\n${answer.preview}` : ""}`;
    case "custom":
      return `User typed "${answer.answer}" for "${answer.question}"`;
    case "multi":
      return `User selected [${answer.selected?.join(", ")}] for "${answer.question}"`;
    case "chat":
      return `User chose to chat about "${answer.question}" instead of selecting an option`;
  }
}

export function buildResponse(result: QuestionnaireResult): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  if (result.cancelled) {
    if (result.error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${result.error} - ${result.answers.length ? "answered " + result.answers.length + " questions" : "no answers"}`,
          },
        ],
        details: { answers: result.answers, cancelled: true, error: result.error },
      };
    }
    return {
      content: [{ type: "text", text: "User cancelled the questionnaire." }],
      details: { answers: result.answers, cancelled: true },
    };
  }

  const text =
    result.answers.length === 0
      ? "No answers provided."
      : result.answers.map(formatAnswer).join("\n\n");

  return {
    content: [
      {
        type: "text",
        text: `User has answered your questions:\n\n${text}\n\nYou can now continue with the user's answers in mind.`,
      },
    ],
    details: { answers: result.answers, cancelled: false },
  };
}

export function buildErrorResult(
  message: string,
  partial: QuestionnaireResult,
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text: message }],
    details: { answers: partial.answers, cancelled: partial.cancelled, error: partial.error },
  };
}
