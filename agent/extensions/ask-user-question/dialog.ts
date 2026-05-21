/**
 * dialog.ts — Custom UI component for the ask_user_question tabbed dialog.
 *
 * Handles single-select (↑↓ Enter), multi-select (Space toggle, Enter commit),
 * free-text "Type something." row, "Chat about this" cancel, and a Submit tab
 * for final review.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  type OptionData,
  type QuestionAnswer,
  type QuestionData,
  type QuestionnaireResult,
  SENTINEL_CHAT,
  SENTINEL_NEXT,
  SENTINEL_OTHER,
} from "./types.js";

interface DialogState {
  tabIndex: number;
  optionIndex: number;
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

  constructor(config: DialogConfig) {
    this.questions = config.questions;
    this.theme = config.theme;
    this.done = config.done;
    this.state = {
      tabIndex: 0,
      optionIndex: 0,
      selections: new Map(),
      customTexts: new Map(),
      chatAbandoned: new Set(),
      multiSelectPending: new Map(),
      inputMode: null,
      showSubmit: this.questions.length > 1,
      submitChoiceIndex: 0,
    };
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
      if (this.isOnChatSentinel(items)) {
        this.state.chatAbandoned.add(this.state.tabIndex);
        this.advanceOrSubmit();
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
      this.state.optionIndex = Math.max(0, this.state.optionIndex - 1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.state.optionIndex = Math.min(items.length - 1, this.state.optionIndex + 1);
      return;
    }

    // Tab to next question
    if (matchesKey(data, "tab") && this.questions.length > 1) {
      this.state.tabIndex = (this.state.tabIndex + 1) % this.questions.length;
      this.state.optionIndex = 0;
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
    const hasPreview = q.options.some((o) => o.preview && o.preview.length > 0);
    const isWide = width >= 80;

    const lines: string[] = [];
    const pad = "  ";

    // Header
    lines.push("");
    lines.push(truncateToWidth(`${pad}${th.fg("accent", th.bold(`[${q.header}]`))} ${th.fg("text", q.question)}`, width));
    lines.push(truncateToWidth(`${pad}${th.fg("borderMuted", "─".repeat(Math.max(0, width - 4)))}`, width));
    lines.push("");

    // Tab bar (multi-question)
    if (this.questions.length > 1) {
      const tabs = this.questions.map((tq, i) => {
        const answered = this.state.selections.has(i) || this.state.customTexts.has(i) || this.state.chatAbandoned.has(i);
        const marker = answered ? "✓" : (i === this.state.tabIndex ? "●" : "○");
        return i === this.state.tabIndex
          ? th.fg("accent", `${marker} ${tq.header}`)
          : th.fg("dim", `${marker} ${tq.header}`);
      });
      lines.push(truncateToWidth(`${pad}${tabs.join(" │ ")}`, width));
      lines.push("");
    }

    // Option list (left side) + preview (right side, if wide enough)
    if (hasPreview && isWide) {
      const previewOpt = q.options[this.state.optionIndex];
      lines.push(...this.renderSideBySide(items, previewOpt, q, width, th));
    } else {
      lines.push(...this.renderSimpleList(items, q, width, th));
    }

    // Footer
    lines.push("");
    const hints = this.getFooterHints(q);
    lines.push(truncateToWidth(`${pad}${th.fg("dim", hints)}`, width));

    return lines;
  }

  invalidate(): void {}

  // ── Private ─────────────────────────────────────────────────────────

  private currentQuestion(): QuestionData {
    return this.questions[this.state.tabIndex];
  }

  private buildOptionList(q: QuestionData): string[] {
    const labels = q.options.map((o) => o.label);
    if (!q.multiSelect) labels.push(SENTINEL_OTHER);
    labels.push(SENTINEL_CHAT);
    if (q.multiSelect) labels.push(SENTINEL_NEXT);
    return labels;
  }

  private isOnCustomSentinel(items: string[]): boolean {
    return items[this.state.optionIndex] === SENTINEL_OTHER;
  }

  private isOnChatSentinel(items: string[]): boolean {
    return items[this.state.optionIndex] === SENTINEL_CHAT;
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
    if (!pending) { pending = new Set(); this.state.multiSelectPending.set(qi, pending); }
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
    const remaining = this.questions.filter((_, i) =>
      !this.state.selections.has(i) && !this.state.customTexts.has(i) && !this.state.chatAbandoned.has(i),
    );
    if (remaining.length === 0) {
      // All answered
      this.done({ answers: this.collectAnswers(), cancelled: false });
      return;
    }
    // Go to next unanswered question
    for (let i = 1; i <= this.questions.length; i++) {
      const ni = (this.state.tabIndex + i) % this.questions.length;
      if (!this.state.selections.has(ni) && !this.state.customTexts.has(ni) && !this.state.chatAbandoned.has(ni)) {
        this.state.tabIndex = ni;
        this.state.optionIndex = 0;
        return;
      }
    }
    // All done (shouldn't reach here)
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
        answers.push({ questionIndex: i, question: q.question, kind: "chat", answer: "Chat about this" });
      } else if (custom) {
        answers.push({ questionIndex: i, question: q.question, kind: "custom", answer: custom });
      } else if (sel && q.multiSelect) {
        answers.push({ questionIndex: i, question: q.question, kind: "multi", answer: null, selected: sel });
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
      const isFocused = i === this.state.optionIndex;
      const label = items[i];
      const prefix = isFocused ? th.fg("accent", "▶ ") : "  ";

      // Check marks
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

    // Show "Type something." buffer when in custom mode
    if (this.state.inputMode && this.state.inputMode.questionIndex === this.state.tabIndex) {
      lines.push("");
      const buf = this.state.inputMode.buffer || "";
      const cursor = buf + th.fg("accent", "▌");
      lines.push(truncateToWidth(`${pad}  ${th.fg("dim", "Type: ")}${cursor}`, width));
    }

    return lines;
  }

  private renderSideBySide(items: string[], previewOpt: OptionData | undefined, q: QuestionData, width: number, th: Theme): string[] {
    const leftWidth = Math.floor(width * 0.45);
    const rightWidth = width - leftWidth - 4;
    const pad = "    ";

    // Left: option list
    const leftLines: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const isFocused = i === this.state.optionIndex;
      const label = items[i];
      const prefix = isFocused ? th.fg("accent", "▶ ") : "  ";
      const sel = this.state.selections.get(this.state.tabIndex);
      const checked = sel?.includes(label);
      const check = q.multiSelect ? (checked ? th.fg("success", "☑ ") : th.fg("dim", "☐ ")) : "";
      let text = isFocused ? th.fg("accent", th.bold(label))
        : label === SENTINEL_CHAT || label === SENTINEL_OTHER ? th.fg("dim", label)
        : label === SENTINEL_NEXT ? th.fg("accent", label)
        : label;
      leftLines.push(truncateToWidth(`${pad}${prefix}${check}${text}`, leftWidth));
    }

    // Right: preview
    const previewText = previewOpt?.preview?.trim() ?? "";
    const rightLines: string[] = [];
    if (previewText) {
      rightLines.push(th.fg("accent", th.bold(" Preview ")));
      rightLines.push(th.fg("borderMuted", "─".repeat(Math.min(20, rightWidth - 2))));
      for (const ln of previewText.split("\n")) {
        rightLines.push(th.fg("muted", truncateToWidth(` ${ln}`, rightWidth, "…")));
      }
    } else {
      rightLines.push(th.fg("dim", "(select an option with preview)"));
    }

    // Interleave left and right
    const maxLen = Math.max(leftLines.length, rightLines.length);
    const result: string[] = [];
    for (let i = 0; i < maxLen; i++) {
      const left = i < leftLines.length ? leftLines[i] : " ".repeat(leftWidth);
      result.push(left + "  " + (i < rightLines.length ? rightLines[i] : ""));
    }
    return result;
  }
}
