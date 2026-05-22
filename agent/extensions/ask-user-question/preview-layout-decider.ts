/**
 * preview-layout-decider.ts — Layout mode, column width allocation, and cross-tab
 * stability for the ask_user_question preview pane.
 *
 * Ported from @juicesharp/rpiv-ask-user-question view/components/preview/preview-layout-decider.ts
 * Adapted: uses bare string labels instead of WrappingSelectItem.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { QuestionData } from "./types";
import {
  BORDER_HORIZONTAL_OVERHEAD,
  BORDER_INNER_PADDING_HORIZONTAL,
} from "./preview-box-renderer";

/** Min terminal/pane width for the side-by-side layout to engage. */
export const PREVIEW_MIN_WIDTH = 100;
/** Visual gap between options column and preview column in side-by-side. */
export const PREVIEW_COLUMN_GAP = 2;
/** 1 col padding inside the preview column (between gap and `│`). */
export const PREVIEW_PADDING_LEFT = 1;
/** Empty rows between options and preview blocks in stacked (narrow) layout. */
export const STACKED_GAP_ROWS = 1;

/** Floor for the adaptive left column width. */
export const MIN_LEFT = 30;
/** Ceiling ratio: left column never exceeds this fraction of pane width. */
export const MAX_LEFT_RATIO = 0.5;
/** Floor for the preview column width. */
export const MIN_PREVIEW_WIDTH = 45;
/** visibleWidth(" ✔") = 2. Reserved on the longest-label measurement. */
export const CONFIRMED_OVERHEAD = 2;

export type PreviewLayoutMode = "side-by-side" | "stacked";

/**
 * Decide layout mode from terminal + pane widths.
 */
export function decideLayout(terminalWidth: number, paneWidth: number): PreviewLayoutMode {
  return terminalWidth >= PREVIEW_MIN_WIDTH && paneWidth >= PREVIEW_MIN_WIDTH
    ? "side-by-side"
    : "stacked";
}

/**
 * Compute the adaptive left column width from option labels.
 */
export function adaptiveLeftWidth(
  labels: readonly string[],
  totalForNumbering: number,
  paneWidth: number,
): number {
  const prefixW = String(Math.max(1, totalForNumbering)).length + 4;
  let maxLabel = 0;
  for (const label of labels) {
    const w = visibleWidth(label);
    if (w > maxLabel) maxLabel = w;
  }
  const desired = maxLabel + prefixW + CONFIRMED_OVERHEAD;
  const ratioCapped = Math.min(desired, Math.floor(paneWidth * MAX_LEFT_RATIO));
  const available = paneWidth - PREVIEW_COLUMN_GAP - MIN_PREVIEW_WIDTH;
  return Math.max(MIN_LEFT, Math.min(ratioCapped, Math.max(1, available)));
}

/**
 * Cross-tab maximum left-column width.
 */
export function crossTabMaxLeftWidth(
  tabs: ReadonlyArray<{ multiSelect?: boolean; labels: readonly string[] }>,
  paneWidth: number,
): number {
  let max = MIN_LEFT;
  for (const tab of tabs) {
    const totalForNumbering = tab.multiSelect ? tab.labels.length : tab.labels.length + 1;
    const tabWidth = adaptiveLeftWidth(tab.labels, totalForNumbering, paneWidth);
    if (tabWidth > max) max = tabWidth;
  }
  return max;
}

/**
 * Source-line probe: widest source line across all previews of a question.
 */
export function previewSourceWidth(question: QuestionData): number {
  let max = 0;
  for (const option of question.options) {
    const text = option.preview;
    if (!text) continue;
    for (const line of text.split("\n")) {
      const w = visibleWidth(line);
      if (w > max) max = w;
    }
  }
  return max;
}

/**
 * Cross-tab/cross-option preview budget.
 */
export function crossTabPreviewBudget(
  questions: readonly QuestionData[],
  paneWidth: number,
): number {
  let max = MIN_PREVIEW_WIDTH;
  for (const question of questions) {
    const rawWidth = previewSourceWidth(question);
    const capped = Math.min(rawWidth, paneWidth - PREVIEW_COLUMN_GAP - MIN_LEFT);
    const budget =
      capped +
      BORDER_HORIZONTAL_OVERHEAD +
      2 * BORDER_INNER_PADDING_HORIZONTAL +
      PREVIEW_PADDING_LEFT;
    if (budget > max) max = budget;
  }
  return max;
}

/**
 * Cross-tab left-column width with slack donation from narrow previews.
 */
export function crossTabLeftWidthWithDonation(
  tabs: ReadonlyArray<{ multiSelect?: boolean; labels: readonly string[] }>,
  questions: readonly QuestionData[],
  paneWidth: number,
): number {
  const labelDriven = crossTabMaxLeftWidth(tabs, paneWidth);
  if (labelDriven <= MIN_LEFT) return labelDriven;
  const previewBudget = crossTabPreviewBudget(questions, paneWidth);
  const slackDonation = paneWidth - PREVIEW_COLUMN_GAP - previewBudget;
  const ceiling = paneWidth - PREVIEW_COLUMN_GAP - MIN_PREVIEW_WIDTH;
  return Math.min(Math.max(labelDriven, slackDonation), Math.max(1, ceiling));
}

/** Shorter alias used in dialog.ts. */
export { crossTabLeftWidthWithDonation as adaptLeftWidth };

/**
 * Width allocation for side-by-side mode.
 */
export function columnWidths(
  paneWidth: number,
  adaptiveLeft: number,
): { leftWidth: number; rightWidth: number; gap: number } {
  const gap = PREVIEW_COLUMN_GAP;
  const leftWidth = Math.min(adaptiveLeft, Math.max(1, paneWidth - gap - 1));
  const rightWidth = Math.max(1, paneWidth - leftWidth - gap);
  return { leftWidth, rightWidth, gap };
}

/**
 * Returns the widths passed to option list and preview renderers.
 */
export function bodyWidths(
  paneWidth: number,
  mode: PreviewLayoutMode,
  adaptiveLeft: number,
): { optionsWidth: number; previewWidth: number } {
  if (mode === "stacked") return { optionsWidth: paneWidth, previewWidth: paneWidth };
  const { leftWidth, rightWidth } = columnWidths(paneWidth, adaptiveLeft);
  return { optionsWidth: leftWidth, previewWidth: Math.max(1, rightWidth - PREVIEW_PADDING_LEFT) };
}
