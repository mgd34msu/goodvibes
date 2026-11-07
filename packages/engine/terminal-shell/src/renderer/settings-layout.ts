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
}
/** Settings adapt their documentation pager to the shared list/context element. */
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
    const doc = policy.docLines(modal, selected >= 0, width);
    return drawList(f.canvas, {
      rows,
      activeIndex: selected,
      top: p.top,
      bottom,
      x0: sx,
      x1: sr,
      context: { lines: doc, window: capacity => policy.windowDoc(modal, doc, capacity) },
      scrollKey: { owner: modal, name: modal.searchFocused ? 'search' : `category:${modal.currentCategory}` },
    });
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
