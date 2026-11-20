/**
 * renderFilePickerOverlay, the @ file popup.
 *
 * Anchored to the composer with no dimming, the same shape as the slash
 * popup (┃ bar, surface fill, no frame, no hint rows). Its first row is the
 * typed query ("@ query▏" and the match count), since the query lives in the
 * picker rather than the composer. Fuzzy-matched letters of the file name are
 * drawn in the brand color; the directory part is dimmer than the name, so
 * the path dims toward the root.
 */

import type { Line } from '@goodvibes/engine/platform/platform/types';
import type { FilePickerModal } from '../file-picker.js';
import { activeTokens } from './theme.js';
import { renderPopup } from './surface-kit-parts.js';
import { lazyRows, type KitRow, type KitRowSource, type KitSpan } from './surface-kit-list.js';

function popupRows(viewportHeight: number): number {
  return Math.max(4, Math.min(12, Math.floor(viewportHeight * 0.5)));
}

/** Split a path into directory and name spans, marking the query's letters (in order) in the name. */
function fileSpans(file: string, query: string, selected: boolean): KitSpan[] {
  const t = activeTokens();
  const trimmed = file.endsWith('/') ? file.slice(0, -1) : file;
  const cut = trimmed.lastIndexOf('/') + 1;
  const dir = file.slice(0, cut);
  const name = file.slice(cut);
  const spans: KitSpan[] = [];
  if (dir) spans.push({ text: dir, fg: t.textFaint });
  const wanted = [...query.toLowerCase()].filter((ch) => ch !== ' ');
  let q = 0;
  let run = '';
  let runHit = false;
  const flush = (): void => {
    if (run) spans.push({ text: run, fg: runHit && !selected ? t.brand : t.text, bold: selected || runHit });
    run = '';
  };
  for (const ch of name) {
    const hit = q < wanted.length && ch.toLowerCase() === wanted[q];
    if (hit) q++;
    if (run && hit !== runHit) flush();
    runHit = hit;
    run += ch;
  }
  flush();
  return spans;
}

export function renderFilePickerOverlay(
  picker: FilePickerModal,
  width: number,
  viewportHeight = 24,
): Line[] {
  const t = activeTokens();
  const count = picker.results.length === 0 ? '' : `${picker.results.length} file${picker.results.length === 1 ? '' : 's'}`;
  const header: KitRow = {
    spans: [
      { text: `@${picker.query}`, fg: t.text, bold: true },
      { text: '▏', fg: t.brand },
    ],
    // The header stays visible while the list scrolls, so a partial walk is flagged here.
    right: picker.truncated ? `${count ? `${count} ` : ''}(list truncated)` : count || undefined,
  };
  let rows: KitRowSource;
  if (picker.results.length === 0) {
    const empty = picker.loadError ?? (picker.query ? 'No matching files' : picker.listed ? 'No files here' : 'Loading files…');
    rows = [{ label: picker.truncated && !picker.loadError ? `${empty} (more files exist than were listed)` : empty, muted: true }];
  } else {
    // Only the rows on screen are built: the list can hold thousands of files.
    const { results, query, selectedIndex } = picker;
    rows = lazyRows(results.length, (index): KitRow => {
      const selected = index === selectedIndex;
      return { spans: fileSpans(results[index]!, query, selected), selected };
    });
  }
  const activeIndex = picker.results.length === 0 ? undefined : picker.selectedIndex;
  return renderPopup({ width, rows, activeIndex, header, maxRows: popupRows(viewportHeight), scrollOwner: picker }).lines;
}

/** The static strings this surface can show (checked by package verification). */
export function renderFilePickerPackageText(): string {
  return [
    '@<query>',
    '<n> files',
    'No matching files',
    'No files here',
    'Loading files…',
    'File listing unavailable. Close and reopen to retry.',
  ].join('\n');
}
