import { activeTokens } from './theme.js';
import { fitValue } from './settings-documentation.js';
import { mcpTrustRows, type McpTrustRowEntry } from './mcp-form-rows.js';
import { type SubscriptionEntry } from '../settings-subscriptions.js';
import type { KitRow } from './surface-kit-list.js';
import type { KitHint } from './surface-kit.js';
interface SettingRowEntry {
  readonly isDefault: boolean;
  readonly locked?: unknown;
  readonly conflict?: unknown;
}
interface SettingsRowState<Entry> {
  readonly editingMode: boolean;
  readonly searchFocused: boolean;
  readonly currentCategory: string;
  readonly selectedIndex: number;
  readonly currentItems: readonly Entry[];
  readonly searchResults: readonly Entry[];
  readonly editBuffer: string;
  readonly mcpEntries: readonly McpTrustRowEntry[];
  readonly subscriptionEntries: readonly SubscriptionEntry[];
}
export function createSettingsRows<Modal extends SettingsRowState<Entry>, Entry extends SettingRowEntry>(policy: {
  readonly label: (entry: Entry) => string;
  readonly rowLabel: (entry: Entry) => string;
  readonly color: (entry: Entry) => string;
  readonly currentValue: (modal: Modal, entry: Entry, selected: boolean) => string;
  readonly unavailable: (entry: Entry) => boolean;
  readonly category: (entry: Entry) => string;
  readonly focused: (modal: Modal) => boolean;
  readonly routeLabel: (route: string) => string;
  readonly specialRow?:
    | ((
        modal: Modal,
        entry: Entry,
        selected: boolean,
        focused: boolean,
        width: number,
        category?: string | undefined,
      ) => KitRow | undefined)
    | undefined;
  readonly specialList?:
    | ((
        modal: Modal,
        width: number,
        focused: boolean,
        clamp: (length: number) => number,
      ) => { rows: KitRow[]; selected: number } | undefined)
    | undefined;
}) {
  function settingRow(modal: Modal, entry: Entry, selected: boolean, focused: boolean, width: number, category?: string): KitRow {
    const special = policy.specialRow?.(modal, entry, selected, focused, width, category);
    if (special) return special;
    const tokens = activeTokens();
    const flags = [policy.unavailable(entry) ? 'unavailable' : '', entry.locked ? 'locked' : '', entry.conflict ? 'conflict' : '']
      .filter(Boolean)
      .join(' · ');
    const description = [category, flags].filter(Boolean).join(' · ');
    return {
      label: policy.rowLabel(entry),
      desc: description || undefined,
      right: fitValue(policy.currentValue(modal, entry, selected), width, selected && modal.editingMode, policy.label(entry)),
      rightFg: policy.color(entry),
      mark: entry.isDefault ? undefined : '◇',
      markFg: tokens.warning,
      selected: selected && focused,
      current: selected && !focused,
      labelFg: modal.currentCategory === 'danger' && !modal.searchFocused ? tokens.error : undefined,
    };
  }
  function listRows(modal: Modal, width: number): { rows: KitRow[]; selected: number } {
    const focused = policy.focused(modal);
    const clamp = (length: number): number => Math.max(0, Math.min(modal.selectedIndex, length - 1));
    if (modal.searchFocused) {
      const rows = modal.searchResults;
      if (!rows.length) return { rows: [], selected: -1 };
      const selected = clamp(rows.length);
      return {
        rows: rows.map((entry, index) => settingRow(modal, entry, index === selected, true, width, policy.category(entry))),
        selected,
      };
    }
    const special = policy.specialList?.(modal, width, focused, clamp);
    if (special) return special;
    if (modal.currentCategory === 'mcp') {
      const entries = modal.mcpEntries;
      if (!entries.length) return { rows: [{ label: 'No MCP servers registered.', muted: true }], selected: -1 };
      const selected = clamp(entries.length);
      return { rows: mcpTrustRows(entries, selected, focused, modal.editingMode, modal.editBuffer), selected };
    }
    if (modal.currentCategory === 'subscriptions') {
      const entries = modal.subscriptionEntries;
      if (!entries.length) return { rows: [{ label: 'No provider subscriptions available or configured.', muted: true }], selected: -1 };
      const selected = clamp(entries.length),
        tokens = activeTokens();
      return {
        rows: entries.map((entry, index) => ({
          label: entry.provider,
          desc:
            [
              entry.activeRoute ? policy.routeLabel(entry.activeRoute) : '',
              entry.authFreshness ?? '',
            ]
              .filter(Boolean)
              .join(' · ') || undefined,
          right: entry.state,
          rightFg: entry.state === 'active' ? tokens.success : undefined,
          selected: index === selected && focused,
          current: index === selected && !focused,
        })),
        selected,
      };
    }
    const entries = modal.currentItems;
    if (!entries.length) return { rows: [{ label: 'No settings in this category.', muted: true }], selected: -1 };
    const selected = clamp(entries.length);
    return { rows: entries.map((entry, index) => settingRow(modal, entry, index === selected, focused, width)), selected };
  }
  return { settingRow, listRows };
}
export function settingsNavigationHints(
  state: {
    readonly editingMode: boolean;
    readonly searchFocused: boolean;
    readonly currentCategory: string;
    readonly subscriptionLogoutConfirmationTarget?: unknown;
  },
  policy: {
    readonly resetPending: boolean;
    readonly categoryFocused: boolean;
    readonly flagToggle: boolean;
    readonly extendedReset: boolean;
  },
): KitHint[] {
  if (policy.resetPending)
    return [
      ['⏎', 'confirm reset'],
      ['esc', 'cancel'],
    ];
  if (state.subscriptionLogoutConfirmationTarget)
    return [
      ['⏎', 'sign out'],
      ['esc', 'cancel'],
    ];
  if (state.editingMode)
    return [
      ['⏎', 'save'],
      ['esc', 'cancel edit'],
    ];
  if (state.searchFocused)
    return [
      ['↑↓', 'move'],
      ['⏎', 'change'],
      ['⌫', 'edit search'],
      ['ctrl+r', 'reset'],
    ];
  if (policy.categoryFocused)
    return [
      ['↑↓', 'category'],
      ['→', 'settings'],
      ['tab', 'pane'],
    ];
  const enter: KitHint = [
    '⏎',
    state.currentCategory === 'mcp'
      ? 'edit trust'
      : state.currentCategory === 'subscriptions'
        ? 'review or sign out'
        : policy.flagToggle && state.currentCategory === 'flags'
          ? 'toggle'
          : 'change',
  ];
  return [
    ['↑↓', 'move'],
    enter,
    ['←→', 'category'],
    ['pgup pgdn', 'docs'],
    ['ctrl+r', 'reset'],
    ...(policy.extendedReset
      ? ([
          ['shift+r', 'reset category'],
          ['ctrl+shift+r', 'reset all'],
        ] satisfies KitHint[])
      : []),
  ];
}
