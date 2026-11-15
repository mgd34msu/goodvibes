import { maskConcealedText } from '../concealed-input.js';
import { NOTIFICATIONS_METADATA_ONLY_KEY } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { inferSubscriptionRouteReason, type SubscriptionEntry } from '../settings-subscriptions.js';
import { helpLineText, type HelpLine } from './settings-documentation.js';

const text = (line: string): HelpLine => ({ kind: 'text', text: line });
const heading = (line: string): HelpLine => ({ kind: 'heading', text: line });
const blank: HelpLine = { kind: 'text', text: '' };
/** A `Label: value` fact; `folded` is its entry in the one facts row. */
const fact = (label: string, value: string, folded?: string): HelpLine => ({ kind: 'fact', text: `${label}: ${value}`, folded });
export function formatDefaultValue(value: unknown): string {
  if (value === '') return '(empty)';
  if (value === null || value === undefined) return '(unset)';
  return String(value);
}
interface SettingContextEntry {
  readonly setting: {
    readonly key: string;
    readonly default: unknown;
    readonly type: string;
    readonly description?: string | undefined;
    readonly enumValues?: readonly string[] | undefined;
  };
  readonly currentValue: unknown;
  readonly effectiveSource?: string | undefined;
  readonly sourceLabel?: string | undefined;
}
interface SettingContextModal {
  readonly editingMode: boolean;
  readonly editBuffer: string;
}
export function createSettingContext<Modal extends SettingContextModal, Entry extends SettingContextEntry>(policy: {
  readonly isSecretKey: (key: string) => boolean;
  readonly cursor: string;
  readonly formatValue: (entry: Entry) => string;
  readonly label: (entry: Entry) => string;
  readonly source: (entry: Entry) => string;
  readonly detail: (entry: Entry) => string[];
  readonly enumDescriptions: Readonly<Partial<Record<string, Readonly<Partial<Record<string, string>>>>>>;
  readonly routingKeys: readonly string[];
  readonly describeUiRouting: (value: string) => string;
  readonly customEditing?: ((entry: Entry) => string | undefined) | undefined;
}) {
  function currentSettingValue(modal: Modal, entry: Entry, selected: boolean): string {
    if (selected && modal.editingMode) {
      const buffer = policy.isSecretKey(entry.setting.key) ? maskConcealedText(modal.editBuffer) : modal.editBuffer;
      return buffer + policy.cursor;
    }
    return policy.formatValue(entry);
  }
  /**
   * The help for one setting, each line with its kind (see HelpLine). The
   * product's own detail lines stay plain strings, read by their wording.
   */
  function buildSettingHelp(modal: Modal, entry: Entry): Array<string | HelpLine> {
    const type = `${entry.setting.type}${entry.setting.enumValues ? ` with ${entry.setting.enumValues.length} possible value(s)` : ''}`;
    const source = `${policy.source(entry)}${entry.sourceLabel ? ` from ${entry.sourceLabel}` : ''}`;
    const defaultValue = formatDefaultValue(entry.setting.default);
    const lines: Array<string | HelpLine> = [
      text(policy.label(entry)),
      fact('Key', entry.setting.key, entry.setting.key),
      { ...fact('Current', currentSettingValue(modal, entry, true)), onRow: true },
      fact('Default', defaultValue, `default ${defaultValue}`),
      fact('Type', type, type),
      fact('Source', source, `source ${source}`),
      ...policy.detail(entry),
      ...(entry.setting.description ? [blank, text(entry.setting.description)] : []),
    ];
    if (policy.routingKeys.includes(entry.setting.key))
      lines.push(text(`Routing meaning: ${policy.describeUiRouting(String(entry.currentValue))}.`));
    if (entry.setting.type === 'boolean') {
      lines.push(blank, heading('Possible values:'));
      if (entry.setting.key === NOTIFICATIONS_METADATA_ONLY_KEY)
        lines.push(
          text('true: Keep notifications metadata-only (restrictive default).'),
          text('false: Explicitly permit notification details on supported paths.'),
        );
      else lines.push(text('true: enabled or allowed for this setting.'), text('false: disabled or not allowed for this setting.'));
    }
    if (entry.setting.type === 'enum' && entry.setting.enumValues) {
      lines.push(blank, heading('Possible values:'));
      const descriptions = Object.hasOwn(policy.enumDescriptions, entry.setting.key)
        ? policy.enumDescriptions[entry.setting.key]
        : undefined;
      for (const value of entry.setting.enumValues)
        lines.push(
          text(`${value}: ${descriptions && Object.hasOwn(descriptions, value) ? descriptions[value] : `Use ${value} for this setting.`}`),
        );
    }
    const secret = policy.isSecretKey(entry.setting.key);
    if (secret)
      lines.push(
        blank,
        {
          kind: 'warning',
          text: 'Secret handling: raw values entered here are stored through the secret manager and the config receives a goodvibes:// secret reference. Empty input clears the config value.',
        },
      );
    if (entry.setting.type === 'number')
      lines.push(blank, text('Editing: Enter opens inline edit, then type the value and press Enter to save. Arrow keys only navigate.'));
    const customEditing = policy.customEditing?.(entry);
    if (customEditing) lines.push(blank, text(customEditing));
    else if (entry.setting.type === 'string' && !secret)
      lines.push(
        blank,
        text('Editing: Enter opens inline edit. Delete the current text to save an empty value when that is valid for the setting.'),
      );
    return lines;
  }
  /** The same help as plain text lines. */
  function buildSettingContext(modal: Modal, entry: Entry): string[] {
    return helpLineText(buildSettingHelp(modal, entry));
  }
  return { currentSettingValue, buildSettingHelp, buildSettingContext };
}
export function createSubscriptionContext<Modal extends { readonly subscriptionLogoutConfirmationTarget: string | null }>(policy: {
  readonly confirmLogout: (provider: string) => string;
  readonly beginLogout: string;
  readonly login: (provider: string) => string;
  readonly route: (value: SubscriptionEntry['activeRoute'] | SubscriptionEntry['preferredRoute']) => string;
}) {
  const help = (modal: Modal, entry: SubscriptionEntry | null): HelpLine[] => {
    if (!entry) return [text('Subscriptions'), text('No subscription provider is selected.')];
    const routeReason = inferSubscriptionRouteReason(entry);
    const logout =
      entry.state === 'active' || entry.state === 'pending'
        ? modal.subscriptionLogoutConfirmationTarget === entry.provider
          ? policy.confirmLogout(entry.provider)
          : policy.beginLogout
        : policy.login(entry.provider);
    return [
      text(entry.provider),
      fact('State', entry.state),
      ...(routeReason ? [text(routeReason)] : []),
      modal.subscriptionLogoutConfirmationTarget === entry.provider && (entry.state === 'active' || entry.state === 'pending')
        ? { kind: 'warning' as const, text: logout }
        : text(logout),
      fact('Active route', policy.route(entry.activeRoute)),
      fact('Preferred route', policy.route(entry.preferredRoute)),
      fact('OAuth configured', entry.oauthConfigured ? 'yes' : 'no'),
      fact('Freshness', entry.authFreshness ?? 'n/a'),
      fact('Expires', entry.expiresAt ? new Date(entry.expiresAt).toISOString() : 'not reported'),
      ...((entry.issues ?? []).length ? [blank, heading('Issues:'), ...(entry.issues ?? []).map(text)] : []),
      ...((entry.nextActions ?? []).length ? [blank, heading('Next actions:'), ...(entry.nextActions ?? []).map(text)] : []),
    ];
  };
  // Help lines with their kinds, and the same lines as plain text.
  return Object.assign((modal: Modal, entry: SubscriptionEntry | null): string[] => helpLineText(help(modal, entry)), { help });
}
