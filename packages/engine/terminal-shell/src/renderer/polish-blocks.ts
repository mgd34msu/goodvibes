import type { Line } from '@goodvibes-jev/engine/platform/platform/types';
import { createStyledCell } from '@goodvibes-jev/engine/platform/platform/types';
import { getDisplayWidth, wrapText } from '@goodvibes-jev/engine/platform/platform/utils';
import { GLYPHS, STATE_GLYPHS, type StatusState } from '@goodvibes-jev/engine/platform/platform/presentation';
import { buildViewLine, buildStyledViewLine, DEFAULT_VIEW_PALETTE, type ViewPalette, type StyledViewSegment } from './polish-core.js';
export interface TerminalPolishPresentation {
  readonly padding: 1 | 2;
  readonly cropSearchTail: boolean;
  readonly reserveSummaryRow: boolean;
}
export function createTerminalPolishBlocks(presentation: TerminalPolishPresentation) {
  function buildGuidanceLine(width: number, command: string, summary: string, palette: ViewPalette): Line {
    return buildViewLine(width, [
      [` ${GLYPHS.status.info} `, palette.info],
      [command, palette.info],
      ['  - ', palette.dim],
      [summary, palette.dim],
    ]);
  }
  function buildViewTitle(width: number, title: string, palette: ViewPalette): Line {
    // Two columns between the fill edge and the title (the Measurements padding rule).
    const titleText = fitDisplayText(`${' '.repeat(presentation.padding)}${title}`, width);
    return buildStyledViewLine(
      width,
      [{ text: titleText, fg: palette.header ?? palette.accent ?? palette.value, bg: palette.headerBg, bold: true }],
      { fillBg: palette.headerBg },
    );
  }
  function buildBodyText(width: number, text: string, palette: ViewPalette, fg: string = palette.value): Line[] {
    const wrapped = wrapText(text, Math.max(10, width - 2));
    return wrapped.map((line) =>
      buildStyledViewLine(width, [{ text: ` ${line}`, fg, bg: palette.surfaceBg }], { fillBg: palette.surfaceBg }),
    );
  }
  function buildSectionHeader(width: number, title: string, palette: ViewPalette): Line {
    const prefix = `${GLYPHS.status.dualPane} ${title}`;
    const divider = GLYPHS.frame.horizontal.repeat(Math.max(0, width - getDisplayWidth(prefix) - 2));
    return buildStyledViewLine(
      width,
      [
        { text: ' ', fg: palette.label, bg: palette.sectionBg },
        { text: prefix, fg: palette.label, bg: palette.sectionBg, bold: true },
        { text: ' ', fg: palette.dim, bg: palette.sectionBg },
        { text: divider, fg: palette.dim, bg: palette.sectionBg },
      ],
      { fillBg: palette.sectionBg },
    );
  }
  function buildKeyValueLine(
    width: number,
    entries: ReadonlyArray<{
      label: string;
      value: string;
      valueColor?: string | undefined;
    }>,
    palette: ViewPalette,
  ): Line {
    const segments: Array<[string, string, string?]> = [];
    for (const entry of entries) {
      segments.push([' ', palette.label]);
      segments.push([`${entry.label} `, palette.label]);
      segments.push([entry.value, entry.valueColor ?? palette.value]);
      segments.push(['  ', palette.dim]);
    }
    return buildStyledViewLine(
      width,
      segments.map(([text, fg, bg]) => ({ text, fg, bg: bg ?? palette.summaryBg })),
      { fillBg: palette.summaryBg },
    );
  }
  function buildShortcutLine(width: number, keys: string, summary: string, palette: ViewPalette): Line {
    return buildViewLine(width, [
      ['  ', palette.label],
      [keys, palette.info],
      ['  ', palette.dim],
      [summary, palette.dim],
    ]);
  }
  function buildViewListRow(
    width: number,
    segments: ReadonlyArray<StyledViewSegment>,
    palette: ViewPalette,
    options: {
      readonly selected?: boolean | undefined;
      readonly selectedBg?: string | undefined;
      readonly marker?: string | undefined;
      readonly markerColor?: string | undefined;
      readonly fillBg?: string | undefined;
    } = {},
  ): Line {
    const selected = options.selected ?? false;
    const selectedBg = options.selectedBg ?? palette.selectBg;
    const fillBg = selected ? selectedBg : options.fillBg;
    const marker = selected ? `${options.marker ?? GLYPHS.navigation.selected} ` : '  ';
    const markerFg = selected ? (options.markerColor ?? palette.info) : palette.dim;
    return buildStyledViewLine(
      width,
      [
        { text: marker, fg: markerFg, bg: fillBg, bold: selected },
        ...segments.map((segment) => ({
          ...segment,
          bg: segment.bg ?? fillBg,
        })),
      ],
      { fillBg },
    );
  }
  function buildSearchInputLine(
    width: number,
    label: string,
    value: string,
    palette: ViewPalette,
    options: {
      active?: boolean | undefined;
      bg?: string | undefined;
      emptyLabel?: string | undefined;
      valueColor?: string | undefined;
    } = {},
  ): Line {
    const active = options.active ?? false;
    const normalizedValue = active && value.endsWith('_') ? `${value.slice(0, -1)}${GLYPHS.surface.cursor}` : value;
    const hasValue = normalizedValue.trim().length > 0;
    const content = hasValue ? normalizedValue : (options.emptyLabel ?? '(none)');
    const bg = options.bg ?? (active ? palette.inputBg : palette.sectionBg);
    const fg = active ? (options.valueColor ?? palette.info) : hasValue ? (options.valueColor ?? palette.value) : palette.dim;
    // Two columns of padding on both sides of the fill; a long draft keeps its
    // end (where the cursor is) in view.
    const room = Math.max(1, width - 4 - getDisplayWidth(label));
    let shown = content;
    while (presentation.cropSearchTail && shown.length > 0 && getDisplayWidth(shown) > room) shown = shown.slice(1);
    return buildStyledViewLine(
      width,
      [
        { text: ' '.repeat(presentation.padding), fg: palette.label, bg },
        { text: `${label}`, fg: palette.label, bg },
        { text: shown, fg, bg, bold: active },
      ],
      { fillBg: bg },
    );
  }
  function buildStatusPill(
    state: StatusState,
    label: string,
    opts?:
      | {
          glyph?: string | undefined;
          bg?: string | undefined;
          count?: number | undefined;
        }
      | undefined,
  ): StyledViewSegment[] {
    const glyph = opts?.glyph ?? STATE_GLYPHS[state];
    const color =
      state === 'good'
        ? DEFAULT_VIEW_PALETTE.good
        : state === 'warn'
          ? DEFAULT_VIEW_PALETTE.warn
          : state === 'bad'
            ? DEFAULT_VIEW_PALETTE.bad
            : DEFAULT_VIEW_PALETTE.info;
    const bg = opts?.bg;
    const text = opts?.count !== undefined ? `${glyph} ${label} (${opts.count})` : `${glyph} ${label}`;
    return [{ text, fg: color, ...(bg === undefined ? {} : { bg }) }];
  }
  function buildStatPill(label: string, value: string, labelColor: string, valueColor: string, bg = ''): Array<[string, string, string?]> {
    return [
      [' ', labelColor, bg],
      [label, labelColor, bg],
      [' ', labelColor, bg],
      [value, valueColor, bg],
      ['  ', labelColor, bg],
    ];
  }
  function buildMeterLine(
    width: number,
    filled: number,
    total: number,
    colors: {
      filled: string;
      empty: string;
      label?: string | undefined;
    },
    options: {
      prefix?: string | undefined;
      suffix?: string | undefined;
      filledChar?: string | undefined;
      emptyChar?: string | undefined;
    } = {},
  ): Line {
    const prefix = options.prefix ?? ' ';
    const suffix = options.suffix ?? ' ';
    const emptyChar = options.emptyChar ?? GLYPHS.meter.empty;
    const normalizedFilledChar = options.filledChar ?? GLYPHS.meter.filled;
    const barWidth = Math.max(1, total);
    const clampedFilled = Math.max(0, Math.min(barWidth, filled));
    const segments: StyledViewSegment[] = [{ text: prefix, fg: colors.label ?? colors.filled }];
    if (clampedFilled > 0) {
      segments.push({ text: normalizedFilledChar.repeat(clampedFilled), fg: colors.filled });
    }
    if (clampedFilled < barWidth) {
      segments.push({ text: emptyChar.repeat(barWidth - clampedFilled), fg: colors.empty });
    }
    segments.push({ text: suffix, fg: colors.label ?? colors.filled });
    return buildStyledViewLine(width, segments);
  }
  function buildEmptyState(
    width: number,
    title: string,
    body: string,
    actions: ReadonlyArray<{
      command: string;
      summary: string;
    }>,
    palette: ViewPalette,
  ): Line[] {
    const lines: Line[] = [];
    lines.push(buildViewLine(width, [[` ${title}`, palette.empty]]));
    lines.push(...buildBodyText(width, body, palette, palette.dim));
    if (actions.length > 0) {
      lines.push(buildViewLine(width, [[' Suggested next steps', palette.label]]));
      for (const action of actions) {
        lines.push(buildGuidanceLine(width, action.command, action.summary, palette));
      }
    }
    return lines;
  }
  function buildSummaryBlock(width: number, title: string, rows: readonly Line[], palette: ViewPalette): Line[] {
    const lines: Line[] = [
      buildStyledViewLine(
        width,
        [{ text: ` ${GLYPHS.status.active} ${title}`, fg: palette.header ?? palette.value, bg: palette.summaryBg, bold: true }],
        { fillBg: palette.summaryBg },
      ),
    ];
    for (const row of rows) lines.push(row);
    return lines;
  }
  function buildDetailBlock(width: number, title: string, rows: readonly Line[], palette: ViewPalette): Line[] {
    return [
      buildStyledViewLine(
        width,
        [{ text: ` ${GLYPHS.status.review} ${title}`, fg: palette.header ?? palette.value, bg: palette.sectionBg, bold: true }],
        { fillBg: palette.sectionBg },
      ),
      ...rows.map((row) =>
        row.map((cell) =>
          cell.bg
            ? cell
            : createStyledCell(cell.char, {
                fg: cell.fg,
                ...(palette.surfaceBg === undefined ? {} : { bg: palette.surfaceBg }),
                bold: cell.bold,
                dim: cell.dim,
                underline: cell.underline,
              }),
        ),
      ),
    ];
  }
  function fitDisplayText(text: string, width: number): string {
    let col = 0;
    let out = '';
    for (const ch of text) {
      const w = getDisplayWidth(ch);
      if (w <= 0 || col + w > width) break;
      out += ch;
      col += w;
    }
    return out;
  }
  return {
    buildGuidanceLine,
    buildViewTitle,
    buildBodyText,
    buildSectionHeader,
    buildKeyValueLine,
    buildShortcutLine,
    buildViewListRow,
    buildSearchInputLine,
    buildStatusPill,
    buildStatPill,
    buildMeterLine,
    buildEmptyState,
    buildSummaryBlock,
    buildDetailBlock,
  };
}
