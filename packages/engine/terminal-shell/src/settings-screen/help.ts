/**
 * settings-screen/help.ts, the few sentences under the rows of the settings
 * screen for the selected one: what a setting does, when a change takes effect,
 * its default in words, where its value comes from and who keeps it; a
 * feature's state; and the help of each list a topic opens (tool servers,
 * provider sign-ins, mail and calendar, features, the secure address). Each line
 * states its kind (HelpLine); the renderer wraps and styles it by that kind.
 */
import { GATE_PRESETS } from '@goodvibes/engine/platform/platform/gate';
import { CVV_PROMPT_TRADEOFF_WARNING } from '@goodvibes/engine/platform/platform/payments';
import { isDaemonOwnedConfigKey, isSecretConfigKey } from '@goodvibes/engine/platform/platform/config';
import { TERMINAL_PROGRAM_NAMES } from '@goodvibes/engine/platform/platform/runtime/program-host-settings';
import { FEATURE_SETTINGS_BY_ID } from '../cli-feature-settings.js';
import { SHARED_SETTING_ENUM_DESCRIPTIONS } from '../renderer/settings-metadata.js';
import { helpFact, helpHeading, helpText, helpWarning, type HelpLine } from '../renderer/settings-documentation.js';
import { createSettingContext, createSubscriptionContext, firstSentence, settingSourceWords, settingStateWarnings } from '../renderer/settings-context.js';
import { createSettingsValueHelpers } from '../renderer/settings-value-helpers.js';
import type { McpEntry } from '../settings-model-types.js';
import type { ScreenEntry, ScreenFlag, ScreenProgram } from './rows.js';

export const { formatValue, formatDefault, valueColor, getSettingLabel } = createSettingsValueHelpers<ScreenEntry>({
  isSecretKey: isSecretConfigKey,
  isDaemonKept: isDaemonOwnedConfigKey,
});

/** A program by its name as a sentence starts it. */
export function programName(program: ScreenProgram, capital = false): string {
  const name = TERMINAL_PROGRAM_NAMES[program];
  return capital ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

const SHARED_ENUM_DESCRIPTIONS: Record<string, Record<string, string>> = {
  'behavior.guidanceMode': {
    off: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.guidanceMode']['off'],
    minimal: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.guidanceMode']['minimal'],
    guided: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.guidanceMode']['guided'],
  },
  'permissions.mode': Object.fromEntries(Object.values(GATE_PRESETS).map((preset) => [preset.mode, preset.summary])),
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
 * What each choice means where the two programs differ: a setting each keeps of its own reads as that program
 * runs it (the terminal app keeps its notices in Notifications, the Agent in its Activity view).
 */
const PROGRAM_ENUM_DESCRIPTIONS: Readonly<Record<ScreenProgram, Record<string, Record<string, string>>>> = {
  tui: {
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
    'diagnostics.postEdit': {
      on: 'After the model edits or writes a file, run language diagnostics on it and surface any new problems.',
      off: 'Do not run diagnostics automatically after edits.',
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
  },
  agent: {
    'behavior.hitlMode': {
      off: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.hitlMode']['off'],
      quiet: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.hitlMode']['quiet'],
      balanced: SHARED_SETTING_ENUM_DESCRIPTIONS['behavior.hitlMode']['balanced'],
      operator: 'Surface more operational detail for users actively supervising agents, tools, connected-host posture, and automation.',
    },
    'diagnostics.postEdit': {
      on: 'After a successful file write/edit, append cheap, in-process syntax diagnostics (errors only) to the tool result. Syntax-level only, not type-checking.',
      off: 'Never append post-edit diagnostics to write/edit tool results.',
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
  },
};

/** What each choice of a setting means, as the program shown runs it. */
export function enumDescriptionsFor(program: ScreenProgram): Readonly<Record<string, Readonly<Record<string, string>>>> {
  return { ...SHARED_ENUM_DESCRIPTIONS, ...PROGRAM_ENUM_DESCRIPTIONS[program] };
}

/** The state of the screen the help reads. */
export interface HelpState {
  readonly editingMode: boolean;
  readonly editBuffer: string;
  /** Whose settings are shown, and the program the screen is in. */
  readonly viewed: ScreenProgram;
  readonly own: ScreenProgram;
  /** The key that shows the other program's settings, as bound. */
  readonly otherProgramKey: string;
}

/** Which store a value was read from, as settingSourceWords names it. */
function tierOf(entry: ScreenEntry): 'daemon' | 'shared' | 'project' | 'global' | 'default' | undefined {
  const source = entry.source;
  if (source === 'host') return entry.isDefault ? undefined : 'global';
  return source === 'daemon' || source === 'shared' || source === 'project' || source === 'global' || source === 'default' ? source : undefined;
}

/** Who keeps a setting, said on every row: the daemon (the same from every program) or the program shown, by name. */
function ownerLines(state: HelpState, entry: ScreenEntry): HelpLine[] {
  if (entry.owner === 'daemon' || entry.cards) return [];
  const other: ScreenProgram = state.viewed === 'tui' ? 'agent' : 'tui';
  return [helpText(`${programName(state.viewed, true)} keeps this setting; ${programName(other)} keeps its own (${state.otherProgramKey} shows ${programName(other)}'s).`)];
}

/** The choice rows open a list; the theme row a picker with a live preview. */
function editingWords(entry: ScreenEntry): string | undefined {
  if (entry.setting.key === 'display.theme') return 'Enter opens the theme picker with a live preview; Enter keeps the theme, Esc puts the previous one back.';
  if (entry.setting.type === 'enum') return 'Enter lists the choices, each with what it does.';
  return undefined;
}

function contextFor(program: ScreenProgram) {
  return createSettingContext<HelpState, ScreenEntry>({
    isSecretKey: isSecretConfigKey,
    cursor: '▏',
    formatValue,
    formatDefault,
    label: getSettingLabel,
    // Where the value comes from, said only when it is not the default.
    source: (state, entry) => (entry.effectiveSource === 'unavailable' || (entry.isDefault && entry.effectiveSource !== 'managed') ? undefined
      : settingSourceWords({ effectiveSource: entry.effectiveSource, tier: tierOf(entry), program: programName(state.viewed) })),
    detail(entry) {
      const lines: HelpLine[] = [];
      // A value that could not be read says why, in the daemon's words.
      if (entry.effectiveSource === 'unavailable' && entry.currentValue === undefined && entry.sourceLabel) {
        lines.push(helpWarning(entry.sourceLabel.startsWith('reading') ? 'Asking the daemon what it holds for this setting.' : `This value ${entry.sourceLabel.replace(/[.]?$/, '.')}`));
      }
      if (entry.setting.key === 'payments.cvvHandling' && entry.currentValue === 'prompt') lines.push(helpWarning(CVV_PROMPT_TRADEOFF_WARNING));
      lines.push(...settingStateWarnings(entry));
      // A setting a feature owns names the feature, so what it belongs to is answered here.
      if (entry.ownerFlagId) {
        const owner = FEATURE_SETTINGS_BY_ID.get(entry.ownerFlagId);
        if (owner) lines.push(helpText(`Part of ${owner.name}.`));
      }
      return lines;
    },
    enumDescriptions: enumDescriptionsFor(program),
    customEditing: editingWords,
  });
}

const CONTEXTS: Readonly<Record<ScreenProgram, ReturnType<typeof contextFor>>> = { tui: contextFor('tui'), agent: contextFor('agent') };

/** The value a row shows (the edit field while it is edited). */
export function currentSettingValue(state: HelpState, entry: ScreenEntry, selected: boolean): string {
  return CONTEXTS[state.viewed].currentSettingValue(state, entry, selected);
}

/** The help for one setting. */
export function settingHelp(state: HelpState, entry: ScreenEntry): HelpLine[] {
  const lines = CONTEXTS[state.viewed].buildSettingHelp(state, entry);
  // Who keeps it, after what it does: the second line names the setting's purpose, this one its owner.
  const owner = ownerLines(state, entry);
  return owner.length > 0 ? [...lines.slice(0, 2), ...owner, ...lines.slice(2)] : lines;
}

/** A feature's switch, in words: what it does, whether it is on, when a change takes effect, a restart still pending. */
export function flagHelp(state: HelpState, flag: ScreenFlag, entry: ScreenEntry | null): HelpLine[] {
  const { feature, state: on, pendingRestart } = flag;
  const lines: HelpLine[] = [
    helpText(feature.name),
    ...(entry ? settingStateWarnings(entry) : []),
    ...(feature.operable === false && feature.inoperableDetail ? [helpWarning(`Not available in this build: ${feature.inoperableDetail}`)] : []),
    ...(pendingRestart ? [helpWarning(`Saved ${on === 'enabled' ? 'on' : 'off'}; the change takes effect at the next start.`)] : []),
    helpText(firstSentence(feature.description).first),
    ...(entry ? ownerLines(state, entry) : []),
  ];
  const value = entry?.currentValue;
  const meaning = typeof value === 'string' ? enumDescriptionsFor(state.viewed)[feature.enablement.key]?.[value] : undefined;
  if (meaning && entry) lines.push(helpText(`${formatValue(entry)}: ${meaning}`));
  lines.push(helpText(feature.restartRequired ? `Takes effect the next time ${programName(state.viewed)} starts.` : 'Takes effect at once.'));
  lines.push(helpText(`The default is ${feature.defaultEnabled ? 'On' : 'Off'}.`));
  const rest = firstSentence(feature.description).rest;
  if (rest) lines.push(helpText(''), helpText(rest));
  return lines;
}

/** A tool server's trust, its scope and its tool rules; Enter lists what can be changed. */
export function mcpHelp(entry: McpEntry | null, keepsWho: string): HelpLine[] {
  if (!entry) return [helpText('Tool servers'), helpText(`No tool server is set up in ${keepsWho}.`)];
  const scope = entry.allowedPaths.length > 0
    ? `Allowed paths: ${entry.allowedPaths.join(', ')}`
    : entry.allowedHosts.length > 0 ? `Allowed hosts: ${entry.allowedHosts.join(', ')}` : 'No explicit path or host scope is configured.';
  const rules = entry.toolRules ?? [];
  return [
    helpText(entry.name),
    helpFact('Connection', entry.connected ? 'connected' : 'disconnected'),
    helpFact('Role', entry.role),
    helpFact('Trust', entry.trustMode),
    helpText('Enter lists the trust levels and the tool rules: a trust level applies at once and is kept in the server\'s MCP config; allowing all asks first, opening on No. Shift and an arrow moves to the next level.'),
    helpText(''),
    helpText(scope),
    helpText(''),
    helpHeading('Tool rules:'),
    ...(rules.length > 0
      ? rules.map((rule) => helpText(`${rule.rule === 'deny' ? 'blocked' : 'past its limits'} ${rule.toolName}: ${rule.source === 'session' ? 'for this session only' : 'kept in the MCP config'}${rule.inEffect ? '' : '; a block wins'}`))
      : [helpText('None. Every tool is decided by the trust level and scope.')]),
    helpText(''),
    helpHeading('Trust levels:'),
    helpText('constrained: keep its activity inside the declared paths and hosts, and ask on risk.'),
    helpText('ask-on-risk: allow routine operations, ask before risky ones.'),
    helpText('allow-all: allow everything it does, after you confirm.'),
    helpText('blocked: the server is not used.'),
  ];
}

/** A provider sign-in: its state and route; Enter signs out of an active one. */
export const subscriptionHelp = createSubscriptionContext<{ readonly subscriptionLogoutConfirmationTarget: string | null }>({
  confirmLogout: (provider) => `Enter signs out of ${provider}.`,
  beginLogout: 'Enter signs out of this sign-in, for every program; sign in again in Models and providers.',
  login: (provider) => `Sign in to ${provider} in Models and providers (the menu, Models and providers, Providers).`,
  route: (value) => value ?? 'n/a',
});

/** What the "Mail and calendar" rows say: whether each answers now, and what to do when it does not. */
export interface ConnectionRow {
  readonly surface: 'mail' | 'calendar';
  readonly state: 'checking' | 'ready' | 'needs-setup' | 'unreachable' | 'unreadable';
  readonly detail: string;
  readonly nextActions: readonly string[];
}

export function connectionLabel(surface: ConnectionRow['surface']): string {
  return surface === 'mail' ? 'Mail' : 'Calendar';
}

export function connectionHelp(row: ConnectionRow | null): HelpLine[] {
  if (!row) return [helpText('Mail and calendar'), helpText('No connection is selected.')];
  return [
    helpText(connectionLabel(row.surface)),
    helpFact('State', row.state === 'unreadable' ? 'the secret store could not be read' : row.state),
    helpText(row.detail),
    ...(row.nextActions.length > 0 ? [helpText(''), helpHeading('Next steps:'), ...row.nextActions.map((action) => helpText(action))] : []),
    helpText(''),
    helpText(row.surface === 'mail'
      ? 'Read and send it in Mail, calendar and channels, from the menu (its Inbox).'
      : 'See and change it in Mail, calendar and channels, from the menu (its Calendar).'),
  ];
}
