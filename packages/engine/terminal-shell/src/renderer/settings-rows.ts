import { activeTokens } from './theme.js';
import { fitValue } from './settings-documentation.js';
import { mcpTrustRows, type McpTrustRowEntry } from './mcp-form-rows.js';
import { type SubscriptionEntry } from '../settings-subscriptions.js';
import type { SettingPlace, SettingsTopicRow } from '../settings-navigation.js';
import type { KitRow } from './surface-kit-list.js';
import type { KitHint } from './surface-kit.js';
interface SettingRowEntry {
  readonly isDefault: boolean;
  readonly locked?: unknown;
  readonly conflict?: unknown;
  readonly setting: { readonly key: string };
}
interface SettingsRowState<Entry, Category extends string> {
  readonly editingMode: boolean;
  readonly searchFocused: boolean;
  readonly currentCategory: string;
  readonly openList: Category | null;
  readonly selectedIndex: number;
  readonly searchResults: readonly Entry[];
  readonly editBuffer: string;
  readonly mcpEntries: readonly McpTrustRowEntry[];
  readonly subscriptionEntries: readonly SubscriptionEntry[];
}
/**
 * A settings row: the setting's plain name with its value in words, and under
 * it in small secondary text its section and key. Search results, a topic's
 * rows and the lists a topic opens are drawn here for both terminal programs.
 */
export function createSettingsRows<Modal extends SettingsRowState<Entry, Category>, Entry extends SettingRowEntry, Category extends string>(policy: {
  readonly label: (entry: Entry) => string;
  readonly color: (entry: Entry) => string;
  readonly currentValue: (modal: Modal, entry: Entry, selected: boolean) => string;
  readonly unavailable: (entry: Entry) => boolean;
  /** Where a search result is filed (a topic row carries its own place). */
  readonly placeOf: (entry: Entry) => SettingPlace;
  /** The chosen topic's rows as shown (a program may hide a row its other settings make moot). */
  readonly visibleRows: (modal: Modal) => readonly SettingsTopicRow<Entry, Category>[];
  /** What a list row shows on its right: how many items the list holds. */
  readonly listCount: (modal: Modal, category: Category) => string | undefined;
  readonly focused: (modal: Modal) => boolean;
  readonly routeLabel: (route: string) => string;
  readonly specialRow?:
    | ((modal: Modal, entry: Entry, selected: boolean, focused: boolean, width: number, sub: string) => KitRow | undefined)
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
  function subLine(entry: Entry, place: SettingPlace): string {
    const state = [policy.unavailable(entry) ? 'cannot be read' : '', entry.locked ? 'locked' : '', entry.conflict ? 'in conflict' : '']
      .filter(Boolean)
      .join(', ');
    return `${place.section} · ${entry.setting.key}${state ? ` · ${state}` : ''}`;
  }
  function settingRow(modal: Modal, entry: Entry, selected: boolean, focused: boolean, width: number, place: SettingPlace): KitRow {
    const sub = subLine(entry, place);
    const special = policy.specialRow?.(modal, entry, selected, focused, width, sub);
    if (special) return special;
    const tokens = activeTokens();
    const label = policy.label(entry);
    return {
      label,
      sub,
      right: fitValue(policy.currentValue(modal, entry, selected), width, selected && modal.editingMode, label),
      rightFg: policy.color(entry),
      selected: selected && focused,
      current: selected && !focused,
      labelFg: entry.setting.key.startsWith('danger.') ? tokens.error : undefined,
    };
  }
  function listRows(modal: Modal, width: number): { rows: KitRow[]; selected: number } {
    const focused = policy.focused(modal);
    const clamp = (length: number): number => Math.max(0, Math.min(modal.selectedIndex, length - 1));
    if (modal.searchFocused) {
      const rows = modal.searchResults;
      if (!rows.length) return { rows: [{ label: 'No setting matches the search.', muted: true }], selected: -1 };
      const selected = clamp(rows.length);
      return {
        rows: rows.map((entry, index) => settingRow(modal, entry, index === selected, true, width, policy.placeOf(entry))),
        selected,
      };
    }
    if (modal.openList !== null) {
      const special = policy.specialList?.(modal, width, focused, clamp);
      if (special) return special;
      if (modal.currentCategory === 'mcp') {
        const entries = modal.mcpEntries;
        if (!entries.length) return { rows: [{ label: 'No tool servers are set up. /mcp adds one.', muted: true }], selected: -1 };
        const selected = clamp(entries.length);
        return { rows: mcpTrustRows(entries, selected, focused, modal.editingMode, modal.editBuffer), selected };
      }
      if (modal.currentCategory === 'subscriptions') {
        const entries = modal.subscriptionEntries;
        if (!entries.length) return { rows: [{ label: 'No provider sign-ins are available or set up.', muted: true }], selected: -1 };
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
    }
    const rows = policy.visibleRows(modal);
    if (!rows.length) return { rows: [{ label: 'Nothing in this topic yet.', muted: true }], selected: -1 };
    const selected = clamp(rows.length);
    return {
      rows: rows.map((row, index) =>
        row.kind === 'setting'
          ? settingRow(modal, row.entry, index === selected, focused, width, row.place)
          : {
              label: row.list.label,
              sub: `${row.place.section} · ${row.list.description}`,
              right: policy.listCount(modal, row.list.category),
              selected: index === selected && focused,
              current: index === selected && !focused,
            },
      ),
      selected,
    };
  }
  return { settingRow, listRows };
}
export function settingsNavigationHints(
  state: {
    readonly editingMode: boolean;
    readonly searchFocused: boolean;
    readonly currentCategory: string;
    readonly openList: string | null;
    readonly subscriptionLogoutConfirmationTarget?: unknown;
  },
  policy: {
    readonly resetPending: boolean;
    readonly categoryFocused: boolean;
    readonly flagToggle: boolean;
    /** The selected setting's default in words, for "reset to <default>"; undefined when no setting is selected. */
    readonly resetTo: string | undefined;
    /** True when the selected row opens a list rather than holding a value. */
    readonly onList: boolean;
    /** True when the selected setting's value can be nudged in place (a number or a choice). */
    readonly adjustable: boolean;
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
  const reset: KitHint[] =
    policy.resetTo === undefined ? [] : policy.resetTo === 'Not set' ? [['ctrl+r', 'clear']] : [['ctrl+r', `reset to ${policy.resetTo}`]];
  const adjust: KitHint[] = policy.adjustable ? [['shift+←→', 'adjust']] : [];
  if (state.searchFocused) return [['⏎', 'change'], ...adjust, ...reset, ['tab', 'browse by topic']];
  if (policy.categoryFocused)
    return [
      ['↑↓', 'topic'],
      ['→', 'its settings'],
      ['type', 'search'],
    ];
  if (state.openList !== null) {
    const enter: KitHint = [
      '⏎',
      state.currentCategory === 'mcp'
        ? 'edit trust'
        : state.currentCategory === 'subscriptions'
          ? 'review or sign out'
          : policy.flagToggle && state.currentCategory === 'flags'
            ? 'turn on or off'
            : 'change',
    ];
    const nudge: KitHint[] = state.currentCategory === 'mcp' || state.currentCategory === 'flags' ? [['shift+←→', 'adjust']] : [];
    return [['↑↓', 'move'], enter, ...nudge, ['←', 'back']];
  }
  return [['↑↓', 'move'], ['⏎', policy.onList ? 'open' : 'change'], ...adjust, ...reset, ['←', 'topics']];
}
