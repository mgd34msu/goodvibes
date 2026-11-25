import { createSettingsRows, settingsNavigationHints } from '@goodvibes/engine/terminal-shell/renderer/settings-rows';
import { createSettingsLayout, settingsTopicRailRows } from '@goodvibes/engine/terminal-shell/renderer/settings-layout';
import { createSettingsDocumentation } from '@goodvibes/engine/terminal-shell/renderer/settings-documentation';
/**
 * renderSettingsModal, the settings screen drawn with the surface kit: the
 * seven topics the web UI shows, in its order and words; each lists its
 * sections' settings by name with the value in words, one line each. Typing searches every setting by name, key or description
 * (the topics step aside). Under the rows, the selected one explained in a
 * few sentences. The same screen as the terminal app's (see its renderer).
 */

import type { SettingsModal, SettingEntry, FlagEntry, SettingsCategory } from '../input/settings-modal.ts';
import { flagStateColor, formatDefault, getSettingLabel, valueColor } from './settings-modal-helpers.ts';
import { currentSettingValue, listItemCount, settingContextLines } from './settings-modal-context.ts';
import { formatProviderAuthRouteId } from '../provider-auth-route-display.ts';
import { type KitHint } from './surface-kit.ts';
import { type KitRow } from './surface-kit-list.ts';

function flagRow(entry: FlagEntry, selected: boolean, focused: boolean): KitRow {
  return {
    label: entry.feature.name,
    right: entry.state === 'enabled' ? 'On' : 'Off',
    rightFg: flagStateColor(entry.state),
    selected: selected && focused,
    current: selected && !focused,
  };
}

function topicRows(modal: SettingsModal): KitRow[] {
  return settingsTopicRailRows({
    topics: modal.topics,
    topicIndex: modal.topicIndex,
    searching: modal.searchFocused,
    focused: !modal.searchFocused && modal.focusPane === 'categories',
  });
}

const { docLines, windowDoc, settingsDocumentation } = createSettingsDocumentation<SettingsModal>(settingContextLines, {
  clampStoredOffset: true,
  countIndicatorRow: true,
});
export { settingsDocumentation };

const { listRows } = createSettingsRows<SettingsModal, SettingEntry, SettingsCategory>({
  label: getSettingLabel,
  color: valueColor,
  currentValue: currentSettingValue,
  unavailable: () => false,
  visibleRows: (modal) => modal.visibleRows(),
  listCount: listItemCount,
  focused: (modal) => modal.searchFocused || (modal.focusPane ?? 'settings') === 'settings',
  routeLabel: formatProviderAuthRouteId,
  specialList(modal, _width, focused, clampIndex) {
    if (modal.currentCategory === 'secure-address-now') {
      const sel = clampIndex(modal.secureAddressRows.length);
      return { rows: modal.secureAddressRows.map((row, i) => ({ label: row.label, right: row.state, selected: focused && i === sel, current: !focused && i === sel })), selected: sel };
    }
    if (modal.currentCategory !== 'flags') return undefined;
    const items = modal.flagEntries;
    if (items.length === 0) return { rows: [{ label: 'No features registered.', muted: true }], selected: -1 };
    const sel = clampIndex(items.length);
    return { rows: items.map((entry, i) => flagRow(entry, i === sel, focused)), selected: sel };
  },
});

/** A number or a choice is nudged in place with shift+arrows; a picker's setting is not. */
function adjustable(entry: SettingEntry | null): boolean {
  if (!entry) return false;
  return entry.setting.type === 'number' || (entry.setting.type === 'enum' && entry.setting.key !== 'permissions.mode');
}

function settingsHints(modal: SettingsModal): KitHint[] {
  const selected = modal.getSelected();
  return settingsNavigationHints(modal, {
    resetPending: false,
    categoryFocused: !modal.searchFocused && modal.focusPane === 'categories',
    flagToggle: true,
    resetTo: selected ? formatDefault(selected) : undefined,
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
  notices: (modal) => [...(modal.lastSettingEffectMessage ? [modal.lastSettingEffectMessage] : [])],
  breadcrumbs(modal) {
    if (modal.searchFocused) return [];
    const list = modal.openList !== null ? modal.topicRows.find((row) => row.kind === 'list' && row.list.category === modal.openList) : undefined;
    return [modal.topicLabel, ...(list?.kind === 'list' ? [list.list.label] : [])];
  },
});
