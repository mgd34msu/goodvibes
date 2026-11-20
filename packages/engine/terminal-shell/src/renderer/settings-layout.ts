import { getDisplayWidth } from '@goodvibes/engine/platform/platform/utils/terminal-width';
import { activeTokens } from './theme.js';
import {
  beginModal,
  finishModal,
  scrollCountText,
  searchRow,
  wrapLines,
  type KitHint,
  type ModalFrame,
  type SurfaceLayer,
} from './surface-kit.js';
import { drawList, drawScrollingList, type KitRow } from './surface-kit-list.js';
import { inset, type KitInset } from './surface-kit-parts.js';
import type { DocLine } from './settings-documentation.js';
export interface SettingsLayoutModal {
  readonly editingMode: boolean;
  readonly searchFocused: boolean;
  readonly searchQuery: string;
  readonly searchResults: readonly unknown[];
  readonly currentCategory: string;
  readonly topicIndex: number;
  readonly openList: string | null;
}
/**
 * The settings screen of both terminal programs: the search row, the seven
 * topics on the left (they step aside while a search is shown), the rows on
 * the right, and under them the selected row's help in a few sentences.
 */
export function createSettingsLayout<Modal extends SettingsLayoutModal>(policy: {
  readonly listRows: (modal: Modal, width: number) => { rows: KitRow[]; selected: number };
  readonly topicRows: (modal: Modal) => KitRow[];
  readonly breadcrumbs: (modal: Modal) => string[];
  readonly hints: (modal: Modal) => KitHint[];
  readonly notices: (modal: Modal) => string[];
  readonly selectRow?: ((modal: Modal, index: number) => void) | undefined;
  readonly docLines: (modal: Modal, selected: boolean, width: number) => DocLine[];
  readonly windowDoc: (modal: Modal, lines: DocLine[], capacity: number) => DocLine[];
}) {
  function drawSettingsColumn(f: ModalFrame, modal: Modal, p: KitInset): { above: number; below: number } {
    const t = activeTokens();
    const sx = p.x + 4;
    const sr = p.x + p.w - 5;
    const width = sr - sx + 1;

    const notices = policy.notices(modal).flatMap((n) => wrapLines(n, width));
    const bottom = notices.length > 0 ? p.bottom - notices.length - 1 : p.bottom;
    notices.forEach((line, k) => f.canvas.put(sx, bottom + 2 + k, line, { fg: t.accent }));

    const { rows, selected } = policy.listRows(modal, width);
    if (!modal.editingMode && policy.selectRow)
      rows.forEach((row, index) => {
        rows[index] = { ...row, onClick: () => policy.selectRow?.(modal, index) };
      });
    const doc = policy.docLines(modal, selected >= 0, width);
    const area = Math.max(1, bottom - p.top + 1);
    // The help takes what it needs up to two fifths of the column, and never the
    // last rows the list needs to show the selection with a row either side.
    const docHeight = doc.length === 0 ? 0 : Math.max(0, Math.min(doc.length, Math.floor(area * 0.4), area - 4));
    const listBottom = docHeight > 0 ? bottom - docHeight - 1 : bottom;
    const result = drawList(f.canvas, {
      rows,
      activeIndex: selected,
      top: p.top,
      bottom: listBottom,
      x0: sx,
      x1: sr,
      scrollKey: { owner: modal, name: modal.searchFocused ? 'search' : modal.openList ?? `topic:${modal.topicIndex}` },
    });
    if (docHeight > 0) {
      // Right under the rows when they fit, at the foot of the column when they scroll.
      const docTop = Math.min(result.endY + 1, bottom - docHeight + 1);
      const shown = policy.windowDoc(modal, doc, docHeight);
      shown.forEach((line, k) => f.canvas.put(sx, docTop + k, line.text, { fg: line.fg, bold: line.bold === true }));
    }
    return result;
  }
  function renderSettingsModal(modal: Modal, screenWidth: number, screenHeight = 24): SurfaceLayer {
    const crumbs = policy.breadcrumbs(modal);
    const f = beginModal(screenWidth, screenHeight, { title: 'Settings', crumbs, hints: policy.hints(modal) });

    const count = modal.searchFocused ? `${modal.searchResults.length} result${modal.searchResults.length === 1 ? '' : 's'}` : undefined;
    searchRow(f, f.top, modal.searchQuery, 'Search settings by name, key or what they do', count);

    const body = f.top + 2;
    const inner = f.r - f.l + 1;
    let detailX = 2;
    // Search spans every topic, so the topics step aside for it.
    // Below about 100 columns the rail steps aside: the title names the topic and ↑↓ on the topics still switch it.
    if (inner >= 90 && !modal.searchFocused) {
      const rail = policy.topicRows(modal);
      const widest = rail.reduce((most, row) => Math.max(most, getDisplayWidth(row.label ?? '')), 0);
      const catW = Math.max(16, Math.min(24, widest + 4));
      const x1 = f.l + catW - 1;
      drawScrollingList(f.canvas, {
        rows: rail,
        top: body,
        bottom: f.bottom,
        x0: f.l,
        x1,
        scrollKey: { owner: modal, name: 'topics' },
      });
      detailX = x1 + 3;
    }
    const p = inset(f.canvas, detailX, body, f.r + 2 - detailX + 1, f.bottom - body + 1);
    const hidden = drawSettingsColumn(f, modal, p);
    f.hintRight = scrollCountText(hidden.above, hidden.below);
    return finishModal(f);
  }
  return { renderSettingsModal };
}

/** The topic rail: the seven topics in the web UI's order and words. */
export function settingsTopicRailRows(options: {
  readonly topics: readonly { readonly label: string }[];
  readonly topicIndex: number;
  readonly searching: boolean;
  readonly focused: boolean;
  readonly onSelect?: ((index: number) => void) | undefined;
}): KitRow[] {
  return options.topics.map((topic, index) => {
    const active = index === options.topicIndex && !options.searching;
    return {
      ...(options.onSelect ? { onClick: () => options.onSelect?.(index) } : {}),
      label: topic.label,
      selected: active && options.focused,
      current: active && !options.focused,
    };
  });
}
