/**
 * cli-command-catalog.ts, WHAT a terminal-shaped front-end's command line
 * understands.
 *
 * This file is data (plus the handful of pure functions its own field
 * semantics need, inferring a provider from a `provider:model` key, folding
 * leftover positionals into a prompt). It holds no argv-walking logic of its
 * own: cli-parser-engine.ts is the engine, handed this catalog and an
 * argument list, and it knows nothing about any specific command. `--print`
 * and `--prompt` implying the `run` command, `--non-interactive` also
 * implying `--yes`, and the session-lifecycle-flag conflict check are this
 * catalog's own domain rules, wired through its `postProcess` hook, the one
 * seam the engine leaves for a product to have opinions the engine itself
 * must not.
 *
 * GLOBAL_FLAGS is every flag this vocabulary recognizes. A command whose
 * handler reads options of its own (`auth add-user --role admin`, `secrets
 * set KEY --stdin`, `pair --name phone`) is listed in OWNS_OPTIONS: an
 * unknown option after its word reaches that handler in `commandArgs`. Every
 * other command takes only the global flags, so a mistyped option after its
 * word (`run --max-turn 3`) is refused instead of being dropped and its value
 * joined into the prompt.
 */
import { AUTO_REGISTER_CATALOG, BUILTIN_PROVIDER_ENV_KEYS } from '@goodvibes-jev/engine/platform/platform/providers';
import type { CliCatalog, CommandFlagSpec, CommandSpec, EngineParseResult } from './cli-catalog-types.js';
import type { GoodVibesCliCommand, GoodVibesCliFlags, GoodVibesCliOutputFormat } from './cli-types.js';

/** Every field a flag in this vocabulary can land on. */
export type GoodVibesCliFlagField = keyof GoodVibesCliFlags;

function createDefaultFlags(): GoodVibesCliFlags {
  return {
    provider: undefined,
    model: undefined,
    daemonHome: undefined,
    workingDir: undefined,
    help: false,
    version: false,
    prompt: undefined,
    print: false,
    outputFormat: 'text',
    configOverrides: [],
    enableFeatures: [],
    disableFeatures: [],
    noAltScreen: false,
    port: undefined,
    hostname: undefined,
    open: false,
    continueLast: false,
    resume: undefined,
    session: undefined,
    fork: undefined,
    yes: false,
    nonInteractive: false,
    strict: false,
  };
}

/**
 * Providers that run on the operator's machine and so do not appear in the
 * credential catalog, which only lists providers that take a key.
 */
const LOCAL_PROVIDER_IDS: ReadonlySet<string> = new Set(['ollama', 'lmstudio', 'lm-studio', 'llamacpp', 'llama-cpp', 'litellm', 'vllm', 'copilot-proxy']);

/** Registered providers that are neither in the credential catalog nor local: the subscription login. */
const SUBSCRIPTION_PROVIDER_IDS: readonly string[] = ['openai-subscriber'];

function isKnownProviderId(prefix: string): boolean {
  return (
    Object.hasOwn(BUILTIN_PROVIDER_ENV_KEYS, prefix) ||
    LOCAL_PROVIDER_IDS.has(prefix) ||
    SUBSCRIPTION_PROVIDER_IDS.includes(prefix) ||
    AUTO_REGISTER_CATALOG.some((entry) => entry.id === prefix)
  );
}

/**
 * `provider:model` names the provider inside the model id; that is the
 * platform's own model reference grammar. But model ids carry colons of their
 * own (Ollama `llama3:8b`, OpenRouter `:free`), so the text before a colon
 * names a provider only when it is one the platform knows. Otherwise the whole
 * value is the model id and the configured provider stays. A provider defined
 * only in the operator's own config is named with `--provider`. A slash is not
 * a separator either: `meta-llama/Llama-3.1-8B` carries one inside the model
 * name. An explicit `--provider` always wins; callers use this only when none
 * was given.
 */
export function inferProviderFromModel(model: string): string | undefined {
  const separator = model.indexOf(':');
  if (separator <= 0) return undefined;
  const prefix = model.slice(0, separator);
  return isKnownProviderId(prefix) ? prefix : undefined;
}

const OUTPUT_FORMAT_VALUES: readonly GoodVibesCliOutputFormat[] = ['text', 'json', 'stream-json'];

const GLOBAL_FLAGS: readonly CommandFlagSpec<GoodVibesCliFlagField>[] = [
  { tokens: ['--help', '-h'], field: 'help', kind: 'boolean', summary: 'Print help and exit 0.' },
  { tokens: ['--version', '-v'], field: 'version', kind: 'boolean', summary: 'Print the version and exit 0.' },
  {
    tokens: ['--print'],
    field: 'print',
    kind: 'boolean',
    summary: 'Print one conversation turn instead of opening the terminal UI. Implies `run` with no command word.',
  },
  {
    tokens: ['--json'],
    field: 'outputFormat',
    kind: 'const',
    constValue: 'json',
    summary: 'Shorthand for --output json.',
  },
  { tokens: ['--no-worries-just-vibes'], field: 'autoApprove', kind: 'boolean', summary: 'Auto-approve tools, including access outside the project, for this launch.' },
  { tokens: ['--no-alt-screen'], field: 'noAltScreen', kind: 'boolean', summary: 'Do not use the terminal alt screen.' },
  { tokens: ['--open'], field: 'open', kind: 'boolean', summary: 'Open a browser window for the web surface.' },
  { tokens: ['--continue'], field: 'continueLast', kind: 'boolean', summary: 'Resume the last conversation.' },
  {
    tokens: ['--fork'],
    field: 'fork',
    kind: 'string-optional',
    bareValue: true,
    valueName: 'id',
    summary: 'Fork a conversation. With no id, forks the current one.',
  },
  { tokens: ['--yes', '-y'], field: 'yes', kind: 'boolean', summary: 'Answer confirmation prompts with yes.' },
  {
    tokens: ['--non-interactive'],
    field: 'nonInteractive',
    kind: 'boolean',
    summary: 'Never prompt. Implies --yes.',
  },
  {
    tokens: ['--strict'],
    field: 'strict',
    kind: 'boolean',
    summary: "doctor: advisory findings also fail (exit 1), for CI. Ignored by every other command.",
  },
  { tokens: ['--timeout'], field: 'timeout', kind: 'string', valueName: 'duration', summary: 'run: stop after this long (90, 90s, 5m, 1h); exits 124.' },
  { tokens: ['--max-turns'], field: 'maxTurns', kind: 'string', valueName: 'n', summary: 'run: stop once the model has answered this many times and still asks for tools; exits 1.' },
  { tokens: ['--omit-accumulated'], field: 'omitAccumulated', kind: 'boolean', summary: 'run: with stream-json, leave `accumulated` out of STREAM_DELTA frames.' },
  { tokens: ['--answer-permissions'], field: 'answerPermissions', kind: 'boolean', summary: 'run: with stream-json, read PERMISSION_ANSWER lines on stdin for the owner prompts the run raises.' },
  { tokens: ['--provider'], field: 'provider', kind: 'string', valueName: 'id', summary: 'Run with this provider.' },
  {
    tokens: ['--model', '-m'],
    field: 'model',
    kind: 'string',
    valueName: 'registryKey',
    summary: 'Run with this model. A provider:model key also sets the provider, unless --provider was given too.',
  },
  {
    tokens: ['--daemon-home'],
    field: 'daemonHome',
    kind: 'string',
    valueName: 'dir',
    summary: "The daemon's own identity directory.",
  },
  {
    tokens: ['--working-dir', '--cd', '-C'],
    field: 'workingDir',
    kind: 'string',
    valueName: 'dir',
    summary: 'The directory this front-end treats as its workspace.',
  },
  {
    tokens: ['--prompt', '-p'],
    field: 'prompt',
    kind: 'string',
    valueName: 'text',
    summary: 'Send this prompt. Implies `run` with no command word.',
  },
  {
    tokens: ['--output-format'],
    field: 'outputFormat',
    kind: 'enum',
    enumValues: OUTPUT_FORMAT_VALUES,
    enumDefault: 'text',
    valueName: 'format',
    summary: 'Deprecated alias for --output.',
    warning: '--output-format is deprecated; use --output (or -o) instead.',
  },
  {
    tokens: ['--output', '-o'],
    field: 'outputFormat',
    kind: 'enum',
    enumValues: OUTPUT_FORMAT_VALUES,
    enumDefault: 'text',
    valueName: 'format',
    summary: 'Output format: text, json, or stream-json.',
  },
  {
    tokens: ['--config', '-c'],
    field: 'configOverrides',
    kind: 'string-list',
    valueName: 'key=value',
    summary: 'Override one settings key for this run only. Repeatable.',
  },
  {
    tokens: ['--enable'],
    field: 'enableFeatures',
    kind: 'string-list',
    valueName: 'feature',
    summary: 'Switch a capability on for this run. Repeatable.',
  },
  {
    tokens: ['--disable'],
    field: 'disableFeatures',
    kind: 'string-list',
    valueName: 'feature',
    summary: 'Switch a capability off for this run. Repeatable.',
  },
  { tokens: ['--port'], field: 'port', kind: 'port', valueName: 'n', summary: 'Port to bind or call.' },
  {
    tokens: ['--hostname', '--host'],
    field: 'hostname',
    kind: 'string',
    valueName: 'host',
    summary: 'Bind address for the endpoint the selected command owns.',
  },
  {
    tokens: ['--resume', '-r'],
    field: 'resume',
    kind: 'string-optional',
    bareValue: 'latest',
    valueName: 'id',
    summary: 'Resume a conversation. With no id, resumes the most recent.',
  },
  {
    tokens: ['--session', '-s'],
    field: 'session',
    kind: 'string',
    valueName: 'id',
    summary: 'Select a conversation by id.',
  },
];

/**
 * Commands whose handler parses its own subcommand options from `commandArgs`.
 * Only these let an option the catalog does not know through; their handlers
 * are where those options are read.
 */
const OWNS_OPTIONS: ReadonlySet<GoodVibesCliCommand> = new Set<GoodVibesCliCommand>([
  'service', 'doctor', 'models', 'providers', 'auth', 'subscription', 'secrets', 'sessions', 'tasks',
  'pair', 'surfaces', 'support-bundle', 'hooks', 'plugin',
]);

/** Every command word this vocabulary accepts. */
const COMMANDS: readonly CommandSpec<GoodVibesCliCommand, GoodVibesCliFlagField>[] = ([
  ['tui', ['app']],
  ['run', ['exec', 'e']],
  ['serve', ['daemon', 'server']],
  ['web', []],
  ['service', ['services']],
  ['status', []],
  ['doctor', []],
  ['onboarding', ['setup']],
  ['models', ['model']],
  ['providers', ['provider']],
  ['auth', []],
  ['subscription', ['subscriptions']],
  ['secrets', ['secret']],
  ['sessions', ['session']],
  ['tasks', ['task']],
  ['pair', ['qrcode', 'qr']],
  ['surfaces', ['surface']],
  ['listener', ['http-listener', 'webhook']],
  ['control-plane', ['controlplane', 'cp']],
  // `bundle`/`bundles` are retained as backward-compat aliases for the shipped
  // command word; the primary, unambiguous name is `support-bundle` (distinct
  // from the `plugin bundles` capability-bundle surface).
  ['support-bundle', ['bundle', 'bundles']],
  ['remote', []],
  ['bridge', []],
  ['hooks', ['hook']],
  ['plugin', ['plugins']],
  ['completion', ['completions']],
  ['help', []],
  ['version', []],
] as const).map(([name, aliases]) => ({
  name,
  aliases,
  flags: [],
  passthrough: false,
  lenientUnknownFlags: OWNS_OPTIONS.has(name),
  subcommands: [],
})) as readonly CommandSpec<GoodVibesCliCommand, GoodVibesCliFlagField>[];

/**
 * Non-interactive implies yes; a model key backfills an unset provider;
 * `--print`/`--prompt` with no explicit command word implies `run`; leftover
 * positionals become the prompt for a `run` (or `--print`) invocation with
 * none set otherwise; only one of --continue/--resume/--fork may be used;
 * and --session / --fork are refused where they would be ignored. These are this vocabulary's own domain rules, the engine enforces
 * none of them, and a catalog with no such rules (there is nothing the
 * daemon's own vocabulary needs this hook for today) simply omits it.
 */
function postProcess(
  result: EngineParseResult<GoodVibesCliCommand, GoodVibesCliFlags>,
): EngineParseResult<GoodVibesCliCommand, GoodVibesCliFlags> {
  let flags = result.flags;
  let command = result.command;
  const errors = [...result.errors];

  if (flags.nonInteractive) flags = { ...flags, yes: true };
  if (flags.autoApprove) flags = { ...flags, configOverrides: [...flags.configOverrides, 'behavior.autoApprove=true'] };

  if (flags.model !== undefined && flags.provider === undefined) {
    const inferred = inferProviderFromModel(flags.model);
    if (inferred !== undefined) flags = { ...flags, provider: inferred };
  }

  if (result.rawCommand === undefined && (flags.print || flags.prompt !== undefined)) {
    command = 'run';
  }

  if (flags.prompt === undefined && (command === 'run' || flags.print) && result.positionals.length > 0) {
    flags = { ...flags, prompt: result.positionals.join(' ') };
  }

  const sessionLifecycleFlags = [
    flags.continueLast ? '--continue' : undefined,
    flags.resume !== undefined ? '--resume' : undefined,
    flags.fork !== undefined ? '--fork' : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  if (sessionLifecycleFlags.length > 1) {
    errors.push(
      `Conflicting session lifecycle flags: ${sessionLifecycleFlags.join(' and ')}. Use only one of --continue, --resume, or --fork.`,
    );
  }

  // `--session` is read only by `run`; the interactive shell never attaches to it,
  // and `run` never forks, so refuse each where it would be silently ignored.
  if (command !== 'run' && flags.session !== undefined) {
    errors.push('--session is only supported with run; use --resume to reopen a session in the interactive shell.');
  }
  if (command === 'run' && flags.fork !== undefined) {
    errors.push('--fork is not supported with run; use --resume <id> or --session <id> to continue a session headlessly.');
  }

  return { ...result, command, flags, errors };
}

/** The shared terminal front-end vocabulary `parseGoodVibesCli` is built from. */
export const GOODVIBES_CLI_CATALOG: CliCatalog<GoodVibesCliCommand, GoodVibesCliFlagField, GoodVibesCliFlags> = {
  commands: COMMANDS,
  globalFlags: GLOBAL_FLAGS,
  defaultCommand: 'tui',
  // An unrecognized first word becomes an ordinary positional under the
  // default command: `goodvibes "fix the bug"` opens the app with that first
  // prompt, and with --print it is the run prompt. A lone word one or two
  // edits from a command word is refused by the engine as a typo.
  unmatchedFirstToken: 'passthrough',
  createDefaultFlags,
  postProcess,
};
