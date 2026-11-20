/**
 * renderAutocompleteOverlay, the slash-command popup.
 *
 * Anchored to the composer with no dimming (you are still typing): the same
 * width as the composer, a ┃ bar on its left edge, the surface fill, and no
 * frame or hint rows. The selected command description occupies a separate area above the
 * uninterrupted command list, with "tab complete" beside the selected name. When the list is
 * longer than the popup, its last row carries a muted "12 more ↓" count.
 */

import { createEmptyLine, type Line } from '@goodvibes-jev/engine/platform/platform/types';
import type { AutocompleteEngine } from '../autocomplete.js';
import { renderPopup } from './surface-kit-parts.js';
import type { KitRow } from './surface-kit-list.js';

/** Rows the popup may use at most (it shrinks to its content). */
function popupRows(viewportHeight: number): number {
  return Math.max(3, Math.min(12, Math.floor(viewportHeight * 0.5)));
}

export function renderAutocompleteOverlay(
  autocomplete: Pick<AutocompleteEngine, 'getState'>,
  width: number,
  viewportHeight = 24,
  leadingGap = false,
): Line[] {
  const state = autocomplete.getState();
  const argument = state.argument;
  if (argument && state.active) {
    // Past a described command's name: its actions, the blank's values, or its options.
    const rows: KitRow[] = [
      { header: argument.pending ? `${argument.header}: reading…` : argument.header },
      ...argument.items.map((item, index) => ({
        label: item.label,
        detail: item.detail,
        right: index === state.selectedIndex ? 'tab complete' : undefined,
        selected: index === state.selectedIndex,
      })),
    ];
    const lines = renderPopup({ width, rows, maxRows: popupRows(viewportHeight), scrollOwner: autocomplete }).lines;
    return leadingGap ? [createEmptyLine(width), ...lines] : lines;
  }
  if (!state.active || state.results.length === 0) return [];
  const rows: KitRow[] = state.results.map((result, index) => ({
    label: `/${result.command.name}`,
    detail: result.command.description,
    right: index === state.selectedIndex ? 'tab complete' : undefined,
    selected: index === state.selectedIndex,
  }));
  const lines = renderPopup({ width, rows, maxRows: popupRows(viewportHeight), scrollOwner: autocomplete }).lines;
  return leadingGap ? [createEmptyLine(width), ...lines] : lines;
}

/** The static strings this surface can show (checked by package verification). */
export function renderAutocompletePackageText(): string {
  return [
    '/<command>',
    'tab complete',
    '<n> more ↓',
    'Actions',
    'Options',
    '<blank>: reading…',
  ].join('\n');
}
