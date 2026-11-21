import { inferProviderFromModel } from '@goodvibes/engine/terminal-shell/cli-command-catalog';
import type { CliCatalog, CommandFlagSpec, CommandOptionSpec, CommandSpec } from '@goodvibes/engine/terminal-shell';
import type { GoodVibesCliCommand, GoodVibesCliFlags } from './types.ts';
import { MEMORY_FLAG_OPTIONS, MEMORY_VALUE_OPTIONS } from './memory-command.ts';
export const COMMAND_ALIASES: Readonly<Record<string, GoodVibesCliCommand>> = {
  run: 'run',
  exec: 'run',
  e: 'run',
  status: 'status',
  doctor: 'doctor',
  onboarding: 'onboarding',
  setup: 'onboarding',
  models: 'models',
  model: 'models',
  providers: 'providers',
  provider: 'providers',
  profiles: 'profiles',
  profile: 'profiles',
  personas: 'personas',
  persona: 'personas',
  skills: 'skills',
  skill: 'skills',
  'agent-skills': 'skills',
  memory: 'memory',
  memories: 'memory',
  routines: 'routines',
  routine: 'routines',
  ci: 'ci',
  principals: 'principals',
  principal: 'principals',
  // `profile` already means `profiles` (isolated Agent profile homes), so the
  // owner profile takes its own unambiguous name rather than re-pointing a
  // command that works today.
  'owner-profile': 'owner-profile',
  'owner-profiles': 'owner-profile',
  'about-me': 'owner-profile',
  'channel-profiles': 'channel-profiles',
  'channel-profile': 'channel-profiles',
  workspaces: 'workspaces',
  workspace: 'workspaces',
  browser: 'browser',
  plugin: 'plugin',
  plugins: 'plugin',
  relay: 'relay',
  fleet: 'fleet',
  fleets: 'fleet',
  auth: 'auth',
  compat: 'compat',
  compatibility: 'compat',
  knowledge: 'knowledge',
  know: 'knowledge',
  kb: 'knowledge',
  ask: 'ask',
  search: 'search',
  find: 'search',
  delegate: 'delegate',
  build: 'delegate',
  subscription: 'subscription',
  subscriptions: 'subscription',
  secrets: 'secrets',
  secret: 'secrets',
  sessions: 'sessions',
  session: 'sessions',
  tasks: 'tasks',
  task: 'tasks',
  pair: 'pair',
  qrcode: 'pair',
  qr: 'pair',
  bundle: 'bundle',
  bundles: 'bundle',
  import: 'import',
  migrate: 'import',
  completion: 'completion',
  completions: 'completion',
  help: 'help',
  version: 'version',
};
export const BLOCKED_PRODUCT_COMMAND_HINTS: Readonly<Partial<Record<string, (binary: string) => string>>> = {
  app: (binary) => `Unsupported command: app. Launch the Agent TUI with "${binary}" and no command.`,
  bridge: () =>
    'Unsupported command: bridge. GoodVibes Agent connects to an externally managed GoodVibes host and does not expose bridge processes.',
  'control-plane': () =>
    'Unsupported command: control-plane. GoodVibes Agent can inspect connected-host posture, but it does not manage host endpoints.',
  controlplane: () =>
    'Unsupported command: controlplane. GoodVibes Agent can inspect connected-host posture, but it does not manage host endpoints.',
  cp: () => 'Unsupported command: cp. GoodVibes Agent can inspect connected-host posture, but it does not manage host endpoints.',
  daemon: () =>
    'Unsupported command: daemon. GoodVibes Agent connects to an externally managed GoodVibes host and does not start or manage host processes.',
  'http-listener': () => 'Unsupported command: http-listener. GoodVibes Agent does not start listeners or expose inbound host endpoints.',
  launch: (binary) => `Unsupported command: launch. Launch the Agent TUI with "${binary}" and no command.`,
  listener: () => 'Unsupported command: listener. GoodVibes Agent does not start listeners or expose inbound host endpoints.',
  remote: () =>
    'Unsupported command: remote. GoodVibes Agent uses explicit connected-host routes and does not manage remote host transport.',
  serve: () =>
    'Unsupported command: serve. GoodVibes Agent connects to an externally managed GoodVibes host and does not start server processes.',
  server: () =>
    'Unsupported command: server. GoodVibes Agent connects to an externally managed GoodVibes host and does not start server processes.',
  service: () => 'Unsupported command: service. GoodVibes Agent keeps host lifecycle ownership outside this product.',
  services: () => 'Unsupported command: services. GoodVibes Agent keeps host lifecycle ownership outside this product.',
  start: (binary) =>
    `Unsupported command: start. Launch the Agent TUI with "${binary}" and no command; Agent does not start connected-host processes.`,
  surface: () => 'Unsupported command: surface. GoodVibes Agent does not manage connected-host surfaces.',
  surfaces: () => 'Unsupported command: surfaces. GoodVibes Agent does not manage connected-host surfaces.',
  tui: (binary) => `Unsupported command: tui. Launch the Agent TUI with "${binary}" and no command.`,
  web: () => 'Unsupported command: web. GoodVibes Agent does not start web servers or expose browser routes.',
  webhook: () =>
    'Unsupported command: webhook. GoodVibes Agent can send explicit channel messages, but it does not create webhook listeners.',
};
function createDefaultFlags(): GoodVibesCliFlags {
  return {
    provider: undefined,
    model: undefined,
    agentProfile: undefined,
    runtimeUrl: undefined,
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
    fork: false,
    rawOutput: false,
    acceptRawOutputRisk: false,
  };
}
function inferProviderForFlag(model: string, currentProvider: string | undefined): string | undefined {
  return currentProvider ?? inferProviderFromModel(model);
}
type FlagField = keyof GoodVibesCliFlags;
const GLOBAL_FLAGS: readonly CommandFlagSpec<FlagField>[] = [
  {
    field: 'help',
    tokens: ['--help', '-h'],
    kind: 'boolean',
    summary: 'Agent help',
    allowInlineValue: true,
  },
  {
    field: 'version',
    tokens: ['--version', '-v'],
    kind: 'boolean',
    summary: 'Agent version',
    allowInlineValue: true,
  },
  {
    field: 'print',
    tokens: ['--print'],
    kind: 'boolean',
    summary: 'Print the response and exit (same as run)',
    allowInlineValue: true,
  },
  {
    field: 'outputFormat',
    tokens: ['--json'],
    kind: 'const',
    summary: 'Agent outputFormat',
    allowInlineValue: true,
    constValue: 'json',
  },
  {
    field: 'noAltScreen',
    tokens: ['--no-alt-screen'],
    kind: 'boolean',
    summary: 'Agent noAltScreen',
    allowInlineValue: true,
  },
  {
    field: 'open',
    tokens: ['--open'],
    kind: 'boolean',
    summary: 'Agent open',
    allowInlineValue: true,
  },
  {
    field: 'continueLast',
    tokens: ['--continue'],
    kind: 'boolean',
    summary: 'Agent continueLast',
    allowInlineValue: true,
  },



  {
    field: 'provider',
    tokens: ['--provider'],
    kind: 'string',
    summary: 'Agent provider',
  },
  {
    field: 'model',
    tokens: ['--model', '-m'],
    kind: 'string',
    summary: 'Agent model',
  },
  {
    field: 'agentProfile',
    tokens: ['--agent-profile'],
    kind: 'string',
    summary: 'Agent agentProfile',
  },
  {
    field: 'runtimeUrl',
    tokens: ['--runtime-url', '--runtime'],
    kind: 'string',
    summary: 'Agent runtimeUrl',
  },
  {
    field: 'workingDir',
    tokens: ['--working-dir', '--cd', '-C'],
    kind: 'string',
    summary: 'Agent workingDir',
  },
  {
    field: 'prompt',
    tokens: ['--prompt', '-p'],
    kind: 'string',
    summary: 'Agent prompt',
  },
  {
    field: 'outputFormat',
    tokens: ['--output-format', '--output', '-o'],
    kind: 'enum',
    summary: 'Agent outputFormat',
    enumValues: ['text', 'json', 'stream-json'],
    enumDefault: 'text',
  },
  {
    field: 'configOverrides',
    tokens: ['--config', '-c'],
    kind: 'string-list',
    summary: 'Agent configOverrides',
  },
  {
    field: 'enableFeatures',
    tokens: ['--enable'],
    kind: 'string-list',
    summary: 'Agent enableFeatures',
  },
  {
    field: 'disableFeatures',
    tokens: ['--disable'],
    kind: 'string-list',
    summary: 'Agent disableFeatures',
  },
  {
    field: 'port',
    tokens: ['--port'],
    kind: 'port',
    summary: 'pair: port to print in the pairing endpoint',
  },
  {
    field: 'hostname',
    tokens: ['--hostname', '--host'],
    kind: 'string',
    summary: 'pair: host to print in the pairing endpoint',
  },
  {
    field: 'resume',
    tokens: ['--resume', '-r'],
    kind: 'string-optional',
    summary: 'Agent resume',
    bareValue: 'latest',
  },
  {
    field: 'session',
    tokens: ['--session', '-s'],
    kind: 'string',
    summary: 'Agent session',
  },
  { field: 'permissionMode', tokens: ['--just-vibes'], kind: 'const', constValue: 'just-vibes', exclusive: true, summary: 'Work without interrupting you for this launch: anything that needs you is held and listed at the end (permissions.mode just-vibes)' },
  // --no-worries-just-vibes is kept as an unlisted spelling of --yolo.
  { field: 'permissionMode', tokens: ['--yolo', '--no-worries-just-vibes'], kind: 'const', constValue: 'yolo', exclusive: true, summary: 'Run every action without safety denials for this launch (permissions.mode yolo)' },
  // run limits and native intake recovery: parsed here like every flag; parseNativeShellCli reads them.
  { field: 'intakeMode', tokens: ['--intake-status'], kind: 'const', constValue: 'status', exclusive: true, summary: 'run: print the host\'s state of the saved native input instead of sending a new one; exits 0 when the host has a record of it' },
  { field: 'intakeMode', tokens: ['--intake-retry'], kind: 'const', constValue: 'retry', exclusive: true, summary: 'run: request admission again for the same saved input' },
  { field: 'intakeMode', tokens: ['--intake-resume'], kind: 'const', constValue: 'resume', exclusive: true, summary: 'run: explicit recovery of a saved input the host reports as processing' },
  { field: 'intakeMode', tokens: ['--intake-cancel'], kind: 'const', constValue: 'cancel', exclusive: true, summary: 'run: cancel the saved input, or drop it when it already became work (the work stays in /work)' },
  { field: 'timeout', tokens: ['--timeout'], kind: 'string', summary: 'run: stop after this long (90, 90s, 5m, 1h); exits 124' },
  { field: 'maxTurns', tokens: ['--max-turns'], kind: 'string', summary: 'run: stop once the model has answered this many times and still asks for tools; exits 1' },
  { field: 'omitAccumulated', tokens: ['--omit-accumulated'], kind: 'boolean', summary: 'run: with stream-json, leave accumulated out of STREAM_DELTA frames' },
  { field: 'answerPermissions', tokens: ['--answer-permissions'], kind: 'boolean', summary: 'run: with stream-json, read PERMISSION_ANSWER lines on stdin for the owner prompts the run raises' },
];
const names = [...new Set<GoodVibesCliCommand>(['tui', ...Object.values(COMMAND_ALIASES)])];
/**
 * The options each command's handler (or the slash command that reuses it)
 * reads from `commandArgs` itself, beyond the global flags. A command word not
 * listed takes only the global flags. Every command is strict: after its word
 * an option it does not declare is refused, naming what it accepts, instead of
 * reaching a handler that would ignore it while the command reports success.
 */
const options = (...names: readonly string[]): readonly CommandOptionSpec[] =>
  names.map((name) => ({ tokens: [`--${name}`], takesValue: false }));
/** Options that always take the next word as their value, so a missing value is refused here. */
const valued = (...names: readonly string[]): readonly CommandOptionSpec[] =>
  names.map((name) => ({ tokens: [`--${name}`], takesValue: true }));
// `routines promote` (parseRoutineSchedulePromotionArgs): the schedule, its target and its delivery.
const ROUTINE_PROMOTE_OPTIONS = [
  ...valued('cron', 'every', 'at', 'timezone', 'provider', 'model',
    'delivery-channel', 'deliver-channel', 'delivery-route', 'deliver-route',
    'delivery-webhook', 'deliver-webhook', 'delivery-link', 'deliver-link'),
  ...options('disabled'),
];
const KNOWLEDGE_OPTIONS = [
  ...options('allow-private-hosts', 'connector', 'content', 'folder', 'home', 'input', 'kind', 'limit', 'mode', 'path', 'review', 'tags', 'title', 'wrfc', 'yes',
    'browser', 'browsers', 'since-days', 'source-kind', 'source-kinds', 'sources'),
  // Scope options the handler refuses with its own explanation (Agent Knowledge is isolated).
  ...options('space', 'knowledge-space', 'knowledge-space-id', 'knowledgeSpaceId', 'include-all-spaces', 'includeAllSpaces', 'homegraph', 'home-graph'),
];
const COMMAND_OPTIONS: Partial<Record<GoodVibesCliCommand, readonly CommandOptionSpec[]>> = {
  doctor: options('strict'),
  onboarding: [...options('apply'), ...valued('name')],
  profiles: options('description', 'include-vibe', 'name', 'persona', 'profile-name', 'replace', 'routines', 'skills', 'starter', 'starter-id', 'template', 'template-id', 'yes'),
  personas: options('body', 'description', 'name', 'provenance', 'tags', 'triggers', 'use', 'yes'),
  skills: options('description', 'enabled', 'name', 'procedure', 'provenance', 'requires-command', 'requires-commands', 'requires-env', 'skills', 'tags', 'triggers', 'yes'),
  memory: [...valued(...MEMORY_VALUE_OPTIONS), ...options(...MEMORY_FLAG_OPTIONS)],
  routines: [...options('description', 'enabled', 'name', 'requires-command', 'requires-commands', 'requires-env', 'steps', 'tags', 'triggers', 'yes'), ...ROUTINE_PROMOTE_OPTIONS],
  ci: options('delivery-channel', 'pr', 'ref', 'trigger-fix-session', 'yes'),
  principals: options('channel', 'clear-identities', 'identity', 'kind', 'name', 'value', 'yes'),
  'owner-profile': options('said', 'section', 'text', 'yes'),
  'channel-profiles': options('channel-id', 'model', 'permission-mode', 'provider', 'yes'),
  workspaces: options('label', 'yes'),
  browser: [...options('arg', 'repair', 'visible'), { tokens: ['--help', '-h'], takesValue: false }],
  plugin: [{ tokens: ['--sha256'], takesValue: true }, { tokens: ['--ref'], takesValue: true }, ...options('yes')],
  fleet: options('workstream', 'yes'),
  knowledge: KNOWLEDGE_OPTIONS,
  compat: KNOWLEDGE_OPTIONS,
  ask: KNOWLEDGE_OPTIONS,
  search: KNOWLEDGE_OPTIONS,
  delegate: KNOWLEDGE_OPTIONS,
  secrets: options('user', 'project', 'secure', 'plaintext', 'stdin'),
  pair: valued('name'),
  import: options('apply', 'apply-permissions'),
  // `bundle import <path> --yes [--include-security]` (the shared support-bundle command).
  bundle: options('yes', 'include-security'),
};
const COMMANDS: readonly CommandSpec<GoodVibesCliCommand, FlagField>[] = [
  {
    name: 'unknown',
    aliases: Object.keys(BLOCKED_PRODUCT_COMMAND_HINTS),
    flags: [],
    passthrough: false,
    lenientUnknownFlags: true,
    subcommands: [],
  },
  ...names.map((name) => ({
    name,
    aliases: Object.entries(COMMAND_ALIASES)
      .filter(([token, command]) => command === name && token !== name)
      .map(([token]) => token),
    flags: [],
    passthrough: false,
    options: COMMAND_OPTIONS[name] ?? [],
    subcommands: [],
  })),
];
export const AGENT_CLI_CATALOG: CliCatalog<GoodVibesCliCommand, FlagField, GoodVibesCliFlags> = {
  commands: COMMANDS,
  globalFlags: GLOBAL_FLAGS,
  defaultCommand: 'tui',
  unmatchedFirstToken: 'passthrough',
  createDefaultFlags,
  unknownOptionError: (name) => 'Unknown option: ' + name,
  postFlag(flags, spec) {
    if (spec.field === 'permissionMode' && flags.permissionMode) {
      return { ...flags, configOverrides: [...flags.configOverrides, `permissions.mode=${flags.permissionMode}`] };
    }
    return spec.field === 'model' && flags.model !== undefined
      ? { ...flags, provider: inferProviderForFlag(flags.model, flags.provider) }
      : flags;
  },
  postProcess(result) {
    let flags = result.flags;
    let command = result.command;
    if (result.rawCommand === undefined && (flags.print || flags.prompt !== undefined)) command = 'run';
    if (flags.prompt === undefined && (command === 'run' || flags.print) && result.positionals.length)
      flags = { ...flags, prompt: result.positionals.join(' ') };
    const errors = [...result.errors];
    // These parse everywhere but only act in one place; refuse them where they
    // would be silently ignored instead of starting something the user did not ask for.
    if (command !== 'run' && (flags.continueLast || flags.session !== undefined)) {
      errors.push(`${flags.continueLast ? '--continue' : '--session'} is only supported with run in goodvibes-agent. Use --resume to reopen a session in the interactive shell.`);
    }
    // One session selector per run: --session names one exactly as --resume <id> does.
    const selectors = [flags.continueLast ? '--continue' : '', flags.resume !== undefined ? '--resume' : '', flags.session !== undefined ? '--session' : ''].filter(Boolean);
    if (selectors.length > 1) {
      errors.push(`Conflicting session lifecycle flags: ${selectors.join(' and ')}. Use only one of --continue, --resume or --session.`);
    }
    if ((flags.port !== undefined || flags.hostname !== undefined) && command !== 'pair' && command !== 'unknown') {
      const given = [flags.port !== undefined ? '--port' : '', flags.hostname !== undefined ? '--hostname' : ''].filter(Boolean).join(' and ');
      errors.push(`${given} only ${given.includes(' and ') ? 'apply' : 'applies'} to the pair command; nothing else reads ${given.includes(' and ') ? 'them' : 'it'}. Remove ${given.includes(' and ') ? 'them' : 'it'}, or run pair with ${given.includes(' and ') ? 'them' : 'it'}.`);
    }
    if (command === 'unknown' && result.rawCommand !== undefined) {
      const key = result.rawCommand.toLowerCase();
      const hint = Object.hasOwn(BLOCKED_PRODUCT_COMMAND_HINTS, key) ? BLOCKED_PRODUCT_COMMAND_HINTS[key] : undefined;
      errors.push(hint ? hint(result.binary) : 'Unknown command ' + result.rawCommand);
    }
    return { ...result, command, flags, errors };
  },
};
