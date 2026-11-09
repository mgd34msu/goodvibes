import type { Line } from '@goodvibes-jev/engine/platform/platform/types';
import { fitDisplay, getDisplayWidth, truncateDisplay } from '@goodvibes-jev/engine/platform/platform/utils';
import { createBottomBarLine, writeBottomBarText } from '../bottom-bar.js';
import { activeTokens } from './theme.js';
import { keycapHintsWidth, paintKeycapHints } from './surface-kit-parts.js';
import type { KitHint } from './surface-kit.js';

export interface SearchOverlayView {
  readonly matches: readonly unknown[];
  readonly currentMatch: number;
  readonly query: string;
  readonly locked: boolean;
  readonly wrapAround?: boolean | undefined;
}
const LABEL = ' Find: ';
const LOCKED_HINTS: KitHint[] = [
  ['↑↓ jk', 'navigate'],
  ['bksp', 'edit'],
  ['esc', 'close'],
];
const UNLOCKED_HINTS: KitHint[] = [
  ['⏎ tab', 'lock'],
  ['esc', 'close'],
];
/** Preserve each product's hints while sharing search-state projection and bar painting. */
export function createSearchOverlayRenderer(style: 'text' | 'keycaps') {
  return (manager: SearchOverlayView, width: number): Line[] => {
    const count = manager.matches.length
      ? `${manager.currentMatch + 1}/${manager.matches.length}${style === 'text' ? (manager.wrapAround ? ' (wrap)' : '') : ' up/down'}`
      : manager.query.length
        ? 'No matches'
        : '';
    const locked = manager.locked;
    const leftPart = LABEL + manager.query + (locked ? '' : '█');
    let match = count ? ` ${count}` : '',
      hints = '',
      leftWidth: number;
    const caps = locked ? LOCKED_HINTS : UNLOCKED_HINTS;
    const capsWidth = keycapHintsWidth(caps);
    let showCaps = false;
    if (style === 'text') {
      const minimum = getDisplayWidth(LABEL) + 4;
      const space = () => width - getDisplayWidth(hints) - getDisplayWidth(match) - 2;
      hints = locked ? '  [n/N] next/prev  [jk] navigate  [Bksp] edit  [Esc] close' : '  [Enter/Tab] lock  [Esc] close';
      if (space() < minimum) hints = locked ? '  [n/N]  [Esc]' : '  [Esc]';
      if (space() < minimum) hints = '';
      if (space() < minimum && match.length) match = '';
      leftWidth = Math.max(1, Math.min(width, space()));
    } else {
      showCaps = width - capsWidth - 2 - getDisplayWidth(match) >= getDisplayWidth(LABEL) + 8;
      leftWidth = Math.max(1, width - getDisplayWidth(match) - (showCaps ? capsWidth + 4 : 1));
    }
    const left = fitDisplay(getDisplayWidth(leftPart) > leftWidth ? truncateDisplay(leftPart, leftWidth) : leftPart, leftWidth);
    const p = activeTokens(),
      colors = { fg: p.selectedListItemText, bg: p.accent };
    const line = createBottomBarLine(width, colors);
    if (style === 'text') writeBottomBarText(line, 0, width, fitDisplay(truncateDisplay(left + match + hints + ' ', width), width), colors);
    else writeBottomBarText(line, 0, leftWidth, left, colors);
    if (match.length) writeBottomBarText(line, getDisplayWidth(left), getDisplayWidth(match), match, { ...colors, dim: true });
    if (showCaps) paintKeycapHints(line, width - capsWidth - 2, width - 2, caps, colors);
    return [line];
  };
}
export function renderSearchOverlayPackageText(): string {
  return [
    LABEL.trim(),
    '<current>/<total> up/down',
    'No matches',
    ...LOCKED_HINTS.map(([, action]) => action),
    ...UNLOCKED_HINTS.map(([, action]) => action),
  ].join('\n');
}
