/**
 * btw-ui — bottom-slot overlay for /btw side-agent answers.
 *
 * Bottom-anchored overlay panel: banner, history, echo, answer body, footer.
 * Clips to 30 lines with ↑/↓ scroll. Supports pending (spinner), streaming
 * (cursor), answer, and error modes.
 */

import type { Theme, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, visibleWidth } from "@earendil-works/pi-tui";

// ── Constants ─────────────────────────────────────────────────────────

const SIDE_PAD = "  ";
const ANSWER_PAD = "    ";
const BTW_LITERAL = "/btw";
const MAX_ROWS = 30;

// ── Types ─────────────────────────────────────────────────────────────

export type OverlayMode = "pending" | "streaming" | "answer" | "error";

export interface BtwHistoryEntry {
  question: string;
  answer: string;
}

export interface ShowBtwOverlayParams {
  ctx: ExtensionCommandContext;
  question: string;
  history: BtwHistoryEntry[];
  controller: AbortController;
  onClear: () => void;
}

// ── Component ─────────────────────────────────────────────────────────

export class BtwOverlay {
  private mode: OverlayMode = "pending";
  private answer = "";
  private error = "";
  private scrollOffset = 0;
  private history: BtwHistoryEntry[];
  private question: string;
  private theme: Theme;
  private done: () => void;
  private controller: AbortController;
  private onClear: () => void;

  constructor(
    question: string,
    history: BtwHistoryEntry[],
    theme: Theme,
    done: () => void,
    controller: AbortController,
    onClear: () => void,
  ) {
    this.question = question;
    this.history = [...history];
    this.theme = theme;
    this.done = done;
    this.controller = controller;
    this.onClear = onClear;
  }

  appendDelta(delta: string): void {
    this.mode = "streaming";
    this.answer += delta;
  }

  finalizeAnswer(): void {
    this.mode = "answer";
  }

  setError(msg: string): void {
    this.mode = "error";
    this.error = msg;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.controller.abort();
      this.done();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollOffset += 1;
      return;
    }
    if (data === "x") {
      this.history = [];
      this.onClear();
      this.scrollOffset = 0;
      return;
    }
  }

  render(width: number): string[] {
    const th = this.theme;

    // Banner
    const qTrunc = truncateToWidth(BTW_LITERAL + " " + this.question, width - SIDE_PAD.length, "…");
    const rawBanner = SIDE_PAD + qTrunc + " ".repeat(Math.max(0, width - visibleWidth(SIDE_PAD + qTrunc)));
    const banner = th.bg("customMessageBg", th.fg("customMessageText", rawBanner));

    // History
    const qAvail = Math.max(0, width - SIDE_PAD.length - 6);
    const histLines = this.history.map((h) =>
      `${SIDE_PAD}${th.fg("accent", BTW_LITERAL)} ${th.fg("muted", truncateToWidth(h.question.replace(/\s+/g, " "), qAvail, "…"))}`
    );

    // Echo
    const echo = `${SIDE_PAD}${th.fg("accent", BTW_LITERAL)} ${th.fg("muted", truncateToWidth(this.question.replace(/\s+/g, " "), qAvail, "…"))}`;

    // Answer body
    const bodyW = Math.max(1, width - ANSWER_PAD.length);
    const body = this.renderBody(th, bodyW);

    // Footer
    const parts: string[] = [];
    if (this.mode === "answer") parts.push("↑↓ to scroll");
    if (this.history.length > 0) parts.push("x to clear");
    parts.push("Esc to dismiss");
    const footer = SIDE_PAD + truncateToWidth(th.fg("dim", parts.join(" · ")), Math.max(1, width - SIDE_PAD.length), "…");

    const lines = [banner, "", ...histLines, echo, "", ...body, "", footer];
    if (lines.length <= MAX_ROWS) return lines;
    const excess = lines.length - MAX_ROWS;
    this.scrollOffset = Math.min(this.scrollOffset, excess);
    return lines.slice(excess - this.scrollOffset, excess - this.scrollOffset + MAX_ROWS);
  }

  invalidate(): void {}

  private renderBody(th: Theme, bodyW: number): string[] {
    const indent = (ls: string[]) => ls.map((l) => ANSWER_PAD + l);

    if (this.mode === "pending") return indent([th.fg("warning", "…")]);
    if (this.mode === "error") {
      const out: string[] = [];
      for (const ln of this.error.split("\n")) {
        out.push(...wrapTextWithAnsi(th.fg("error", ln || " "), bodyW));
      }
      return indent(out);
    }
    const text = this.mode === "streaming" ? this.answer + th.fg("accent", "▌") : this.answer;
    const out: string[] = [];
    for (const ln of text.split("\n")) {
      out.push(...wrapTextWithAnsi(ln || " ", bodyW));
    }
    return indent(out);
  }
}

// ── Entry point ───────────────────────────────────────────────────────

export function showBtwOverlay(params: ShowBtwOverlayParams): {
  overlayPromise: Promise<void>;
  overlay: Promise<BtwOverlay>;
} {
  let resolveOverlay!: (ov: BtwOverlay) => void;
  const overlay = new Promise<BtwOverlay>((r) => { resolveOverlay = r; });

  const overlayPromise = params.ctx.ui.custom<void>(
    (_tui: unknown, theme: Theme, _kb: unknown, done: () => void) => {
      const ov = new BtwOverlay(params.question, params.history, theme, done, params.controller, params.onClear);
      resolveOverlay(ov);
      return ov;
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

  return { overlayPromise, overlay };
}
