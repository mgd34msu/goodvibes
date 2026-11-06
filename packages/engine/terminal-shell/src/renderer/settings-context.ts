import { maskConcealedText } from '../concealed-input.js';
import { NOTIFICATIONS_METADATA_ONLY_KEY } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { inferSubscriptionRouteReason, type SubscriptionEntry } from '../settings-subscriptions.js';
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
  function buildSettingContext(modal: Modal, entry: Entry): string[] {
    const lines = [
      policy.label(entry),
      `Key: ${entry.setting.key}`,
      `Current: ${currentSettingValue(modal, entry, true)}`,
      `Default: ${formatDefaultValue(entry.setting.default)}`,
      `Type: ${entry.setting.type}${entry.setting.enumValues ? ` with ${entry.setting.enumValues.length} possible value(s)` : ''}`,
      `Source: ${policy.source(entry)}${entry.sourceLabel ? ` from ${entry.sourceLabel}` : ''}`,
      ...policy.detail(entry),
    ];
    if (policy.routingKeys.includes(entry.setting.key))
      lines.push(`Routing meaning: ${policy.describeUiRouting(String(entry.currentValue))}.`);
    if (entry.setting.type === 'boolean') {
      lines.push('', 'Possible values:');
      if (entry.setting.key === NOTIFICATIONS_METADATA_ONLY_KEY)
        lines.push(
          'true: Keep notifications metadata-only (restrictive default).',
          'false: Explicitly permit notification details on supported paths.',
        );
      else lines.push('true: enabled or allowed for this setting.', 'false: disabled or not allowed for this setting.');
    }
    if (entry.setting.type === 'enum' && entry.setting.enumValues) {
      lines.push('', 'Possible values:');
      const descriptions = Object.hasOwn(policy.enumDescriptions, entry.setting.key)
        ? policy.enumDescriptions[entry.setting.key]
        : undefined;
      for (const value of entry.setting.enumValues)
        lines.push(
          `${value}: ${descriptions && Object.hasOwn(descriptions, value) ? descriptions[value] : `Use ${value} for this setting.`}`,
        );
    }
    const secret = policy.isSecretKey(entry.setting.key);
    if (secret)
      lines.push(
        '',
        'Secret handling: raw values entered here are stored through the secret manager and the config receives a goodvibes:// secret reference. Empty input clears the config value.',
      );
    if (entry.setting.type === 'number')
      lines.push('', 'Editing: Enter opens inline edit, then type the value and press Enter to save. Arrow keys only navigate.');
    const customEditing = policy.customEditing?.(entry);
    if (customEditing) lines.push('', customEditing);
    else if (entry.setting.type === 'string' && !secret)
      lines.push(
        '',
        'Editing: Enter opens inline edit. Delete the current text to save an empty value when that is valid for the setting.',
      );
    return lines;
  }
  return { currentSettingValue, buildSettingContext };
}
export function createSubscriptionContext<Modal extends { readonly subscriptionLogoutConfirmationTarget: string | null }>(policy: {
  readonly confirmLogout: (provider: string) => string;
  readonly beginLogout: string;
  readonly login: (provider: string) => string;
  readonly route: (value: SubscriptionEntry['activeRoute'] | SubscriptionEntry['preferredRoute']) => string;
}) {
  return (modal: Modal, entry: SubscriptionEntry | null): string[] => {
    if (!entry) return ['Subscriptions', 'No subscription provider is selected.'];
    const routeReason = inferSubscriptionRouteReason(entry);
    const logout =
      entry.state === 'active' || entry.state === 'pending'
        ? modal.subscriptionLogoutConfirmationTarget === entry.provider
          ? policy.confirmLogout(entry.provider)
          : policy.beginLogout
        : policy.login(entry.provider);
    return [
      entry.provider,
      `State: ${entry.state}`,
      ...(routeReason ? [routeReason] : []),
      logout,
      `Active route: ${policy.route(entry.activeRoute)}`,
      `Preferred route: ${policy.route(entry.preferredRoute)}`,
      `OAuth configured: ${entry.oauthConfigured ? 'yes' : 'no'}`,
      `Freshness: ${entry.authFreshness ?? 'n/a'}`,
      `Expires: ${entry.expiresAt ? new Date(entry.expiresAt).toISOString() : 'not reported'}`,
      ...((entry.issues ?? []).length ? ['', 'Issues:', ...(entry.issues ?? [])] : []),
      ...((entry.nextActions ?? []).length ? ['', 'Next actions:', ...(entry.nextActions ?? [])] : []),
    ];
  };
}
