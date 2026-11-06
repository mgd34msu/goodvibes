import { settingCategoryLabel } from '@goodvibes-jev/engine/terminal-shell/settings-metadata';
import { createSettingsRows, settingsNavigationHints } from '@goodvibes-jev/engine/terminal-shell/renderer/settings-rows';
import { createSettingsLayout, settingsCategoryRows } from '@goodvibes-jev/engine/terminal-shell/renderer/settings-layout';
import '@goodvibes-jev/engine/terminal-shell/renderer/mcp-form-rows';
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

import type { SettingsModal, SettingEntry } from '../input/settings-modal.ts';
import { SETTINGS_CATEGORIES, SETTINGS_CATEGORY_GROUPS } from '../input/settings-modal.ts';
import { isFeatureValueEnabled } from '@goodvibes-jev/engine/terminal-shell';
import { CATEGORY_LABELS, getSettingLabel, valueColor } from './settings-modal-helpers.ts';
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

const categoryOf = (entry: SettingEntry): string => settingCategoryLabel(entry.setting.key, CATEGORY_LABELS);

/** The rows of the right-hand list for the current view, and which one is selected. */

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

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/** Below this many text columns the category list folds into the breadcrumb (←→ still switch). */

const { docLines, windowDoc, settingsDocumentation } = createSettingsDocumentation<SettingsModal>(settingContextLines, {
  clampStoredOffset: false,
  countIndicatorRow: false,
});
export { settingsDocumentation };

const { listRows } = createSettingsRows<SettingsModal, SettingEntry>({
  label: getSettingLabel,
  rowLabel: (entry) => (entry.ownerFlagId ? '· ' + getSettingLabel(entry) : getSettingLabel(entry)),
  color: valueColor,
  currentValue: currentSettingValue,
  unavailable: (entry) => !!entry.metadataUnavailable,
  category: categoryOf,
  focused: (modal) => modal.searchFocused || (modal.focusRegion ?? 'settings') === 'settings',
  routeLabel: (route) => route,
  specialRow(modal, entry, selected, focused, width, category) {
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
    return undefined;
  },
  specialList: (modal, _width, focused, clampIndex) =>
    modal.currentCategory === 'connections'
      ? {
          rows: connectionRows(modal, focused),
          selected: modal.connectionEntries.length > 0 ? clampIndex(modal.connectionEntries.length) : -1,
        }
      : undefined,
});
function settingsHints(modal: SettingsModal): KitHint[] {
  return settingsNavigationHints(modal, {
    resetPending: modal.resetCategoryConfirm !== null || modal.resetAllConfirm !== null,
    categoryFocused: modal.focusRegion === 'categories',
    flagToggle: false,
    extendedReset: true,
  });
}

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
