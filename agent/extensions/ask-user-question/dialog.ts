/**
 * dialog.ts — Custom UI component for the ask_user_question tabbed dialog.
 *
 * Handles single-select (↑↓ Enter), multi-select (Space toggle, Enter commit),
 * free-text "Type something." row, "Chat about this" cancel, and a Submit tab
 * for final review.
 */

import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  type QuestionAnswer,
  type QuestionData,
  type QuestionnaireResult,
  SENTINEL_CHAT,
  SENTINEL_NEXT,
  SENTINEL_OTHER,
} from "./types";
import { PreviewBlockRenderer } from "./preview-block-renderer";
import {
  decideLayout,
  columnWidths,
  type PreviewLayoutMode,
  PREVIEW_PADDING_LEFT,
  adaptLeftWidth,
} from "./preview-layout-decider";

interface DialogState {
  tabIndex: number;
  optionIndex: number;
  chatFocused: boolean;
  // Per-question answers
  selections: Map<number, string[]>;
  customTexts: Map<number, string>;
  chatAbandoned: Set<number>;
  // Multi-select mode tracking
  multiSelectPending: Map<number, Set<string>>;
  // Input mode: null = selecting, "custom" = typing custom text
  inputMode: { questionIndex: number; buffer: string } | null;
  // Show submit tab
  showSubmit: boolean;
  submitChoiceIndex: number;
}

interface DialogConfig {
  questions: QuestionData[];
  theme: Theme;
  width: number;
  done: (result: QuestionnaireResult) => void;
}

export class QuestionnaireDialog {
  private state: DialogState;
  private questions: QuestionData[];
  private theme: Theme;
  private done: (result: QuestionnaireResult) => void;
  private previewBlocks: Map<number, PreviewBlockRenderer>;
  /** Cross-tab max left column width, computed once on construction. */
  private adaptiveLeft: number;

  constructor(config: DialogConfig) {
    this.questions = config.questions;
    this.theme = config.theme;
    this.done = config.done;
    this.state = {
      tabIndex: 0,
      optionIndex: 0,
      chatFocused: false,
      selections: new Map(),
      customTexts: new Map(),
      chatAbandoned: new Set(),
      multiSelectPending: new Map(),
      inputMode: null,
      showSubmit: this.questions.length > 1,
      submitChoiceIndex: 0,
    };

    // Build per-question preview renderers
    const markdownTheme = getMarkdownTheme();
    this.previewBlocks = new Map();
    for (let i = 0; i < this.questions.length; i++) {
      this.previewBlocks.set(
        i,
        new PreviewBlockRenderer({
          question: this.questions[i],
          theme: this.theme,
          markdownTheme,
        }),
      );
    }

    // Compute cross-tab max adaptive left width
    this.adaptiveLeft = this.computeAdaptiveLeft(config.width);
  }

  private computeAdaptiveLeft(paneWidth: number): number {
    const tabs = this.questions.map((q) => {
      const labels = q.options.map((o) => o.label);
      const hasPreview = q.options.some(
        (o) => typeof o.preview === "string" && o.preview.length > 0,
      );
      if (!q.multiSelect && !hasPreview) labels.push(SENTINEL_OTHER);
      if (q.multiSelect) labels.push(SENTINEL_NEXT);
      return { multiSelect: q.multiSelect, labels };
    });
    return adaptLeftWidth(tabs, this.questions, paneWidth);
  }

  handleInput(data: string): void {
    if (this.state.inputMode) {
      this.handleTextInput(data);
      return;
    }

    const q = this.currentQuestion();
    const items = this.buildOptionList(q);

    if (matchesKey(data, "escape")) {
      this.done({ answers: this.collectAnswers(), cancelled: true });
      return;
    }

    if (this.state.chatFocused) {
      if (matchesKey(data, "enter")) {
        this.state.chatAbandoned.add(this.state.tabIndex);
        this.advanceOrSubmit();
        return;
      }
      if (matchesKey(data, "down")) {
        this.state.chatFocused = false;
        this.state.optionIndex = 0;
        return;
      }
      if (matchesKey(data, "up")) {
        this.state.chatFocused = false;
        this.state.optionIndex = Math.max(0, items.length - 1);
        return;
      }
      if (data === " ") return;
    }

    // Multi-select: Space to toggle
    if (q.multiSelect) {
      if (data === " ") {
        this.toggleMultiSelect();
        return;
      }
      // Tab or Enter on "Next →" commits multi-select
      if ((matchesKey(data, "enter") || matchesKey(data, "tab")) && this.isOnNextSentinel(items)) {
        this.commitMultiSelect();
        this.advanceOrSubmit();
        return;
      }
      // Enter on option toggles in multi-select
      if (matchesKey(data, "enter") && this.state.optionIndex < q.options.length) {
        this.toggleMultiSelect();
        return;
      }
    }

    // Single-select: Enter to select
    if (matchesKey(data, "enter")) {
      if (this.isOnCustomSentinel(items)) {
        this.enterCustomMode();
        return;
      }
      // Select option
      const opt = q.options[this.state.optionIndex];
      if (opt) {
        this.state.selections.set(this.state.tabIndex, [opt.label]);
        this.advanceOrSubmit();
      }
      return;
    }

    // Up/Down navigation
    if (matchesKey(data, "up")) {
      if (this.state.optionIndex === 0) {
        this.state.chatFocused = true;
        return;
      }
      this.state.optionIndex = Math.max(0, this.state.optionIndex - 1);
      return;
    }
    if (matchesKey(data, "down")) {
      if (this.state.optionIndex >= items.length - 1) {
        this.state.chatFocused = true;
        return;
      }
      this.state.optionIndex = Math.min(items.length - 1, this.state.optionIndex + 1);
      return;
    }

    // Tab to next question
    if (matchesKey(data, "tab") && this.questions.length > 1) {
      this.state.tabIndex = (this.state.tabIndex + 1) % this.questions.length;
      this.state.optionIndex = 0;
      this.state.chatFocused = false;
      return;
    }
  }

  private handleTextInput(data: string): void {
    if (!this.state.inputMode) return;
    if (matchesKey(data, "enter")) {
      const text = this.state.inputMode.buffer.trim();
      if (text) {
        this.state.customTexts.set(this.state.inputMode.questionIndex, text);
      }
      this.state.inputMode = null;
      this.advanceOrSubmit();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.state.inputMode = null;
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.state.inputMode.buffer = this.state.inputMode.buffer.slice(0, -1);
      return;
    }
    if (data.length === 1 && data >= " ") {
      this.state.inputMode.buffer += data;
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const q = this.currentQuestion();
    const items = this.buildOptionList(q);
    const previewBlock = this.previewBlocks.get(this.state.tabIndex);
    const hasPreview = previewBlock?.hasAnyPreview() ?? false;
    const mode = decideLayout(width, width); // terminal width ≈ pane width from pi
    const isSideBySide = mode === "side-by-side" && hasPreview && !q.multiSelect;

    const lines: string[] = [];
    const pad = "  ";

    // Header
    lines.push("");
    lines.push(
      truncateToWidth(
        `${pad}${th.fg("accent", th.bold(`[${q.header}]`))} ${th.fg("text", q.question)}`,
        width,
      ),
    );
    lines.push(
      truncateToWidth(`${pad}${th.fg("borderMuted", "─".repeat(Math.max(0, width - 4)))}`, width),
    );
    lines.push("");

    // Tab bar (multi-question)
    if (this.questions.length > 1) {
      const tabs = this.questions.map((tq, i) => {
        const answered =
          this.state.selections.has(i) ||
          this.state.customTexts.has(i) ||
          this.state.chatAbandoned.has(i);
        const marker = answered ? "✓" : i === this.state.tabIndex ? "●" : "○";
        return i === this.state.tabIndex
          ? th.fg("accent", `${marker} ${tq.header}`)
          : th.fg("dim", `${marker} ${tq.header}`);
      });
      lines.push(truncateToWidth(`${pad}${tabs.join(" │ ")}`, width));
      lines.push("");
    }

    // Option list + preview
    if (isSideBySide && previewBlock) {
      const { leftWidth, rightWidth } = columnWidths(width, this.adaptiveLeft);
      lines.push(
        ...this.renderSideBySide(items, q, leftWidth, rightWidth, mode, previewBlock, width, th),
      );
    } else if (hasPreview && !q.multiSelect && previewBlock) {
      // Stacked: options on top, preview block below
      lines.push(...this.renderSimpleList(items, q, width, th));
      lines.push("");
      lines.push(...this.renderPreviewBlock(previewBlock, width, mode));
    } else {
      lines.push(...this.renderSimpleList(items, q, width, th));
    }
    lines.push("");
    lines.push(...this.renderChatRow(width, th));

    // Footer
    lines.push("");
    const hints = this.getFooterHints(q);
    lines.push(truncateToWidth(`${pad}${th.fg("dim", hints)}`, width));

    return lines;
  }

  invalidate(): void {
    for (const block of this.previewBlocks.values()) block.invalidate();
  }

  // ── Private ─────────────────────────────────────────────────────────

  private currentQuestion(): QuestionData {
    return this.questions[this.state.tabIndex];
  }

  private buildOptionList(q: QuestionData): string[] {
    const labels = q.options.map((o) => o.label);
    const hasPreview = q.options.some((o) => typeof o.preview === "string" && o.preview.length > 0);
    if (!q.multiSelect && !hasPreview) labels.push(SENTINEL_OTHER);
    if (q.multiSelect) labels.push(SENTINEL_NEXT);
    return labels;
  }

  private isOnCustomSentinel(items: string[]): boolean {
    return items[this.state.optionIndex] === SENTINEL_OTHER;
  }

  private isOnNextSentinel(items: string[]): boolean {
    return items[this.state.optionIndex] === SENTINEL_NEXT;
  }

  private enterCustomMode(): void {
    this.state.inputMode = { questionIndex: this.state.tabIndex, buffer: "" };
  }

  private toggleMultiSelect(): void {
    const qi = this.state.tabIndex;
    const q = this.currentQuestion();
    const idx = this.state.optionIndex;
    if (idx >= q.options.length) return;
    const label = q.options[idx].label;
    let pending = this.state.multiSelectPending.get(qi);
    if (!pending) {
      pending = new Set();
      this.state.multiSelectPending.set(qi, pending);
    }
    if (pending.has(label)) pending.delete(label);
    else pending.add(label);
  }

  private commitMultiSelect(): void {
    const qi = this.state.tabIndex;
    const pending = this.state.multiSelectPending.get(qi);
    if (pending && pending.size > 0) {
      this.state.selections.set(qi, [...pending]);
    }
    this.state.multiSelectPending.delete(qi);
  }

  private advanceOrSubmit(): void {
    const remaining = this.questions.filter(
      (_, i) =>
        !this.state.selections.has(i) &&
        !this.state.customTexts.has(i) &&
        !this.state.chatAbandoned.has(i),
    );
    if (remaining.length === 0) {
      this.done({ answers: this.collectAnswers(), cancelled: false });
      return;
    }
    for (let i = 1; i <= this.questions.length; i++) {
      const ni = (this.state.tabIndex + i) % this.questions.length;
      if (
        !this.state.selections.has(ni) &&
        !this.state.customTexts.has(ni) &&
        !this.state.chatAbandoned.has(ni)
      ) {
        this.state.tabIndex = ni;
        this.state.optionIndex = 0;
        this.state.chatFocused = false;
        return;
      }
    }
    this.done({ answers: this.collectAnswers(), cancelled: false });
  }

  private collectAnswers(): QuestionAnswer[] {
    const answers: QuestionAnswer[] = [];
    for (let i = 0; i < this.questions.length; i++) {
      const q = this.questions[i];
      const sel = this.state.selections.get(i);
      const custom = this.state.customTexts.get(i);
      const chat = this.state.chatAbandoned.has(i);

      if (chat) {
        answers.push({
          questionIndex: i,
          question: q.question,
          kind: "chat",
          answer: "Chat about this",
        });
      } else if (custom) {
        answers.push({ questionIndex: i, question: q.question, kind: "custom", answer: custom });
      } else if (sel && q.multiSelect) {
        answers.push({
          questionIndex: i,
          question: q.question,
          kind: "multi",
          answer: null,
          selected: sel,
        });
      } else if (sel && sel.length === 1) {
        const opt = q.options.find((o) => o.label === sel[0]);
        answers.push({
          questionIndex: i,
          question: q.question,
          kind: "option",
          answer: sel[0],
          preview: opt?.preview,
        });
      }
    }
    return answers;
  }

  private getFooterHints(q: QuestionData): string {
    const parts: string[] = [];
    if (q.multiSelect) {
      parts.push("Space toggle   Enter next");
    } else {
      parts.push("↑↓ navigate   Enter select");
    }
    if (this.questions.length > 1) parts.push("Tab next question");
    parts.push("Esc cancel");
    return parts.join("   ");
  }

  private renderSimpleList(items: string[], q: QuestionData, width: number, th: Theme): string[] {
    const lines: string[] = [];
    const pad = "    ";
    for (let i = 0; i < items.length; i++) {
      const isFocused = !this.state.chatFocused && i === this.state.optionIndex;
      const label = items[i];
      const prefix = isFocused ? th.fg("accent", "▶ ") : "  ";

      const sel = this.state.selections.get(this.state.tabIndex);
      const isMultiPending = this.state.multiSelectPending.get(this.state.tabIndex)?.has(label);
      const checked = sel?.includes(label) || isMultiPending;
      const check = q.multiSelect ? (checked ? th.fg("success", "☑ ") : th.fg("dim", "☐ ")) : "";

      let text: string;
      if (label === SENTINEL_OTHER) text = th.fg("dim", label);
      else if (label === SENTINEL_CHAT) text = th.fg("dim", label);
      else if (label === SENTINEL_NEXT) text = th.fg("accent", label);
      else if (isFocused) text = th.fg("accent", th.bold(label));
      else if (checked && q.multiSelect) text = th.fg("success", label);
      else text = label;

      lines.push(truncateToWidth(`${pad}${prefix}${check}${text}`, width));
    }

    if (this.state.inputMode && this.state.inputMode.questionIndex === this.state.tabIndex) {
      lines.push("");
      const buf = this.state.inputMode.buffer || "";
      const cursor = buf + th.fg("accent", "▌");
      lines.push(truncateToWidth(`${pad}  ${th.fg("dim", "Type: ")}${cursor}`, width));
    }

    return lines;
  }

  private renderChatRow(width: number, th: Theme): string[] {
    const pad = "    ";
    const prefix = this.state.chatFocused ? th.fg("accent", "▶ ") : "  ";
    const label = this.state.chatFocused
      ? th.fg("accent", th.bold(SENTINEL_CHAT))
      : th.fg("dim", SENTINEL_CHAT);
    return [truncateToWidth(`${pad}${prefix}${label}`, width)];
  }

  private renderSideBySide(
    items: string[],
    q: QuestionData,
    leftWidth: number,
    rightWidth: number,
    mode: PreviewLayoutMode,
    previewBlock: PreviewBlockRenderer,
    totalWidth: number,
    th: Theme,
  ): string[] {
    const pad = "    ";

    // Left: option list
    const leftLines: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const isFocused = !this.state.chatFocused && i === this.state.optionIndex;
      const label = items[i];
      const prefix = isFocused ? th.fg("accent", "▶ ") : "  ";
      const sel = this.state.selections.get(this.state.tabIndex);
      const checked = sel?.includes(label);
      const check = q.multiSelect ? (checked ? th.fg("success", "☑ ") : th.fg("dim", "☐ ")) : "";
      let text = isFocused
        ? th.fg("accent", th.bold(label))
        : label === SENTINEL_OTHER
          ? th.fg("dim", label)
          : label === SENTINEL_NEXT
            ? th.fg("accent", label)
            : label;
      leftLines.push(truncateToWidth(`${pad}${prefix}${check}${text}`, leftWidth));
    }

    // Right: preview block (with left padding)
    const innerRight = Math.max(1, rightWidth - PREVIEW_PADDING_LEFT);
    const rightLines = this.renderPreviewBlock(previewBlock, innerRight, mode);
    const rightPad = " ".repeat(PREVIEW_PADDING_LEFT);
    const paddedRightLines = rightLines.map((l) => (l === "" ? "" : `${rightPad}${l}`));

    // Interleave
    const maxLen = Math.max(leftLines.length, paddedRightLines.length);
    const result: string[] = [];
    for (let i = 0; i < maxLen; i++) {
      const leftRaw = leftLines[i] ?? "";
      const rightRaw = paddedRightLines[i] ?? "";
      // Pad left column to exact width for alignment
      const leftClamped = truncateToWidth(leftRaw, leftWidth, "");
      const leftPad = " ".repeat(Math.max(0, leftWidth - visibleWidth(leftClamped)));
      const joined = `${leftClamped}${leftPad}  ${rightRaw}`;
      result.push(truncateToWidth(joined, totalWidth, ""));
    }
    return result;
  }

  private renderPreviewBlock(
    block: PreviewBlockRenderer,
    innerWidth: number,
    mode: PreviewLayoutMode,
  ): string[] {
    const isFocused = true; // we're always showing preview for focused option
    return block.renderBlock(innerWidth, this.state.optionIndex, mode, isFocused);
  }
}
