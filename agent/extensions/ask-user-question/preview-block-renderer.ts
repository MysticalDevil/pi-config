/**
 * preview-block-renderer.ts — Renders the bordered markdown preview block for a single
 * question. Owns a per-question MarkdownContentCache.
 *
 * Ported from @juicesharp/rpiv-ask-user-question view/components/preview/preview-block-renderer.ts
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { QuestionData } from "./types";
import {
  MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE,
  MAX_PREVIEW_HEIGHT_STACKED,
  MarkdownContentCache,
  NOTES_AFFORDANCE_OVERHEAD,
} from "./markdown-content-cache";
import {
  BORDER_HORIZONTAL_OVERHEAD,
  BORDER_INNER_PADDING_HORIZONTAL,
  BORDER_VERTICAL_OVERHEAD,
  computeBoxDimensions,
  renderBorderedBox,
} from "./preview-box-renderer";
import type { PreviewLayoutMode } from "./preview-layout-decider";

export const NOTES_AFFORDANCE_TEXT = "Notes: press n to add notes";

export interface PreviewBlockRendererConfig {
  question: QuestionData;
  theme: Theme;
  markdownTheme: MarkdownTheme;
}

/**
 * Renders the bordered markdown preview block for a single question.
 * NOT a Component — pure render-and-measure helper. The layout mode
 * is threaded as an explicit param.
 */
export class PreviewBlockRenderer {
  private readonly theme: Theme;
  private readonly cache: MarkdownContentCache;

  constructor(config: PreviewBlockRendererConfig) {
    this.theme = config.theme;
    this.cache = new MarkdownContentCache(config.question, config.theme, config.markdownTheme);
  }

  hasAnyPreview(): boolean {
    return this.cache.hasAnyPreview();
  }

  has(optionIndex: number): boolean {
    return this.cache.has(optionIndex);
  }

  invalidate(): void {
    this.cache.invalidate();
  }

  /**
   * Height contribution of the preview block.
   */
  blockHeight(width: number, optionIndex: number, mode: PreviewLayoutMode): number {
    const cap = mode === "side-by-side" ? MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE : MAX_PREVIEW_HEIGHT_STACKED;
    const contentBudget = Math.max(1, cap - BORDER_VERTICAL_OVERHEAD - NOTES_AFFORDANCE_OVERHEAD);
    const innerWidth = Math.max(1, width - BORDER_HORIZONTAL_OVERHEAD - 2 * BORDER_INNER_PADDING_HORIZONTAL);
    const rawRows = this.cache.bodyFor(optionIndex, innerWidth).length;
    const contentRows = Math.min(rawRows, contentBudget);
    return BORDER_VERTICAL_OVERHEAD + contentRows + NOTES_AFFORDANCE_OVERHEAD;
  }

  /**
   * Render the full preview block at `width`: bordered box + blank separator + affordance row.
   */
  renderBlock(
    width: number,
    optionIndex: number,
    mode: PreviewLayoutMode,
    focused: boolean,
  ): string[] {
    const cap = mode === "side-by-side" ? MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE : MAX_PREVIEW_HEIGHT_STACKED;
    const contentBudget = Math.max(1, cap - BORDER_VERTICAL_OVERHEAD - NOTES_AFFORDANCE_OVERHEAD);
    const maxInnerWidth = Math.max(1, width - BORDER_HORIZONTAL_OVERHEAD - 2 * BORDER_INNER_PADDING_HORIZONTAL);

    const raw = this.cache.bodyFor(optionIndex, maxInnerWidth);
    const truncated = raw.length > contentBudget;
    const hidden = truncated ? raw.length - contentBudget : 0;
    const contentLines = truncated ? raw.slice(0, contentBudget) : raw;

    const { boxWidth } = computeBoxDimensions(contentLines, maxInnerWidth);
    const colorFn = (s: string) => this.theme.fg("accent", s);
    const boxedLines = renderBorderedBox(contentLines, boxWidth, colorFn, hidden);

    const showAffordance = focused && this.cache.has(optionIndex);
    const affordance = showAffordance
      ? this.theme.fg("muted", NOTES_AFFORDANCE_TEXT)
      : "";
    return [...boxedLines, "", affordance];
  }
}
