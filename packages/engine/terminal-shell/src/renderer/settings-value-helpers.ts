import { gatePresetLabel } from '@goodvibes/engine/platform/platform/gate/presets';
import { activeTokens } from './theme.js';
export interface SettingsValueEntry {
  readonly setting: {
    readonly key: string;
    readonly label?: string | undefined;
    readonly type?: string | undefined;
    readonly enumValues?: readonly string[] | undefined;
    readonly enumLabels?: Readonly<Record<string, string>> | undefined;
    readonly default?: unknown;
  };
  readonly currentValue: unknown;
  readonly isDefault: boolean;
  readonly flag?: { readonly feature: { readonly name: string } } | undefined;
  /** `unavailable` with no current value: the host owns the value and it is being read or could not be read. */
  readonly effectiveSource?: string | undefined;
  /** Why, for an unavailable row ("reading from the connected host", "host value unavailable: ..."). */
  readonly sourceLabel?: string | undefined;
}

/** The setting facts value words are read from: its key, kind, choices and plain name. */
export interface SettingWordsFacts {
  readonly key: string;
  readonly label?: string | undefined;
  readonly type?: string | undefined;
  readonly enumValues?: readonly string[] | undefined;
  /** The schema's words for stored values that read differently (`judgment.policy`'s Hybrid reads "Ask me"). */
  readonly enumLabels?: Readonly<Record<string, string>> | undefined;
}

/** Text settings that hold one of a set of named levels ("medium"), read as a choice. */
const LEVEL_KEYS = /(^|\.)reasoningEffort$/;

/** Units a setting's name states in its closing brackets, "Wait before retrying (ms)". */
const NAMED_UNITS = new Set(['%', 'bytes', 'ms', 'minutes', 'days', 'MB', 'MB per second', 'seconds', 'years', 'hours', 'USD']);

/** What a setting's name says about its number: its unit and what 0 means ("(ms, 0 for no limit)"). */
function namedNumber(label: string | undefined): { readonly unit?: string; readonly zero?: string } {
  const bracket = label?.match(/\(([^)]*)\)\s*$/)?.[1];
  if (!bracket) return {};
  let unit: string | undefined;
  let zero: string | undefined;
  for (const part of bracket.split(',').map((piece) => piece.trim())) {
    if (NAMED_UNITS.has(part)) unit = part;
    const means = part.match(/^0 for (.+)$/)?.[1];
    if (means) zero = means.charAt(0).toUpperCase() + means.slice(1);
  }
  return { ...(unit ? { unit } : {}), ...(zero ? { zero } : {}) };
}

/** A choice's own words: the permission modes' labels, otherwise the value written as words ("jev-decides" reads "Jev decides"). */
export function settingChoiceWords(key: string, value: string): string {
  if (key === 'permissions.mode') return gatePresetLabel(value);
  if (value === '') return 'Not set';
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/**
 * A setting's value as a person reads it: On or Off, the choice's words, the
 * number with the unit its name states, "Not set" for nothing. A secret is
 * masked by the caller before it gets here.
 */
export function settingValueWords(setting: SettingWordsFacts, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Not set';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'string' && setting.enumLabels !== undefined && Object.hasOwn(setting.enumLabels, value)) return setting.enumLabels[value]!;
  if (typeof value === 'string' && (setting.type === 'enum' || setting.enumValues || LEVEL_KEYS.test(setting.key))) return settingChoiceWords(setting.key, value);
  if (typeof value === 'number') {
    const { unit, zero } = namedNumber(setting.label);
    if (value === 0 && zero) return zero;
    if (!unit) return String(value);
    if (unit === '%') return `${value}%`;
    return `${value} ${value === 1 && unit.endsWith('s') ? unit.slice(0, -1) : unit}`;
  }
  if (Array.isArray(value)) return value.length ? value.map(String).join(', ') : 'None';
  if (typeof value === 'object') {
    const count = Object.keys(value).length;
    return count ? `${count} entr${count === 1 ? 'y' : 'ies'}` : 'None';
  }
  return String(value);
}

export function createSettingsValueHelpers<Entry extends SettingsValueEntry>(policy: {
  readonly isSecretKey: (key: string) => boolean;
  /** True when the daemon keeps this credential (it is daemon-owned), false when this computer does. */
  readonly isDaemonKept: (key: string) => boolean;
}) {
  /** Whether a credential is held and where; never any part of the value. */
  function heldWords(key: string, value: string): string {
    if (!value.trim().length) return 'Not set';
    return policy.isDaemonKept(key) ? 'Set · kept by the daemon' : 'Set · kept on this computer';
  }
  /** The value a row shows, in words. */
  function formatValue(entry: Entry): string {
    const value = entry.currentValue;
    if (entry.setting.key === 'judgment.fallbacks' && Array.isArray(value)) {
      return value.length ? `${value.length} backup model${value.length === 1 ? '' : 's'}` : 'None';
    }
    if (entry.setting.key === 'provider.decisionRouter') return 'Choose';
    if (entry.setting.key === 'judgment.backend' && value && typeof value === 'object' && !Array.isArray(value)) {
      const adapter = (value as { adapter?: unknown }).adapter;
      return adapter === 'cloudflare-workers-ai' ? 'Cloudflare Workers AI' : adapter === 'laya' ? 'Laya' : 'System One';
    }
    // A value the host owns and has not given is unknown, not unset.
    if (value === undefined && entry.effectiveSource === 'unavailable') {
      return entry.sourceLabel?.startsWith('reading') ? 'Asking the daemon…' : 'Unknown';
    }
    if (policy.isSecretKey(entry.setting.key)) return typeof value === 'string' ? heldWords(entry.setting.key, value) : 'Not set';
    return settingValueWords(entry.setting, value);
  }
  /** The default a row returns to, in words. */
  function formatDefault(entry: Entry): string {
    if (policy.isSecretKey(entry.setting.key)) return 'Not set';
    return settingValueWords(entry.setting, entry.setting.default);
  }
  function valueColor(entry: Entry): string {
    return entry.isDefault ? activeTokens().textMuted : activeTokens().accent;
  }
  /** A setting's plain name: the feature's name for a feature's switch, else the setting's own label. */
  function getSettingLabel(entry: Entry): string {
    if (entry.flag) return entry.flag.feature.name;
    return entry.setting.label ?? entry.setting.key;
  }
  return { formatValue, formatDefault, valueColor, getSettingLabel };
}
export function flagStateColor(state: string): string {
  const tokens = activeTokens();
  return state === 'enabled' ? tokens.accent : tokens.textMuted;
}
export function mcpTrustColor(mode: string): string {
  const tokens = activeTokens();
  if (mode === 'allow-all') return tokens.error;
  if (mode === 'ask-on-risk') return tokens.warning;
  if (mode === 'constrained') return tokens.accent;
  return tokens.textMuted;
}
export function subscriptionStateColor(state: string): string {
  const tokens = activeTokens();
  if (state === 'active') return tokens.accent;
  if (state === 'pending') return tokens.warning;
  if (state === 'available') return tokens.info;
  return tokens.textMuted;
}
