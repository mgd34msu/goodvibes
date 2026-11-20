import { createEmptyLine } from '@goodvibes/engine/platform/platform/types/grid';
import type { Cell, Line } from '@goodvibes/engine/platform/platform/types';

/** Everything a cell carries except its character; one shared object per distinct style. */
type CellStyle = Readonly<Omit<Cell, 'char'>>;

/**
 * A run of cells with one style. `text` holds one cell per UTF-16 unit; a run
 * with a wide-glyph continuation cell (an empty char) or a character outside
 * the basic plane keeps one string per cell in `chars` instead.
 */
type CompactRun =
  | { readonly style: CellStyle; readonly text: string }
  | { readonly style: CellStyle; readonly chars: readonly string[] };

/**
 * A rendered transcript row kept as styled runs instead of one object per
 * terminal column: a 160-column row is a few runs, not 160 cells. Cells are
 * built only for the rows on screen (`InfiniteBuffer.getSnapshot`).
 */
export interface CompactLine {
  readonly width: number;
  readonly runs: readonly CompactRun[];
}

const styles = new Map<string, CellStyle>();
function internStyle(cell: Cell): CellStyle {
  // The copy facts (chrome, a soft wrap's join, verbatim whitespace) are part of
  // the style, so a compacted row hands them back to the selection unchanged.
  const key = `${cell.fg}\u0000${cell.bg}\u0000${cell.bold ? 1 : 0}${cell.dim ? 1 : 0}${cell.underline ? 1 : 0}${cell.italic ? 1 : 0}${cell.strikethrough ? 1 : 0}\u0000${cell.link ?? ''}`
    + `\u0000${cell.chrome ? 1 : 0}${cell.verbatim ? 1 : 0}\u0000${cell.wrapJoin ?? '\u0001'}`;
  let style = styles.get(key);
  if (!style) {
    style = Object.freeze({
      fg: cell.fg, bg: cell.bg, bold: cell.bold, dim: cell.dim, underline: cell.underline,
      italic: cell.italic, strikethrough: cell.strikethrough, link: cell.link,
      ...(cell.chrome ? { chrome: true } : {}),
      ...(cell.verbatim ? { verbatim: true } : {}),
      ...(cell.wrapJoin !== undefined ? { wrapJoin: cell.wrapJoin } : {}),
    });
    styles.set(key, style);
  }
  return style;
}

function isSingleUnit(char: string): boolean {
  if (char.length !== 1) return false;
  const code = char.charCodeAt(0);
  return code < 0xd800 || code > 0xdfff;
}

/** The compact form of a rendered row; lossless: `expandLine(compactLine(l))` has the same cells. */
export function compactLine(line: Line): CompactLine {
  const runs: CompactRun[] = [];
  let style: CellStyle | undefined;
  let text = '';
  let chars: string[] | undefined;
  const flush = (): void => {
    if (!style) return;
    if (chars) runs.push({ style, chars });
    else if (text.length > 0) runs.push({ style, text });
    text = '';
    chars = undefined;
  };
  for (const cell of line) {
    const next = internStyle(cell);
    const simple = isSingleUnit(cell.char);
    if (next !== style || (chars === undefined) !== simple) {
      flush();
      style = next;
      if (!simple) chars = [];
    }
    if (chars) chars.push(cell.char);
    else text += cell.char;
  }
  flush();
  return { width: line.length, runs };
}

/** The cells of a compact row, each a new object a renderer may change. */
export function expandLine(compact: CompactLine): Line {
  const line: Line = [];
  for (const run of compact.runs) {
    const { style } = run;
    if ('text' in run) {
      for (let i = 0; i < run.text.length; i++) line.push({ char: run.text[i]!, ...style });
    } else {
      for (const char of run.chars) line.push({ char, ...style });
    }
  }
  return line;
}

/**
 * InfiniteBuffer - the whole conversation as rendered rows.
 *
 * Rows are kept compact (see CompactLine), so memory follows the text of the
 * transcript, not lines x columns x one object per cell. A row added as cells
 * is compacted once; a row the line cache already holds compact is kept by
 * reference, so a rebuild replays cached units without re-encoding them.
 * Cells are built for the visible window only, and the window's rows are
 * reused while they stay on screen.
 */
export class InfiniteBuffer {
  private lines: CompactLine[] = [];
  private shown = new Map<CompactLine, Line>();

  public addLine(line: Line): void {
    this.lines.push(compactLine(line));
  }

  public addLines(lines: Line[]): void {
    for (const line of lines) this.lines.push(compactLine(line));
  }

  /** Rows already compact (the line cache's entries): kept by reference. */
  public addCompactLines(lines: readonly CompactLine[]): void {
    for (const line of lines) this.lines.push(line);
  }

  public getLineCount(): number {
    return this.lines.length;
  }

  /** One row's cells, or undefined past the end. */
  public getLine(index: number): Line | undefined {
    const compact = this.lines[index];
    return compact ? expandLine(compact) : undefined;
  }

  /**
   * Every row, as a read-only array whose rows are built when indexed. Code that
   * reads a range (`slice`, an index loop) builds only that range; iterating the
   * whole array builds each row in turn and keeps none of them.
   */
  public getAllLines(): Line[] {
    const lines = this.lines;
    return new Proxy([] as Line[], {
      get(target, prop, receiver) {
        if (prop === 'length') return lines.length;
        if (typeof prop === 'string' && /^(0|[1-9]\d*)$/.test(prop)) {
          const compact = lines[Number(prop)];
          return compact ? expandLine(compact) : undefined;
        }
        return Reflect.get(target, prop, receiver);
      },
      has(target, prop) {
        if (typeof prop === 'string' && /^(0|[1-9]\d*)$/.test(prop)) return Number(prop) < lines.length;
        return Reflect.has(target, prop);
      },
      set() {
        return false;
      },
    });
  }

  public getSnapshot(startLine: number, height: number, width: number): Line[] {
    const end = Math.min(this.lines.length, startLine + height);
    const shown = new Map<CompactLine, Line>();
    const slice: Line[] = [];
    for (let index = Math.max(0, startLine); index < end; index++) {
      const compact = this.lines[index]!;
      const line = shown.get(compact) ?? this.shown.get(compact) ?? expandLine(compact);
      shown.set(compact, line);
      slice.push(line);
    }
    this.shown = shown;

    while (slice.length < height) {
      slice.unshift(createEmptyLine(width));
    }

    return slice;
  }

  public clear(): void {
    this.lines = [];
    this.shown = new Map();
  }

  public truncateToLine(lineIndex: number): void {
    if (lineIndex >= 0 && lineIndex < this.lines.length) {
      this.lines.length = lineIndex;
    }
  }
}
