import { SHARED_SETTING_ENUM_DESCRIPTIONS } from '@goodvibes-jev/engine/terminal-shell/renderer/settings-metadata';
import { buildMcpContext } from '@goodvibes-jev/engine/terminal-shell/renderer/mcp-trust-context';
/**
 * settings-modal-context.ts, the documentation the settings modal shows for
 * its selected row: every setting's key, current and default value, type,
 * source, lock and conflict state, description, possible values (with the
 * per-value meaning for enums), editing notes, and the full feature-unit,
 * MCP-trust, subscription and connection documentation. Split out of
 * settings-modal.ts for the 800-line file cap. Pure text; the renderer wraps
 * and styles it.
 */

import type { SettingsModal, SettingEntry, SettingsCategory } from '../input/settings-modal.ts';
import { FEATURE_SETTINGS_BY_ID, isFeatureValueEnabled } from '@goodvibes-jev/engine/terminal-shell';
import { CATEGORY_INFO, describeUiRouting, formatValue, getSettingLabel } from './settings-modal-helpers.ts';
import { buildConnectionContext } from './settings-modal-connections.ts';
import { isSecretConfigKey } from '../config/secret-config.ts';
import '../input/concealed-input.ts';
import { CVV_PROMPT_TRADEOFF_WARNING } from '@goodvibes-jev/engine/sdk/platform/payments';
import '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { GLYPHS } from './ui-primitives.ts';
import { GATE_PRESETS } from '@goodvibes-jev/engine/sdk/platform/gate';

const ENUM_VALUE_DESCRIPTIONS: Record<string, Record<string, string>> = {
  'display.themeMode': {
    auto: 'Probe the terminal background colour (OSC 11) once at startup and pick light or dark. Falls back to dark on unreadable/unsupported terminals. Only evaluated at startup: selecting auto takes effect next launch.',
    dark: 'Force the dark theme regardless of terminal background. Applies immediately.',
    light: 'Force the light theme regardless of terminal background. Applies immediately.',
  },
  'behavior.hitlMode': {
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
  'permissions.backgroundAgents': {
    inherit: 'Background and subagent tool calls run through the SAME session permission mode as foreground work.',
    'allow-all': 'Background and subagent tool calls are exempt from prompting (auto-approved) even when foreground work is gated.',
  },
  'diagnostics.postEdit': {
    on: 'After the model edits or writes a file, run language diagnostics on it and surface any new problems.',
    off: 'Do not run diagnostics automatically after edits.',
  },
  'storage.secretPolicy': {
    preferred_secure: SHARED_SETTING_ENUM_DESCRIPTIONS['storage.secretPolicy']['preferred_secure'],
    require_secure: SHARED_SETTING_ENUM_DESCRIPTIONS['storage.secretPolicy']['require_secure'],
    plaintext_allowed: SHARED_SETTING_ENUM_DESCRIPTIONS['storage.secretPolicy']['plaintext_allowed'],
  },
  'batch.mode': {
    off: 'Keep daemon work on the immediate local path.',
    explicit: 'Use batch only when callers explicitly request batch execution.',
    'eligible-by-default': 'Allow eligible daemon work to use the batch path unless callers opt out.',
  },
  'controlPlane.hostMode': {
    localhost: 'Bind only to this computer.',
    network: 'Bind for LAN access using the default network host.',
    custom: 'Use the explicit host value in the related host setting.',
  },
  'httpListener.hostMode': {
    localhost: 'Bind only to this computer.',
    network: 'Bind for LAN/webhook access using the default network host.',
    custom: 'Use the explicit host value in the related host setting.',
  },
  'web.hostMode': {
    localhost: 'Serve the browser UI only on this computer.',
    network: 'Serve the browser UI on the LAN.',
    custom: 'Use the explicit host value in the related host setting.',
  },
  'ui.systemMessages': {
    panel: 'Kept for older settings files: shows system messages inline in the transcript, same as conversation.',
    conversation: SHARED_SETTING_ENUM_DESCRIPTIONS['ui.systemMessages']['conversation'],
    both: 'Shows system messages inline in the transcript, same as conversation.',
  },
  'ui.operationalMessages': {
    panel: 'Kept for older settings files: shows operational messages inline in the transcript, same as conversation.',
    conversation: SHARED_SETTING_ENUM_DESCRIPTIONS['ui.operationalMessages']['conversation'],
    both: 'Shows operational messages inline in the transcript, same as conversation.',
  },
  'ui.contractMessages': {
    panel: 'Kept for older settings files: shows WRFC messages inline in the transcript, same as conversation.',
    conversation: 'Show WRFC messages inline in the transcript.',
    both: 'Shows WRFC messages inline in the transcript, same as conversation.',
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
 * The option shape of a feature header, rendered from the same schema the
 * write path uses: enum headers list every mode choice (marking the current
 * value and which values keep the feature active), boolean headers state the
 * two positions.
 */
function buildFeatureOptionLines(entry: SettingEntry): string[] {
  const feature = entry.flag!.feature;
  const setting = entry.setting;
  const lines: string[] = [];
  if (setting.type === 'enum' && setting.enumValues) {
    lines.push('', `Mode choices for ${setting.key}:`);
    const activeValues = feature.enablement.enabledValues ?? [];
    const descriptions = ENUM_VALUE_DESCRIPTIONS[setting.key] ?? {};
    for (const value of setting.enumValues) {
      const marks: string[] = [];
      if (value === String(entry.currentValue)) marks.push('current');
      if (feature.enablement.kind === 'enum') {
        marks.push(activeValues.includes(value) ? 'feature on' : 'feature off');
      }
      const suffix = marks.length > 0 ? ` (${marks.join(', ')})` : '';
      lines.push(`${value}${suffix}: ${descriptions[value] ?? `Use ${value} for this setting.`}`);
    }
  } else if (setting.type === 'boolean') {
    lines.push('');
    lines.push('Possible values:');
    lines.push('true: the feature is enabled.');
    lines.push('false: the feature is disabled.');
  }
  return lines;
}

/**
 * Under-cursor documentation for a feature-unit header, rendered entirely
 * from the SDK's per-feature settings metadata: full behavior description,
 * the real option shape, every settings key that tunes the feature, and the
 * honest live/restart state from the gate manager.
 */
function buildFlagContext(entry: SettingEntry | null): string[] {
  const flagEntry = entry?.flag ?? null;
  if (!entry || !flagEntry) return ['Features', 'No feature is selected.'];
  const { feature, flag, state, persistedState, pendingRestart } = flagEntry;
  const configOn = isFeatureValueEnabled(feature, entry.currentValue);
  const displayState = state === 'killed' ? 'killed' : configOn ? 'enabled' : 'disabled';
  const lines: string[] = [
    feature.name,
    `Feature: ${feature.id} (${feature.domain} domain)`,
    `Setting: ${feature.enablement.key} = ${formatValue(entry)}`,
    `State: ${displayState}`,
    ...(entry.metadataUnavailable ? [`Source: unavailable`, `Unavailable: ${entry.metadataUnavailable}`] : []),
    ...(entry.valueUnavailable ? [`Value unavailable: ${entry.valueUnavailable} You can set an explicit value here.`] : []),
    // A capability the registry declares not operable reads as disabled no
    // matter what its settings key says. Without this line the row shows a
    // value of true beside a state of disabled and explains nothing, the
    // written reason exists in the registry, so render it where the user meets
    // the contradiction rather than leaving it to be discovered.
    ...(feature.operable === false && feature.inoperableDetail ? [`Not available in this build: ${feature.inoperableDetail}`] : []),
    `Default: ${feature.defaultEnabled ? 'enabled' : 'disabled'}`,
    `Applies: ${feature.restartRequired ? 'on next launch (startup-gated)' : 'immediately'}`,
    ...(pendingRestart ? [`Pending restart: saved as ${persistedState}; effective state stays ${state} until the next launch.`] : []),
    '',
    feature.description,
  ];

  lines.push(...buildFeatureOptionLines(entry));

  lines.push('');
  if (feature.enablement.kind === 'enum') {
    lines.push(`How it turns on: active while ${feature.enablement.key} is ${(feature.enablement.enabledValues ?? []).join(' or ')}.`);
  } else if (feature.enablement.kind === 'constant' && entry.setting.type !== 'boolean') {
    lines.push('How it turns on: always active; the settings listed below tune its behavior directly.');
  } else {
    lines.push(`How it turns on: ${feature.enablement.key} set to true.`);
  }

  if (feature.settings.length > 1) {
    lines.push('', 'Settings in this feature:');
    for (const key of feature.settings) {
      lines.push(key === feature.enablement.key ? `${key} (this row)` : key);
    }
  }

  if (state === 'killed' && flag.killReason) {
    lines.push('', `Kill reason: ${flag.killReason}`);
  }
  return lines;
}

/**
 * The documentation for whatever the settings list has selected, one entry
 * per line (unwrapped; '' separates paragraphs). The first line names the
 * selection; the renderer shows it under the selected row, wrapped in full.
 */
export function settingContextLines(modal: SettingsModal): string[] {
  const category = modal.currentCategory;
  if (modal.searchFocused) {
    const selected = modal.getSelected();
    if (selected) return buildSettingContext(modal, selected);
    return [
      modal.searchQuery.trim().length === 0
        ? 'Type a query to search across all settings categories.'
        : 'No settings matched the search query.',
    ];
  }
  const lines: string[] = [];
  if (category === 'mcp') lines.push(...buildMcpContext(modal, modal.getSelectedMcp()));
  else if (category === 'subscriptions') lines.push(...buildSubscriptionContext(modal, modal.getSelectedSubscription()));
  else if (category === 'connections') lines.push(...buildConnectionContext(modal));
  else {
    const selected = modal.getSelected();
    // A feature-unit header shows the feature's documentation (full
    // description, option shape, settings list, live/restart state); its
    // settings sub-rows and plain settings show the setting context.
    if (selected?.flag) lines.push(...buildFlagContext(selected));
    else if (selected) lines.push(...buildSettingContext(modal, selected));
    else lines.push('No setting is selected in this category.');
  }
  lines.push('', `Category purpose: ${CATEGORY_INFO[category]}`);
  return lines;
}

export function categoryItemCount(modal: SettingsModal, category: SettingsCategory): number {
  if (category === 'mcp') return modal.mcpEntries.length;
  if (category === 'subscriptions') return modal.subscriptionEntries.length;
  if (category === 'connections') return modal.connectionEntries.length;
  return modal.groups.get(category)?.length ?? 0;
}

import { createSettingContext, createSubscriptionContext } from '@goodvibes-jev/engine/terminal-shell/renderer/settings-context';
export const { currentSettingValue, buildSettingContext } = createSettingContext<SettingsModal, SettingEntry>({
  isSecretKey: isSecretConfigKey,
  cursor: GLYPHS.surface.cursor,
  formatValue,
  label: getSettingLabel,
  source: (entry) => (entry.metadataUnavailable || entry.valueUnavailable ? 'unavailable' : (entry.effectiveSource ?? 'default')),
  detail(entry) {
    const lines: string[] = [];
    if (entry.metadataUnavailable) lines.push(`Unavailable: ${entry.metadataUnavailable}`);
    if (entry.valueUnavailable) lines.push(`Value unavailable: ${entry.valueUnavailable} You can set an explicit value here.`);
    if (entry.locked) lines.push(`Locked: ${entry.lockReason ?? 'This setting is locked by a higher-priority layer.'}`);
    if (entry.conflict) lines.push(`Conflict: resolve with /settings-sync resolve ${entry.setting.key} local|synced.`);

    // A settings sub-row owned by a feature unit names its feature so "what does this do" is answerable without scrolling back to the header row.
    if (entry.ownerFlagId) {
      const owner = FEATURE_SETTINGS_BY_ID.get(entry.ownerFlagId);
      if (owner) lines.push(`Part of feature: ${owner.name} (the header row above).`);
    }

    lines.push('', entry.setting.description);

    return lines;
  },
  enumDescriptions: ENUM_VALUE_DESCRIPTIONS,
  routingKeys: ['ui.systemMessages', 'ui.operationalMessages', 'ui.contractMessages'],
  describeUiRouting,
});
const buildSubscriptionContext = createSubscriptionContext<SettingsModal>({
  confirmLogout: (provider) => `Sign out ${provider}? Enter/y to confirm, n/Esc to cancel.`,
  beginLogout: 'Press Enter to begin sign-out for this provider session.',
  login: (provider) => `Use /subscription login ${provider} start to begin OAuth sign-in for this provider.`,
  route: (value) => value ?? 'n/a',
});
