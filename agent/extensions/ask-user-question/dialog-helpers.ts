import type { QuestionData } from "./types";

export function questionHasPreview(question: QuestionData): boolean {
  return question.options.some((o) => typeof o.preview === "string" && o.preview.length > 0);
}

export function shouldShowCustomRow(question: QuestionData): boolean {
  return !question.multiSelect && !questionHasPreview(question);
}

export function totalDialogTabs(questionCount: number, showSubmit: boolean): number {
  return showSubmit ? questionCount + 1 : questionCount;
}

export function isCollapseToggle(data: string): boolean {
  return data === "\x1d";
}

export function formatSubmitAnswerValue(answer: {
  kind: string;
  answer: string | null;
  selected?: string[];
}): string {
  return answer.kind === "multi" ? (answer.selected?.join(", ") ?? "") : (answer.answer ?? "");
}
