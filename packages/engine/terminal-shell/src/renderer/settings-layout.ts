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
import { drawRow, drawScrollingList, measureRow, rememberStart, rememberedStart, type KitRow } from './surface-kit-list.js';
import { inset, type KitInset } from './surface-kit-parts.js';
import type { DocLine } from './settings-documentation.js';
export interface SettingsLayoutModal {
  readonly editingMode: boolean;
  readonly searchFocused: boolean;
  readonly searchQuery: string;
  readonly searchResults: readonly unknown[];
  readonly currentCategory: string;
}
/** Common settings viewport allocation, selected-row documentation and scrolling. */
export function createSettingsLayout<Modal extends SettingsLayoutModal>(policy: {
  readonly listRows: (modal: Modal, width: number) => { rows: KitRow[]; selected: number };
  readonly categoryRows: (modal: Modal) => KitRow[];
  readonly categoryLabel: (modal: Modal) => string;
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
    const capacity = Math.max(1, bottom - p.top + 1);
    const doc = policy.docLines(modal, selected >= 0, width);

    if (selected < 0) {
      let y = p.top;
      for (const row of rows) y += drawRow(f.canvas, y, row, sx, sr, bottom);
      if (rows.length > 0) y++;
      for (const line of policy.windowDoc(modal, doc, Math.max(1, bottom - y + 1))) {
        if (y > bottom) break;
        f.canvas.put(sx, y++, line.text, { fg: line.fg, bold: line.bold });
      }
      return { above: 0, below: 0 };
    }

    const heights = rows.map((row) => measureRow(row, sx, sr));
    // The documentation takes what the rows leave, but never less than a few lines.
    const rowsTotal = heights.reduce((a, b) => a + b, 0);
    const docBudget = Math.max(3, Math.min(doc.length, capacity - Math.min(rowsTotal, Math.max(3, Math.floor(capacity * 0.35))) - 2));
    const shownDoc = policy.windowDoc(modal, doc, docBudget);
    const blockH = shownDoc.length > 0 ? shownDoc.length + 2 : 0;
    const rowCapacity = Math.max(1, capacity - blockH);

    // Scroll so the selected row (and its block) is in view; the window only
    // moves when the selection leaves it.
    const listName = modal.searchFocused ? 'search' : `category:${modal.currentCategory}`;
    const scrollKey = { owner: modal, name: listName };
    let start = Math.max(0, Math.min(rememberedStart(scrollKey) ?? 0, rows.length - 1));
    const span = (from: number, to: number): number => heights.slice(from, to + 1).reduce((a, b) => a + b, 0);
    if (selected < start) start = selected;
    while (start < selected && span(start, selected) > rowCapacity) start++;
    while (start > 0 && span(start - 1, rows.length - 1) <= rowCapacity) start--;
    rememberStart(scrollKey, start);

    let y = p.top;
    let last = start - 1;
    for (let i = start; i < rows.length; i++) {
      const row = rows[i];
      const height = heights[i];
      if (!row || height === undefined || y + height - 1 > bottom) break;
      y += drawRow(f.canvas, y, row, sx, sr, bottom);
      last = i;
      if (i === selected && shownDoc.length > 0) {
        y++;
        for (const line of shownDoc) {
          if (y > bottom) break;
          f.canvas.put(sx, y++, line.text, { fg: line.fg, bold: line.bold });
        }
        y++;
      }
    }
    return { above: start, below: Math.max(0, rows.length - last - 1) };
  }
  function renderSettingsModal(modal: Modal, screenWidth: number, screenHeight = 24): SurfaceLayer {
    const crumbs = policy.breadcrumbs(modal);
    const f = beginModal(screenWidth, screenHeight, { title: 'Settings', crumbs, hints: policy.hints(modal) });

    const count = modal.searchFocused
      ? `${modal.searchResults.length} result${modal.searchResults.length === 1 ? '' : 's'}`
      : policy.categoryLabel(modal).toLowerCase();
    searchRow(f, f.top, modal.searchQuery, 'Search all settings', count);

    const body = f.top + 2;
    const inner = f.r - f.l + 1;
    let detailX = 2;
    // Search spans every category, so the category list steps aside for it.
    if (inner >= 56 && !modal.searchFocused) {
      const catW = Math.max(18, Math.min(26, Math.round(inner * 0.22)));
      const x1 = f.l + catW - 1;
      drawScrollingList(f.canvas, {
        rows: policy.categoryRows(modal),
        top: body,
        bottom: f.bottom,
        x0: f.l,
        x1,
        scrollKey: { owner: modal, name: 'categories' },
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

export function settingsCategoryRows<Category extends string>(options: {
  readonly groups: readonly { readonly label: string; readonly categories: readonly Category[] }[];
  readonly categories: readonly Category[];
  readonly categoryIndex: number;
  readonly searching: boolean;
  readonly focused: boolean;
  readonly label: (category: Category) => string;
  readonly count: (category: Category) => number;
  readonly onSelect?: ((category: Category) => void) | undefined;
}): KitRow[] {
  const rows: KitRow[] = [];
  for (const group of options.groups) {
    const categories = group.categories.filter((category) => options.categories.includes(category));
    if (!categories.length) continue;
    rows.push({ header: group.label });
    for (const category of categories) {
      const active = options.categories.indexOf(category) === options.categoryIndex && !options.searching;
      const count = options.count(category);
      rows.push({
        ...(options.onSelect ? { onClick: () => options.onSelect?.(category) } : {}),
        label: options.label(category),
        right: count > 0 ? String(count) : undefined,
        selected: active && options.focused,
        current: active && !options.focused,
      });
    }
  }
  return rows;
}
