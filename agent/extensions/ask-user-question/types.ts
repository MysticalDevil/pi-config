/**
 * types.ts — Schema, types, and constants for ask_user_question tool.
 *
 * Mirrors @juicesharp/rpiv-ask-user-question tool/types.ts.
 */

import { type Static, Type } from "typebox";

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;

export const OptionSchema = Type.Object({
  label: Type.String({ maxLength: MAX_LABEL_LENGTH, description: `MAX ${MAX_LABEL_LENGTH} CHARACTERS — hard limit. 1-5 words.` }),
  description: Type.String({ description: "What this choice means or its trade-offs." }),
  preview: Type.Optional(Type.String({ description: "Optional markdown shown next to this option when focused." })),
});

export const QuestionSchema = Type.Object({
  question: Type.String({ description: "Full question text, ends with '?'" }),
  header: Type.String({ maxLength: MAX_HEADER_LENGTH, description: `Max ${MAX_HEADER_LENGTH} chars chip label.` }),
  options: Type.Array(OptionSchema, { minItems: MIN_OPTIONS, maxItems: MAX_OPTIONS, description: "2-4 options." }),
  multiSelect: Type.Optional(Type.Boolean({ default: false })),
});

export const QuestionParamsSchema = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: MAX_QUESTIONS, description: "1-4 questions" }),
});

export type OptionData = Static<typeof OptionSchema>;
export type QuestionData = Static<typeof QuestionSchema>;
export type QuestionParams = Static<typeof QuestionParamsSchema>;

export interface QuestionAnswer {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "chat" | "multi";
  answer: string | null;
  selected?: string[];
  notes?: string;
  preview?: string;
}

export interface QuestionnaireResult {
  answers: QuestionAnswer[];
  cancelled: boolean;
  error?: "no_ui" | "no_questions" | "empty_options" | "too_many_questions"
    | "duplicate_question" | "duplicate_option_label" | "reserved_label";
}

export const SENTINEL_OTHER = "Type something.";
export const SENTINEL_CHAT = "Chat about this";
export const SENTINEL_NEXT = "Next →";

export const RESERVED_LABELS = new Set(["Other", SENTINEL_OTHER, SENTINEL_CHAT, SENTINEL_NEXT]);
