import { maskConcealedText } from '../concealed-input.js';
import { inferSubscriptionRouteReason, type SubscriptionEntry } from '../settings-subscriptions.js';
import { settingChoiceWords } from './settings-value-helpers.js';
import { helpFact as fact, helpHeading as heading, helpText as text, helpWarning as warning, type HelpLine } from './settings-documentation.js';

const blank: HelpLine = text('');

/** When a change takes effect, where the setting declares it. */
const APPLIES_WHEN_WORDS: Readonly<Record<string, string>> = {
  now: 'Takes effect at once.',
  'next-answer': 'Takes effect on the next answer.',
  'next-session': 'Takes effect in the next session.',
  restart: 'Takes effect after a restart.',
};

/**
 * A description's first sentence, and the rest: the help leads with the one
 * sentence, and the rest follows the facts for whoever pages down to it.
 */
export function firstSentence(text: string): { readonly first: string; readonly rest: string } {
  const trimmed = text.trim();
  const match = /^(.+?[.!?])\s+(?=[A-Z])/.exec(trimmed);
  if (!match || match[1]!.length < 12) return { first: asSentence(trimmed), rest: '' };
  return { first: asSentence(match[1]!), rest: asSentence(trimmed.slice(match[0].length)) };
}

/** A description as a sentence: a capital first and a full stop last. */
export function asSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?:)]$/.test(capital) ? capital : `${capital}.`;
}

interface SettingContextEntry {
  readonly setting: {
    readonly key: string;
    readonly default: unknown;
    readonly type: string;
    readonly description?: string | undefined;
    readonly enumValues?: readonly string[] | undefined;
    readonly appliesWhen?: string | undefined;
  };
  readonly currentValue: unknown;
  readonly isDefault: boolean;
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
  readonly formatDefault: (entry: Entry) => string;
  readonly label: (entry: Entry) => string;
  /** Where the value comes from, in a sentence, when that is not the default; undefined otherwise. */
  readonly source: (modal: Modal, entry: Entry) => string | undefined;
  /** The product's own lines for one setting (lock, conflict, ownership), each with its kind. */
  readonly detail: (entry: Entry) => readonly HelpLine[];
  readonly enumDescriptions: Readonly<Partial<Record<string, Readonly<Partial<Record<string, string>>>>>>;
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
   * The help for one setting, in sentences: what it does, when a change takes
   * effect (where the setting declares it), the default in words, and where the
   * value comes from when it is not the default.
   */
  function buildSettingHelp(modal: Modal, entry: Entry): HelpLine[] {
    // Warnings among the product's lines are shown first by the renderer; the rest follow the facts.
    const lines: HelpLine[] = [text(policy.label(entry))];
    const description = firstSentence(entry.setting.description ?? '');
    if (description.first) lines.push(text(description.first));
    const applies = entry.setting.appliesWhen ? APPLIES_WHEN_WORDS[entry.setting.appliesWhen] : undefined;
    if (applies) lines.push(text(applies));
    const defaultWords = policy.formatDefault(entry);
    lines.push(text(defaultWords === 'Not set' ? 'By default it is not set.' : `The default is ${defaultWords}.`));
    const source = policy.source(modal, entry);
    if (source) lines.push(text(source));
    const value = entry.currentValue;
    const descriptions = Object.hasOwn(policy.enumDescriptions, entry.setting.key) ? policy.enumDescriptions[entry.setting.key] : undefined;
    if (typeof value === 'string' && descriptions && Object.hasOwn(descriptions, value) && descriptions[value])
      lines.push(text(`${settingChoiceWords(entry.setting.key, value)}: ${descriptions[value]}`));
    lines.push(...policy.detail(entry));
    if (policy.isSecretKey(entry.setting.key))
      lines.push(text('What you type is hidden and kept in the secret store; the settings file holds only a reference to it. Saving it empty changes nothing: reset on this row removes a stored one (it asks first).'));
    const customEditing = policy.customEditing?.(entry);
    if (customEditing) lines.push(text(customEditing));
    if (description.rest) lines.push(blank, text(description.rest));
    return lines;
  }
  return { currentSettingValue, buildSettingHelp };
}

/** Where a value comes from, in words, for the sources every terminal program shares. */
export function settingSourceWords(input: {
  /** The settings control plane's source: a managed policy or a synced copy wins over the file. */
  readonly effectiveSource?: string | undefined;
  /** Which store the live value resolved from. */
  readonly tier?: 'daemon' | 'shared' | 'project' | 'global' | 'default' | undefined;
  /** True when this run's environment or command line set it. */
  readonly runtime?: boolean | undefined;
  /** This program's name, "the terminal app" or "the Agent". */
  readonly program: string;
}): string | undefined {
  if (input.effectiveSource === 'managed') return 'Set by your organization\'s managed settings.';
  if (input.effectiveSource === 'synced') return 'Set by settings synced from another computer.';
  if (input.runtime) return 'Set by the environment this program was started with.';
  switch (input.tier) {
    case 'daemon': return 'Set in the daemon\'s settings.';
    case 'shared': return 'Set in the settings both terminal programs share.';
    case 'project': return 'Set in this project\'s settings.';
    case 'global': return `Set in ${input.program}'s settings file.`;
    default: return undefined;
  }
}

/** The warning lines a setting's state needs, in words: unavailable, locked, in conflict. */
export function settingStateWarnings(entry: {
  readonly setting: { readonly key: string };
  readonly metadataUnavailable?: string | undefined;
  readonly locked?: boolean | undefined;
  readonly lockReason?: string | undefined;
  readonly conflict?: boolean | undefined;
}): HelpLine[] {
  const lines: HelpLine[] = [];
  if (entry.metadataUnavailable) lines.push(warning(`This setting cannot be read right now: ${entry.metadataUnavailable}`));
  if (entry.locked) lines.push(warning(entry.lockReason ? `Locked: ${entry.lockReason}` : 'Locked by a setting that takes priority over this one.'));
  if (entry.conflict) lines.push(warning(`This value disagrees with a synced copy; Devices and network, Settings sync, settle it keeps one.`));
  return lines;
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
  // Help lines with their kinds; helpLineText gives their plain text.
  return help;
}
