import { mcpTrustRows } from '@goodvibes-jev/engine/terminal-shell/renderer/mcp-form-rows';
import { createSettingsDocumentation, fitValue } from '@goodvibes-jev/engine/terminal-shell/renderer/settings-documentation';
/**
 * renderSettingsModal, the settings modal drawn with the surface kit.
 *
 *   ✦ Settings › Display › Theme                                  esc
 *
 *   ▏Search all settings                                       display
 *
 *   ✦ interface          ┌ element inset ─────────────────────────────┐
 *     Display        9     ◇ Theme                        goodvibes
 *     UI             4       Color palette for the whole interface…
 *   ✦ ai routing             display.theme · default goodvibes · …
 *     Provider       7     Theme mode                          dark
 *
 *   ↑↓ move   ⏎ change   ←→ category   ctrl+r reset to default
 *
 * Search reaches every setting in every category at once (the search row is
 * always live). Categories on the left, plain rows on the right: name, value,
 * and a ◇ when the value differs from the default. The selected row explains
 * itself in place, wrapped in full, with its key, default, type and source
 * (PgUp/PgDn scroll long documentation). The breadcrumb in the title says
 * where you are. Changes to the theme preview live (see theme-settings-actions).
 */

import type { SettingsModal, SettingEntry, SettingsCategory } from '../input/settings-modal.ts';
import { SETTINGS_CATEGORIES, SETTINGS_CATEGORY_GROUPS } from '../input/settings-modal.ts';
import { isFeatureValueEnabled } from '@goodvibes-jev/engine/terminal-shell';
import { CATEGORY_LABELS, getSettingLabel, inferSubscriptionRouteReason, valueColor } from './settings-modal-helpers.ts';
import { connectionRows } from './settings-modal-connections.ts';
import { categoryItemCount, currentSettingValue, settingContextLines } from './settings-modal-context.ts';
import { activeTokens } from './theme.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import {
  beginModal,
  clipText,
  finishModal,
  scrollCountText,
  searchRow,
  tailText,
  wrapLines,
  type KitHint,
  type ModalFrame,
  type SurfaceLayer,
} from './surface-kit.ts';
import { drawRow, drawScrollingList, measureRow, rememberStart, rememberedStart, type KitRow } from './surface-kit-list.ts';
import { inset, type KitInset } from './surface-kit-parts.ts';

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * Keep a long value from crowding the name out (the documentation shows it in
 * full). While editing, the value gets all the room the label leaves, and a
 * draft longer than that keeps its end (where the cursor is) in view.
 */


function settingRow(modal: SettingsModal, entry: SettingEntry, selected: boolean, focused: boolean, width: number, category?: string): KitRow {
  const t = activeTokens();
  const editing = selected && modal.editingMode;
  const danger = modal.currentCategory === 'danger' && !modal.searchFocused;
  if (entry.flag) {
    const { feature, state, pendingRestart } = entry.flag;
    const configOn = isFeatureValueEnabled(feature, entry.currentValue);
    const raw = currentSettingValue(modal, entry, selected);
    // A startup-gated feature changed this session shows its saved value with
    // a restart-pending marker (⟳); the documentation spells it out.
    const value = pendingRestart ? `${raw} ⟳` : raw;
    return {
      label: feature.name,
      desc: [category, entry.metadataUnavailable ? 'unavailable' : ''].filter(Boolean).join(' · ') || undefined,
      right: fitValue(value, width, editing, feature.name),
      rightFg: valueColor(entry),
      mark: state === 'killed' ? '✕' : configOn ? '●' : '○',
      markFg: state === 'killed' ? t.error : configOn ? t.success : t.textFaint,
      selected: selected && focused,
      current: selected && !focused,
      labelFg: danger ? t.error : undefined,
    };
  }
  const flags = [entry.metadataUnavailable ? 'unavailable' : '', entry.locked ? 'locked' : '', entry.conflict ? 'conflict' : ''].filter(Boolean).join(' · ');
  const desc = [category, flags].filter(Boolean).join(' · ');
  return {
    // Sub-options of a feature unit read as part of the unit above them.
    label: entry.ownerFlagId ? `· ${getSettingLabel(entry)}` : getSettingLabel(entry),
    desc: desc || undefined,
    right: fitValue(currentSettingValue(modal, entry, selected), width, editing, getSettingLabel(entry)),
    rightFg: valueColor(entry),
    mark: entry.isDefault ? undefined : '◇',
    markFg: t.warning,
    selected: selected && focused,
    current: selected && !focused,
    labelFg: danger ? t.error : undefined,
  };
}

function categoryOf(entry: SettingEntry): string {
  const prefix = entry.setting.key.split('.')[0] ?? '';
  return CATEGORY_LABELS[prefix as SettingsCategory] ?? prefix;
}

/** The rows of the right-hand list for the current view, and which one is selected. */
function listRows(modal: SettingsModal, width: number): { rows: KitRow[]; selected: number } {
  const focused = modal.searchFocused || (modal.focusRegion ?? 'settings') === 'settings';
  const clampIndex = (n: number): number => Math.max(0, Math.min(modal.selectedIndex, n - 1));
  if (modal.searchFocused) {
    const results = modal.searchResults;
    if (results.length === 0) return { rows: [], selected: -1 };
    const sel = clampIndex(results.length);
    return { rows: results.map((entry, i) => settingRow(modal, entry, i === sel, true, width, categoryOf(entry))), selected: sel };
  }
  const t = activeTokens();
  switch (modal.currentCategory) {
    case 'mcp': {
      const items = modal.mcpEntries;
      if (items.length === 0) return { rows: [{ label: 'No MCP servers registered.', muted: true }], selected: -1 };
      const sel = clampIndex(items.length);
      return {
        rows: mcpTrustRows(items, sel, focused, modal.editingMode, modal.editBuffer),
        selected: sel,
      };
    }
    case 'subscriptions': {
      const items = modal.subscriptionEntries;
      if (items.length === 0) return { rows: [{ label: 'No provider subscriptions available or configured.', muted: true }], selected: -1 };
      const sel = clampIndex(items.length);
      return {
        rows: items.map((entry, i) => ({
          label: entry.provider,
          desc: [entry.activeRoute ?? '', entry.authFreshness ?? '', inferSubscriptionRouteReason(entry) ?? ''].filter(Boolean).join(' · ') || undefined,
          right: entry.state,
          rightFg: entry.state === 'active' ? t.success : undefined,
          selected: i === sel && focused,
          current: i === sel && !focused,
        })),
        selected: sel,
      };
    }
    case 'connections':
      return { rows: connectionRows(modal, focused), selected: modal.connectionEntries.length > 0 ? clampIndex(modal.connectionEntries.length) : -1 };
    default: {
      const items = modal.currentItems;
      if (items.length === 0) return { rows: [{ label: 'No settings in this category.', muted: true }], selected: -1 };
      const sel = clampIndex(items.length);
      return { rows: items.map((entry, i) => settingRow(modal, entry, i === sel, focused, width)), selected: sel };
    }
  }
}

function categoryRows(modal: SettingsModal): KitRow[] {
  const focused = !modal.searchFocused && modal.focusRegion === 'categories';
  const rows: KitRow[] = [];
  for (const group of SETTINGS_CATEGORY_GROUPS) {
    const categories = group.categories.filter((category) => SETTINGS_CATEGORIES.includes(category));
    if (categories.length === 0) continue;
    rows.push({ header: group.label });
    for (const category of categories) {
      const active = SETTINGS_CATEGORIES.indexOf(category) === modal.categoryIndex && !modal.searchFocused;
      const count = categoryItemCount(modal, category);
      rows.push({
        onClick: () => {
          if (modal.editingMode) return;
          modal.clearSearch();
          modal.selectCategory(category);
          modal.focusRegion = 'settings';
        },
        label: CATEGORY_LABELS[category],
        right: count > 0 ? String(count) : undefined,
        selected: active && focused,
        current: active && !focused,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Documentation block
// ---------------------------------------------------------------------------






/** Fact lines folded into one compact line under the selected row (the row itself shows the current value). */




/**
 * The complete documentation the selected row explains itself with (its name
 * first), as the wrapped lines the renderer windows over with PgUp/PgDn.
 */


/** Window the documentation by modal.contextScroll, marking hidden lines honestly. */


// ---------------------------------------------------------------------------
// Right side: the settings column
// ---------------------------------------------------------------------------

function drawSettingsColumn(f: ModalFrame, modal: SettingsModal, p: KitInset): { above: number; below: number } {
  const t = activeTokens();
  const sx = p.x + 4;
  const sr = p.x + p.w - 5;
  const width = sr - sx + 1;

  const notices = [
    ...(modal.lastSaveTriggeredRestart ? [`Restarting ${modal.lastSaveTriggeredRestart}`] : []),
    ...(modal.lastSettingEffectMessage ? [modal.lastSettingEffectMessage] : []),
  ].flatMap((n) => wrapLines(n, width));
  const bottom = notices.length > 0 ? p.bottom - notices.length - 1 : p.bottom;
  notices.forEach((line, k) => f.canvas.put(sx, bottom + 2 + k, line, { fg: t.accent }));

  const { rows, selected } = listRows(modal, width);
  if (!modal.editingMode) rows.forEach((row, index) => {
    rows[index] = { ...row, onClick: () => { modal.selectedIndex = index; modal.focusRegion = 'settings'; modal.contextScroll = 0; } };
  });
  const capacity = Math.max(1, bottom - p.top + 1);
  const doc = docLines(modal, selected >= 0, width);

  if (selected < 0) {
    let y = p.top;
    for (const row of rows) y += drawRow(f.canvas, y, row, sx, sr, bottom);
    if (rows.length > 0) y++;
    for (const line of windowDoc(modal, doc, Math.max(1, bottom - y + 1))) {
      if (y > bottom) break;
      f.canvas.put(sx, y++, line.text, { fg: line.fg, bold: line.bold });
    }
    return { above: 0, below: 0 };
  }

  const heights = rows.map((row) => measureRow(row, sx, sr));
  // The documentation takes what the rows leave, but never less than a few lines.
  const rowsTotal = heights.reduce((a, b) => a + b, 0);
  const docBudget = Math.max(3, Math.min(doc.length, capacity - Math.min(rowsTotal, Math.max(3, Math.floor(capacity * 0.35))) - 2));
  const shownDoc = windowDoc(modal, doc, docBudget);
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
    if (y + heights[i]! - 1 > bottom) break;
    if (i !== selected && i > selected && y + heights[i]! - 1 > bottom) break;
    y += drawRow(f.canvas, y, rows[i]!, sx, sr, bottom);
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

// ---------------------------------------------------------------------------
// Hints
// ---------------------------------------------------------------------------

function settingsHints(modal: SettingsModal): KitHint[] {
  if (modal.resetCategoryConfirm !== null || modal.resetAllConfirm !== null) return [['⏎', 'confirm reset'], ['esc', 'cancel']];
  if (modal.subscriptionLogoutConfirmationTarget) return [['⏎', 'sign out'], ['esc', 'cancel']];
  if (modal.editingMode) return [['⏎', 'save'], ['esc', 'cancel edit']];
  if (modal.searchFocused) return [['↑↓', 'move'], ['⏎', 'change'], ['⌫', 'edit search'], ['ctrl+r', 'reset']];
  if (modal.focusRegion === 'categories') return [['↑↓', 'category'], ['→', 'settings'], ['tab', 'pane']];
  const enter: KitHint = modal.currentCategory === 'mcp' ? ['⏎', 'edit trust']
    : modal.currentCategory === 'subscriptions' ? ['⏎', 'review or sign out']
    : ['⏎', 'change'];
  return [['↑↓', 'move'], enter, ['←→', 'category'], ['pgup pgdn', 'docs'], ['ctrl+r', 'reset'], ['shift+r', 'reset category'], ['ctrl+shift+r', 'reset all']];
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/** Below this many text columns the category list folds into the breadcrumb (←→ still switch). */
const MIN_LIST_DETAIL_WIDTH = 56;

export function renderSettingsModal(modal: SettingsModal, screenWidth: number, screenHeight = 24): SurfaceLayer {
  const selectedEntry = !modal.searchFocused && modal.currentCategory !== 'mcp' && modal.currentCategory !== 'subscriptions' && modal.currentCategory !== 'connections'
    ? modal.getSelected()
    : null;
  const crumbs = modal.searchFocused
    ? ['Search']
    : [CATEGORY_LABELS[modal.currentCategory], ...(selectedEntry ? [selectedEntry.flag ? selectedEntry.flag.feature.name : getSettingLabel(selectedEntry)] : [])];
  const f = beginModal(screenWidth, screenHeight, { title: 'Settings', crumbs, hints: settingsHints(modal) });

  const count = modal.searchFocused
    ? `${modal.searchResults.length} result${modal.searchResults.length === 1 ? '' : 's'}`
    : CATEGORY_LABELS[modal.currentCategory].toLowerCase();
  searchRow(f, f.top, modal.searchQuery, 'Search all settings', count);

  const body = f.top + 2;
  const inner = f.r - f.l + 1;
  let detailX = 2;
  // Search spans every category, so the category list steps aside for it.
  if (inner >= MIN_LIST_DETAIL_WIDTH && !modal.searchFocused) {
    const catW = Math.max(18, Math.min(26, Math.round(inner * 0.22)));
    const x1 = f.l + catW - 1;
    drawScrollingList(f.canvas, { rows: categoryRows(modal), top: body, bottom: f.bottom, x0: f.l, x1, scrollKey: { owner: modal, name: 'categories' } });
    detailX = x1 + 3;
  }
  const p = inset(f.canvas, detailX, body, f.r + 2 - detailX + 1, f.bottom - body + 1);
  const hidden = drawSettingsColumn(f, modal, p);
  f.hintRight = scrollCountText(hidden.above, hidden.below);
  return finishModal(f);
}

const { docLines, windowDoc, settingsDocumentation } = createSettingsDocumentation<SettingsModal>(settingContextLines, { clampStoredOffset: false, countIndicatorRow: false });
export { settingsDocumentation };
