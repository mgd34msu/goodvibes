import { SHARED_SETTING_ENUM_DESCRIPTIONS } from '@goodvibes/engine/terminal-shell/renderer/settings-metadata';
import { buildMcpHelp } from '@goodvibes/engine/terminal-shell/renderer/mcp-trust-context';
import { helpText, helpWarning, type HelpLine } from '@goodvibes/engine/terminal-shell/renderer/settings-documentation';
import { asSentence, firstSentence, settingStateWarnings } from '@goodvibes/engine/terminal-shell/renderer/settings-context';
/**
 * settings-modal-context.ts, the few sentences the settings screen shows under
 * its rows for the selected one: what a setting does, when a change takes
 * effect, its default in words, and where its value comes from when that is
 * not the default; a feature's state; and the MCP-trust, sign-in and
 * connection help of the lists a topic opens. Each line states its kind
 * (HelpLine); the renderer wraps and styles it by that kind.
 */

import type { SettingsModal, SettingEntry, SettingsCategory } from '../input/settings-modal.ts';
import { FEATURE_SETTINGS_BY_ID, isFeatureValueEnabled } from '@goodvibes/engine/terminal-shell';
import { formatDefault, formatValue, getSettingLabel } from './settings-modal-helpers.ts';
import { buildConnectionHelp } from './settings-modal-connections.ts';
import { isSecretConfigKey } from '../config/secret-config.ts';
import { CVV_PROMPT_TRADEOFF_WARNING } from '@goodvibes/engine/platform/platform/payments';
import { GLYPHS } from './ui-primitives.ts';
import { GATE_PRESETS } from '@goodvibes/engine/platform/platform/gate';

export const ENUM_VALUE_DESCRIPTIONS: Record<string, Record<string, string>> = {
  'display.themeMode': {
    auto: 'Probe the terminal background colour (OSC 11) once at startup and pick light or dark. Falls back to dark on unreadable/unsupported terminals. Selecting auto applies now when the terminal reported its background at startup, otherwise at the next launch.',
    dark: 'Force the dark theme regardless of terminal background. Applies immediately.',
    light: 'Force the light theme regardless of terminal background. Applies immediately.',
  },
  'behavior.hitlMode': {
    off: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.hitlMode']['off'],
    quiet: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.hitlMode']['quiet'],
    balanced: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.hitlMode']['balanced'],
    operator: 'Surface more operational detail for users actively supervising agents, tools, services, and automation.',
  },
  'behavior.guidanceMode': {
    off: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.guidanceMode']['off'],
    minimal: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.guidanceMode']['minimal'],
    guided: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.guidanceMode']['guided'],
  },
  'permissions.mode': Object.fromEntries(Object.values(GATE_PRESETS).map((preset) => [preset.mode, preset.summary])),
  'diagnostics.postEdit': {
    on: 'After the model edits or writes a file, run language diagnostics on it and surface any new problems.',
    off: 'Do not run diagnostics automatically after edits.',
  },
  'storage.secretPolicy': {
    preferred_secure: SHARED_SETTING_ENUM_DESCRIPTIONS['storage.secretPolicy']['preferred_secure'],
    require_secure: SHARED_SETTING_ENUM_DESCRIPTIONS['storage.secretPolicy']['require_secure'],
    plaintext_allowed: SHARED_SETTING_ENUM_DESCRIPTIONS['storage.secretPolicy']['plaintext_allowed'],
  },
  'batch.mode': SHARED_SETTING_ENUM_DESCRIPTIONS['batch.mode'],
  'batch.fallback': SHARED_SETTING_ENUM_DESCRIPTIONS['batch.fallback'],
  'controlPlane.hostMode': {
    local: 'Bind only to this computer.',
    network: 'Bind for LAN access using the default network host; other machines are served once controlPlane.enabled is on.',
    custom: 'Use the explicit host value in the related host setting.',
  },
  'httpListener.hostMode': {
    local: 'Bind only to this computer.',
    network: 'Bind for LAN/webhook access using the default network host.',
    custom: 'Use the explicit host value in the related host setting.',
  },
  'web.hostMode': {
    local: 'Serve the browser UI only on this computer.',
    network: 'Serve the browser UI on the LAN.',
    custom: 'Use the explicit host value in the related host setting.',
  },
  'ui.systemMessages': {
    panel: 'Keep system messages out of the transcript: they go to Notifications only (toast and history). Errors and warnings still show in the transcript.',
    conversation: 'Show system messages in the transcript; each is also kept in Notifications.',
    both: 'Same as conversation here: every transcript message is also kept in Notifications.',
  },
  'ui.operationalMessages': {
    panel: 'Keep tool, agent, MCP and plugin activity out of the transcript: it goes to Notifications only (toast and history). Errors and warnings still show in the transcript.',
    conversation: 'Show operational messages in the transcript; each is also kept in Notifications.',
    both: 'Same as conversation here: every transcript message is also kept in Notifications.',
  },
  'ui.contractMessages': {
    panel: 'Keep contract updates out of the transcript: they go to Notifications only (toast and history).',
    conversation: 'Show contract updates in the transcript; each is also kept in Notifications.',
    both: 'Same as conversation here: every transcript message is also kept in Notifications. The default.',
  },
  'surfaces.telegram.mode': {
    webhook: 'Receive Telegram updates through webhook delivery.',
    polling: 'Poll Telegram for updates from the service.',
  },
  'surfaces.whatsapp.provider': {
    'meta-cloud': SHARED_SETTING_ENUM_DESCRIPTIONS['surfaces.whatsapp.provider']['meta-cloud'],
    bridge: 'Use a bridge service URL/token flow instead of direct Meta Cloud API delivery.',
  },
  'payments.cvvHandling': {
    stored: 'Store the CVV through the secret manager so the daemon can complete a purchase unattended.',
    prompt: CVV_PROMPT_TRADEOFF_WARNING,
  },
};

/**
 * The help for a feature's switch, in words: what the feature does, whether it
 * is on, when a change takes effect, and a restart still pending.
 */
function buildFlagHelp(entry: SettingEntry): HelpLine[] {
  const flagEntry = entry.flag!;
  const { feature, state, pendingRestart } = flagEntry;
  const on = isFeatureValueEnabled(feature, entry.currentValue);
  const lines: HelpLine[] = [
    helpText(feature.name),
    ...settingStateWarnings(entry),
    // A capability the registry declares not operable reads as off whatever its setting says; say why where the two disagree.
    ...(feature.operable === false && feature.inoperableDetail ? [helpWarning(`Not available in this build: ${feature.inoperableDetail}`)] : []),
    ...(pendingRestart
      ? [helpWarning(`Saved ${on ? 'on' : 'off'}; it stays ${state === 'enabled' ? 'on' : 'off'} until the next start.`)]
      : []),
    helpText(firstSentence(feature.description).first),
  ];
  const value = entry.currentValue;
  const meaning = typeof value === 'string' ? ENUM_VALUE_DESCRIPTIONS[entry.setting.key]?.[value] : undefined;
  if (meaning) lines.push(helpText(`${formatValue(entry)}: ${meaning}`));
  lines.push(helpText(feature.restartRequired ? 'Takes effect after a restart.' : 'Takes effect at once.'));
  lines.push(helpText(`The default is ${feature.defaultEnabled ? 'On' : 'Off'}.`));
  const rest = firstSentence(feature.description).rest;
  if (rest) lines.push(helpText(''), helpText(rest));
  return lines;
}

/**
 * The help for whatever the screen has selected, one entry per line
 * (unwrapped). The first line names the selection; the row already shows it.
 */
export function settingContextLines(modal: SettingsModal): HelpLine[] {
  if (modal.searchFocused) {
    const selected = modal.getSelected();
    if (selected) return buildSettingHelp(modal, selected);
    return [];
  }
  const category = modal.currentCategory;
  if (category === 'mcp') return buildMcpHelp(modal, modal.getSelectedMcp());
  if (category === 'subscriptions') return buildSubscriptionHelp(modal, modal.getSelectedSubscription());
  if (category === 'connections') return buildConnectionHelp(modal);
  const list = modal.getSelectedListRow();
  if (list !== null) {
    const row = modal.visibleRows().find((candidate) => candidate.kind === 'list' && candidate.list.category === list);
    return row?.kind === 'list' ? [helpText(row.list.label), helpText(asSentence(`Opens ${row.list.description}`))] : [];
  }
  const selected = modal.getSelected();
  if (selected?.flag) return buildFlagHelp(selected);
  if (selected) return buildSettingHelp(modal, selected);
  return [];
}

/** How many items a list a topic opens holds, for its row. */
export function listItemCount(modal: SettingsModal, category: SettingsCategory): string | undefined {
  const count = category === 'mcp' ? modal.mcpEntries.length
    : category === 'subscriptions' ? modal.subscriptionEntries.length
    : category === 'connections' ? modal.connectionEntries.length
    : modal.groups.get(category)?.length ?? 0;
  return count > 0 ? String(count) : undefined;
}

import { createSettingContext, createSubscriptionContext } from '@goodvibes/engine/terminal-shell/renderer/settings-context';
export const { currentSettingValue, buildSettingHelp } = createSettingContext<SettingsModal, SettingEntry>({
  isSecretKey: isSecretConfigKey,
  cursor: GLYPHS.surface.cursor,
  formatValue,
  formatDefault,
  label: getSettingLabel,
  source: (modal, entry) => modal.describeSource(entry),
  detail(entry) {
    const lines: HelpLine[] = settingStateWarnings(entry);
    // A setting a feature owns names the feature, so what it belongs to is answered here.
    if (entry.ownerFlagId) {
      const owner = FEATURE_SETTINGS_BY_ID.get(entry.ownerFlagId);
      if (owner) lines.push(helpText(`Part of ${owner.name}.`));
    }
    return lines;
  },
  enumDescriptions: ENUM_VALUE_DESCRIPTIONS,
});
const buildSubscriptionHelp = createSubscriptionContext<SettingsModal>({
  confirmLogout: (provider) => `Sign out ${provider}? Enter/y to confirm, n/Esc to cancel.`,
  beginLogout: 'Press Enter to begin sign-out for this provider session.',
  login: (provider) => `Use /provider sign-in ${provider} to begin OAuth sign-in for this provider.`,
  route: (value) => value ?? 'n/a',
});
