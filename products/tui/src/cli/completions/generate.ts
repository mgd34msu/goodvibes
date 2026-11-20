/**
 * The command table behind `goodvibes completion <shell>`. The scripts come
 * from the shared generator (terminal-shell/shell-completion), the same one
 * the Agent and the daemon use; this file is only the TUI's data.
 *
 * Flag names follow the parser (each `if (name === '--foo')` branch).
 * Subcommands per command follow the usage strings in the COMMAND_HELP table
 * in help.ts. A command listed in `goodvibes help` belongs here too.
 */

import type { GoodVibesCliCommand } from '@goodvibes/engine/terminal-shell';
import { GOODVIBES_CLI_CATALOG } from '@goodvibes/engine/terminal-shell/cli-command-catalog';
import {
  runCompletionCommand,
  type CompletionCommandResult,
  type CompletionTable,
} from '@goodvibes/engine/terminal-shell/shell-completion';

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

/** Every global flag the parser accepts, read from the shared CLI catalog (the parser's own table), so completion offers exactly what parses. */
export const GLOBAL_FLAGS: readonly CompletionFlag[] = GOODVIBES_CLI_CATALOG.globalFlags.map((spec): CompletionFlag => {
  const offered = spec.tokens.filter((token) => !(spec.unlistedTokens ?? []).includes(token));
  const long = offered.filter((token) => token.startsWith('--'));
  const short = offered.find((token) => /^-[^-]/.test(token));
  return {
    name: long[0] ?? offered[0]!,
    ...(short !== undefined ? { short } : {}),
    ...(long.length > 1 ? { aliases: long.slice(1) } : {}),
    takesValue: spec.kind !== 'boolean' && spec.kind !== 'const',
    ...(spec.enumValues !== undefined ? { valueEnum: spec.enumValues } : {}),
    description: spec.summary,
  };
});

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
    name: 'serve',
    aliases: ['serve', 'daemon', 'server'],
    description: 'Run the GoodVibes daemon in this terminal',
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
    name: 'setup',
    aliases: ['setup'],
    description: 'Open /setup in the terminal app, or print whether first run has been done',
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
    description: 'Mint a named device token and print its pairing link and QR code',
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
    description: 'Scaffold, validate or trust a plugin, or manage capability bundles',
    subcommands: ['init', 'validate', 'bundles', 'trust', 'verify', 'capabilities'],
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
    // Every command the parser knows, with its spellings from the parser's catalog; the
    // descriptions and subcommand words are this table's. `acp` and `host` are served before the parser.
    commands: [
      ...GOODVIBES_CLI_CATALOG.commands.map((spec) => {
        const described = COMPLETION_COMMANDS.find((command) => command.name === spec.name);
        return {
          name: spec.name,
          aliases: [spec.name, ...spec.aliases],
          description: described?.description ?? spec.summary ?? spec.name,
          subcommands: described?.subcommands ?? [],
        };
      }),
      ...COMPLETION_COMMANDS.filter((command) => !GOODVIBES_CLI_CATALOG.commands.some((spec) => spec.name === command.name)),
    ],
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
