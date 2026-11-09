import { activeTokens } from './theme.js';
export interface SettingsValueEntry {
  readonly setting: { readonly key: string };
  readonly currentValue: unknown;
  readonly isDefault: boolean;
  readonly flag?: { readonly feature: { readonly name: string } } | undefined;
}
const CHOICE_LABELS: Readonly<Record<string, string>> = {
  'judgment.policy': 'Decision models', 'judgment.backend': 'Decision provider',
  'judgment.model': 'Decision model', 'judgment.endpoint': 'Decision endpoint',
  'judgment.keySource': 'Credential source', 'judgment.keyName': 'Credential reference',
  'judgment.fallbacks': 'Decision fallback chain', 'judgment.timeoutMs': 'Decision timeout (ms)',
  'provider.decisionRouter': 'Decision Router categories', 'permissions.mode': 'Execution permissions',
};
export function createSettingsValueHelpers<Entry extends SettingsValueEntry>(policy: {
  readonly richValues: boolean;
  readonly featureLabels: boolean;
  readonly isSecretKey: (key: string) => boolean;
  readonly isSecretReference: (value: string) => boolean;
  readonly labels: Readonly<Partial<Record<string, string>>>;
  readonly panelDescription: string;
  readonly bothDescription: string;
}) {
  function maskSecretValue(value: string): string {
    if (!value.length) return '(empty)';
    if (policy.isSecretReference(value)) return value;
    if (value.length <= 4) return '••••';
    return '•'.repeat(Math.min(12, Math.max(4, value.length - 4))) + value.slice(-4);
  }
  function formatValue(entry: Entry): string {
    const value = entry.currentValue;
    if (entry.setting.key === 'judgment.fallbacks' && Array.isArray(value)) {
      return `${value.length} fallback target${value.length === 1 ? '' : 's'} (Enter to ${value.length ? 'edit order' : 'add'})`;
    }
    if (entry.setting.key === 'provider.decisionRouter') return 'Enter to configure category routes';
    if (entry.setting.key === 'judgment.backend' && value && typeof value === 'object' && !Array.isArray(value)) {
      const adapter = (value as { adapter?: unknown }).adapter;
      return adapter === 'cloudflare-workers-ai' ? 'Cloudflare Workers AI' : adapter === 'laya' ? 'Laya' : 'System One';
    }
    if (value === null || value === undefined) return '(unset)';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'string' && policy.isSecretKey(entry.setting.key)) return maskSecretValue(value);
    if (value === '') return '(empty)';
    if (policy.richValues) {
      if (Array.isArray(value)) return value.length ? value.join(', ') : '(empty)';
      if (typeof value === 'object') {
        const count = Object.keys(value).length;
        if (!count) return '(none set)';
        const json = JSON.stringify(value);
        return json.length <= 64 ? json : `${count} entr${count === 1 ? 'y' : 'ies'} (Enter to edit as JSON)`;
      }
    }
    return String(value);
  }
  function valueColor(entry: Entry): string {
    return entry.isDefault ? activeTokens().textMuted : activeTokens().accent;
  }
  function getSettingLabel(entry: Entry): string {
    if (policy.featureLabels && entry.flag) return entry.flag.feature.name;
    const key = entry.setting.key;
    if (Object.hasOwn(CHOICE_LABELS, key)) return CHOICE_LABELS[key] ?? key;
    return (Object.hasOwn(policy.labels, key) ? policy.labels[key] : undefined) ?? key.replace(/^[^.]+\./, '');
  }
  function describeUiRouting(value: string): string {
    if (value === 'panel') return policy.panelDescription;
    if (value === 'conversation') return 'render inline in conversation';
    if (value === 'both') return policy.bothDescription;
    return value;
  }
  return { formatValue, valueColor, getSettingLabel, describeUiRouting };
}
export function flagStateColor(state: string, killed: boolean): string {
  const tokens = activeTokens();
  return killed ? tokens.error : state === 'enabled' ? tokens.accent : tokens.textMuted;
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
