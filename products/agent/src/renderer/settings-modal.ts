import { settingCategoryLabel } from '@goodvibes-jev/engine/terminal-shell/renderer/settings-metadata';
import { createSettingsRows, settingsNavigationHints } from '@goodvibes-jev/engine/terminal-shell/renderer/settings-rows';
import { createSettingsLayout, settingsCategoryRows } from '@goodvibes-jev/engine/terminal-shell/renderer/settings-layout';
import '@goodvibes-jev/engine/terminal-shell/renderer/mcp-form-rows';
import { createSettingsDocumentation } from '@goodvibes-jev/engine/terminal-shell/renderer/settings-documentation';
/**
 * renderSettingsModal, the settings modal drawn with the surface kit.
 *
 *   ✦ Settings › Display › Theme                                  esc
 *
 *   ▏Search all settings                                       display
 *
 *   ✦ interface          selected-item help
 *     Display       10      Color palette for the whole interface…
 *     UI             4      display.theme · default goodvibes · …
 *   ✦ ai routing
 *     Provider       7    ◇ Theme                        goodvibes
 *                         Theme mode                          dark
 *
 *   ↑↓ move   ⏎ change   ←→ category   ctrl+r reset
 *
 * The search row is always live and reaches every setting in every category
 * at once. Categories on the left, plain rows in an element panel on the
 * right: name, value, and a ◇ when the value differs from the default. The
 * selected row is explained above the uninterrupted list, with its key,
 * default, type and source. The breadcrumb in the title says where you are.
 */

import type { SettingsModal, SettingEntry, FlagEntry } from '../input/settings-modal.ts';
import { SETTINGS_CATEGORIES, SETTINGS_CATEGORY_GROUPS } from '../input/settings-modal.ts';
import { CATEGORY_LABELS, flagStateColor, getSettingLabel, valueColor } from './settings-modal-helpers.ts';
import {
  CATEGORY_INFO,
  ENUM_VALUE_DESCRIPTIONS,
  categoryItemCount,
  currentSettingValue,
  settingContextLines,
} from './settings-modal-context.ts';
import { formatProviderAuthRouteId } from '../provider-auth-route-display.ts';
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

function flagRow(entry: FlagEntry, selected: boolean, focused: boolean): KitRow {
  const t = activeTokens();
  const on = entry.state === 'enabled';
  return {
    label: entry.feature.name,
    desc: `${entry.feature.domain} · ${entry.feature.restartRequired ? 'applies next run' : 'applies now'}`,
    right: entry.state,
    rightFg: flagStateColor(entry.state, entry.state === 'killed'),
    mark: entry.state === 'killed' ? '✕' : on ? '●' : '○',
    markFg: entry.state === 'killed' ? t.error : on ? t.success : t.textFaint,
    selected: selected && focused,
    current: selected && !focused,
  };
}

const categoryOf = (entry: SettingEntry): string => settingCategoryLabel(entry.setting.key, CATEGORY_LABELS);

/** The rows of the right-hand list for the current view, and which one is selected. */

function categoryRows(modal: SettingsModal): KitRow[] {
  return settingsCategoryRows({
    groups: SETTINGS_CATEGORY_GROUPS,
    categories: SETTINGS_CATEGORIES,
    categoryIndex: modal.categoryIndex,
    searching: modal.searchFocused,
    focused: !modal.searchFocused && modal.focusPane === 'categories',
    label: (category) => CATEGORY_LABELS[category],
    count: (category) => categoryItemCount(modal, category),
  });
}

// ---------------------------------------------------------------------------
// Documentation block
// ---------------------------------------------------------------------------

/** Fact lines folded into one compact line above the list (the row itself shows the current value). */

/** Window the documentation by modal.contextScroll (PgUp/PgDn), marking hidden lines honestly. */

// ---------------------------------------------------------------------------
// Right pane
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Hints
// ---------------------------------------------------------------------------

/** The static strings this surface can show (checked by package verification). */
export function renderSettingsModalPackageText(): string {
  const lines: string[] = [
    'Settings',
    'Search all settings',
    '<n> results',
    'No settings in this category.',
    'No features registered.',
    'No MCP servers registered.',
    'No provider subscriptions available or configured.',
    'No setting is selected in this category.',
    'No feature control is selected.',
    'No MCP server is selected.',
    'No subscription provider is selected.',
    'No setting matches the search.',
    'Trust meanings:',
    'constrained: keep MCP activity inside declared paths/hosts and prompt on risk.',
    'ask-on-risk: allow routine MCP operations but ask before risky behavior.',
    'allow-all: allow unrestricted MCP operations for this server after explicit confirmation.',
    'blocked: prevent this MCP server from being used.',
    'Possible values:',
    'true: enabled or allowed for this setting.',
    'false: disabled or not allowed for this setting.',
    'Secret handling: raw values entered here are stored through the secret manager and the config receives a goodvibes:// secret reference. Empty input clears the config value.',
    'Editing: Enter opens inline edit, then type the value and press Enter to save. Arrow keys only navigate.',
    'Editing: Enter opens inline edit. Delete the current text to save an empty value when that is valid for the setting.',
    '<n> more ↑ · pgup',
    '<n> more ↓ · pgdn',
    'docs',
    'move',
    'change',
    'category',
    'reset',
    'save',
    'cancel edit',
    'edit search',
    'settings',
    'pane',
    'edit trust',
    'review or sign out',
    'toggle',
    'sign out',
    'cancel',
    'applies next run',
    'applies now',
    'no scope',
  ];

  for (const group of SETTINGS_CATEGORY_GROUPS) {
    lines.push(group.label);
    for (const category of group.categories) {
      lines.push(category, CATEGORY_LABELS[category], CATEGORY_INFO[category]);
    }
  }

  for (const [key, values] of Object.entries(ENUM_VALUE_DESCRIPTIONS)) {
    lines.push(key);
    for (const [value, description] of Object.entries(values)) {
      lines.push(value, description);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/** Below this many text columns the category list folds into the breadcrumb (←→ still switch). */

const { docLines, windowDoc, settingsDocumentation } = createSettingsDocumentation<SettingsModal>(settingContextLines, {
  clampStoredOffset: true,
  countIndicatorRow: true,
});
export { settingsDocumentation };

const { listRows } = createSettingsRows<SettingsModal, SettingEntry>({
  label: getSettingLabel,
  rowLabel: getSettingLabel,
  color: valueColor,
  currentValue: currentSettingValue,
  unavailable: () => false,
  category: categoryOf,
  focused: (modal) => modal.searchFocused || (modal.focusPane ?? 'settings') === 'settings',
  routeLabel: formatProviderAuthRouteId,
  specialList(modal, _width, focused, clampIndex) {
    if (modal.currentCategory !== 'flags') return undefined;
    const items = modal.flagEntries;
    if (items.length === 0) return { rows: [{ label: 'No features registered.', muted: true }], selected: -1 };
    const sel = clampIndex(items.length);
    return { rows: items.map((entry, i) => flagRow(entry, i === sel, focused)), selected: sel };
  },
});
function settingsHints(modal: SettingsModal): KitHint[] {
  return settingsNavigationHints(modal, {
    resetPending: false,
    categoryFocused: modal.focusPane === 'categories',
    flagToggle: true,
    extendedReset: false,
  });
}

export const { renderSettingsModal } = createSettingsLayout<SettingsModal>({
  listRows,
  categoryRows,
  categoryLabel: (modal) => CATEGORY_LABELS[modal.currentCategory],
  hints: settingsHints,
  docLines,
  windowDoc,
  notices: (modal) => [...(modal.lastSettingEffectMessage ? [modal.lastSettingEffectMessage] : [])],

  breadcrumbs(modal) {
    const category = modal.currentCategory;
    const selected = !modal.searchFocused && !['flags', 'mcp', 'subscriptions'].includes(category) ? modal.getSelected() : null;
    const flag = !modal.searchFocused && category === 'flags' ? modal.getSelectedFlag() : null;
    return modal.searchFocused
      ? ['Search']
      : [CATEGORY_LABELS[category], ...(selected ? [getSettingLabel(selected)] : flag ? [flag.feature.name] : [])];
  },
});
