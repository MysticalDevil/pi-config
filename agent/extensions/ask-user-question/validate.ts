/**
 * validate.ts — Input validation for ask_user_question.
 *
 * Mirrors @juicesharp/rpiv-ask-user-question tool/validate-questionnaire.ts.
 */

import { type QuestionParams, RESERVED_LABELS, MAX_QUESTIONS } from "./types";

interface Validation {
  ok: boolean;
  error?:
    | "no_questions"
    | "empty_options"
    | "too_many_questions"
    | "duplicate_question"
    | "duplicate_option_label"
    | "reserved_label";
  message?: string;
}

export function validateQuestionnaire(params: QuestionParams): Validation {
  if (!params.questions || params.questions.length === 0) {
    return { ok: false, error: "no_questions", message: "No questions provided" };
  }
  if (params.questions.length > MAX_QUESTIONS) {
    return {
      ok: false,
      error: "too_many_questions",
      message: `At most ${MAX_QUESTIONS} questions allowed`,
    };
  }

  const seenQuestions = new Set<string>();
  for (let qi = 0; qi < params.questions.length; qi++) {
    const q = params.questions[qi];

    // Duplicate question text
    const qKey = q.question.trim().toLowerCase();
    if (seenQuestions.has(qKey)) {
      return {
        ok: false,
        error: "duplicate_question",
        message: `Duplicate question at index ${qi}`,
      };
    }
    seenQuestions.add(qKey);

    // Empty options
    if (!q.options || q.options.length < 2) {
      return {
        ok: false,
        error: "empty_options",
        message: `Question ${qi} has fewer than 2 options`,
      };
    }

    // Duplicate or reserved option labels
    const seenLabels = new Set<string>();
    for (const opt of q.options) {
      const label = opt.label.trim();
      if (seenLabels.has(label)) {
        return {
          ok: false,
          error: "duplicate_option_label",
          message: `Duplicate label "${label}" in question ${qi}`,
        };
      }
      if (RESERVED_LABELS.has(label)) {
        return {
          ok: false,
          error: "reserved_label",
          message: `Reserved label "${label}" in question ${qi}`,
        };
      }
      seenLabels.add(label);
    }
  }

  return { ok: true };
}
