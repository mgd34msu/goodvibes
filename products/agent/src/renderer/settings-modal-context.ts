import { SHARED_SETTING_ENUM_DESCRIPTIONS } from '@goodvibes/engine/terminal-shell/renderer/settings-metadata';
import { buildMcpHelp } from '@goodvibes/engine/terminal-shell/renderer/mcp-trust-context';
import { helpText, helpWarning, type HelpLine } from '@goodvibes/engine/terminal-shell/renderer/settings-documentation';
import { asSentence, firstSentence, settingStateWarnings } from '@goodvibes/engine/terminal-shell/renderer/settings-context';
/**
 * settings-modal-context.ts, the few sentences the settings screen shows under
 * its rows for the selected one: what a setting does, when a change takes
 * effect, its default in words, and where its value comes from when that is
 * not the default; a feature's state; and the MCP-trust and sign-in help of
 * the lists a topic opens. Each line states its kind (HelpLine).
 */

import { GATE_PRESETS } from '@goodvibes/engine/platform/platform/gate';
import type { SettingsModal, SettingEntry, FlagEntry, SubscriptionEntry, SettingsCategory } from '../input/settings-modal.ts';
import { formatDefault, formatValue, getSettingLabel } from './settings-modal-helpers.ts';
import { isSecretConfigKey } from '../config/secret-config.ts';
import { CVV_PROMPT_TRADEOFF_WARNING } from '@goodvibes/engine/platform/platform/payments';
import { formatProviderAuthRouteId } from '../provider-auth-route-display.ts';
import { isDaemonOwnedConfigKey } from '../config/daemon-config-routing.ts';

/** Who acts on a setting the daemon owns, said on every such setting. */
export const HOST_OWNED_SETTING_RULE = 'The daemon owns this setting: a change here is sent to it and it applies it; if it refuses or cannot be reached, nothing changes. With no daemon set up, it is saved for the daemon to read when it starts.';

export const ENUM_VALUE_DESCRIPTIONS: Record<string, Record<string, string>> = {
  'behavior.hitlMode': {
    off: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.hitlMode']['off'],
    quiet: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.hitlMode']['quiet'],
    balanced: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.hitlMode']['balanced'],
    operator: 'Surface more operational detail for users actively supervising agents, tools, connected-host posture, and automation.',
  },
  'behavior.guidanceMode': {
    off: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.guidanceMode']['off'],
    minimal: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.guidanceMode']['minimal'],
    guided: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.guidanceMode']['guided'],
  },
  'permissions.mode': Object.fromEntries(Object.values(GATE_PRESETS).map((preset) => [preset.mode, preset.summary])),
  'diagnostics.postEdit': {
    on: 'After a successful file write/edit, append cheap, in-process syntax diagnostics (errors only) to the tool result. Syntax-level only, not type-checking.',
    off: 'Never append post-edit diagnostics to write/edit tool results.',
  },
  'storage.secretPolicy': {
    preferred_secure: SHARED_SETTING_ENUM_DESCRIPTIONS['storage.secretPolicy']['preferred_secure'],
    require_secure: SHARED_SETTING_ENUM_DESCRIPTIONS['storage.secretPolicy']['require_secure'],
    plaintext_allowed: SHARED_SETTING_ENUM_DESCRIPTIONS['storage.secretPolicy']['plaintext_allowed'],
  },
  'ui.systemMessages': {
    panel: 'Routine system messages go to the Activity view (Ctrl+O) only. Left as the default, a notice you must see still shows on the main screen once (an update result, a setting ignored or read under a new name, a start-up fault); set to panel yourself, it stays in the Activity view too. Never hidden: errors, warnings and anything waiting for your answer.',
    conversation: SHARED_SETTING_ENUM_DESCRIPTIONS['ui.systemMessages']['conversation'],
    both: 'Show system messages in both the activity feed and the transcript.',
  },
  'ui.operationalMessages': {
    panel: 'Tool, agent, MCP and plugin messages go to the Activity view (Ctrl+O) only. Left as the default, one you must see or act on still shows on the main screen once; set to panel yourself, it stays in the Activity view too. Never hidden: errors, warnings and anything waiting for your answer.',
    conversation: SHARED_SETTING_ENUM_DESCRIPTIONS['ui.operationalMessages']['conversation'],
    both: 'Show operational messages in both the activity feed and the transcript.',
  },
  'surfaces.telegram.mode': {
    webhook: 'Receive Telegram updates through externally hosted delivery.',
    polling: 'Poll Telegram for updates from the configured account.',
  },
  'surfaces.whatsapp.provider': {
    'meta-cloud': SHARED_SETTING_ENUM_DESCRIPTIONS['surfaces.whatsapp.provider']['meta-cloud'],
    bridge: 'Use a bridge endpoint URL/token flow instead of direct Meta Cloud API delivery.',
  },
  'batch.mode': SHARED_SETTING_ENUM_DESCRIPTIONS['batch.mode'],
  'batch.fallback': SHARED_SETTING_ENUM_DESCRIPTIONS['batch.fallback'],
};

function formatSubscriptionRoute(route: SubscriptionEntry['activeRoute'] | SubscriptionEntry['preferredRoute']): string {
  return route ? formatProviderAuthRouteId(route) : 'n/a';
}

/** A feature's switch, in words: what it does, whether it is on, and when a change takes effect. */
function buildFlagHelp(entry: FlagEntry | null): HelpLine[] {
  if (!entry) return [];
  return [
    helpText(entry.feature.name),
    helpText(firstSentence(entry.feature.description).first),
    helpText(entry.feature.restartRequired ? 'Takes effect the next time the Agent starts.' : 'Takes effect at once.'),
    helpText(`The default is ${entry.feature.defaultEnabled ? 'On' : 'Off'}.`),
    ...(firstSentence(entry.feature.description).rest ? [helpText(''), helpText(firstSentence(entry.feature.description).rest)] : []),
  ];
}

/** How many items a list a topic opens holds, for its row. */
export function listItemCount(modal: SettingsModal, category: SettingsCategory): string | undefined {
  const count = category === 'flags' ? modal.flagEntries.length
    : category === 'mcp' ? modal.mcpEntries.length
    : category === 'subscriptions' ? modal.subscriptionEntries.length
    : category === 'secure-address-now' ? 0
    : modal.groups.get(category)?.length ?? 0;
  return count > 0 ? String(count) : undefined;
}

/**
 * The help for whatever the screen has selected, one entry per line
 * (unwrapped). The first line names the selection; the row already shows it.
 */
export function settingContextLines(modal: SettingsModal): HelpLine[] {
  if (modal.searchFocused) {
    const selected = modal.getSelected();
    return selected ? buildSettingHelp(modal, selected) : [];
  }
  const category = modal.currentCategory;
  if (category === 'flags') return buildFlagHelp(modal.getSelectedFlag());
  if (category === 'secure-address-now') {
    // The selected row's own words: what is served, why not, and each way's four parts, as the daemon gives them.
    const row = modal.secureAddressRows[Math.max(0, Math.min(modal.secureAddressRows.length - 1, modal.selectedIndex))];
    return row ? [helpText(row.label), ...(row.state ? [helpText(`State: ${row.state}`)] : []), ...row.detail.map((line) => helpText(line))] : [];
  }
  if (category === 'mcp') return buildMcpHelp(modal, modal.getSelectedMcp());
  if (category === 'subscriptions') return buildSubscriptionHelp(modal, modal.getSelectedSubscription());
  const list = modal.getSelectedListRow();
  if (list !== null) {
    const row = modal.visibleRows().find((candidate) => candidate.kind === 'list' && candidate.list.category === list);
    return row?.kind === 'list' ? [helpText(row.list.label), helpText(asSentence(`Opens ${row.list.description}`))] : [];
  }
  const selected = modal.getSelected();
  return selected ? buildSettingHelp(modal, selected) : [];
}

import { createSettingContext, createSubscriptionContext } from '@goodvibes/engine/terminal-shell/renderer/settings-context';
export const { currentSettingValue, buildSettingHelp } = createSettingContext<SettingsModal, SettingEntry>({
  isSecretKey: isSecretConfigKey,
  cursor: '▏',
  formatValue,
  formatDefault,
  label: getSettingLabel,
  source: (modal, entry) => modal.describeSource(entry),
  detail(entry) {
    const lines: HelpLine[] = [];
    if (entry.setting.key === 'payments.cvvHandling' && entry.currentValue === 'prompt') lines.push(helpWarning(CVV_PROMPT_TRADEOFF_WARNING));
    // A value the daemon holds and has not given is unknown here, and the row says so.
    if (entry.effectiveSource === 'unavailable' && entry.currentValue === undefined && entry.sourceLabel)
      lines.push(helpWarning(entry.sourceLabel.startsWith('reading')
        ? 'Asking the daemon what it holds for this setting.'
        : asSentence(entry.sourceLabel.replace(/^host value unavailable: /, ''))));
    lines.push(...settingStateWarnings(entry));
    if (isDaemonOwnedConfigKey(entry.setting.key)) lines.push(helpText(HOST_OWNED_SETTING_RULE));
    return lines;
  },
  enumDescriptions: ENUM_VALUE_DESCRIPTIONS,
  customEditing: (entry) =>
    entry.setting.key === 'display.theme'
      ? 'Enter opens the theme picker with a live preview; Enter keeps the theme, Esc puts the previous one back.'
      : undefined,
});
const buildSubscriptionHelp = createSubscriptionContext<SettingsModal>({
  confirmLogout: (provider) => `Press Enter again to sign out ${provider}. Move selection or close config to cancel.`,
  beginLogout: 'Press Enter to review sign-out for this provider session.',
  login: (provider) => `Open Agent Workspace -> Start and choose Sign in to a provider for ${provider}.`,
  route: formatSubscriptionRoute,
});
