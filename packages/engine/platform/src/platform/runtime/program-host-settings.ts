/**
 * program-host-settings.ts, the settings each terminal program keeps of its
 * own beyond the shared schema, declared once, here, so every reader of a
 * program's settings knows them: the program itself (its config manager
 * registers them before the first load), the daemon when it reads or changes a
 * program's settings for any door (capabilities/builtin/system-settings.ts),
 * and the one settings screen both programs show (terminal-shell
 * settings-screen), which lists the other program's too.
 *
 * Also here: the defaults both terminal programs set over the schema's, so the
 * daemon reading a program's settings file reads the same default the program
 * runs with.
 */
import type { ConfigKey, ConfigSetting, HostBooleanSetting, HostNumberSetting, HostSetting, HostStringSetting } from '../config/index.js';
import { NOTIFICATIONS_METADATA_ONLY_SETTING } from './notification-privacy.js';

/** The two terminal programs. */
export type TerminalProgram = 'tui' | 'agent';

/** Each program by the name a person reads. */
export const TERMINAL_PROGRAM_NAMES: Readonly<Record<TerminalProgram, string>> = { tui: 'the terminal app', agent: 'the Agent' };

// ─── The terminal app's own settings ────────────────────────────────────────

export const STATUSLINE_COMMAND_SETTING: HostStringSetting = Object.freeze({
  key: 'statusline.command',
  label: 'Command for your own status line',
  type: 'string',
  default: '',
  description: 'Shell command run at each turn boundary; the first line it prints shows in the status area. Empty turns the status line off. Read only from your own settings file: a project settings file cannot set it.',
});

export const STATUSLINE_DEFAULT_TIMEOUT_MS = 2000;

export const STATUSLINE_TIMEOUT_SETTING: HostNumberSetting = Object.freeze({
  key: 'statusline.timeoutMs',
  label: 'Longest the status line command may run (ms)',
  type: 'number',
  default: STATUSLINE_DEFAULT_TIMEOUT_MS,
  integer: true,
  min: 100,
  max: 15_000,
  description: 'Milliseconds the status line command may run before it is stopped and the status line is cleared.',
});

export const SESSION_AUTO_TITLE_SETTING: HostBooleanSetting = Object.freeze({
  key: 'session.autoTitle',
  label: 'Name new sessions automatically',
  type: 'boolean',
  default: false,
  description: 'Give an untitled session a short title from the helper model after its first turn (one small model request per session). A title you chose is never replaced.',
});

export const NOTIFY_AFTER_SECONDS_SETTING: HostNumberSetting = Object.freeze({
  key: 'behavior.notifyAfterSeconds',
  label: 'Notify when an answer takes longer than (seconds, 0 for off)',
  type: 'number',
  default: 60,
  integer: true,
  min: 0,
  max: 86_400,
  description: 'Seconds a turn must run before a push notification fires (0 = off). Delivers to desktop (notify-send/osascript) and configured ntfy/webhook URLs.',
});

function alertToggle(key: string, label: string, description: string, defaultOn: boolean): HostBooleanSetting {
  return Object.freeze({ key, label, type: 'boolean' as const, default: defaultOn, description });
}

export const NOTIFY_ON_BUDGET_BREACH_SETTING = alertToggle('behavior.notifyOnBudgetBreach', 'Alert when the session goes over budget',
  'Alert when this conversation\'s cost passes the spending alert (set in Money, Spending, with w).', true);
export const NOTIFY_ON_AGENT_FAILURE_SETTING = alertToggle('behavior.notifyOnAgentFailure', 'Alert when a helper agent fails',
  'Alert when a delegated or background agent fails.', true);
export const NOTIFY_ON_CHAIN_FAILURE_SETTING = alertToggle('behavior.notifyOnChainFailure', 'Alert when a review chain fails',
  'Alert when a WRFC review chain fails.', true);
export const NOTIFY_ON_APPROVAL_PENDING_SETTING = alertToggle('behavior.notifyOnApprovalPending', 'Alert when something waits for your approval',
  'Alert when a tool call is waiting on your approval.', true);
export const NOTIFY_ONLY_WHEN_UNFOCUSED_SETTING = alertToggle('behavior.notifyOnlyWhenUnfocused', 'Alert only when the terminal is in the background',
  'Master gate for the four alerts above: fire only when the terminal window is unfocused, or when focus state was never observed (terminal does not report focus). Turn off to always fire regardless of focus.', true);

// In-terminal (OSC 9) notifications and the bell, each with its own default.
// They are focus-gated on their own (only for an unfocused or unknown
// terminal), independent of `notifyOnlyWhenUnfocused`.
export const TERMINAL_NOTIFY_APPROVAL_WAIT_SETTING = alertToggle('behavior.terminalNotifyApprovalWait', 'Notify from the terminal when something waits for approval',
  'Send an in-terminal (OSC 9) desktop notification when a tool call is waiting on your approval. Fires only when the terminal window is unfocused. Works over SSH/tmux where OS notifications do not.', true);
export const TERMINAL_NOTIFY_TURN_END_SETTING = alertToggle('behavior.terminalNotifyTurnEnd', 'Notify from the terminal when an answer finishes',
  'Send an in-terminal (OSC 9) desktop notification when a turn finishes. Off by default. Fires only when the terminal window is unfocused.', false);
export const TERMINAL_NOTIFY_AGENT_BLOCKED_SETTING = alertToggle('behavior.terminalNotifyAgentBlocked', 'Notify from the terminal when a helper agent needs you',
  'Send an in-terminal (OSC 9) desktop notification when a delegated agent blocks waiting for your input. Off by default. Fires only when the terminal window is unfocused.', false);
export const TERMINAL_BELL_SETTING = alertToggle('behavior.terminalBell', 'Ring the terminal bell with notifications',
  'Also ring the terminal bell alongside in-terminal notifications. Off by default.', false);

// `storage.codeIndexEnabled` is no longer the terminal app's own: it is the daemon's one setting (config schema,
// config-ownership.ts), followed by every program and the daemon's own turns.

/** Setting key: show the per-turn memory-provenance chip. Default OFF. */
export const MEMORY_SHOW_PROVENANCE_CONFIG_KEY = 'memory.showProvenance';
export const MEMORY_SHOW_PROVENANCE_DEFAULT = false;

export const MEMORY_SHOW_PROVENANCE_SETTING: HostBooleanSetting = Object.freeze({
  key: MEMORY_SHOW_PROVENANCE_CONFIG_KEY,
  label: 'Show which memories an answer used',
  type: 'boolean',
  default: MEMORY_SHOW_PROVENANCE_DEFAULT,
  description: 'Show a "used N memories" chip on turns that drew on your standing memories, with a drill-in '
    + 'listing them (Ctrl+G then e to expand, unless rebound). Off by default; when off, nothing is rendered and no metadata is read.',
});

/** The terminal app's own settings beyond the notification privacy and memory chip, registered before the first load. */
export const TUI_EXTENSION_SETTINGS: readonly HostSetting[] = Object.freeze([
  STATUSLINE_COMMAND_SETTING,
  STATUSLINE_TIMEOUT_SETTING,
  SESSION_AUTO_TITLE_SETTING,
  NOTIFY_AFTER_SECONDS_SETTING,
  NOTIFY_ON_BUDGET_BREACH_SETTING,
  NOTIFY_ON_AGENT_FAILURE_SETTING,
  NOTIFY_ON_CHAIN_FAILURE_SETTING,
  NOTIFY_ON_APPROVAL_PENDING_SETTING,
  NOTIFY_ONLY_WHEN_UNFOCUSED_SETTING,
  TERMINAL_NOTIFY_APPROVAL_WAIT_SETTING,
  TERMINAL_NOTIFY_TURN_END_SETTING,
  TERMINAL_NOTIFY_AGENT_BLOCKED_SETTING,
  TERMINAL_BELL_SETTING,
]);

// ─── The Agent's own settings ───────────────────────────────────────────────

/** The Agent's consent to screen raw report text with the hosted screening providers. */
export const AGENT_HOSTED_RESEARCH_SCREENING_KEY = 'tools.hostedResearchScreening';

/** The consent as a host setting; registered on every manager that reads the Agent's settings. */
export const AGENT_HOSTED_RESEARCH_SCREENING_SETTING: HostBooleanSetting = Object.freeze({
  key: AGENT_HOSTED_RESEARCH_SCREENING_KEY,
  label: 'Let hosted models screen research sources',
  type: 'boolean',
  default: false,
  description: 'Explicitly allow raw research report text and source URLs to be screened by Abacus route-llm and TypeSafe Jev. Providers manage retention; zero retention is unverified. Requires native ABACUSAI_API_KEY and TYPESAFE_API_KEY credentials. Covers research report preview, save, and the research editor only.',
});

// ─── Each program's own settings, and the defaults both set ─────────────────

/** Every setting a program keeps beyond the schema, in the order its config manager registers them. */
export const PROGRAM_HOST_SETTINGS: Readonly<Record<TerminalProgram, readonly HostSetting[]>> = Object.freeze({
  tui: Object.freeze([NOTIFICATIONS_METADATA_ONLY_SETTING, MEMORY_SHOW_PROVENANCE_SETTING, ...TUI_EXTENSION_SETTINGS]),
  agent: Object.freeze([NOTIFICATIONS_METADATA_ONLY_SETTING, AGENT_HOSTED_RESEARCH_SCREENING_SETTING]),
});

/**
 * A program's own list setting with no schema row (config/write-admission.ts PRODUCT_OWNED_LEAVES): the variable
 * names every command's environment keeps although they look credential-bearing (tools/exec/credential-env-config.ts
 * reads it at each spawn). Both programs and the daemon's view of a program's settings know it, as a list of names.
 */
export const EXEC_ENV_SCRUB_ALLOWLIST_SETTING: ConfigSetting = Object.freeze({
  key: 'permissions.execEnvScrubAllowlist' as ConfigKey,
  label: 'Variables always passed to commands',
  type: 'object' as const,
  default: [],
  description: 'Environment variable NAMES always kept in a spawned command\'s environment even when the name looks credential-bearing (case-insensitive). Names only: this never inspects or reports values. The scrub itself stays on; this only widens what it lets through, from the next command. Empty: the built-in credential-name scrub applies with no extra exceptions.',
  validate: (value: unknown) => Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0),
  validationHint: 'list of variable names, for example ["CI_SIGNING_KEY"]',
});

/** A program's settings beyond the schema that are not host settings (each program keeps its own value). */
export const PROGRAM_LIST_SETTINGS: readonly ConfigSetting[] = Object.freeze([EXEC_ENV_SCRUB_ALLOWLIST_SETTING]);

/**
 * The defaults both terminal programs set over the schema's (cli-config-overrides.ts
 * applyTerminalRuntimeConfigDefaults): token speed shown, and system and
 * operational messages in the transcript.
 */
export const TERMINAL_PROGRAM_DEFAULTS: ReadonlyArray<readonly [key: string, value: unknown]> = Object.freeze([
  ['display.showTokenSpeed', true],
  ['ui.systemMessages', 'conversation'],
  ['ui.operationalMessages', 'conversation'],
] as const);

/**
 * The daemon's listener settings that take effect only when the daemon starts: changing one restarts the daemon
 * itself, after the change's answer (daemon/facade.ts). Every other listener setting applies in place: the control
 * plane's and the webhook listener's address, port and TLS rebind that listener; the LAN https listener and its
 * certificate resync; who is served, the stream mode, the proxy and CORS settings, the web UI and the OpenAI-
 * compatible routes are read on each request; the web.* addresses only name links.
 */
export const DAEMON_RESTART_SETTINGS: ReadonlyArray<{ readonly key: string; readonly label: string }> = Object.freeze([
  { key: 'danger.httpListener', label: 'Receive webhooks' },
]);
