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
 *   ✦ interface          element panel
 *     Display        9     ◇ Theme                        goodvibes
 *     UI             4       display.theme · default goodvibes · …
 *   ✦ ai routing             Color palette for the whole interface…
 *     Provider       7     Theme mode                          dark
 *
 *   ↑↓ move   ⏎ change   ←→ category   ctrl+r reset
 *
 * The search row is always live and reaches every setting in every category
 * at once. Categories on the left, plain rows in an element panel on the
 * right: name, value, and a ◇ when the value differs from the default. The
 * selected row explains itself in place, wrapped in full, with its key,
 * default, type and source. The breadcrumb in the title says where you are.
 */

import type { SettingsModal, SettingEntry, FlagEntry, SettingsCategory } from '../input/settings-modal.ts';
import { SETTINGS_CATEGORIES, SETTINGS_CATEGORY_GROUPS } from '../input/settings-modal.ts';
import { CATEGORY_LABELS, flagStateColor, getSettingLabel, inferSubscriptionRouteReason, valueColor } from './settings-modal-helpers.ts';
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
  const flags = [entry.locked ? 'locked' : '', entry.conflict ? 'conflict' : ''].filter(Boolean).join(' · ');
  const desc = [category, flags].filter(Boolean).join(' · ');
  const label = getSettingLabel(entry);
  return {
    label,
    desc: desc || undefined,
    right: fitValue(currentSettingValue(modal, entry, selected), width, editing, label),
    rightFg: valueColor(entry),
    mark: entry.isDefault ? undefined : '◇',
    markFg: t.warning,
    selected: selected && focused,
    current: selected && !focused,
    labelFg: danger ? t.error : undefined,
  };
}

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

function categoryOf(entry: SettingEntry): string {
  const prefix = entry.setting.key.split('.')[0] ?? '';
  return CATEGORY_LABELS[prefix as SettingsCategory] ?? prefix;
}

/** The rows of the right-hand list for the current view, and which one is selected. */
function listRows(modal: SettingsModal, width: number): { rows: KitRow[]; selected: number } {
  const focused = modal.searchFocused || (modal.focusPane ?? 'settings') === 'settings';
  const clampIndex = (n: number): number => Math.max(0, Math.min(modal.selectedIndex, n - 1));
  if (modal.searchFocused) {
    const results = modal.searchResults;
    if (results.length === 0) return { rows: [], selected: -1 };
    const sel = clampIndex(results.length);
    return { rows: results.map((entry, i) => settingRow(modal, entry, i === sel, true, width, categoryOf(entry))), selected: sel };
  }
  const t = activeTokens();
  switch (modal.currentCategory) {
    case 'flags': {
      const items = modal.flagEntries;
      if (items.length === 0) return { rows: [{ label: 'No features registered.', muted: true }], selected: -1 };
      const sel = clampIndex(items.length);
      return { rows: items.map((entry, i) => flagRow(entry, i === sel, focused)), selected: sel };
    }
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
            [
              entry.activeRoute ? formatProviderAuthRouteId(entry.activeRoute) : '',
              entry.authFreshness ?? '',
              inferSubscriptionRouteReason(entry) ?? '',
            ]
              .filter(Boolean)
              .join(' · ') || undefined,
          right: entry.state,
          rightFg: entry.state === 'active' ? t.success : undefined,
          selected: i === sel && focused,
          current: i === sel && !focused,
        })),
        selected: sel,
      };
    }
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
    focused: !modal.searchFocused && modal.focusPane === 'categories',
    label: (category) => CATEGORY_LABELS[category],
    count: (category) => categoryItemCount(modal, category),
  });
}

// ---------------------------------------------------------------------------
// Documentation block
// ---------------------------------------------------------------------------

/** Fact lines folded into one compact line under the selected row (the row itself shows the current value). */

/** Window the documentation by modal.contextScroll (PgUp/PgDn), marking hidden lines honestly. */

// ---------------------------------------------------------------------------
// Right pane
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Hints
// ---------------------------------------------------------------------------

function settingsHints(modal: SettingsModal): KitHint[] {
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
  if (modal.focusPane === 'categories')
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
        : modal.currentCategory === 'flags'
          ? ['⏎', 'toggle']
          : ['⏎', 'change'];
  return [['↑↓', 'move'], enter, ['←→', 'category'], ['pgup pgdn', 'docs'], ['ctrl+r', 'reset']];
}

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
