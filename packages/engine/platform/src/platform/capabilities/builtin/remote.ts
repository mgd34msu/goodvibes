/**
 * Remote runners, held by the daemon (runtime/remote/daemon-runners.ts): the
 * self-hosted ACP runners it starts, the pools they run in, their contracts,
 * the artifacts they hand back for review, and what another machine needs to
 * run one. The terminal app kept these in its own memory before, so they died
 * with its window and no other program saw them; now every program, the web
 * UI and a script see the same runners, kept across a daemon restart.
 *
 * A file named here (an export, an import, a bundle) is in the asking
 * program's project: a relative path is taken from its folder.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { getDefaultAcpAgentCommand } from '../../acp/manager.js';
import { AGENT_TEMPLATES } from '../../tools/agent/manager.js';
import type { DaemonRemoteRunners } from '../../runtime/remote/daemon-runners.js';
import type { RemoteRunnerContract, RemoteSessionBundle } from '../../runtime/remote/types.js';
import { summarizeError } from '../../utils/error-display.js';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type FixedChoice, type InputDescription, type ListName } from '../types.js';

/** What the remote capabilities need: the daemon's runners, and how the daemon is set up. */
export interface RemoteCapabilityServices {
  readonly remote: {
    /** The daemon's runner holder; throws a refusal in a host that holds none. */
    runners(): DaemonRemoteRunners;
    /** Whether the daemon and its plain HTTP listener are on. */
    setup(): { readonly daemonEnabled: boolean; readonly httpListenerEnabled: boolean };
  };
}

/** The live lists the inputs choose from (terminal-shell's remote lists read them from `remote.list`). */
export const REMOTE_CONNECTIONS_LIST = 'remote.connections' as ListName;
export const REMOTE_RUNNERS_LIST = 'remote.runners' as ListName;
export const REMOTE_SUPERVISED_LIST = 'remote.supervised' as ListName;
export const REMOTE_POOLS_LIST = 'remote.pools' as ListName;
export const REMOTE_POOL_RUNNERS_LIST = 'remote.pool-runners' as ListName;
export const REMOTE_ARTIFACTS_LIST = 'remote.artifacts' as ListName;

const RUNNER: InputDescription = { id: 'runner', label: 'Runner', help: 'Runners the daemon knows', kind: 'choice', choices: { list: REMOTE_RUNNERS_LIST }, required: true, typed: { position: 1 } };
const SUPERVISED_RUNNER: InputDescription = { id: 'runner', label: 'Runner', help: 'Runners connected over a transport', kind: 'choice', choices: { list: REMOTE_SUPERVISED_LIST }, required: { default: '', defaultMeans: 'the first one' }, typed: { position: 1 } };
const CONNECTION: InputDescription = { id: 'connection', label: 'Connection', help: 'Runner connections open now', kind: 'choice', choices: { list: REMOTE_CONNECTIONS_LIST }, required: true, typed: { position: 1 } };
const POOL: InputDescription = { id: 'pool', label: 'Pool', help: 'Your runner pools', kind: 'choice', choices: { list: REMOTE_POOLS_LIST }, required: true, typed: { position: 1 } };
const ARTIFACT: InputDescription = { id: 'artifact', label: 'Artifact', help: 'Work runners handed back for review', kind: 'choice', choices: { list: REMOTE_ARTIFACTS_LIST }, required: true, typed: { position: 1 } };
const PATH = (help: string): InputDescription => ({ id: 'path', label: 'File', help, kind: 'path', freeTextReason: 'a file path in this project', required: true, typed: { position: 1 } });
const OPTIONAL_PATH = (help: string): InputDescription => ({ id: 'path', label: 'File', help, kind: 'path', freeTextReason: 'a file path in this project', required: { default: '', defaultMeans: 'the usual place in this project' }, typed: { flag: '--to' } });
const TASK: InputDescription = { id: 'task', label: 'Task', help: 'What the runner should do, in your own words', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } };
const TEMPLATE_CHOICES: readonly FixedChoice[] = Object.keys(AGENT_TEMPLATES).map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }));
const TEMPLATE = (means: string): InputDescription => ({ id: 'template', label: 'Kind of agent', help: 'Which agent template it follows', kind: 'choice', choices: TEMPLATE_CHOICES, required: { default: '', defaultMeans: means }, typed: { flag: '--template' } });
const DISPATCH_OWNER = { reason: 'it starts a runner with this machine\'s tools from your own words', instead: 'Ask the owner to start it from the Work place.' } as const;

function runnersOf(services: RemoteCapabilityServices): DaemonRemoteRunners {
  return services.remote.runners();
}

/** A file in the asking program's project (a relative path is from its folder; `~` is the home folder). */
function projectPath(caller: CapabilityCaller, path: string): string {
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  if (isAbsolute(expanded)) return resolve(expanded);
  if (!caller.workingDirectory) throw new CapabilityRefusal(`No project folder came with the request, so ${path} cannot be placed.`, 'Give the file as a full path.');
  return resolve(caller.workingDirectory, expanded);
}

function writeProjectFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { encoding: 'utf-8', mode: 0o600 });
}

function readJson(path: string, what: string): unknown {
  let raw: string;
  try { raw = readFileSync(path, 'utf-8'); } catch (error) { throw new CapabilityRefusal(`Cannot read ${path}: ${summarizeError(error)}. Nothing was changed.`); }
  try { return JSON.parse(raw) as unknown; } catch { throw new CapabilityRefusal(`Cannot use ${path} as ${what}: it is not valid JSON. Nothing was changed.`); }
}

/** The command a runner is started with, or why there is none. */
function agentCommand(): { readonly command: readonly string[] } | { readonly error: string } {
  try { return { command: getDefaultAcpAgentCommand() }; } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

function agentCommandExport(command: readonly string[]): string {
  return `export ACP_AGENT_CMD='${JSON.stringify(command).replace(/'/g, "'\\''")}'`;
}

export function runnerToolsText(contract: Pick<RemoteRunnerContract, 'trustClass' | 'capabilityCeiling'>): string {
  const tools = contract.capabilityCeiling.allowedTools;
  if (tools.length === 0) return '(no tool ceiling)';
  return `${tools.join(', ')} (${contract.trustClass === 'self-hosted-acp' ? 'a permission ask for any other kind of call is refused' : 'the agent is given only these'})`;
}

export function runnerWriteScopeText(contract: Pick<RemoteRunnerContract, 'trustClass' | 'capabilityCeiling'>): string {
  const scope = contract.capabilityCeiling.writeScope;
  if (scope.length === 0) return '(none: the working directory, under its permission rules)';
  return `${scope.join(', ')} (${contract.trustClass === 'self-hosted-acp' ? 'an edit outside it, or a command, is refused at its permission ask' : 'the scope its work is accepted against'})`;
}

export function runnerReviewText(contract: Pick<RemoteRunnerContract, 'trustClass' | 'capabilityCeiling'>): string {
  const mode = contract.capabilityCeiling.reviewMode;
  return mode === 'contract' && contract.trustClass === 'self-hosted-acp' ? 'contract (not applied to an external runner)' : mode;
}

type Supervisor = ReturnType<DaemonRemoteRunners['snapshot']>['supervisor'];
type SupervisorSession = Supervisor['sessions'][number];

function sessionFor(runners: DaemonRemoteRunners, runnerId: string, pick: (sessions: readonly SupervisorSession[]) => SupervisorSession | undefined = (sessions) => sessions[0]): SupervisorSession {
  const supervisor = runners.snapshot().supervisor;
  const selected = runnerId ? supervisor.sessions.find((entry) => entry.runnerId === runnerId) : pick(supervisor.sessions);
  if (selected) return selected;
  const local = runnerId ? supervisor.localRunners.find((entry) => entry.runnerId === runnerId) : undefined;
  if (local) throw new CapabilityRefusal(`${runnerId} is a local runner (${local.template}) in the daemon; it has no transport or heartbeat.`, 'Its contract shows what it may do.');
  throw new CapabilityRefusal(runnerId ? `No remote runner ${runnerId}.` : 'No runner is connected over a transport now.', undefined, 'NOT_FOUND');
}

function reviewModeText(selected: SupervisorSession): string {
  return selected.negotiation.trustClass === 'self-hosted-acp' && selected.negotiation.reviewMode === 'contract' ? 'contract (not applied to an external runner)' : selected.negotiation.reviewMode;
}

type Definition = CapabilityDefinition<RemoteCapabilityServices>;

function read(fields: Pick<Definition, 'actionId' | 'label' | 'sentence' | 'run'> & { readonly inputs?: Definition['inputs']; readonly example?: Definition['example']; readonly group?: Definition['capability']['group'] }): Definition {
  return {
    capability: { id: `remote.${fields.actionId}`, group: fields.group ?? 'work', home: 'daemon', repeat: 'safe' },
    actionId: fields.actionId, label: fields.label, word: fields.actionId, inputs: fields.inputs ?? [],
    sentence: fields.sentence, done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none', example: fields.example ?? {},
    run: fields.run,
  };
}

/** One file written in the project: its words and what it writes. */
function exportFile(fields: Pick<Definition, 'actionId' | 'label' | 'sentence'> & { readonly help: string; readonly group?: Definition['capability']['group']; readonly write: (path: string, services: RemoteCapabilityServices) => string }): Definition {
  return {
    capability: { id: `remote.${fields.actionId}`, group: fields.group ?? 'work', home: 'daemon', repeat: 'safe' },
    actionId: fields.actionId, label: fields.label, word: fields.actionId, inputs: [PATH(fields.help)],
    sentence: fields.sentence, done: '', touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { path: 'remote/setup.json' },
    async run(values, services, caller) {
      const path = projectPath(caller, values.path!);
      return { text: fields.write(path, services), data: { path } };
    },
  };
}

function setupLines(services: RemoteCapabilityServices, connections: number, contracts: number): string[] {
  const resolved = agentCommand();
  const setup = services.remote.setup();
  return [
    'Remote setup',
    `  agent command a runner starts: ${'command' in resolved ? JSON.stringify(resolved.command) : `none (${resolved.error})`}`,
    `  daemon on: ${setup.daemonEnabled ? 'yes' : 'no'}`,
    `  plain HTTP listener on: ${setup.httpListenerEnabled ? 'yes' : 'no'}`,
    `  runner contracts: ${contracts}`,
    `  runners connected now: ${connections}`,
    '',
    '  What to do next:',
    '    - set ACP_AGENT_CMD to a JSON array (program, then arguments) to start a different agent as a runner',
    '    - the environment a remote agent needs can be seen or saved from the Work place',
    '    - switch on the plain HTTP listener (danger.httpListener) only when another machine must reach it',
  ];
}

function tunnelLines(connections: number): string[] {
  return [
    'Remote tunnel',
    '  transport: self-hosted ACP, or the daemon relay',
    `  runners connected now: ${connections}`,
    '  forward ACP agent traffic through a self-hosted tunnel or an SSH connection you run',
  ];
}

function bundleWords(bundle: RemoteSessionBundle, replaces: readonly string[]): string {
  const exportedAt = typeof bundle.exportedAt === 'number' && Number.isFinite(bundle.exportedAt) ? new Date(bundle.exportedAt).toISOString() : 'unknown';
  return [
    'Runner bundle',
    `  saved: ${exportedAt}`,
    `  connections open when saved: ${Array.isArray(bundle.activeConnectionIds) ? bundle.activeConnectionIds.length : 0}`,
    `  pools: ${bundle.pools.length}`,
    `  contracts: ${bundle.contracts.length}`,
    `  artifacts: ${bundle.artifacts.length}`,
    '  it holds runner pools, runner contracts and artifacts; it does not hold a conversation',
    replaces.length > 0 ? `  bringing it in replaces: ${replaces.join(', ')}` : '  bringing it in replaces nothing held now',
  ].join('\n');
}

export const REMOTE_LIST = read({
  actionId: 'list', label: 'See remote runners at a glance',
  sentence: 'Shows the runners the daemon holds: connections, runner contracts, pools, artifacts and supervised runners.',
  async run(_values, services) {
    const runners = runnersOf(services);
    const snapshot = runners.snapshot();
    const { supervisor, contracts, pools, artifacts, connections } = snapshot;
    const lines = [
      'Remote runners',
      ...(runners.unreadable ? [`  The runners kept before could not be read: ${runners.unreadable}.`] : []),
      `  connections open now: ${connections.length}`,
      `  runner contracts: ${contracts.length}`,
      `  runner pools: ${pools.length}`,
      `  artifacts handed back: ${artifacts.length}`,
      `  supervised runners: ${supervisor.sessions.length} (${supervisor.degradedConnections} degraded)`,
      `  local runners (no transport): ${supervisor.localRunners.length}`,
    ];
    for (const contract of contracts.slice(0, 12)) lines.push(`    ${contract.runnerId}  ${contract.template}  ${contract.transport?.state ?? 'local'}  ${contract.capabilityCeiling.executionProtocol}/${runnerReviewText(contract)}`);
    return {
      text: lines.join('\n'),
      data: {
        ...(runners.unreadable ? { unreadable: runners.unreadable } : {}),
        connections: connections.map((connection) => ({ id: connection.agentId, label: connection.label || connection.agentId, transportState: connection.transportState, errorCount: connection.errorCount, ...(connection.lastError ? { lastError: connection.lastError } : {}), ...(connection.connectedAt ? { connectedAt: connection.connectedAt } : {}) })),
        contracts, pools,
        artifacts: artifacts.map((artifact) => ({ id: artifact.id, runnerId: artifact.runnerId, createdAt: artifact.createdAt, template: artifact.runnerContract.template, tools: artifact.runnerContract.capabilityCeiling.allowedTools, task: artifact.task.task, status: artifact.task.status, summary: artifact.task.summary, ...(artifact.task.error ? { error: artifact.task.error } : {}), toolCallCount: artifact.evidence.toolCallCount, errorCount: artifact.evidence.errorCount })),
        supervised: supervisor.sessions.map((session) => ({ runnerId: session.runnerId, label: session.label, transportState: session.transportState, heartbeat: session.heartbeat.status, heartbeatDetail: session.heartbeat.detail, recovery: session.recovery, capabilities: session.capabilities })),
        localRunners: supervisor.localRunners,
      },
    };
  },
});

export const REMOTE_SHOW = read({
  actionId: 'show', label: 'See a remote connection',
  inputs: [{ ...CONNECTION, required: { default: '', defaultMeans: 'the first one' } }],
  sentence: 'Shows {connection}\'s transport, errors, task, contract and tools.', example: { connection: 'acp-7f2' },
  async run(values, services) {
    const runners = runnersOf(services);
    const connections = runners.snapshot().connections;
    const connection = values.connection ? connections.find((entry) => entry.agentId === values.connection) : connections[0];
    if (!connection) throw new CapabilityRefusal(values.connection ? `No remote connection ${values.connection}.` : 'No runner is connected now.', undefined, 'NOT_FOUND');
    const contract = runners.registry.readContractForAgent(connection.agentId);
    return {
      text: [
        `Remote connection ${connection.agentId}`,
        `  label: ${connection.label}`,
        `  transport: ${connection.transportState}`,
        `  connected: ${connection.connectedAt ? new Date(connection.connectedAt).toISOString() : 'not yet'}`,
        `  errors: ${connection.errorCount}`,
        `  task: ${contract?.taskId ?? 'none'}`,
        `  last error: ${connection.lastError ?? 'none'}`,
        `  contract: ${contract?.id ?? 'none'}`,
        `  pool: ${contract?.poolId ?? 'none'}`,
        `  protocol: ${contract?.capabilityCeiling.executionProtocol ?? 'not known'}`,
        `  review: ${contract ? runnerReviewText(contract) : 'not known'}`,
        `  tools: ${contract ? runnerToolsText(contract) : 'not known'}`,
      ].join('\n'),
      data: { connection, ...(contract ? { contract } : {}) },
    };
  },
});

export const REMOTE_CONTRACT = read({
  actionId: 'contract', label: 'See a runner\'s contract', inputs: [RUNNER],
  sentence: 'Shows {runner}\'s template, trust, transport, tools, write scope and review mode.', example: { runner: 'acp-7f2' },
  async run(values, services) {
    const contract = runnersOf(services).registry.readContractForAgent(values.runner!);
    if (!contract) throw new CapabilityRefusal(`No remote runner ${values.runner}.`, undefined, 'NOT_FOUND');
    return {
      text: [
        `Runner contract ${contract.id}`,
        `  runner: ${contract.runnerId}`,
        `  label: ${contract.label}`,
        `  pool: ${contract.poolId ?? '(none)'}`,
        `  trust: ${contract.trustClass}`,
        `  template: ${contract.template}`,
        `  transport: ${contract.transport?.state ?? 'none (a local runner in the daemon)'}`,
        `  tools: ${runnerToolsText(contract)}`,
        `  protocol: ${contract.capabilityCeiling.executionProtocol}`,
        `  review: ${runnerReviewText(contract)}`,
        `  communication: ${contract.capabilityCeiling.communicationLane}`,
        `  write scope: ${runnerWriteScopeText(contract)}`,
      ].join('\n'),
      data: { contract },
    };
  },
});

export const REMOTE_SUPERVISOR = read({
  actionId: 'supervisor', label: 'See a runner\'s supervisor session', inputs: [SUPERVISED_RUNNER],
  sentence: 'Shows {runner}\'s transport, heartbeat, negotiated protocol, capabilities and recovery steps.', example: { runner: 'acp-7f2' },
  async run(values, services) {
    const selected = sessionFor(runnersOf(services), values.runner ?? '');
    return {
      text: [
        `Supervised runner ${selected.runnerId}`,
        `  label: ${selected.label}`,
        `  transport: ${selected.transportState}`,
        `  heartbeat: ${selected.heartbeat.status} (${selected.heartbeat.detail})`,
        `  protocol: ${selected.negotiation.executionProtocol}`,
        `  review: ${reviewModeText(selected)}`,
        `  communication: ${selected.negotiation.communicationLane}`,
        `  trust: ${selected.negotiation.trustClass}`,
        `  task: ${selected.taskId ?? 'none'}`,
        `  errors: ${selected.errorCount}`,
        ...(selected.lastError ? [`  last error: ${selected.lastError}`] : []),
        '  capabilities:',
        ...selected.capabilities.map((capability) => `    ${capability.id}: ${capability.supported ? 'yes' : 'no'} (${capability.detail})`),
        '  recovery:',
        ...selected.recovery.map((action) => `    ${action.reason}`),
      ].join('\n'),
      data: { session: selected },
    };
  },
});

export const REMOTE_CAPABILITIES = read({
  actionId: 'capabilities', label: 'See what a runner can do', inputs: [SUPERVISED_RUNNER],
  sentence: 'Shows which capabilities {runner} supports and which it lacks.', example: { runner: 'acp-7f2' },
  async run(values, services) {
    const selected = sessionFor(runnersOf(services), values.runner ?? '');
    return {
      text: [
        `What runner ${selected.runnerId} can do`,
        `  label: ${selected.label}`,
        `  transport: ${selected.transportState}`,
        `  protocol: ${selected.negotiation.executionProtocol}`,
        `  review: ${reviewModeText(selected)}`,
        ...selected.capabilities.map((capability) => `  ${capability.id}: ${capability.supported ? 'supported' : 'missing'}; ${capability.detail}`),
      ].join('\n'),
      data: { runnerId: selected.runnerId, capabilities: selected.capabilities },
    };
  },
});

export const REMOTE_RECOVER = read({
  actionId: 'recover', label: 'See how to recover a runner', inputs: [{ ...SUPERVISED_RUNNER, required: { default: '', defaultMeans: 'the first one that needs it' } }],
  sentence: 'Shows {runner}\'s heartbeat and last error, and the steps that recover it.', example: { runner: 'acp-7f2' },
  async run(values, services) {
    const selected = sessionFor(runnersOf(services), values.runner ?? '', (sessions) => sessions.find((entry) => entry.recovery.length > 0) ?? sessions[0]);
    const steps = selected.recovery.length > 0 ? selected.recovery.map((action) => `${action.label}: ${action.reason}`) : ['Look at the connection first: nothing says it needs recovering.'];
    return {
      text: [
        `Recovering runner ${selected.runnerId}`,
        `  label: ${selected.label}`,
        `  transport: ${selected.transportState}`,
        `  heartbeat: ${selected.heartbeat.status} (${selected.heartbeat.detail})`,
        ...(selected.lastError ? [`  last error: ${selected.lastError}`] : []),
        ...(selected.taskId ? [`  task: ${selected.taskId}`] : []),
        '  steps:',
        ...steps.map((step) => `    ${step}`),
      ].join('\n'),
      data: { runnerId: selected.runnerId, steps },
    };
  },
});

export const REMOTE_STOP: Definition = {
  capability: { id: 'remote.stop', group: 'work', home: 'daemon', repeat: 'safe' },
  actionId: 'stop', label: 'Stop a remote runner', word: 'stop', inputs: [CONNECTION],
  sentence: 'The runner on {connection} is stopped; what it was doing is not finished.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { connection: 'acp-7f2' },
  async run(values, services) {
    const runnerId = values.connection!;
    let stopped: boolean;
    try {
      stopped = await runnersOf(services).stop(runnerId);
    } catch (error) {
      throw new CapabilityRefusal(`Stopping runner ${runnerId} failed: ${summarizeError(error)}. It may still be running.`, 'Stop it again.');
    }
    if (!stopped) throw new CapabilityRefusal(`No runner ${runnerId} is running in the daemon.`, undefined, 'NOT_FOUND');
    return { text: `Stopped runner ${runnerId}.`, data: { runnerId } };
  },
};

async function dispatch(services: RemoteCapabilityServices, caller: CapabilityCaller, task: string, template: string, poolId: string | undefined) {
  const runners = runnersOf(services);
  const pool = poolId ? runners.registry.getPool(poolId) ?? undefined : undefined;
  if (poolId && !pool) throw new CapabilityRefusal(`No runner pool ${poolId}.`, undefined, 'NOT_FOUND');
  if (pool && pool.maxRunners !== undefined && pool.runnerIds.length >= pool.maxRunners) {
    throw new CapabilityRefusal(`Pool ${pool.id} already holds its ${pool.maxRunners} runner(s). Nothing was started.`, 'Take a runner out of it, or start one from another pool.');
  }
  if (!caller.workingDirectory) throw new CapabilityRefusal('No project folder came with the request, so the runner has nowhere to work. Nothing was started.');
  let started: Awaited<ReturnType<DaemonRemoteRunners['dispatch']>>;
  try {
    started = await runners.dispatch({ task, template: template || pool?.preferredTemplate || 'general', pool, workingDirectory: caller.workingDirectory });
  } catch (error) {
    throw new CapabilityRefusal(`No runner was started: ${summarizeError(error)}`);
  }
  return {
    text: [
      !pool ? `Started runner ${started.runnerId}.` : started.inPool ? `Started runner ${started.runnerId} from pool ${pool.id}.`
        : `Started runner ${started.runnerId}; pool ${pool.id} filled up meanwhile, so the runner is not in it (stop it if it should not run outside the pool).`,
      `  template: ${started.template}`,
      `  tools: ${started.tools.join(', ')} (a permission ask for any other kind of call is refused)`,
      `  folder: ${caller.workingDirectory}`,
      `  task: ${task}`,
    ].join('\n'),
    data: { runnerId: started.runnerId, template: started.template, ...(pool ? { pool: pool.id, inPool: started.inPool } : {}) },
  };
}

export const REMOTE_DISPATCH: Definition = {
  capability: { id: 'remote.dispatch', group: 'work', home: 'daemon', repeat: 'unsafe' },
  actionId: 'dispatch', label: 'Start a remote runner on a task', word: 'dispatch', inputs: [TASK, TEMPLATE('a general agent')],
  sentence: 'A self-hosted runner starts on "{task}" now in this project, with only its template\'s tools; it runs in the daemon until it finishes or you stop it.',
  done: '', touches: 'this-machine', lasts: 'not-a-change', risk: 'none', undoneBy: 'stop', ownerOnly: DISPATCH_OWNER,
  example: { task: 'run the test suite and report failures', template: 'tester' },
  async run(values, services, caller) { return dispatch(services, caller, values.task!, values.template ?? '', undefined); },
};

export const REMOTE_DISPATCH_POOL: Definition = {
  capability: { id: 'remote.dispatch-pool', group: 'work', home: 'daemon', repeat: 'unsafe' },
  actionId: 'dispatch-pool', label: 'Start a runner from a pool on a task', word: 'dispatch-pool', inputs: [POOL, { ...TASK }, TEMPLATE('the pool\'s usual agent')],
  sentence: 'A runner from pool {pool} starts on "{task}" now in this project, with only its template\'s tools; it runs in the daemon until it finishes or you stop it.',
  done: '', touches: 'this-machine', lasts: 'not-a-change', risk: 'none', undoneBy: 'stop', ownerOnly: DISPATCH_OWNER,
  example: { pool: 'ci', task: 'run the test suite and report failures' },
  async run(values, services, caller) { return dispatch(services, caller, values.task!, values.template ?? '', values.pool!); },
};

export const REMOTE_POOLS = read({
  actionId: 'pools', label: 'See runner pools',
  sentence: 'Shows every runner pool with its runners, trust and template.',
  async run(_values, services) {
    const pools = runnersOf(services).registry.listPools();
    if (pools.length === 0) return { text: 'No runner pools yet.', data: { pools } };
    return { text: [`Runner pools (${pools.length})`, ...pools.map((pool) => `  ${pool.id}  ${pool.runnerIds.length} runner(s)  trust ${pool.trustClass}  template ${pool.preferredTemplate ?? '(none)'}`)].join('\n'), data: { pools } };
  },
});

export const REMOTE_POOL = read({
  actionId: 'pool', label: 'See a runner pool', inputs: [POOL],
  sentence: 'Shows {pool}\'s label, trust, template, limit and runners.', example: { pool: 'ci' },
  async run(values, services) {
    const pool = runnersOf(services).registry.getPool(values.pool!);
    if (!pool) throw new CapabilityRefusal(`No runner pool ${values.pool}.`, undefined, 'NOT_FOUND');
    return {
      text: [
        `Runner pool ${pool.id}`,
        `  label: ${pool.label}`,
        `  trust: ${pool.trustClass}`,
        `  usual template: ${pool.preferredTemplate ?? '(none)'}`,
        `  limit: ${pool.maxRunners ?? 'none'}`,
        `  runners: ${pool.runnerIds.join(', ') || '(none)'}`,
        `  description: ${pool.description ?? '(none)'}`,
      ].join('\n'),
      data: { pool },
    };
  },
});

export const REMOTE_CREATE_POOL: Definition = {
  capability: { id: 'remote.create-pool', group: 'work', home: 'daemon', repeat: 'safe' },
  actionId: 'create-pool', label: 'Make a runner pool', word: 'create-pool',
  inputs: [
    { id: 'pool', label: 'Pool id', help: 'A short id you choose', kind: 'text', freeTextReason: 'a new id you choose', required: true, typed: { position: 1 } },
    { id: 'label', label: 'Label', help: 'A name people will read', kind: 'text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'the same as its id' }, typed: { tail: true } },
  ],
  sentence: 'Runner pool {pool} is made, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { pool: 'ci', label: 'CI machines' },
  async run(values, services) {
    const pool = runnersOf(services).registry.createPool({ id: values.pool!, label: values.label || values.pool! });
    return { text: `Made runner pool ${pool.id} (${pool.label}).`, data: { pool } };
  },
};

export const REMOTE_ASSIGN: Definition = {
  capability: { id: 'remote.assign', group: 'work', home: 'daemon', repeat: 'safe' },
  actionId: 'assign', label: 'Put a runner in a pool', word: 'assign', inputs: [POOL, { ...RUNNER, typed: { position: 2 } }],
  sentence: 'Runner {runner} joins pool {pool} until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'unassign', example: { pool: 'ci', runner: 'acp-7f2' },
  async run(values, services) {
    if (!runnersOf(services).registry.assignRunnerToPool(values.pool!, values.runner!)) throw new CapabilityRefusal(`Pool ${values.pool} is full, so ${values.runner} was not put in it.`, 'Take a runner out of the pool first.');
    return { text: `Runner ${values.runner} is in pool ${values.pool}.`, data: { pool: values.pool, runner: values.runner } };
  },
};

export const REMOTE_UNASSIGN: Definition = {
  capability: { id: 'remote.unassign', group: 'work', home: 'daemon', repeat: 'safe' },
  actionId: 'unassign', label: 'Take a runner out of a pool', word: 'unassign',
  inputs: [POOL, { id: 'runner', label: 'Runner', help: 'Runners in this pool', kind: 'choice', choices: { list: REMOTE_POOL_RUNNERS_LIST, dependsOn: 'pool' }, required: true, typed: { position: 2 } }],
  sentence: 'Runner {runner} leaves pool {pool} until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'assign', example: { pool: 'ci', runner: 'acp-7f2' },
  async run(values, services) {
    if (!runnersOf(services).registry.removeRunnerFromPool(values.pool!, values.runner!)) throw new CapabilityRefusal(`No runner pool ${values.pool}.`, undefined, 'NOT_FOUND');
    return { text: `Runner ${values.runner} left pool ${values.pool}.`, data: { pool: values.pool, runner: values.runner } };
  },
};

export const REMOTE_ARTIFACTS = read({
  actionId: 'artifacts', label: 'See what runners handed back',
  sentence: 'Shows the work runners handed back for review, with its state and summary.',
  async run(_values, services) {
    const artifacts = runnersOf(services).registry.listArtifacts();
    if (artifacts.length === 0) return { text: 'Nothing has been handed back yet.', data: { artifacts: [] } };
    return {
      text: [`Handed back (${artifacts.length})`, ...artifacts.slice(0, 12).map((artifact) => `  ${artifact.id}  ${artifact.runnerId}  ${artifact.task.status}  ${artifact.task.summary}`)].join('\n'),
      data: { artifacts: artifacts.map((artifact) => ({ id: artifact.id, runnerId: artifact.runnerId, status: artifact.task.status, summary: artifact.task.summary })) },
    };
  },
});

export const REMOTE_REVIEW = read({
  actionId: 'review', label: 'Review an artifact', inputs: [ARTIFACT],
  sentence: 'Shows what {artifact} holds: the task, its result and the evidence.', example: { artifact: 'art-31c' },
  async run(values, services) {
    const runners = runnersOf(services);
    const summary = runners.registry.buildReviewSummary(values.artifact!);
    if (!summary) throw new CapabilityRefusal(`No artifact ${values.artifact}.`, undefined, 'NOT_FOUND');
    return { text: summary, data: { artifact: runners.registry.getArtifact(values.artifact!) } };
  },
});

export const REMOTE_EXPORT: Definition = {
  capability: { id: 'remote.export', group: 'work', home: 'daemon', repeat: 'unsafe' },
  actionId: 'export', label: 'Save a runner\'s work for review', word: 'export', inputs: [RUNNER, OPTIONAL_PATH('Where to write it')],
  sentence: 'What {runner} did is captured as an artifact and written to a file in this project.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { runner: 'acp-7f2' },
  async run(values, services, caller) {
    const registry = runnersOf(services).registry;
    const artifact = registry.captureArtifactForRunner(values.runner!);
    if (!artifact) throw new CapabilityRefusal(`No runner ${values.runner} to capture.`, undefined, 'NOT_FOUND');
    const exported = await registry.exportArtifact(artifact.id, values.path ? projectPath(caller, values.path) : caller.workingDirectory ? join(caller.workingDirectory, '.goodvibes', 'remote-artifacts', `${artifact.id.replace(/[:]/g, '_')}.json`) : undefined);
    if (!exported) throw new CapabilityRefusal(`Saving runner ${values.runner}'s work failed.`);
    return { text: `Saved artifact ${exported.artifact.id} to ${exported.path}.`, data: { artifact: exported.artifact.id, path: exported.path } };
  },
};

export const REMOTE_ARTIFACT_EXPORT: Definition = {
  capability: { id: 'remote.artifact-export', group: 'work', home: 'daemon', repeat: 'safe' },
  actionId: 'artifact-export', label: 'Save an artifact to a file', word: 'artifact-export', inputs: [ARTIFACT, OPTIONAL_PATH('Where to write it')],
  sentence: '{artifact} is written to a file in this project.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { artifact: 'art-31c' },
  async run(values, services, caller) {
    const id = values.artifact!;
    const exported = await runnersOf(services).registry.exportArtifact(id, values.path ? projectPath(caller, values.path) : caller.workingDirectory ? join(caller.workingDirectory, '.goodvibes', 'remote-artifacts', `${id.replace(/[:]/g, '_')}.json`) : undefined);
    if (!exported) throw new CapabilityRefusal(`No artifact ${id}.`, undefined, 'NOT_FOUND');
    return { text: `Saved artifact ${exported.artifact.id} to ${exported.path}.`, data: { artifact: exported.artifact.id, path: exported.path } };
  },
};

export const REMOTE_RERUN_LOCAL: Definition = {
  capability: { id: 'remote.rerun-local', group: 'work', home: 'daemon', repeat: 'unsafe' },
  actionId: 'rerun-local', label: 'Run an artifact\'s task here', word: 'rerun-local', inputs: [ARTIFACT],
  sentence: 'An agent starts in the daemon on the task {artifact} recorded, with only the tools it recorded (shown beside each artifact); it may come from another machine.',
  done: '', touches: 'this-machine', lasts: 'not-a-change', risk: 'loosens-a-protection',
  ownerOnly: { reason: 'it runs task text and a tool list that may come from another machine', instead: 'Ask the owner to run it from the Work place.' },
  example: { artifact: 'art-31c' },
  async run(values, services) {
    const runners = runnersOf(services);
    const artifact = runners.registry.getArtifact(values.artifact!);
    if (!artifact) throw new CapabilityRefusal(`No artifact ${values.artifact}.`, undefined, 'NOT_FOUND');
    const ceiling = artifact.runnerContract.capabilityCeiling;
    if (ceiling.allowedTools.length === 0) throw new CapabilityRefusal(`Artifact ${artifact.id} recorded no tools, so an agent started from it would have none. Nothing was started.`);
    const started = runners.rerunLocal(artifact);
    return {
      text: [
        `Started agent ${started.agentId} from artifact ${artifact.id}.`,
        `  template: ${started.template}`,
        `  tools (only these): ${ceiling.allowedTools.join(', ')}`,
        `  write scope: ${ceiling.writeScope.join(', ') || '(none)'}`,
        `  task: ${artifact.task.task}`,
      ].join('\n'),
      data: { agentId: started.agentId, artifact: artifact.id },
    };
  },
};

export const REMOTE_IMPORT: Definition = {
  capability: { id: 'remote.import', group: 'work', home: 'daemon', repeat: 'safe' },
  actionId: 'import', label: 'Bring in an artifact from a file', word: 'import', inputs: [PATH('An artifact file saved from the Work place')],
  sentence: 'The artifact in {path} is added for review, replacing a different artifact held with the same id; a file that would replace a known runner\'s tools is refused.',
  done: '', touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { path: 'remote/art-31c.json' },
  async run(values, services, caller) {
    try {
      // Reached only once the person confirmed the replacement the sentence names.
      const artifact = await runnersOf(services).registry.importArtifact(projectPath(caller, values.path!), { replace: true });
      return { text: `Brought in artifact ${artifact.id} from runner ${artifact.runnerId}; it is in the list of what runners handed back.`, data: { artifact: artifact.id } };
    } catch (error) {
      if (error instanceof CapabilityRefusal) throw error;
      throw new CapabilityRefusal(`Not brought in: ${summarizeError(error)}`);
    }
  },
};

export const REMOTE_SETUP = read({
  actionId: 'setup', label: 'See how remote running is set up',
  sentence: 'Shows the agent command a runner starts, whether the daemon and its listener are on, and what to do next.',
  async run(_values, services) {
    const snapshot = runnersOf(services).snapshot();
    return { text: setupLines(services, snapshot.connections.length, snapshot.contracts.length).join('\n') };
  },
});

export const REMOTE_SETUP_EXPORT = exportFile({
  actionId: 'setup-export', label: 'Save the remote setup to a file', help: 'Where to write the setup file',
  sentence: 'The remote setup is written as JSON to {path}.',
  write(path, services) {
    const resolved = agentCommand();
    const setup = services.remote.setup();
    writeProjectFile(path, `${JSON.stringify({ exportedAt: Date.now(), acpAgentCommand: 'command' in resolved ? resolved.command : null, daemonEnabled: setup.daemonEnabled, httpListenerEnabled: setup.httpListenerEnabled, remoteRunnerContracts: runnersOf(services).registry.listContracts().length }, null, 2)}\n`);
    return `Saved the remote setup to ${path}.`;
  },
});

function envSnippet(): string {
  const resolved = agentCommand();
  if ('error' in resolved) throw new CapabilityRefusal(`No agent command is known for a runner: ${resolved.error}`);
  return agentCommandExport(resolved.command);
}

export const REMOTE_ENV = read({
  actionId: 'env', label: 'See the environment a remote agent needs',
  sentence: 'Shows the shell line that tells a remote agent which agent command to run.',
  async run() { return { text: ['Remote environment', envSnippet()].join('\n') }; },
});

export const REMOTE_ENV_EXPORT = exportFile({
  actionId: 'env-export', label: 'Save the remote environment to a file', help: 'Where to write the shell snippet',
  sentence: 'The shell line a remote agent needs is written to {path}.',
  write(path) { writeProjectFile(path, `${envSnippet()}\n`); return `Saved the remote environment to ${path}.`; },
});

export const REMOTE_TUNNEL = read({
  actionId: 'tunnel', label: 'See how to tunnel remote traffic', group: 'devices',
  sentence: 'Shows how a remote agent\'s traffic reaches the daemon through a tunnel you run.',
  async run(_values, services) { return { text: tunnelLines(runnersOf(services).snapshot().connections.length).join('\n') }; },
});

export const REMOTE_TUNNEL_EXPORT = exportFile({
  actionId: 'tunnel-export', label: 'Save the tunnel guidance to a file', help: 'Where to write the guidance', group: 'devices',
  sentence: 'The tunnel guidance is written to {path}.',
  write(path, services) { writeProjectFile(path, `${tunnelLines(runnersOf(services).snapshot().connections.length).join('\n')}\n`); return `Saved the tunnel guidance to ${path}.`; },
});

export const REMOTE_BOOTSTRAP_EXPORT = exportFile({
  actionId: 'bootstrap-export', label: 'Save a start-up bundle for another machine', help: 'Where to write the bundle',
  sentence: 'A bundle with the agent command and environment another machine starts from is written to {path}.',
  write(path) {
    const resolved = agentCommand();
    if ('error' in resolved) throw new CapabilityRefusal(`Start-up bundle not saved: ${resolved.error}`);
    writeProjectFile(path, `${JSON.stringify({ exportedAt: Date.now(), acpAgentCommand: resolved.command, env: { ACP_AGENT_CMD: JSON.stringify(resolved.command) } }, null, 2)}\n`);
    return `Saved the start-up bundle to ${path}.`;
  },
});

export const REMOTE_BOOTSTRAP_INSPECT = read({
  actionId: 'bootstrap-inspect', label: 'Look inside a start-up bundle', inputs: [PATH('A bundle saved from the Work place')],
  sentence: 'Shows the agent command and links in {path}.', example: { path: 'remote/bootstrap.json' },
  async run(values, _services, caller) {
    const path = projectPath(caller, values.path!);
    const parsed = readJson(path, 'a start-up bundle') as { sessionId?: unknown; acpAgentCommand?: unknown; links?: unknown } | null;
    return {
      text: [
        'Start-up bundle',
        ...(typeof parsed?.sessionId === 'string' ? [`  session: ${parsed.sessionId}`] : []),
        `  agent command: ${JSON.stringify(parsed?.acpAgentCommand ?? null)}`,
        `  links: ${Array.isArray(parsed?.links) ? parsed.links.length : 0}`,
      ].join('\n'),
    };
  },
});

export const REMOTE_SESSION_EXPORT: Definition = {
  capability: { id: 'remote.session-export', group: 'work', home: 'daemon', repeat: 'safe' },
  actionId: 'session-export', label: 'Save the runners to a bundle', word: 'session-export', inputs: [PATH('Where to write the bundle')],
  sentence: 'The runner pools, runner contracts and artifacts the daemon holds are written to {path}; no conversation is.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { path: 'remote/session.json' },
  async run(values, services, caller) {
    const path = projectPath(caller, values.path!);
    // The registry frames and writes the bundle (the same file a session import reads).
    const exported = await runnersOf(services).registry.exportSessionBundle(undefined, path);
    return {
      text: `Saved a runner bundle to ${exported.path}: ${exported.bundle.pools.length} pool(s), ${exported.bundle.contracts.length} runner contract(s) and ${exported.bundle.artifacts.length} artifact(s). It holds no conversation.`,
      data: { path: exported.path },
    };
  },
};

export const REMOTE_SESSION_INSPECT = read({
  actionId: 'session-inspect', label: 'Look inside a runner bundle', inputs: [PATH('A runner bundle saved from the Work place')],
  sentence: 'Shows what {path} holds and what bringing it in would replace; nothing is changed.', example: { path: 'remote/session.json' },
  async run(values, services, caller) {
    const path = projectPath(caller, values.path!);
    const described = runnersOf(services).registry.describeSessionBundleImport(readJson(path, 'a runner bundle'));
    if (!described.ok) throw new CapabilityRefusal(`Cannot use ${path} as a runner bundle: ${described.problem}. Nothing was changed.`);
    return { text: bundleWords(described.bundle, described.replaces), data: { replaces: described.replaces } };
  },
});

export const REMOTE_SESSION_IMPORT: Definition = {
  capability: { id: 'remote.session-import', group: 'work', home: 'daemon', repeat: 'safe' },
  actionId: 'session-import', label: 'Bring in a runner bundle', word: 'session-import', inputs: [PATH('A runner bundle saved from the Work place')],
  sentence: 'The runner pools, contracts and artifacts in {path} are brought in, replacing any held with the same ids.',
  done: '', touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { path: 'remote/session.json' },
  async run(values, services, caller) {
    const path = projectPath(caller, values.path!);
    if (!existsSync(path)) throw new CapabilityRefusal(`There is no file ${path}. Nothing was changed.`, undefined, 'NOT_FOUND');
    try {
      const bundle = await runnersOf(services).registry.importSessionBundle(path, { replace: true });
      return { text: `Brought in the runner bundle: ${bundle.pools.length} pool(s), ${bundle.contracts.length} runner contract(s), ${bundle.artifacts.length} artifact(s).` };
    } catch (error) {
      throw new CapabilityRefusal(summarizeError(error));
    }
  },
};

/** Every remote capability, in the order their command listed them. */
export const REMOTE_CAPABILITIES_ALL: readonly Definition[] = [
  REMOTE_LIST, REMOTE_SHOW, REMOTE_CONTRACT, REMOTE_SUPERVISOR, REMOTE_CAPABILITIES, REMOTE_RECOVER, REMOTE_STOP,
  REMOTE_DISPATCH, REMOTE_DISPATCH_POOL, REMOTE_POOLS, REMOTE_POOL, REMOTE_CREATE_POOL, REMOTE_ASSIGN, REMOTE_UNASSIGN,
  REMOTE_ARTIFACTS, REMOTE_REVIEW, REMOTE_EXPORT, REMOTE_ARTIFACT_EXPORT, REMOTE_RERUN_LOCAL, REMOTE_IMPORT,
  REMOTE_SETUP, REMOTE_SETUP_EXPORT, REMOTE_ENV, REMOTE_ENV_EXPORT, REMOTE_TUNNEL, REMOTE_TUNNEL_EXPORT,
  REMOTE_BOOTSTRAP_EXPORT, REMOTE_BOOTSTRAP_INSPECT, REMOTE_SESSION_EXPORT, REMOTE_SESSION_INSPECT, REMOTE_SESSION_IMPORT,
];
