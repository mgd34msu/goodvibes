import type { Line } from '@goodvibes-jev/engine/platform/platform/types';
import { getDisplayWidth, truncateDisplay } from '@goodvibes-jev/engine/platform/platform/utils';
import { GLYPHS } from '@goodvibes-jev/engine/platform/platform/presentation';
import { activeUiTones, registerThemeRefresh } from './theme.js';
// Build on the leaf primitives in ./polish-core.ts (palette + base line
// builders). polish-core has no back-edge to this file, so there is no cycle.
import { buildSelectableViewLine, DEFAULT_VIEW_PALETTE } from './polish-core.js';
import type { ViewPalette, StyledViewSegment } from './polish-core.js';
// ---------------------------------------------------------------------------
// Shared formatting primitives (the toolkit views standardize on).
//
// All are display-width aware (via getDisplayWidth / truncateDisplay) so they
// stay aligned across emoji, CJK, and other wide characters, never hand-roll
// .slice()/.padEnd() truncation or alignment in views.
// ---------------------------------------------------------------------------
export type ColumnAlign = 'left' | 'right' | 'center';
export interface ColumnSpec {
  /** Fixed display width of the column. */
  readonly width: number;
  /** Horizontal alignment within the column. Default 'left'. */
  readonly align?: ColumnAlign | undefined;
}
export interface AlignedCell {
  readonly text: string;
  readonly fg: string;
  readonly bg?: string | undefined;
  readonly bold?: boolean | undefined;
  readonly dim?: boolean | undefined;
}
/** Truncate + pad `text` to exactly `width` display columns with alignment. */
function alignText(text: string, width: number, align: ColumnAlign): string {
  if (width <= 0) return '';
  const truncated = truncateDisplay(text, width);
  const pad = Math.max(0, width - getDisplayWidth(truncated));
  if (pad === 0) return truncated;
  if (align === 'right') return ' '.repeat(pad) + truncated;
  if (align === 'center') {
    const left = Math.floor(pad / 2);
    return ' '.repeat(left) + truncated + ' '.repeat(pad - left);
  }
  return truncated + ' '.repeat(pad);
}
/**
 * Build a multi-column row with display-width-aware alignment. Replaces manual
 * `.padEnd()`/`.padStart()` column math (which misaligns on wide chars).
 *
 * `cells` and `columns` are zip-aligned by index; extra cells are ignored.
 */
export function buildAlignedRow(
  width: number,
  cells: ReadonlyArray<AlignedCell>,
  columns: ReadonlyArray<ColumnSpec>,
  options: {
    readonly gap?: number | undefined;
    readonly selected?: boolean | undefined;
    readonly selectedBg?: string | undefined;
    readonly marker?: string | undefined;
    readonly fillBg?: string | undefined;
  } = {},
): Line {
  const gap = options.gap ?? 1;
  const segments: StyledViewSegment[] = [];
  const count = Math.min(cells.length, columns.length);
  for (let i = 0; i < count; i++) {
    const col = columns[i]!;
    const cell = cells[i]!;
    if (i > 0 && gap > 0) segments.push({ text: ' '.repeat(gap), fg: cell.fg, bg: cell.bg });
    segments.push({
      text: alignText(cell.text, col.width, col.align ?? 'left'),
      fg: cell.fg,
      bg: cell.bg,
      bold: cell.bold,
      dim: cell.dim,
    });
  }
  return buildSelectableViewLine(width, segments, {
    selected: options.selected,
    selectedBg: options.selectedBg,
    fillBg: options.fillBg,
    leadingMarker: options.marker,
  });
}
export type StatusBadgeKind = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked' | 'review';
interface BadgeSpec {
  readonly glyph: string;
  readonly fg: string;
  readonly label: string;
}
function buildStatusBadges(): Record<StatusBadgeKind, BadgeSpec> {
  const tones = activeUiTones();
  return {
    pending: { glyph: GLYPHS.status.pending, fg: DEFAULT_VIEW_PALETTE.info, label: 'Pending' },
    running: { glyph: GLYPHS.status.active, fg: tones.state.active, label: 'Running' },
    completed: { glyph: GLYPHS.status.success, fg: DEFAULT_VIEW_PALETTE.good, label: 'Completed' },
    failed: { glyph: GLYPHS.status.failure, fg: DEFAULT_VIEW_PALETTE.bad, label: 'Failed' },
    cancelled: { glyph: GLYPHS.status.skipped, fg: DEFAULT_VIEW_PALETTE.dim, label: 'Cancelled' },
    blocked: { glyph: GLYPHS.status.blocked, fg: tones.state.blocked, label: 'Blocked' },
    review: { glyph: GLYPHS.status.review, fg: DEFAULT_VIEW_PALETTE.info, label: 'Review' },
  };
}
// Rebuilt in place on every theme change (registered after the base palette's
// own refresher, so DEFAULT_VIEW_PALETTE already carries the new values).
const STATUS_BADGES: Record<StatusBadgeKind, BadgeSpec> = buildStatusBadges();
registerThemeRefresh(() => Object.assign(STATUS_BADGES, buildStatusBadges()));
/**
 * Canonical status badge (glyph + label) with a consistent color per lifecycle
 * state. Returns StyledViewSegment[], spread into a buildViewLine call:
 *   buildViewLine(width, [['  ', C.label], ...buildStatusBadge('running')])
 * Supersedes ad-hoc per-view status→color maps.
 */
export function buildStatusBadge(
  kind: StatusBadgeKind,
  label?: string | undefined,
  opts?:
    | {
        glyph?: string | undefined;
        bg?: string | undefined;
        count?: number | undefined;
      }
    | undefined,
): StyledViewSegment[] {
  const spec = STATUS_BADGES[kind];
  const glyph = opts?.glyph ?? spec.glyph;
  const text = label ?? spec.label;
  const rendered = opts?.count !== undefined ? `${glyph} ${text} (${opts.count})` : `${glyph} ${text}`;
  return [{ text: rendered, fg: spec.fg, bg: opts?.bg }];
}
export interface TreeItemSpec {
  readonly depth: number;
  readonly label: string;
  readonly icon?: string | undefined;
  readonly expandable?: boolean | undefined;
  readonly expanded?: boolean | undefined;
  readonly labelColor?: string | undefined;
  /** Right-aligned metadata columns (e.g. size, mtime). */
  readonly metadata?:
    | ReadonlyArray<{
        text: string;
        fg: string;
      }>
    | undefined;
}
/**
 * Build a hierarchical tree row: indentation + expand/collapse glyph + optional
 * icon + label, with right-aligned metadata. Replaces hand-rolled indentation
 * in file-explorer / symbol-outline / orchestration views.
 */
export function buildTreeRow(
  width: number,
  item: TreeItemSpec,
  palette: ViewPalette,
  options: {
    selected?: boolean | undefined;
    selectedBg?: string | undefined;
    indentWidth?: number | undefined;
  } = {},
): Line {
  const indent = ' '.repeat(Math.max(0, item.depth) * (options.indentWidth ?? 2));
  const toggle = item.expandable ? (item.expanded ? GLYPHS.navigation.expanded : GLYPHS.navigation.collapsed) : ' ';
  const iconPart = item.icon ? `${item.icon} ` : '';
  const prefix = `${indent}${toggle} ${iconPart}`;
  const prefixW = getDisplayWidth(prefix);
  const metadata = item.metadata ?? [];
  const metaText = metadata.map((m) => m.text).join(' ');
  const metaW = getDisplayWidth(metaText);
  const reserve = metaW > 0 ? metaW + 1 : 0;
  const labelBudget = Math.max(0, width - prefixW - reserve);
  const label = truncateDisplay(item.label, labelBudget);
  const usedW = prefixW + getDisplayWidth(label);
  const segments: StyledViewSegment[] = [
    { text: prefix, fg: palette.dim },
    { text: label, fg: item.labelColor ?? palette.value },
  ];
  if (metaW > 0) {
    const spacer = Math.max(1, width - usedW - metaW);
    segments.push({ text: ' '.repeat(spacer), fg: palette.dim });
    metadata.forEach((m, i) => {
      if (i > 0) segments.push({ text: ' ', fg: palette.dim });
      segments.push({ text: m.text, fg: m.fg });
    });
  }
  return buildSelectableViewLine(width, segments, {
    selected: options.selected,
    selectedBg: options.selectedBg ?? palette.selectBg,
  });
}
export interface TableColumn {
  readonly label: string;
  /** Fixed width; omit to auto-distribute remaining space. */
  readonly width?: number | undefined;
  readonly align?: ColumnAlign | undefined;
}
export interface TableCell {
  readonly text: string;
  readonly fg?: string | undefined;
  readonly bg?: string | undefined;
  readonly bold?: boolean | undefined;
}
export interface TableRow {
  readonly cells: ReadonlyArray<TableCell>;
  readonly selected?: boolean | undefined;
}
/** Resolve concrete per-column widths, auto-distributing any unsized columns. */
function resolveColumnWidths(width: number, columns: ReadonlyArray<TableColumn>, gap: number): number[] {
  const totalGap = gap * Math.max(0, columns.length - 1);
  const explicit = columns.reduce((s, c) => s + (c.width ?? 0), 0);
  const autoIdx = columns.map((c, i) => (c.width === undefined ? i : -1)).filter((i) => i >= 0);
  const autoBudget = Math.max(0, width - totalGap - explicit);
  const each = autoIdx.length > 0 ? Math.floor(autoBudget / autoIdx.length) : 0;
  const widths = columns.map((c) => c.width ?? each);
  if (autoIdx.length > 0) {
    const used = each * autoIdx.length;
    const lastAuto = autoIdx.at(-1);
    if (lastAuto !== undefined) widths[lastAuto] = (widths[lastAuto] ?? 0) + autoBudget - used; // remainder to last auto col
  }
  return widths;
}
/**
 * Build a table: a header row plus aligned data rows. Replaces ad-hoc
 * row/column offset math in history/ledger/roster views.
 */
export function buildTable(
  width: number,
  columns: ReadonlyArray<TableColumn>,
  rows: ReadonlyArray<TableRow>,
  palette: ViewPalette,
  options: {
    gap?: number | undefined;
    selectedBg?: string | undefined;
  } = {},
): Line[] {
  const gap = options.gap ?? 1;
  const widths = resolveColumnWidths(width, columns, gap);
  const specs: ColumnSpec[] = columns.map((c, i) => ({ width: widths[i]!, align: c.align }));
  const header = buildAlignedRow(
    width,
    columns.map((c) => ({ text: c.label, fg: palette.label, bold: true })),
    specs,
    { gap },
  );
  const dataRows = rows.map((row) =>
    buildAlignedRow(
      width,
      columns.map((_, i) => {
        const cell = row.cells[i] ?? { text: '', fg: palette.value };
        return { text: cell.text, fg: cell.fg ?? palette.value, bg: cell.bg, bold: cell.bold };
      }),
      specs,
      { gap, selected: row.selected, selectedBg: options.selectedBg ?? palette.selectBg },
    ),
  );
  return [header, ...dataRows];
}
