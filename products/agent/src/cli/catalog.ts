import type { CliCatalog, CommandFlagSpec, CommandSpec } from '@goodvibes-jev/engine/terminal-shell';
import type { GoodVibesCliCommand, GoodVibesCliFlags } from './types.ts';
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
function inferProviderFromModel(model: string, currentProvider: string | undefined): string | undefined {
  if (currentProvider !== undefined) return currentProvider;
  if (model.includes(':')) return model.split(':')[0];
  if (model.includes('/')) return model.split('/')[0];
  return undefined;
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
    summary: 'Agent print',
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
    field: 'fork',
    tokens: ['--fork'],
    kind: 'boolean',
    summary: 'Agent fork',
    allowInlineValue: true,
  },
  {
    field: 'rawOutput',
    tokens: ['--raw-output'],
    kind: 'boolean',
    summary: 'Agent rawOutput',
    allowInlineValue: true,
  },
  {
    field: 'acceptRawOutputRisk',
    tokens: ['--accept-raw-output-risk'],
    kind: 'boolean',
    summary: 'Agent acceptRawOutputRisk',
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
    summary: 'Agent port',
  },
  {
    field: 'hostname',
    tokens: ['--hostname', '--host'],
    kind: 'string',
    summary: 'Agent hostname',
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
];
const names = [...new Set<GoodVibesCliCommand>(['tui', ...Object.values(COMMAND_ALIASES)])];
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
    lenientUnknownFlags: true,
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
    return spec.field === 'model' && flags.model !== undefined
      ? { ...flags, provider: inferProviderFromModel(flags.model, flags.provider) }
      : flags;
  },
  postProcess(result) {
    let flags = result.flags;
    let command = result.command;
    if (result.rawCommand === undefined && (flags.print || flags.prompt !== undefined)) command = 'run';
    if (flags.prompt === undefined && (command === 'run' || flags.print) && result.positionals.length)
      flags = { ...flags, prompt: result.positionals.join(' ') };
    const errors = [...result.errors];
    if (command === 'unknown' && result.rawCommand !== undefined) {
      const key = result.rawCommand.toLowerCase();
      const hint = Object.hasOwn(BLOCKED_PRODUCT_COMMAND_HINTS, key) ? BLOCKED_PRODUCT_COMMAND_HINTS[key] : undefined;
      errors.push(hint ? hint(result.binary) : 'Unknown command ' + result.rawCommand);
    }
    return { ...result, command, flags, errors };
  },
};
