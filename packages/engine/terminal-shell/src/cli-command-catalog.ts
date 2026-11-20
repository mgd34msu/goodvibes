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
 * set KEY --stdin`, `pair --name phone`) declares them in COMMAND_OPTIONS and
 * receives them in `commandArgs`. Every command refuses any other option after
 * its word (`run --max-turn 3`, `secrets set K v --plaintxt`), so a mistyped
 * option is never dropped while the command reports success.
 */
// The credential catalog alone, not the providers module: argument parsing runs
// on every invocation, `--version` included, and must not load the provider stack.
import type { CliCatalog, CommandFlagSpec, CommandOptionSpec, CommandSpec, EngineParseResult } from './cli-catalog-types.js';
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
 * `provider:model` names the provider inside the model id; that is the
 * platform's own model reference grammar. The text before the first colon is
 * the provider (Ollama's `llama3:8b` under it is `ollama:llama3:8b`), named by
 * the provider's id or display name without regard to case; the registry
 * resolves it once the providers are known, and a name it does not know is an
 * error that lists the registered providers, never a model of another
 * provider. A slash is not a separator: an id such as
 * `meta-llama/llama-3.3-70b-instruct:free` carries its colon inside the model
 * name, so text with a slash before the colon keeps the configured provider.
 * An explicit `--provider` always wins; callers use this only when none was
 * given.
 */
export function inferProviderFromModel(model: string): string | undefined {
  const separator = model.indexOf(':');
  if (separator <= 0) return undefined;
  const prefix = model.slice(0, separator);
  return prefix.includes('/') || prefix.trim() !== prefix ? undefined : prefix;
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
  { tokens: ['--just-vibes'], field: 'permissionMode', kind: 'const', constValue: 'just-vibes', summary: 'Work without interrupting you for this launch: anything that needs you is held and listed at the end (permissions.mode just-vibes).' },
  // --no-worries-just-vibes is kept as an unlisted spelling of --yolo.
  { tokens: ['--yolo', '--no-worries-just-vibes'], unlistedTokens: ['--no-worries-just-vibes'], field: 'permissionMode', kind: 'const', constValue: 'yolo', summary: 'Run every action without safety denials for this launch (permissions.mode yolo).' },
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
  { tokens: ['--intake-status'], field: 'intakeMode', kind: 'const', constValue: 'status', exclusive: true, summary: 'run: print the host\'s state of the saved native input instead of sending a new one; exits 0 when the host has a record of it.' },
  { tokens: ['--intake-retry'], field: 'intakeMode', kind: 'const', constValue: 'retry', exclusive: true, summary: 'run: request admission again for the same saved input.' },
  { tokens: ['--intake-resume'], field: 'intakeMode', kind: 'const', constValue: 'resume', exclusive: true, summary: 'run: explicit recovery of a saved input the host reports as processing.' },
  { tokens: ['--intake-cancel'], field: 'intakeMode', kind: 'const', constValue: 'cancel', exclusive: true, summary: 'run: cancel the saved input, or drop it when it already became work (the work stays in /work).' },
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
 * The options each command's handler reads from `commandArgs` itself, beyond
 * the global flags. A command word not listed takes only the global flags.
 * Every command is strict: after its word an option it does not declare is
 * refused, naming what it accepts, instead of reaching a handler that would
 * ignore it.
 */
const COMMAND_OPTIONS: Partial<Record<GoodVibesCliCommand, readonly CommandOptionSpec[]>> = {
  auth: [
    { tokens: ['--password'], takesValue: true },
    { tokens: ['--password-stdin'], takesValue: false },
    { tokens: ['--role'], takesValue: true },
  ],
  subscription: [{ tokens: ['--open'], takesValue: false }],
  secrets: [
    { tokens: ['--user'], takesValue: false },
    { tokens: ['--project'], takesValue: false },
    { tokens: ['--secure'], takesValue: false },
    { tokens: ['--plaintext'], takesValue: false },
    { tokens: ['--stdin'], takesValue: false },
  ],
  pair: [{ tokens: ['--name'], takesValue: true }],
  'support-bundle': [{ tokens: ['--include-security'], takesValue: false }],
  plugin: [
    { tokens: ['--ref'], takesValue: true },
    { tokens: ['--sha'], takesValue: true },
    // The old retyped answer to a failed signature check; the confirmation now asks instead.
    { tokens: ['--override'], takesValue: false },
  ],
};

/** Every command word this vocabulary accepts. */
const COMMANDS: readonly CommandSpec<GoodVibesCliCommand, GoodVibesCliFlagField>[] = ([
  ['tui', ['app']],
  ['open', []],
  ['run', ['exec', 'e']],
  ['serve', ['daemon', 'server']],
  ['web', []],
  ['service', ['services']],
  ['status', []],
  ['doctor', []],
  ['setup', []],
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
  options: COMMAND_OPTIONS[name] ?? [],
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
  if (flags.permissionMode) flags = { ...flags, configOverrides: [...flags.configOverrides, `permissions.mode=${flags.permissionMode}`] };

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
    flags.session !== undefined ? '--session' : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  // One session selector per run: --session names one exactly as --resume <id> does, so it conflicts with the others.
  if (sessionLifecycleFlags.length > 1) {
    errors.push(
      `Conflicting session lifecycle flags: ${sessionLifecycleFlags.join(' and ')}. Use only one of --continue, --resume, --session, or --fork.`,
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
