import type { Line } from '@goodvibes-jev/engine/sdk/platform/types';
import { createEmptyLine, createStyledCell } from '@goodvibes-jev/engine/sdk/platform/types';
import { getDisplayWidth } from '@goodvibes-jev/engine/sdk/platform/utils';
import { activeUiTones, registerThemeRefresh } from './theme.js';
// ---------------------------------------------------------------------------
// View palette + core line primitives.
//
// The leaf foundation of the view formatting toolkit: both `polish.ts` and
// `polish-tables.ts` build on these. Kept dependency-free (only grid /
// terminal-width / ui-primitives) so it never participates in an import cycle.
// All symbols are re-exported from `polish.ts`, views import from there.
// ---------------------------------------------------------------------------
export interface ViewPalette {
  readonly label: string;
  readonly value: string;
  readonly dim: string;
  readonly info: string;
  readonly good?: string | undefined;
  readonly warn?: string | undefined;
  readonly bad?: string | undefined;
  readonly empty: string;
  readonly header?: string | undefined;
  readonly headerBg?: string | undefined;
  readonly surfaceBg?: string | undefined;
  readonly sectionBg?: string | undefined;
  readonly summaryBg?: string | undefined;
  readonly inputBg?: string | undefined;
  readonly accent?: string | undefined;
  readonly selectBg?: string | undefined;
}
// Built from the mode-resolved chrome tones (activeUiTones). Because 100+ call
// sites read this object by reference, mode changes rebuild it IN PLACE via the
// registered refresher below rather than re-resolving per call, see theme.ts's
// active-mode runtime note. This refresher is registered before any view's
// extendPalette() runs (views import polish → polish-core first), so on a mode
// flip the base is rebuilt before the extended palettes re-merge from it.
function buildViewPalette(): Required<ViewPalette> {
  const t = activeUiTones();
  return {
    header: t.fg.primary,
    headerBg: t.bg.title,
    label: t.fg.muted,
    value: t.fg.primary,
    dim: t.fg.dim,
    info: t.state.info,
    good: t.state.good,
    warn: t.state.warn,
    bad: t.state.bad,
    empty: t.fg.empty,
    surfaceBg: t.bg.surface,
    sectionBg: t.bg.section,
    summaryBg: t.bg.summary,
    inputBg: t.bg.input,
    accent: t.fg.secondary,
    selectBg: t.bg.selected,
  };
}
export const DEFAULT_VIEW_PALETTE: Readonly<Required<ViewPalette>> = buildViewPalette();
registerThemeRefresh(() => Object.assign(DEFAULT_VIEW_PALETTE as Required<ViewPalette>, buildViewPalette()));
/**
 * Extend the base view palette with domain-specific colors.
 *
 * `extras` is a builder that reads theme tokens (activeTokens() /
 * activeUiTones()); it runs now and again on every theme or mode change, so
 * the domain colors follow the active theme. Raw hex literals do not belong
 * in extras: map each domain color onto a theme token.
 *
 * @example
 * ```ts
 * const C = extendPalette(DEFAULT_VIEW_PALETTE, () => {
 *   const p = activeTokens();
 *   return { decision: p.info, incident: p.error };
 * });
 * ```
 */
export function extendPalette<T extends Record<string, string>>(
  base: typeof DEFAULT_VIEW_PALETTE,
  extras: () => T,
): typeof DEFAULT_VIEW_PALETTE & T {
  const merged = { ...base, ...extras() } as typeof DEFAULT_VIEW_PALETTE & T;
  // Self-register an in-place rebuild so every extendPalette-derived view
  // palette tracks the active theme with zero per-view churn. Runs AFTER the
  // base refresher (registered at module eval, before any view calls this),
  // so `base` already carries the new values when the extras are rebuilt.
  registerThemeRefresh(() => Object.assign(merged as Record<string, string>, base, extras()));
  return merged;
}
export function buildViewLine(width: number, segments: Array<StyledViewSegment | [string, string, string?]>): Line {
  return buildStyledViewLine(
    width,
    segments.map((seg) => (Array.isArray(seg) ? { text: seg[0], fg: seg[1], bg: seg[2] } : seg)),
  );
}
export interface StyledViewSegment {
  readonly text: string;
  readonly fg: string;
  readonly bg?: string | undefined;
  readonly bold?: boolean | undefined;
  readonly dim?: boolean | undefined;
}
export function buildSelectableViewLine(
  width: number,
  segments: ReadonlyArray<StyledViewSegment>,
  options: {
    selected?: boolean | undefined;
    selectedBg?: string | undefined;
    fillFg?: string | undefined;
    fillBg?: string | undefined;
    leadingMarker?: string | undefined;
  } = {},
): Line {
  const selected = options.selected ?? false;
  const selectedBg = selected ? (options.selectedBg ?? DEFAULT_VIEW_PALETTE.selectBg) : '';
  const fillBg = selectedBg || options.fillBg || '';
  const fillFg = options.fillFg ?? '';
  const cells = createEmptyLine(width);
  if (fillBg) {
    for (let col = 0; col < width; col++) {
      cells[col] = createStyledCell(' ', { bg: fillBg, fg: fillFg });
    }
  }
  let col = 0;
  if (selected && options.leadingMarker) {
    for (const ch of options.leadingMarker) {
      const charWidth = getDisplayWidth(ch);
      if (charWidth <= 0 || col + charWidth > width) break;
      cells[col] = createStyledCell(ch, { fg: DEFAULT_VIEW_PALETTE.info, bg: selectedBg, bold: true });
      if (charWidth > 1 && col + 1 < width)
        cells[col + 1] = createStyledCell(' ', { fg: DEFAULT_VIEW_PALETTE.info, bg: selectedBg, bold: true });
      col += charWidth;
    }
  }
  for (const segment of segments) {
    const fg = segment.fg;
    const bg = segment.bg ?? fillBg;
    for (const ch of segment.text) {
      const charWidth = getDisplayWidth(ch);
      if (charWidth <= 0) continue;
      if (col + charWidth > width) return cells;
      cells[col] = createStyledCell(ch, {
        fg,
        bg,
        bold: segment.bold ?? false,
        dim: segment.dim ?? false,
      });
      if (charWidth > 1 && col + 1 < width) {
        cells[col + 1] = createStyledCell(' ', {
          fg,
          bg,
          bold: segment.bold ?? false,
          dim: segment.dim ?? false,
        });
      }
      col += charWidth;
    }
  }
  while (col < width) {
    cells[col++] = createStyledCell(' ', { bg: fillBg, fg: fillFg });
  }
  return cells;
}
export function buildStyledViewLine(
  width: number,
  segments: ReadonlyArray<StyledViewSegment>,
  options: {
    fillBg?: string | undefined;
    fillFg?: string | undefined;
  } = {},
): Line {
  return buildSelectableViewLine(width, segments, options);
}
