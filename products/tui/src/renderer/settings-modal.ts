import { createSettingsLayout, settingsCategoryRows } from '@goodvibes-jev/engine/terminal-shell/renderer/settings-layout';
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
import '../utils/terminal-width.ts';
import { type KitHint } from './surface-kit.ts';
import { type KitRow } from './surface-kit-list.ts';
import './surface-kit-parts.ts';

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * Keep a long value from crowding the name out (the documentation shows it in
 * full). While editing, the value gets all the room the label leaves, and a
 * draft longer than that keeps its end (where the cursor is) in view.
 */

function settingRow(
  modal: SettingsModal,
  entry: SettingEntry,
  selected: boolean,
  focused: boolean,
  width: number,
  category?: string,
): KitRow {
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
  const flags = [entry.metadataUnavailable ? 'unavailable' : '', entry.locked ? 'locked' : '', entry.conflict ? 'conflict' : '']
    .filter(Boolean)
    .join(' · ');
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
          desc:
            [entry.activeRoute ?? '', entry.authFreshness ?? '', inferSubscriptionRouteReason(entry) ?? ''].filter(Boolean).join(' · ') ||
            undefined,
          right: entry.state,
          rightFg: entry.state === 'active' ? t.success : undefined,
          selected: i === sel && focused,
          current: i === sel && !focused,
        })),
        selected: sel,
      };
    }
    case 'connections':
      return {
        rows: connectionRows(modal, focused),
        selected: modal.connectionEntries.length > 0 ? clampIndex(modal.connectionEntries.length) : -1,
      };
    default: {
      const items = modal.currentItems;
      if (items.length === 0) return { rows: [{ label: 'No settings in this category.', muted: true }], selected: -1 };
      const sel = clampIndex(items.length);
      return { rows: items.map((entry, i) => settingRow(modal, entry, i === sel, focused, width)), selected: sel };
    }
  }
}

function categoryRows(modal: SettingsModal): KitRow[] {
  return settingsCategoryRows({
    groups: SETTINGS_CATEGORY_GROUPS,
    categories: SETTINGS_CATEGORIES,
    categoryIndex: modal.categoryIndex,
    searching: modal.searchFocused,
    focused: !modal.searchFocused && modal.focusRegion === 'categories',
    label: (category) => CATEGORY_LABELS[category],
    count: (category) => categoryItemCount(modal, category),
    onSelect: (category) => {
      if (modal.editingMode) return;
      modal.clearSearch();
      modal.selectCategory(category);
      modal.focusRegion = 'settings';
    },
  });
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

// ---------------------------------------------------------------------------
// Hints
// ---------------------------------------------------------------------------

function settingsHints(modal: SettingsModal): KitHint[] {
  if (modal.resetCategoryConfirm !== null || modal.resetAllConfirm !== null)
    return [
      ['⏎', 'confirm reset'],
      ['esc', 'cancel'],
    ];
  if (modal.subscriptionLogoutConfirmationTarget)
    return [
      ['⏎', 'sign out'],
      ['esc', 'cancel'],
    ];
  if (modal.editingMode)
    return [
      ['⏎', 'save'],
      ['esc', 'cancel edit'],
    ];
  if (modal.searchFocused)
    return [
      ['↑↓', 'move'],
      ['⏎', 'change'],
      ['⌫', 'edit search'],
      ['ctrl+r', 'reset'],
    ];
  if (modal.focusRegion === 'categories')
    return [
      ['↑↓', 'category'],
      ['→', 'settings'],
      ['tab', 'pane'],
    ];
  const enter: KitHint =
    modal.currentCategory === 'mcp'
      ? ['⏎', 'edit trust']
      : modal.currentCategory === 'subscriptions'
        ? ['⏎', 'review or sign out']
        : ['⏎', 'change'];
  return [
    ['↑↓', 'move'],
    enter,
    ['←→', 'category'],
    ['pgup pgdn', 'docs'],
    ['ctrl+r', 'reset'],
    ['shift+r', 'reset category'],
    ['ctrl+shift+r', 'reset all'],
  ];
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/** Below this many text columns the category list folds into the breadcrumb (←→ still switch). */

const { docLines, windowDoc, settingsDocumentation } = createSettingsDocumentation<SettingsModal>(settingContextLines, {
  clampStoredOffset: false,
  countIndicatorRow: false,
});
export { settingsDocumentation };

export const { renderSettingsModal } = createSettingsLayout<SettingsModal>({
  listRows,
  categoryRows,
  categoryLabel: (modal) => CATEGORY_LABELS[modal.currentCategory],
  hints: settingsHints,
  docLines,
  windowDoc,
  notices: (modal) => [
    ...(modal.lastSaveTriggeredRestart ? ['Restarting ' + modal.lastSaveTriggeredRestart] : []),
    ...(modal.lastSettingEffectMessage ? [modal.lastSettingEffectMessage] : []),
  ],
  selectRow: (modal, index) => {
    modal.selectedIndex = index;
    modal.focusRegion = 'settings';
    modal.contextScroll = 0;
  },
  breadcrumbs(modal) {
    const selected =
      !modal.searchFocused && !['mcp', 'subscriptions', 'connections'].includes(modal.currentCategory) ? modal.getSelected() : null;
    return modal.searchFocused
      ? ['Search']
      : [
          CATEGORY_LABELS[modal.currentCategory],
          ...(selected ? [selected.flag ? selected.flag.feature.name : getSettingLabel(selected)] : []),
        ];
  },
});
