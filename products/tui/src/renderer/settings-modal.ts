import { createSettingsRows, settingsNavigationHints } from '@goodvibes/engine/terminal-shell/renderer/settings-rows';
import { createSettingsLayout, settingsTopicRailRows } from '@goodvibes/engine/terminal-shell/renderer/settings-layout';
import { createSettingsDocumentation, fitValue } from '@goodvibes/engine/terminal-shell/renderer/settings-documentation';
import { settingPlace } from '@goodvibes/engine/terminal-shell/settings-navigation';
/**
 * renderSettingsModal, the settings screen drawn with the surface kit.
 *
 *   ✦ Settings › General                                          esc
 *
 *   ▏Search settings by name, key or what they do
 *
 *   General                 Stream the answer as it arrives          On
 *   Account                   Display · display.stream
 *   Models and providers    Show the model's thinking               Off
 *   Voice                     Display · display.showThinking
 *   …
 *                           Shows what the model was reasoning about.
 *                           Takes effect at once. The default is Off.
 *
 *   ↑↓ move   ⏎ change   ctrl+r reset to Off   ← topics
 *
 * The seven topics the web UI shows, in its order and words; each lists its
 * sections' settings by name with the value in words, and the section and key
 * small beneath. Typing searches every setting by name, key or description
 * (the topics step aside). Under the rows, the selected one explained in a
 * few sentences. Changes to the theme preview live (see theme-settings-actions).
 */

import type { SettingsModal, SettingEntry, SettingsCategory } from '../input/settings-modal.ts';
import { formatDefault, getSettingLabel, valueColor } from './settings-modal-helpers.ts';
import { connectionRows } from './settings-modal-connections.ts';
import { currentSettingValue, listItemCount, settingContextLines } from './settings-modal-context.ts';
import { activeTokens } from './theme.ts';
import { type KitHint } from './surface-kit.ts';
import { type KitRow } from './surface-kit-list.ts';

/** What a saved network change restarts, in words. */
const RESTART_WORDS = {
  'control-plane': 'Restarting the daemon\'s connection for other programs.',
  'http-listener': 'Restarting the listener for webhooks.',
  web: 'Restarting the web UI.',
} as const;

function topicRows(modal: SettingsModal): KitRow[] {
  return settingsTopicRailRows({
    topics: modal.topics,
    topicIndex: modal.topicIndex,
    searching: modal.searchFocused,
    focused: !modal.searchFocused && modal.focusRegion === 'categories',
    onSelect: (index) => {
      if (modal.editingMode) return;
      modal.clearSearch();
      modal.selectTopic(index);
      modal.focusRegion = 'settings';
    },
  });
}

const { docLines, windowDoc, settingsDocumentation } = createSettingsDocumentation<SettingsModal>(settingContextLines, {
  clampStoredOffset: false,
  countIndicatorRow: false,
});
export { settingsDocumentation };

const { listRows } = createSettingsRows<SettingsModal, SettingEntry, SettingsCategory>({
  label: getSettingLabel,
  color: valueColor,
  currentValue: currentSettingValue,
  unavailable: (entry) => !!entry.metadataUnavailable,
  placeOf: (entry) => settingPlace(entry.setting.key, entry.setting.key.split('.', 1)[0] ?? ''),
  visibleRows: (modal) => modal.visibleRows(),
  listCount: listItemCount,
  focused: (modal) => modal.searchFocused || (modal.focusRegion ?? 'settings') === 'settings',
  routeLabel: (route) => route,
  specialRow(modal, entry, selected, focused, width, sub) {
    if (!entry.flag) return undefined;
    const t = activeTokens();
    const editing = selected && modal.editingMode;
    const { feature, pendingRestart } = entry.flag;
    const raw = currentSettingValue(modal, entry, selected);
    // A startup-gated feature changed this session says it waits for a restart.
    const value = pendingRestart ? `${raw} after a restart` : raw;
    return {
      label: feature.name,
      sub,
      right: fitValue(value, width, editing, feature.name),
      rightFg: valueColor(entry),
      selected: selected && focused,
      current: selected && !focused,
      labelFg: entry.setting.key.startsWith('danger.') ? t.error : undefined,
    };
  },
  specialList: (modal, _width, focused, clampIndex) =>
    modal.currentCategory === 'connections'
      ? {
          rows: connectionRows(modal, focused),
          selected: modal.connectionEntries.length > 0 ? clampIndex(modal.connectionEntries.length) : -1,
        }
      : undefined,
});

/** A number or a choice is nudged in place with shift+arrows; a picker's setting is not. */
function adjustable(entry: SettingEntry | null): boolean {
  if (!entry) return false;
  return entry.setting.type === 'number' || (entry.setting.type === 'enum' && entry.setting.key !== 'permissions.mode');
}

function settingsHints(modal: SettingsModal): KitHint[] {
  const selected = modal.getSelected();
  return settingsNavigationHints(modal, {
    resetPending: modal.resetCategoryConfirm !== null || modal.resetAllConfirm !== null,
    categoryFocused: !modal.searchFocused && modal.focusRegion === 'categories',
    flagToggle: false,
    resetTo: selected ? (selected.flag ? (selected.flag.feature.defaultEnabled ? 'On' : 'Off') : formatDefault(selected)) : undefined,
    onList: modal.getSelectedListRow() !== null,
    adjustable: adjustable(selected),
  });
}

export const { renderSettingsModal } = createSettingsLayout<SettingsModal>({
  listRows,
  topicRows,
  hints: settingsHints,
  docLines,
  windowDoc,
  notices: (modal) => [
    ...(modal.resetCategoryConfirm ? [`Put every setting in ${modal.resetCategoryConfirm.subject} back to its default? Enter resets them, Esc keeps them.`] : []),
    ...(modal.resetAllConfirm ? ['Put every setting back to its default? Enter resets them all, Esc keeps them.'] : []),
    ...(modal.lastSaveTriggeredRestart ? [RESTART_WORDS[modal.lastSaveTriggeredRestart]] : []),
    ...(modal.lastSettingEffectMessage ? [modal.lastSettingEffectMessage] : []),
  ],
  selectRow: (modal, index) => {
    modal.selectedIndex = index;
    modal.focusRegion = 'settings';
    modal.contextScroll = 0;
  },
  breadcrumbs(modal) {
    if (modal.searchFocused) return [];
    const list = modal.openList !== null ? modal.topicRows.find((row) => row.kind === 'list' && row.list.category === modal.openList) : undefined;
    return [modal.topicLabel, ...(list?.kind === 'list' ? [list.list.label] : [])];
  },
});
