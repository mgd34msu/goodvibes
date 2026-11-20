/**
 * conversation-display-only.ts, the display-only output a conversation keeps.
 *
 * A command's printed text or a tool result row is drawn into the transcript
 * but is not a message, so a rebuild (a resize, a theme change, the splash
 * leaving) would drop it. ConversationManager keeps each such draw here, with
 * the number of messages that existed when it was drawn, and draws it again
 * in the same place on every rebuild. While a reply streams, draws made during
 * the turn sit below the streamed text and are drawn again after each delta.
 */

interface DisplayOnlyEntry {
  readonly seq: number;
  /** Messages that existed when it was drawn: it goes right after the unit holding message `anchor - 1`. */
  readonly anchor: number;
  readonly draw: (width: number) => void;
}

/** One rebuild's walk over the kept draws, in order. */
export interface DisplayOnlyCursor {
  /** Draw every kept entry printed while messages up to `lastIndex` existed. */
  through(lastIndex: number): void;
  /** During a streaming rebuild: the entries not yet drawn go below the streamed text. */
  trailStreamed(lineCount: () => number): void;
}

export class DisplayOnlyOutput {
  private entries: DisplayOnlyEntry[] = [];
  private seq = 0;
  /** While a reply streams, draws from this seq on sit below the streamed text. */
  private trailingFromSeq = Number.POSITIVE_INFINITY;
  /** Lines those trailing draws take, below the streamed text. */
  trailingLineCount = 0;

  get count(): number { return this.entries.length; }

  drop(): void {
    this.entries = [];
    this.resetTrailing();
  }

  resetTrailing(): void {
    this.trailingFromSeq = Number.POSITIVE_INFINITY;
    this.trailingLineCount = 0;
  }

  /** Forget one kept draw; the next rebuild leaves it out. */
  remove(seq: number): void {
    this.entries = this.entries.filter((entry) => entry.seq !== seq);
  }

  /**
   * Keep a draw; `anchor` is the message count when it was printed. Every draw is
   * kept until the conversation is cleared: a command's output is something the
   * person was told, and a rebuild (a resize) that dropped the oldest would take
   * it out of the scrollback for good. One entry per printed output, so the list
   * grows with what was printed, never faster.
   */
  keep(anchor: number, draw: (width: number) => void): number {
    const seq = ++this.seq;
    this.entries.push({ seq, anchor, draw });
    return seq;
  }

  /** A kept draw was just drawn at the end of the buffer; while streaming it trails the streamed text. */
  noteDrawn(seq: number, lines: number, streaming: boolean): void {
    if (!streaming) return;
    if (this.trailingFromSeq === Number.POSITIVE_INFINITY) this.trailingFromSeq = seq;
    this.trailingLineCount += lines;
  }

  /** Draw the entries kept below the streamed text again, and count their lines. */
  drawTrailing(width: number, lineCount: () => number): void {
    const before = lineCount();
    for (const entry of this.entries) if (entry.seq >= this.trailingFromSeq) entry.draw(width);
    this.trailingLineCount = lineCount() - before;
  }

  cursor(width: number): DisplayOnlyCursor {
    const kept = this.entries;
    let next = 0;
    return {
      through: (lastIndex) => {
        while (next < kept.length && kept[next]!.anchor <= lastIndex + 1) kept[next++]!.draw(width);
      },
      trailStreamed: (lineCount) => {
        if (next >= kept.length) return;
        this.trailingFromSeq = kept[next]!.seq;
        this.drawTrailing(width, lineCount);
      },
    };
  }
}
