/**
 * The command table behind `goodvibes completion <shell>`. The scripts come
 * from the shared generator (terminal-shell/shell-completion), the same one
 * the Agent and the daemon use; this file is only the TUI's data.
 *
 * Flag names follow the parser (each `if (name === '--foo')` branch).
 * Subcommands per command follow the usage strings in the COMMAND_HELP table
 * in help.ts. A command listed in `goodvibes help` belongs here too.
 */

import type { GoodVibesCliCommand } from '@goodvibes-jev/engine/terminal-shell';
import {
  runCompletionCommand,
  type CompletionCommandResult,
  type CompletionTable,
} from '@goodvibes-jev/engine/terminal-shell/shell-completion';

// ---------------------------------------------------------------------------
// Typed completion data surface
// ---------------------------------------------------------------------------

/** A flag definition for completion purposes. */
export interface CompletionFlag {
  /** Primary flag name, e.g. '--model' */
  readonly name: string;
  /** Short alias if any, e.g. '-m' */
  readonly short?: string;
  /** Additional aliases (long), e.g. '--working-dir' */
  readonly aliases?: readonly string[];
  /** Whether the flag takes a value argument */
  readonly takesValue: boolean;
  /** Enumerated completions for the flag value, if applicable */
  readonly valueEnum?: readonly string[];
  /** Human-readable description */
  readonly description: string;
}

/** Per-command completion metadata. */
export interface CompletionCommand {
  /** The canonical command name (the GoodVibesCliCommand union, plus `acp` and `host`, which are served before the shared parser runs) */
  readonly name: GoodVibesCliCommand | 'acp' | 'host';
  /** All tokens that map to this command (aliases included) */
  readonly aliases: readonly string[];
  /** One-line description */
  readonly description: string;
  /** Subcommand tokens accepted by this command */
  readonly subcommands: readonly string[];
}

// ---------------------------------------------------------------------------
// Global flags
// Derived from parser.ts branch-by-branch inspection (each `if (name === ...)`).
// ---------------------------------------------------------------------------

export const GLOBAL_FLAGS: readonly CompletionFlag[] = [
  { name: '--help', short: '-h', takesValue: false, description: 'Print help' },
  { name: '--version', short: '-v', takesValue: false, description: 'Print version' },
  {
    name: '--model',
    short: '-m',
    takesValue: true,
    description: 'Override model (provider:model infers --provider)',
  },
  { name: '--provider', takesValue: true, description: 'Override provider' },
  {
    name: '--cd',
    short: '-C',
    aliases: ['--working-dir'],
    takesValue: true,
    description: 'Set working directory for this launch',
  },
  { name: '--daemon-home', takesValue: true, description: 'Override daemon home' },
  {
    name: '--config',
    short: '-c',
    takesValue: true,
    description: 'Override a config value (key=value)',
  },
  { name: '--enable', takesValue: true, description: 'Enable a platform feature for this launch (writes its domain setting)' },
  { name: '--disable', takesValue: true, description: 'Disable a platform feature for this launch (writes its domain setting)' },
  {
    name: '--prompt',
    short: '-p',
    takesValue: true,
    description: 'Run a non-interactive prompt',
  },
  { name: '--print', takesValue: false, description: 'Alias for non-interactive run mode' },
  {
    name: '--output',
    short: '-o',
    aliases: ['--output-format'],
    takesValue: true,
    valueEnum: ['text', 'json', 'stream-json'],
    description: 'Output format: text, json, or stream-json',
  },
  {
    name: '--json',
    takesValue: false,
    description: 'Alias for --output-format json',
  },
  {
    name: '--just-vibes', takesValue: false, description: 'Work without interrupting you; anything that needs you is held for the end',
  },
  {
    name: '--yolo', takesValue: false, description: 'Run every action without safety denials for this launch',
  },
  {
    name: '--no-alt-screen',
    takesValue: false,
    description: 'Keep output in normal terminal scrollback',
  },
  { name: '--port', takesValue: true, description: 'Port for server/web commands' },
  { name: '--hostname', aliases: ['--host'], takesValue: true, description: 'Hostname for server/web commands' },
  { name: '--open', takesValue: false, description: 'Open browser when supported' },
  {
    name: '--resume',
    short: '-r',
    takesValue: true,
    description: 'Resume saved session (optional id or "latest")',
  },
  {
    name: '--session',
    short: '-s',
    takesValue: true,
    description: 'Use a specific session',
  },
  { name: '--continue', takesValue: false, description: 'Continue the latest session' },
  { name: '--fork', takesValue: false, description: 'Fork session when supported' },
  { name: '--timeout', takesValue: true, description: 'run: stop after this long (90, 90s, 5m, 1h)' },
  { name: '--max-turns', takesValue: true, description: 'run: stop after n model answers that still ask for tools' },
  { name: '--omit-accumulated', takesValue: false, description: 'run: with stream-json, leave accumulated out of STREAM_DELTA' },
  { name: '--answer-permissions', takesValue: false, description: 'run: with stream-json, read PERMISSION_ANSWER lines on stdin for owner prompts' },
  { name: '--yes', short: '-y', takesValue: false, description: 'Auto-confirm prompts (non-interactive)' },
  { name: '--non-interactive', takesValue: false, description: 'Disable all interactive prompts (implies --yes)' },
  { name: '--strict', takesValue: false, description: 'doctor: also fail on advisory findings, for CI' },
] as const;

// ---------------------------------------------------------------------------
// Command table
// Derived from GoodVibesCliCommand union + COMMAND_ALIASES in parser.ts +
// subcommand usage strings from COMMAND_HELP in help.ts.
// ---------------------------------------------------------------------------

export const COMPLETION_COMMANDS: readonly CompletionCommand[] = [
  {
    name: 'tui',
    aliases: ['tui', 'app'],
    description: 'Start the interactive TUI (default)',
    subcommands: [],
  },
  {
    name: 'open',
    aliases: ['open'],
    description: 'Start the app on the view a goodvibes://open link names',
    subcommands: [],
  },
  {
    name: 'run',
    aliases: ['run', 'exec', 'e'],
    description: 'Run non-interactively with text/json/stream-json output',
    subcommands: [],
  },
  {
    name: 'web',
    aliases: ['web'],
    description: 'Show browser surface bind URL and enablement',
    subcommands: [],
  },
  {
    name: 'service',
    aliases: ['service', 'services'],
    description: 'Inspect/manage daemon service lifecycle',
    subcommands: ['status', 'check', 'install', 'start', 'stop', 'restart', 'uninstall'],
  },
  {
    name: 'status',
    aliases: ['status'],
    description: 'Print config, provider, service, and onboarding posture',
    subcommands: [],
  },
  {
    name: 'doctor',
    aliases: ['doctor'],
    description: 'Print status plus setup warnings',
    subcommands: ['explain', 'routing', 'hooks'],
  },
  {
    name: 'onboarding',
    aliases: ['onboarding', 'setup'],
    description: 'Open onboarding in the TUI, or print onboarding status',
    subcommands: ['status'],
  },
  {
    name: 'models',
    aliases: ['models', 'model'],
    description: 'List/use/pin selectable models and recent model history',
    subcommands: ['current', 'use', 'pin', 'recent'],
  },
  {
    name: 'providers',
    aliases: ['providers', 'provider'],
    description: 'List/inspect/use provider config/auth posture',
    subcommands: ['list', 'current', 'inspect', 'use'],
  },
  {
    name: 'auth',
    aliases: ['auth'],
    description: 'Inspect and manage local users, sessions, and bootstrap auth',
    subcommands: ['status', 'users', 'sessions', 'add-user', 'delete-user', 'rotate-password', 'revoke-session', 'revoke-sessions', 'clear-bootstrap'],
  },
  {
    name: 'subscription',
    aliases: ['subscription', 'subscriptions'],
    description: 'Start/finish/logout provider subscription sessions',
    subcommands: ['list', 'providers', 'inspect', 'login', 'logout'],
  },
  {
    name: 'secrets',
    aliases: ['secrets', 'secret'],
    description: 'List, set, link, delete, and test GoodVibes secret refs',
    subcommands: ['list', 'providers', 'test', 'set', 'link', 'delete'],
  },
  {
    name: 'sessions',
    aliases: ['sessions', 'session'],
    description: 'List, show, export, or resume saved sessions',
    subcommands: ['list', 'show', 'export', 'resume'],
  },
  {
    name: 'tasks',
    aliases: ['tasks', 'task'],
    description: 'List/show in-process tasks or submit a non-interactive task',
    subcommands: ['list', 'show', 'submit'],
  },
  {
    name: 'acp',
    aliases: ['acp'],
    description: 'Run as an Agent Client Protocol agent over stdio (for editors)',
    subcommands: [],
  },
  {
    name: 'pair',
    aliases: ['pair', 'qrcode', 'qr'],
    description: 'Print companion pairing payload and QR code',
    subcommands: [],
  },
  {
    name: 'surfaces',
    aliases: ['surfaces', 'surface'],
    description: 'Inspect/check/enable/disable browser/listener/external surfaces',
    subcommands: ['list', 'check', 'show', 'enable', 'disable'],
  },
  {
    name: 'listener',
    aliases: ['listener', 'http-listener', 'webhook'],
    description: 'Test HTTP listener/webhook readiness',
    subcommands: ['test'],
  },
  {
    name: 'control-plane',
    aliases: ['control-plane', 'controlplane', 'cp'],
    description: 'Inspect daemon auth, local admin, tokens, and ports',
    subcommands: ['status'],
  },
  {
    name: 'support-bundle',
    aliases: ['support-bundle', 'bundle', 'bundles'],
    description: 'Move a support snapshot (config + diagnostics + posture)',
    subcommands: ['export', 'inspect', 'import'],
  },
  {
    name: 'remote',
    aliases: ['remote'],
    description: 'Inspect remote runner/node posture',
    subcommands: [],
  },
  {
    name: 'bridge',
    aliases: ['bridge'],
    description: 'Bridge CLI operations (alias: remote)',
    subcommands: [],
  },
  {
    name: 'hooks',
    aliases: ['hooks', 'hook'],
    description: 'Validate hooks.json against the hook loader schema',
    subcommands: ['validate'],
  },
  {
    name: 'plugin',
    aliases: ['plugin', 'plugins'],
    description: 'Scaffold a plugin, validate a plugin directory, or manage capability bundles',
    subcommands: ['init', 'validate', 'bundles'],
  },
  {
    name: 'host',
    aliases: ['host'],
    description: 'Review, create or forget explicit TUI host pairing',
    subcommands: ['pair', 'unpair'],
  },
  {
    name: 'completion',
    aliases: ['completion', 'completions'],
    description: 'Generate shell completion script',
    subcommands: ['bash', 'zsh', 'fish'],
  },
  {
    name: 'help',
    aliases: ['help'],
    description: 'Print help or command-specific help',
    subcommands: [],
  },
  {
    name: 'version',
    aliases: ['version'],
    description: 'Print version',
    subcommands: [],
  },
] satisfies readonly CompletionCommand[];

/** Flags whose value is a directory. */
const DIRECTORY_FLAGS: ReadonlySet<string> = new Set(['--cd', '--daemon-home']);

/** The TUI's table in the shared generator's shape. */
export function tuiCompletionTable(binary = 'goodvibes'): CompletionTable {
  return {
    binary,
    commands: COMPLETION_COMMANDS.map((command) => ({
      name: command.name,
      aliases: command.aliases,
      description: command.description,
      subcommands: command.subcommands,
    })),
    globalFlags: GLOBAL_FLAGS.map((flag) => ({
      tokens: [flag.name, ...(flag.aliases ?? []), ...(flag.short !== undefined ? [flag.short] : [])],
      takesValue: flag.takesValue,
      ...(flag.valueEnum !== undefined ? { valueEnum: flag.valueEnum } : {}),
      ...(DIRECTORY_FLAGS.has(flag.name) ? { directory: true } : {}),
      description: flag.description,
    })),
  };
}

/** `goodvibes completion <shell>`; a missing or unsupported shell is a usage refusal (exit 2). */
export function runTuiCompletion(args: readonly string[], binary = 'goodvibes'): CompletionCommandResult {
  return runCompletionCommand(args, tuiCompletionTable(binary));
}
