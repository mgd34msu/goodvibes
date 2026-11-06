import { activeTokens } from './theme.js';
import { filterGroups, type HelpGroup } from './help-groups.js';
import { beginModal, finishModal, searchRow, scrollCountText, type KitHint, type SurfaceLayer } from './surface-kit.js';
import { drawList, listScrollEnd, type KitRow } from './surface-kit-list.js';
import { drawTextBlock } from './surface-kit-extra.js';
export interface HelpOverlayFilter {
  readonly query: string;
  maxScroll: number;
}
const HELP_HINTS: readonly KitHint[] = [
  ['↑↓', 'scroll'],
  ['?', 'close'],
];
export function createHelpBrowser<Keybindings, Command>(
  groupsFor: (keybindings: Keybindings, commands?: Command[]) => HelpGroup[],
  catalogNote?: string,
) {
  function renderHelpOverlay(
    screenWidth: number,
    screenHeight: number,
    keybindingsManager: Keybindings,
    commands?: Command[],
    scrollOffset = 0,
    filter?: HelpOverlayFilter,
  ): SurfaceLayer {
    const t = activeTokens();
    const query = filter?.query ?? '';
    const all = groupsFor(keybindingsManager, commands);
    const groups = filterGroups(all, query);
    const f = beginModal(screenWidth, screenHeight, { title: 'Help', hints: HELP_HINTS });
    const total = all.reduce((n, g) => n + g.entries.length, 0);
    const shown = groups.reduce((n, g) => n + g.entries.length, 0);
    searchRow(f, f.top, query, 'Filter commands and shortcuts', query ? `${shown} of ${total}` : `${total} entries`);

    const top = f.top + 2;
    if (groups.length === 0) {
      if (filter) filter.maxScroll = 0;
      drawTextBlock(f.canvas, f.l, top, f.r - f.l + 1, [{ text: `Nothing matches "${query}".`, style: { fg: t.textMuted } }], f.bottom);
      return finishModal(f);
    }

    const rows: KitRow[] = [];
    for (const g of groups) {
      rows.push({ header: g.title });
      for (const e of g.entries) rows.push({ label: e.label, right: e.right });
    }
    if (catalogNote && !query && commands?.length) rows.push({ label: catalogNote, labelFg: t.textFaint });
    // The furthest start that still fills the list, by drawList's own spacing rules.
    const listOptions = { rows, top, bottom: f.bottom, x0: f.l, x1: f.r };
    const maxStart = listScrollEnd(f.canvas, listOptions);
    if (filter) filter.maxScroll = maxStart;
    const res = drawList(f.canvas, { ...listOptions, scrollStart: Math.min(scrollOffset, maxStart) });
    f.hintRight = scrollCountText(res.above, res.below);
    return finishModal(f);
  }
  return { renderHelpOverlay };
}
