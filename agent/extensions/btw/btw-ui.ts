/**
 * btw-ui.ts — bottom-slot overlay for /btw side-agent answers.
 *
 * Mirrors @juicesharp/rpiv-btw btw-ui.ts exactly, with the single addition of
 * DSML stripping in the answer rendering path.
 *
 * Bottom-anchored overlay panel: banner, history, echo, answer body, footer.
 * Clips to terminal-height with ↑/↓ scroll. Supports answer and error modes.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const SIDE_PAD = "  ";
const ANSWER_PAD = "    ";
const BTW_LITERAL = "/btw";
const BTW_MAX_HEIGHT_RATIO = 0.85;
const PENDING_GLYPH = "…";
const FOOTER_SCROLL = "↑/↓ to scroll";
const FOOTER_CLEAR = "x to clear history";
const FOOTER_DISMISS = "Esc to dismiss";
const FOOTER_SEP = " · ";

type Mode = "pending" | "answer" | "error";

export interface BtwHistoryEntry {
  question: string;
  answer: string;
}

export interface ShowBtwOverlayParams {
  ctx: ExtensionCommandContext;
  question: string;
  history: BtwHistoryEntry[];
  controller: AbortController;
  onClearHistory: () => void;
}

export interface ShowBtwOverlayResult {
  overlayPromise: Promise<void>;
  controllerReady: Promise<BtwOverlayController>;
}

export class BtwOverlayController {
  private mode: Mode = "pending";
  private answer = "";
  private error = "";
  private scrollOffset = 0;
  private history: BtwHistoryEntry[];

  constructor(
    private readonly question: string,
    history: BtwHistoryEntry[],
    private readonly theme: Theme,
    private readonly tui: TUI,
    private readonly done: (result?: undefined) => void,
    private readonly controller: AbortController,
    private readonly onClearHistory: () => void,
  ) {
    this.history = [...history];
  }

  setAnswer(text: string): void {
    this.mode = "answer";
    // Strip DSML markup that reasoning models may emit
    this.answer = text.replace(/<\|[^|]*\|[^>]*>/g, "");
    this.tui.requestRender();
  }

  setError(message: string): void {
    this.mode = "error";
    this.error = message;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.controller.abort();
      this.done();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollOffset = this.scrollOffset + 1;
      this.tui.requestRender();
      return;
    }
    if (data === "x") {
      this.history = [];
      this.onClearHistory();
      this.scrollOffset = 0;
      this.tui.requestRender();
      return;
    }
  }

  render(width: number): string[] {
    const banner = this.renderBanner(width);
    const historyLines = this.history.map((h) => this.historyLine(h.question, width));
    const echoLine = this.echoLine(this.question, width);
    const answerLines = this.renderAnswer(width);
    const footerAvail = Math.max(1, width - SIDE_PAD.length);
    const footerParts: string[] = [];
    if (this.mode !== "pending") footerParts.push(FOOTER_SCROLL);
    if (this.history.length > 0) footerParts.push(FOOTER_CLEAR);
    footerParts.push(FOOTER_DISMISS);
    const footer =
      SIDE_PAD + truncateToWidth(this.theme.fg("dim", footerParts.join(FOOTER_SEP)), footerAvail, "…", false);

    const natural: string[] = [banner, "", ...historyLines, echoLine, "", ...answerLines, "", footer];

    const termRows = (this.tui.terminal as { rows?: number }).rows ?? 24;
    const maxRows = Math.max(4, Math.floor(termRows * BTW_MAX_HEIGHT_RATIO));
    if (natural.length <= maxRows) return natural;
    const excess = natural.length - maxRows;
    if (this.scrollOffset > excess) this.scrollOffset = excess;
    const start = excess - this.scrollOffset;
    return natural.slice(start, start + maxRows);
  }

  invalidate(): void {}

  private renderBanner(width: number): string {
    const prefix = `${SIDE_PAD}${BTW_LITERAL} `;
    const prefixWidth = visibleWidth(prefix);
    const qAvail = Math.max(0, width - prefixWidth);
    const qTrunc = truncateToWidth(this.question, qAvail, "…", false);
    const raw = prefix + qTrunc;
    const padded = raw + " ".repeat(Math.max(0, width - visibleWidth(raw)));
    return this.theme.bg("customMessageBg", this.theme.fg("customMessageText", padded));
  }

  private historyLine(question: string, width: number): string {
    const qAvail = Math.max(0, width - SIDE_PAD.length);
    const qClean = question.replace(/\s+/g, " ").trim();
    const raw = `${BTW_LITERAL} ${qClean}`;
    const trunc = truncateToWidth(raw, qAvail, "…", false);
    return SIDE_PAD + this.theme.fg("muted", trunc);
  }

  private echoLine(question: string, width: number): string {
    const bodyAvail = Math.max(1, width - SIDE_PAD.length);
    const prefixWidth = visibleWidth(BTW_LITERAL) + 1;
    const qAvail = Math.max(0, bodyAvail - prefixWidth);
    const qClean = question.replace(/\s+/g, " ").trim();
    const qTrunc = truncateToWidth(qClean, qAvail, "…", false);
    return `${SIDE_PAD + this.theme.fg("accent", BTW_LITERAL)} ${this.theme.fg("muted", qTrunc)}`;
  }

  private renderAnswer(width: number): string[] {
    const bodyWidth = Math.max(1, width - ANSWER_PAD.length);
    const indent = (lines: string[]) => lines.map((l) => ANSWER_PAD + l);

    if (this.mode === "pending") return indent([this.theme.fg("warning", PENDING_GLYPH)]);
    if (this.mode === "error") {
      const out: string[] = [];
      for (const ln of this.error.split("\n")) {
        const src = ln.length === 0 ? " " : ln;
        out.push(...wrapTextWithAnsi(this.theme.fg("error", src), bodyWidth));
      }
      return indent(out);
    }
    const out: string[] = [];
    for (const ln of this.answer.split("\n")) {
      const src = ln.length === 0 ? " " : ln;
      out.push(...wrapTextWithAnsi(src, bodyWidth));
    }
    return indent(out);
  }
}

export function showBtwOverlay(params: ShowBtwOverlayParams): ShowBtwOverlayResult {
  let resolveReady!: (controller: BtwOverlayController) => void;
  const controllerReady = new Promise<BtwOverlayController>((resolve) => {
    resolveReady = resolve;
  });

  const overlayPromise = params.ctx.ui.custom<void>(
    (tui, theme, _kb, done) => {
      const controller = new BtwOverlayController(
        params.question,
        params.history,
        theme,
        tui as TUI,
        done,
        params.controller,
        params.onClearHistory,
      );
      resolveReady(controller);
      return controller;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "bottom-center",
        width: "100%",
        maxHeight: "85%",
        margin: { left: 0, right: 0, bottom: 0 },
      },
    },
  );

  return { overlayPromise, controllerReady };
}
