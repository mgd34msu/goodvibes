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
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { callerPathOf, fileWorkRefusal, readCallerJson, unreadableFile } from '../path-inputs.js';
import { getDefaultAcpAgentCommand } from '../../acp/manager.js';
import { AGENT_TEMPLATES } from '../../tools/agent/manager.js';
import type { DaemonRemoteRunners } from '../../runtime/remote/daemon-runners.js';
import type { RemoteRunnerContract, RemoteSessionBundle } from '../../runtime/remote/types.js';
import { summarizeError } from '../../utils/error-display.js';
import { currentRecordReach } from '@goodvibes/engine/daemon-api';
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
const SUPERVISED_RUNNER: InputDescription = { id: 'runner', label: 'Runner', help: 'Runners connected now', kind: 'choice', choices: { list: REMOTE_SUPERVISED_LIST }, required: { default: '', defaultMeans: 'the first one' }, typed: { position: 1 } };
const CONNECTION: InputDescription = { id: 'connection', label: 'Connection', help: 'Runner connections open now', kind: 'choice', choices: { list: REMOTE_CONNECTIONS_LIST }, required: true, typed: { position: 1 } };
const POOL: InputDescription = { id: 'pool', label: 'Pool', help: 'Your runner pools', kind: 'choice', choices: { list: REMOTE_POOLS_LIST }, required: true, typed: { position: 1 } };
const ARTIFACT: InputDescription = { id: 'artifact', label: 'Handed back', help: 'Work runners handed back for review', kind: 'choice', choices: { list: REMOTE_ARTIFACTS_LIST }, required: true, typed: { position: 1 } };
// Read, unless a capability marks it written: bringing a file in or looking inside one puts nothing on disk there.
const PATH = (help: string): InputDescription => ({ id: 'path', label: 'File', help, kind: 'path', file: 'read', freeTextReason: 'a file path in this project', required: true, typed: { position: 1 } });
const OPTIONAL_PATH = (help: string): InputDescription => ({ id: 'path', label: 'File', help, kind: 'path', file: 'written', freeTextReason: 'a file path in this project', required: { default: '', defaultMeans: 'the usual place in this project' }, typed: { flag: '--to' } });
const TASK: InputDescription = { id: 'task', label: 'Task', help: 'What the runner should do, in your own words', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } };
const TEMPLATE_CHOICES: readonly FixedChoice[] = Object.keys(AGENT_TEMPLATES).map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }));
const TEMPLATE = (means: string): InputDescription => ({ id: 'template', label: 'Kind of agent', help: 'Which agent template it follows', kind: 'choice', choices: TEMPLATE_CHOICES, required: { default: '', defaultMeans: means }, typed: { flag: '--template' } });
const DISPATCH_OWNER = { reason: 'it starts a runner with this machine\'s tools from your own words', instead: 'Ask the owner to start it from the Work place.' } as const;

function runnersOf(services: RemoteCapabilityServices): DaemonRemoteRunners {
  return services.remote.runners();
}

/**
 * Whether the asking caller may reach this runner (its contract) or this result: the one reach rule
 * (control-plane/caller-reach.ts `remote-runner`, `remote-artifact`: the project of the work that made them). The owner
 * reaches every one; a runner or result named by id is checked before the run (record-addresses.ts), and these keep a
 * list or a default pick to what the caller may reach.
 */
function reachesRunner(runnerId: string | undefined): boolean {
  const reach = currentRecordReach();
  return !reach || (typeof runnerId === 'string' && reach('remote-runner', runnerId));
}
function reachesArtifact(artifactId: string): boolean {
  const reach = currentRecordReach();
  return !reach || reach('remote-artifact', artifactId);
}
/** A pool as the caller may read it: the daemon's pool, naming only the runners it may reach. */
function poolAsReached<T extends { readonly runnerIds: readonly string[] }>(pool: T): T {
  return currentRecordReach() ? { ...pool, runnerIds: pool.runnerIds.filter((id) => reachesRunner(id)) } : pool;
}

/** A file in the asking program's project, placed by capabilities/path-inputs.ts `callerPathOf`. */
function projectPath(caller: CapabilityCaller, path: string): string {
  return callerPathOf(caller, path);
}

function writeProjectFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { encoding: 'utf-8', mode: 0o600 });
}

/** A JSON file named by path; never the system's or the parser's words (capabilities/path-inputs.ts). */
function readJson(path: string, what: string, caller: CapabilityCaller): unknown {
  return readCallerJson(path, what, caller);
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
  if (tools.length === 0) return 'any (no limit is set)';
  return `${tools.join(', ')} (${contract.trustClass === 'self-hosted-acp' ? 'anything else it asks to do is refused' : 'it is given only these'})`;
}

export function runnerWriteScopeText(contract: Pick<RemoteRunnerContract, 'trustClass' | 'capabilityCeiling'>): string {
  const scope = contract.capabilityCeiling.writeScope;
  if (scope.length === 0) return 'its folder, under the permission rules';
  return `${scope.join(', ')} (${contract.trustClass === 'self-hosted-acp' ? 'an edit elsewhere, or a command, is refused when it asks' : 'its work is accepted only there'})`;
}

/** Whether a runner's work is checked before the owner reviews it, in words. */
export function runnerReviewText(contract: Pick<RemoteRunnerContract, 'trustClass' | 'capabilityCeiling'>): string {
  const mode = contract.capabilityCeiling.reviewMode;
  if (mode === 'contract') return contract.trustClass === 'self-hosted-acp' ? 'not here: it runs on its own, so review what it hands back' : 'against what it was asked to do';
  return 'no: review what it hands back';
}

/** How a runner goes about its task, in words. */
const PROTOCOL_WORDS: Readonly<Record<RemoteRunnerContract['capabilityCeiling']['executionProtocol'], string>> = {
  direct: 'it does the task straight away',
  'gather-plan-apply': 'it looks first, makes a plan, then makes its changes',
};
/** Whom a runner talks to, in words. */
const LANE_WORDS: Readonly<Record<RemoteRunnerContract['capabilityCeiling']['communicationLane'], string>> = {
  direct: 'the daemon only', 'parent-only': 'only whoever started it', 'parent-and-children': 'whoever started it and the agents it starts', cohort: 'the other agents of its group',
};
/** How far a runner is trusted, in words. */
const TRUST_WORDS: Readonly<Record<string, string>> = {
  'self-hosted-acp': 'a runner this daemon starts on this machine', 'local-daemon': 'an agent inside the daemon',
};
/** What a pool holds, in words (the Work place's own words for a pool's trust). */
const POOL_TRUST_WORDS: Readonly<Record<string, string>> = {
  'self-hosted-acp': 'runners this daemon starts on this machine', 'local-daemon': 'agents inside the daemon', mixed: 'runners of either kind',
};
/** A runner's last error as a person reads it: the protocol library's own words for a closed connection are said plainly. */
function runnerErrorWords(error: string): string {
  return /^ACP connection closed/i.test(error) ? 'its agent went away without finishing' : error;
}
/** How a runner's task ended, as Handed back says it. */
const ARTIFACT_STATUS_WORDS: Readonly<Record<string, string>> = {
  completed: 'finished', failed: 'failed', cancelled: 'stopped', running: 'still running when saved', pending: 'not started when saved', unknown: 'not known',
};
/** What a runner can do, each named in words. */
const ABILITY_WORDS: Readonly<Record<string, string>> = {
  files: 'work with files', commands: 'run commands', approvals: 'ask you', artifacts: 'hand its work back', resume: 'go on after a stop', containment: 'be kept apart from this machine',
};

type Supervisor = ReturnType<DaemonRemoteRunners['snapshot']>['supervisor'];
type SupervisorSession = Supervisor['sessions'][number];

function sessionFor(runners: DaemonRemoteRunners, runnerId: string, pick: (sessions: readonly SupervisorSession[]) => SupervisorSession | undefined = (sessions) => sessions[0]): SupervisorSession {
  const supervisor = runners.snapshot().supervisor;
  // Only the runners the caller may reach, named or picked (one named was checked before the run).
  const sessions = supervisor.sessions.filter((entry) => reachesRunner(entry.runnerId));
  const selected = runnerId ? sessions.find((entry) => entry.runnerId === runnerId) : pick(sessions);
  if (selected) return selected;
  const local = runnerId ? supervisor.localRunners.find((entry) => entry.runnerId === runnerId && reachesRunner(entry.runnerId)) : undefined;
  if (local) throw new CapabilityRefusal(`That runner (${local.template}) runs inside the daemon, so it has no connection to look at.`, 'What it is held to shows what it may do.');
  throw new CapabilityRefusal(runnerId ? 'That runner is not connected now.' : 'No runner is connected now.', undefined, 'NOT_FOUND');
}

/** "1 pool", "2 pools", "no pools". */
const counted = (count: number, one: string, many = `${one}s`): string => count === 0 ? `no ${many}` : `${count} ${count === 1 ? one : many}`;
/** What a runner bundle holds, in words. */
const bundleWords = (bundle: { readonly pools: readonly unknown[]; readonly contracts: readonly unknown[]; readonly artifacts: readonly unknown[] }): string =>
  `${counted(bundle.pools.length, 'pool')}, ${counted(bundle.contracts.length, 'runner')} and ${bundle.artifacts.length === 0 ? 'nothing handed back' : counted(bundle.artifacts.length, 'thing handed back', 'things handed back')}`;

/** A runner's connection state in words. */
const CONNECTION_WORDS: Readonly<Record<string, string>> = {
  initializing: 'starting', authenticating: 'starting', connected: 'connected', syncing: 'working', degraded: 'struggling',
  reconnecting: 'reconnecting', disconnected: 'closed', terminal_failure: 'lost for good',
};

function reviewModeText(selected: SupervisorSession): string {
  return runnerReviewText({ trustClass: selected.negotiation.trustClass, capabilityCeiling: { reviewMode: selected.negotiation.reviewMode } as RemoteRunnerContract['capabilityCeiling'] });
}

/** What a supervised runner can do and cannot, one line each, in words. */
function abilityLines(selected: SupervisorSession, indent: string): string[] {
  return selected.capabilities.map((capability) => `${indent}${capability.supported ? 'can' : 'cannot'} ${ABILITY_WORDS[capability.id] ?? capability.id}: ${capability.detail}`);
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
    actionId: fields.actionId, label: fields.label, word: fields.actionId, inputs: [{ ...PATH(fields.help), file: 'written' }],
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
    'How remote runners are set up',
    `  the program a runner starts: ${'command' in resolved ? resolved.command.join(' ') : `none (${resolved.error})`}`,
    `  daemon on: ${setup.daemonEnabled ? 'yes' : 'no'}`,
    `  receiving from other machines ("Receive webhooks" in Settings): ${setup.httpListenerEnabled ? 'on' : 'off'}`,
    `  runners: ${contracts}, ${connections} connected now`,
    '',
    '  What to do next:',
    '    - to start a different agent as a runner, set ACP_AGENT_CMD in the shell that starts the daemon (the program, then its arguments, as a JSON list); "environment" shows the line',
    '    - turn on "Receive webhooks" in Settings only when another machine must reach the daemon',
  ];
}

function tunnelLines(connections: number): string[] {
  return [
    'How a runner on another machine reaches this daemon',
    `  runners connected now: ${connections}`,
    '  run a tunnel of your own, or an SSH connection, from that machine to this one, and start the runner\'s agent through it; the daemon starts nothing on another machine itself',
  ];
}

/** A runner's name (its contract's label, which is its task), else its id. */
function runnerName(registry: DaemonRemoteRunners['registry'], runnerId: string): string {
  return registry.getContract(runnerId)?.label ?? runnerId;
}

function bundleInspectWords(bundle: RemoteSessionBundle, replaces: readonly string[]): string {
  const saved = typeof bundle.exportedAt === 'number' && Number.isFinite(bundle.exportedAt) ? `saved ${new Date(bundle.exportedAt).toLocaleString()}` : 'saved at a time it does not say';
  // Open connections are not counted: the daemon saves a bundle with no conversation store, so it never records them.
  return [
    `This runner bundle, ${saved}, holds ${bundleWords(bundle)}, and no conversation.`,
    replaces.length > 0 ? `Bringing it in replaces ${replaces.join(', ')}.` : 'Bringing it in replaces nothing held now.',
  ].join('\n');
}

export const REMOTE_LIST = read({
  actionId: 'list', label: 'See remote runners at a glance',
  sentence: 'Shows the runners the daemon holds: connections, runner contracts, pools, artifacts and supervised runners.',
  async run(_values, services) {
    const runners = runnersOf(services);
    const snapshot = runners.snapshot();
    // Only the runners and results the caller may reach (the project of the work that made them); the pools are the
    // daemon's, naming only those runners.
    const supervisor = { ...snapshot.supervisor,
      sessions: snapshot.supervisor.sessions.filter((session) => reachesRunner(session.runnerId)),
      localRunners: snapshot.supervisor.localRunners.filter((runner) => reachesRunner(runner.runnerId)) };
    const contracts = snapshot.contracts.filter((contract) => reachesRunner(contract.runnerId));
    const pools = snapshot.pools.map(poolAsReached);
    const artifacts = snapshot.artifacts.filter((artifact) => reachesArtifact(artifact.id));
    const connections = snapshot.connections.filter((connection) => reachesRunner(connection.agentId));
    const lines = [
      'Remote runners',
      ...(runners.unreadable ? [`  The runners kept before could not be read: ${runners.unreadable}.`] : []),
      `  runners: ${contracts.length}, ${connections.length} connected now${supervisor.degradedConnections > 0 ? `, ${supervisor.degradedConnections} struggling` : ''}`,
      `  runner pools: ${pools.length}`,
      `  handed back: ${artifacts.length}`,
      ...(supervisor.localRunners.length > 0 ? [`  agents running inside the daemon: ${supervisor.localRunners.length}`] : []),
    ];
    // Each runner by its task, as its row is; ids are in the data.
    for (const contract of contracts.slice(0, 12)) lines.push(`    "${contract.label}"  ${contract.template}  ${contract.transport ? CONNECTION_WORDS[contract.transport.state] ?? contract.transport.state : 'inside the daemon'}`);
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
  sentence: 'Shows {connection}\'s connection: its state, errors, pool and tools.', example: { connection: 'acp-7f2' },
  async run(values, services) {
    const runners = runnersOf(services);
    const connections = runners.snapshot().connections.filter((entry) => reachesRunner(entry.agentId));
    const connection = values.connection ? connections.find((entry) => entry.agentId === values.connection) : connections[0];
    if (!connection) throw new CapabilityRefusal(values.connection ? `No remote connection ${values.connection}.` : 'No runner is connected now.', undefined, 'NOT_FOUND');
    const contract = runners.registry.readContractForAgent(connection.agentId);
    // Named by its task, as its row is; the connection's id is in the data.
    const name = contract?.label || (connection.label && connection.label !== connection.agentId ? connection.label : '');
    return {
      text: [
        name ? `The connection to the runner on "${name}"` : 'The connection to a runner with no task named',
        `  state: ${CONNECTION_WORDS[connection.transportState] ?? connection.transportState}`,
        `  connected: ${connection.connectedAt ? new Date(connection.connectedAt).toLocaleString() : 'not yet'}`,
        `  errors: ${connection.errorCount === 0 ? 'none' : connection.errorCount}`,
        ...(connection.lastError ? [`  last error: ${runnerErrorWords(connection.lastError)}`] : []),
        ...(contract?.taskId ? ['  it is working on a task listed in Tasks here or Daemon tasks'] : []),
        `  pool: ${contract?.poolId ? runners.registry.getPool(contract.poolId)?.label ?? contract.poolId : 'none'}`,
        ...(contract ? [
          `  how it works: ${PROTOCOL_WORDS[contract.capabilityCeiling.executionProtocol] ?? contract.capabilityCeiling.executionProtocol}`,
          `  its work checked: ${runnerReviewText(contract)}`,
          `  tools: ${runnerToolsText(contract)}`,
        ] : ['  what it may do: not known (the daemon holds nothing on it)']),
      ].join('\n'),
      data: { connection, ...(contract ? { contract } : {}) },
    };
  },
});

export const REMOTE_CONTRACT = read({
  actionId: 'contract', label: 'See what a runner is held to', inputs: [RUNNER],
  sentence: 'Shows what {runner} is held to: its kind of agent, its tools, where it may write and whether its work is checked.', example: { runner: 'acp-7f2' },
  async run(values, services) {
    const registry = runnersOf(services).registry;
    const contract = registry.readContractForAgent(values.runner!);
    if (!contract) throw new CapabilityRefusal(`No remote runner ${values.runner}.`, undefined, 'NOT_FOUND');
    return {
      text: [
        `The runner on "${contract.label}": what it is held to`,
        `  pool: ${contract.poolId ? registry.getPool(contract.poolId)?.label ?? contract.poolId : 'none'}`,
        `  what it is: ${TRUST_WORDS[contract.trustClass] ?? contract.trustClass}`,
        `  kind of agent: ${contract.template}`,
        `  connection: ${contract.transport ? CONNECTION_WORDS[contract.transport.state] ?? contract.transport.state : 'none (it runs inside the daemon)'}`,
        `  tools: ${runnerToolsText(contract)}`,
        `  how it works: ${PROTOCOL_WORDS[contract.capabilityCeiling.executionProtocol] ?? contract.capabilityCeiling.executionProtocol}`,
        `  its work checked: ${runnerReviewText(contract)}`,
        `  talks to: ${LANE_WORDS[contract.capabilityCeiling.communicationLane] ?? contract.capabilityCeiling.communicationLane}`,
        `  may write: ${runnerWriteScopeText(contract)}`,
      ].join('\n'),
      data: { contract },
    };
  },
});

export const REMOTE_SUPERVISOR = read({
  actionId: 'supervisor', label: 'See how a runner is doing', inputs: [SUPERVISED_RUNNER],
  sentence: 'Shows how {runner} is doing: its connection, whether it is in contact, what it can do and how to put it right.', example: { runner: 'acp-7f2' },
  async run(values, services) {
    const selected = sessionFor(runnersOf(services), values.runner ?? '');
    // Opening the runners in the Work place is where this is read, so only the steps beyond it are shown.
    const recovery = selected.recovery.filter((action) => action.id !== 'remote-panel');
    return {
      // Named by its task, as its row is; its id is in the data.
      text: [
        `How the runner on "${selected.label}" is doing`,
        `  connection: ${CONNECTION_WORDS[selected.transportState] ?? selected.transportState}`,
        `  in contact: ${selected.heartbeat.status === 'fresh' ? 'yes' : selected.heartbeat.status === 'stale' ? 'lost for now' : 'no'} (${selected.heartbeat.detail})`,
        `  how it works: ${PROTOCOL_WORDS[selected.negotiation.executionProtocol] ?? selected.negotiation.executionProtocol}`,
        `  its work checked: ${reviewModeText(selected)}`,
        `  talks to: ${LANE_WORDS[selected.negotiation.communicationLane] ?? selected.negotiation.communicationLane}`,
        `  what it is: ${TRUST_WORDS[selected.negotiation.trustClass] ?? selected.negotiation.trustClass}`,
        ...(selected.taskId ? ['  it is working on a task listed in Tasks here or Daemon tasks'] : []),
        `  errors: ${selected.errorCount === 0 ? 'none' : selected.errorCount}`,
        ...(selected.lastError ? [`  last error: ${runnerErrorWords(selected.lastError)}`] : []),
        '  what it can do:',
        ...abilityLines(selected, '    '),
        ...(recovery.length > 0 ? ['  to put it right:', ...recovery.map((action) => `    ${action.label}: ${action.reason}`)] : []),
      ].join('\n'),
      data: { session: selected },
    };
  },
});

export const REMOTE_CAPABILITIES = read({
  actionId: 'capabilities', label: 'See what a runner can do', inputs: [SUPERVISED_RUNNER],
  sentence: 'Shows what {runner} can do and what it cannot.', example: { runner: 'acp-7f2' },
  async run(values, services) {
    const selected = sessionFor(runnersOf(services), values.runner ?? '');
    return {
      text: [
        `What the runner on "${selected.label}" can do`,
        ...abilityLines(selected, '  '),
        `  how it works: ${PROTOCOL_WORDS[selected.negotiation.executionProtocol] ?? selected.negotiation.executionProtocol}`,
        `  its work checked: ${reviewModeText(selected)}`,
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
    const recovery = selected.recovery.filter((action) => action.id !== 'remote-panel');
    const steps = recovery.length > 0 ? recovery.map((action) => `${action.label}: ${action.reason}`) : ['Look at the connection first: nothing says it needs recovering.'];
    return {
      text: [
        // Named as its row is, by its task; the id is in the data. The first line is the answer (a place shows it alone).
        recovery[0]
          ? `The runner on "${selected.label}": ${recovery[0].label.charAt(0).toLowerCase()}${recovery[0].label.slice(1)}; ${recovery[0].reason}.`
          : `The runner on "${selected.label}": ${steps[0]}`,
        `  connection: ${CONNECTION_WORDS[selected.transportState] ?? selected.transportState}`,
        `  contact: ${selected.heartbeat.detail}`,
        ...(selected.lastError ? [`  last error: ${runnerErrorWords(selected.lastError)}`] : []),
        '  to put it right:',
        ...steps.map((step) => `    ${step}`),
      ].join('\n'),
      data: { runnerId: selected.runnerId, steps },
    };
  },
});

export const REMOTE_STOP: Definition = {
  capability: { id: 'remote.stop', group: 'work', home: 'daemon', repeat: 'safe' },
  actionId: 'stop', label: 'Stop a remote runner', word: 'stop', inputs: [CONNECTION],
  sentence: 'Runner {connection} is stopped; what it was doing is not finished.', done: '',
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
    return { text: `Stopped runner "${runnerName(runnersOf(services).registry, runnerId)}".`, data: { runnerId } };
  },
};

/** What a caller that names no project is told, before anything is asked (capabilities.run reads `callerNeeds`). */
const RUNNER_PROJECT_NEEDED = 'No project folder came with the request, so the runner has nowhere to work. Nothing was started. Send workingDirectory, the project folder, with the request.';

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
    // Who caused this run (routes/capabilities.ts `causeOfRun`) is the runner's party: started by anyone but the owner,
    // its asks are decided as someone else's input. Unrecorded (no daemon dispatch) is someone else's.
    started = await runners.dispatch({ task, template: template || pool?.preferredTemplate || 'general', pool, workingDirectory: caller.workingDirectory,
      inputParty: caller.cause ?? { party: 'other', who: 'a caller the daemon did not name' } });
  } catch (error) {
    throw new CapabilityRefusal(`No runner was started: ${summarizeError(error)}`);
  }
  return {
    text: [
      // Named by its task, as its row is; the id is in the data and in the row's detail.
      !pool ? `Started a runner on "${task}"; it is in Runners, in the Work place.` : started.inPool ? `Started a runner on "${task}" in pool ${pool.label}; it is in Runners, in the Work place.`
        : `Started a runner on "${task}"; pool ${pool.label} filled up meanwhile, so the runner is not in it (stop it if it should not run outside the pool).`,
      `  kind of agent: ${started.template}`,
      `  tools: ${started.tools.join(', ')} (anything else it asks to do is refused)`,
      `  folder: ${caller.workingDirectory}`,
    ].join('\n'),
    data: { runnerId: started.runnerId, template: started.template, ...(pool ? { pool: pool.id, inPool: started.inPool } : {}) },
  };
}

export const REMOTE_DISPATCH: Definition = {
  capability: { id: 'remote.dispatch', group: 'work', home: 'daemon', repeat: 'unsafe' },
  actionId: 'dispatch', label: 'Start a remote runner on a task', word: 'dispatch', inputs: [TASK, TEMPLATE('a general agent')],
  // It makes a runner, the Runners tab's kind of thing, which is kept (an empty tab names this action first).
  sentence: 'A self-hosted runner starts on "{task}" now in this project, with only the tools its kind of agent has; it runs in the daemon until it finishes or you stop it, and stays in Runners, with its pool, until you change it.',
  done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'stop', ownerOnly: DISPATCH_OWNER,
  example: { task: 'run the test suite and report failures', template: 'tester' },
  callerNeeds: { project: RUNNER_PROJECT_NEEDED },
  async run(values, services, caller) { return dispatch(services, caller, values.task!, values.template ?? '', undefined); },
};

export const REMOTE_DISPATCH_POOL: Definition = {
  capability: { id: 'remote.dispatch-pool', group: 'work', home: 'daemon', repeat: 'unsafe' },
  actionId: 'dispatch-pool', label: 'Start a runner from a pool on a task', word: 'dispatch-pool', inputs: [POOL, { ...TASK }, TEMPLATE('the pool\'s usual agent')],
  sentence: 'A runner from pool {pool} starts on "{task}" now in this project, with only the tools its kind of agent has; it runs in the daemon until it finishes or you stop it, and stays in Runners, with its pool, until you change it.',
  done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'stop', ownerOnly: DISPATCH_OWNER,
  example: { pool: 'ci', task: 'run the test suite and report failures' },
  callerNeeds: { project: RUNNER_PROJECT_NEEDED },
  async run(values, services, caller) { return dispatch(services, caller, values.task!, values.template ?? '', values.pool!); },
};

export const REMOTE_POOLS = read({
  actionId: 'pools', label: 'See runner pools',
  sentence: 'Shows every runner pool with its runners, trust and template.',
  async run(_values, services) {
    const pools = runnersOf(services).registry.listPools().map(poolAsReached);
    if (pools.length === 0) return { text: 'No runner pools yet.', data: { pools } };
    return { text: [`Runner pools (${pools.length})`, ...pools.map((pool) => `  "${pool.label || pool.id}": ${counted(pool.runnerIds.length, 'runner')}; holds ${POOL_TRUST_WORDS[pool.trustClass] ?? pool.trustClass}; usual agent ${pool.preferredTemplate ?? 'general'}`)].join('\n'), data: { pools } };
  },
});

export const REMOTE_POOL = read({
  actionId: 'pool', label: 'See a runner pool', inputs: [POOL],
  sentence: 'Shows {pool}\'s trust, usual agent, limit and runners.', example: { pool: 'ci' },
  async run(values, services) {
    const registry = runnersOf(services).registry;
    const held = registry.getPool(values.pool!);
    const pool = held ? poolAsReached(held) : held;
    if (!pool) throw new CapabilityRefusal(`No runner pool ${values.pool}.`, undefined, 'NOT_FOUND');
    return {
      text: [
        `Runner pool "${pool.label || pool.id}"`,
        `  holds: ${POOL_TRUST_WORDS[pool.trustClass] ?? pool.trustClass}`,
        `  usual agent: ${pool.preferredTemplate ?? 'general (none chosen)'}`,
        `  limit: ${pool.maxRunners ?? 'none'}`,
        // Each runner by its task, as its row is.
        `  runners: ${pool.runnerIds.map((runnerId) => `"${runnerName(registry, runnerId)}"`).join(', ') || 'none yet'}`,
        ...(pool.description ? [`  description: ${pool.description}`] : []),
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
    // Named as its row is; its id is in the data.
    return { text: `Made the runner pool "${pool.label || pool.id}"; it is in Runner pools, in the Work place.`, data: { pool } };
  },
};

export const REMOTE_ASSIGN: Definition = {
  capability: { id: 'remote.assign', group: 'work', home: 'daemon', repeat: 'safe' },
  actionId: 'assign', label: 'Put a runner in a pool', word: 'assign', inputs: [POOL, { ...RUNNER, typed: { position: 2 } }],
  sentence: 'Runner {runner} joins pool {pool} until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'unassign', example: { pool: 'ci', runner: 'acp-7f2' },
  async run(values, services) {
    const registry = runnersOf(services).registry;
    if (!registry.assignRunnerToPool(values.pool!, values.runner!)) throw new CapabilityRefusal(`Pool ${values.pool} is full, so ${values.runner} was not put in it.`, 'Take a runner out of the pool first.');
    return { text: `Runner "${runnerName(registry, values.runner!)}" is in pool "${registry.getPool(values.pool!)?.label ?? values.pool}".`, data: { pool: values.pool, runner: values.runner } };
  },
};

export const REMOTE_UNASSIGN: Definition = {
  capability: { id: 'remote.unassign', group: 'work', home: 'daemon', repeat: 'safe' },
  actionId: 'unassign', label: 'Take a runner out of a pool', word: 'unassign',
  inputs: [POOL, { id: 'runner', label: 'Runner', help: 'Runners in this pool', kind: 'choice', choices: { list: REMOTE_POOL_RUNNERS_LIST, dependsOn: 'pool' }, required: true, typed: { position: 2 } }],
  sentence: 'Runner {runner} leaves pool {pool} until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'assign', example: { pool: 'ci', runner: 'acp-7f2' },
  async run(values, services) {
    const registry = runnersOf(services).registry;
    if (!registry.removeRunnerFromPool(values.pool!, values.runner!)) throw new CapabilityRefusal(`No runner pool ${values.pool}.`, undefined, 'NOT_FOUND');
    return { text: `Runner "${runnerName(registry, values.runner!)}" left pool "${registry.getPool(values.pool!)?.label ?? values.pool}".`, data: { pool: values.pool, runner: values.runner } };
  },
};

export const REMOTE_ARTIFACTS = read({
  actionId: 'artifacts', label: 'See what runners handed back',
  sentence: 'Shows the work runners handed back for review, with its state and summary.',
  async run(_values, services) {
    const artifacts = runnersOf(services).registry.listArtifacts().filter((artifact) => reachesArtifact(artifact.id));
    if (artifacts.length === 0) return { text: 'Nothing has been handed back yet.', data: { artifacts: [] } };
    // Each by its task, as its row is; ids are in the data.
    return {
      text: [`Handed back (${artifacts.length})`, ...artifacts.slice(0, 12).map((artifact) => `  "${artifact.task.task || artifact.runnerContract.label}": ${ARTIFACT_STATUS_WORDS[artifact.task.status] ?? artifact.task.status}${artifact.task.summary ? `; ${artifact.task.summary}` : ''}`)].join('\n'),
      data: { artifacts: artifacts.map((artifact) => ({ id: artifact.id, runnerId: artifact.runnerId, status: artifact.task.status, summary: artifact.task.summary })) },
    };
  },
});

/** The file a runner's handed-back work is saved to when none is named: its task and when it was saved, never its id. */
function handedBackFile(artifact: { readonly id: string; readonly createdAt?: number | undefined; readonly task: { readonly task: string } }): string {
  const slug = artifact.task.task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'runner-work';
  const at = typeof artifact.createdAt === 'number' && Number.isFinite(artifact.createdAt) ? new Date(artifact.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '-') : artifact.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(-12);
  return join('.goodvibes', 'remote-artifacts', `${slug}-${at}.json`);
}

export const REMOTE_REVIEW = read({
  actionId: 'review', label: 'Review what a runner handed back', inputs: [ARTIFACT],
  sentence: 'Shows what {artifact} holds: the task, how it ended and what the runner did.', example: { artifact: 'art-31c' },
  async run(values, services) {
    const runners = runnersOf(services);
    const artifact = runners.registry.getArtifact(values.artifact!);
    if (!artifact) throw new CapabilityRefusal('Nothing handed back is held under that name.', undefined, 'NOT_FOUND');
    const { toolCallCount, errorCount } = artifact.evidence;
    // The artifact's id joins its runner, task and time: the words name each instead.
    return {
      text: [
        `What the runner on "${artifact.runnerContract.label}" handed back`,
        `  task: ${artifact.task.task || 'not said'}`,
        `  how it ended: ${ARTIFACT_STATUS_WORDS[artifact.task.status] ?? artifact.task.status}`,
        `  what it said: ${artifact.task.summary || 'nothing'}`,
        ...(artifact.task.error ? [`  what went wrong: ${artifact.task.error}`] : []),
        `  kind of agent: ${artifact.runnerContract.template}`,
        `  tools it had: ${artifact.runnerContract.capabilityCeiling.allowedTools.join(', ') || 'none'}`,
        `  what it did: ${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'}, ${errorCount} error${errorCount === 1 ? '' : 's'}`,
        ...(artifact.knowledgeInjections.length > 0 ? [`  notes it was given: ${artifact.knowledgeInjections.length}`] : []),
      ].join('\n'),
      data: { artifact },
    };
  },
});

export const REMOTE_EXPORT: Definition = {
  capability: { id: 'remote.export', group: 'work', home: 'daemon', repeat: 'unsafe' },
  actionId: 'export', label: 'Save a runner\'s work for review', word: 'export', inputs: [RUNNER, OPTIONAL_PATH('Where to write it')],
  sentence: 'What {runner} did is kept in Handed back for review and written to a file in this project.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { runner: 'acp-7f2' },
  async run(values, services, caller) {
    const registry = runnersOf(services).registry;
    const artifact = registry.captureArtifactForRunner(values.runner!);
    if (!artifact) throw new CapabilityRefusal('That runner is not held here, so nothing was saved.', undefined, 'NOT_FOUND');
    // With no file named, the project's own `.goodvibes/remote-artifacts/`, placed and held as a named file is: never the
    // daemon's own folder, refused with no project.
    const exported = await registry.exportArtifact(artifact.id, projectPath(caller, values.path || handedBackFile(artifact)));
    if (!exported) throw new CapabilityRefusal(`Saving what the runner on "${runnerName(registry, values.runner!)}" did failed.`);
    return { text: `Saved what the runner did to ${exported.path}; it is in Handed back, in the Work place.`, data: { artifact: exported.artifact.id, path: exported.path } };
  },
};

export const REMOTE_ARTIFACT_EXPORT: Definition = {
  capability: { id: 'remote.artifact-export', group: 'work', home: 'daemon', repeat: 'safe' },
  actionId: 'artifact-export', label: 'Save what a runner handed back to a file', word: 'artifact-export', inputs: [ARTIFACT, OPTIONAL_PATH('Where to write it')],
  sentence: '{artifact} is written to a file in this project.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { artifact: 'art-31c' },
  async run(values, services, caller) {
    const id = values.artifact!;
    const registry = runnersOf(services).registry;
    const held = registry.getArtifact(id);
    if (!held) throw new CapabilityRefusal('Nothing handed back is held under that name.', undefined, 'NOT_FOUND');
    const exported = await registry.exportArtifact(id, projectPath(caller, values.path || handedBackFile(held)));
    if (!exported) throw new CapabilityRefusal('Nothing handed back is held under that name.', undefined, 'NOT_FOUND');
    // Named by its task; the id is long (runner, task and time) and in the data.
    return { text: `Saved what the runner on "${held.task.task || held.runnerContract.label}" handed back to ${exported.path}.`, data: { artifact: exported.artifact.id, path: exported.path } };
  },
};

export const REMOTE_RERUN_LOCAL: Definition = {
  capability: { id: 'remote.rerun-local', group: 'work', home: 'daemon', repeat: 'unsafe' },
  actionId: 'rerun-local', label: 'Run a handed-back task here', word: 'rerun-local', inputs: [ARTIFACT],
  sentence: 'An agent starts in the daemon on the task {artifact} records, in this project, with only the tools it records (shown beside it), and is listed in Daemon tasks; that task and those tools may come from another machine.',
  done: '', touches: 'this-machine', lasts: 'not-a-change', risk: 'loosens-a-protection',
  ownerOnly: { reason: 'it runs task text and a tool list that may come from another machine', instead: 'Ask the owner to run it from the Work place.' },
  example: { artifact: 'art-31c' },
  // It works in the asking program's project, never the daemon's own folder.
  callerNeeds: { project: 'No project folder came with the request, so the agent has nowhere to work. Nothing was started. Send workingDirectory, the project folder, with the request.' },
  async run(values, services, caller) {
    const runners = runnersOf(services);
    const artifact = runners.registry.getArtifact(values.artifact!);
    if (!artifact) throw new CapabilityRefusal('Nothing handed back is held under that name.', undefined, 'NOT_FOUND');
    const ceiling = artifact.runnerContract.capabilityCeiling;
    if (ceiling.allowedTools.length === 0) throw new CapabilityRefusal(`What the runner on "${artifact.runnerContract.label}" handed back recorded no tools, so an agent started from it would have none. Nothing was started.`);
    if (!caller.workingDirectory) throw new CapabilityRefusal('No project folder came with the request, so the agent has nowhere to work. Nothing was started.');
    const started = runners.rerunLocal(artifact, caller.workingDirectory);
    // Named by its task; the agent's id is in the data.
    return {
      text: [
        // A daemon task (daemon-runners.ts rerunLocal): Daemon tasks in the Work place follows it and stops it.
        `Started an agent in the daemon on "${artifact.task.task || artifact.runnerContract.label}"; it works in ${caller.workingDirectory} and is listed in Daemon tasks, where you can follow it and stop it.`,
        `  kind of agent: ${started.template}`,
        `  tools (only these): ${ceiling.allowedTools.join(', ')}`,
        `  may write: ${ceiling.writeScope.join(', ') || 'its folder, under the permission rules'}`,
      ].join('\n'),
      data: { agentId: started.agentId, artifact: artifact.id },
    };
  },
};

export const REMOTE_IMPORT: Definition = {
  capability: { id: 'remote.import', group: 'work', home: 'daemon', repeat: 'safe' },
  actionId: 'import', label: 'Bring in what a runner handed back, from a file', word: 'import', inputs: [PATH('A file saved from Handed back or Runners in the Work place')],
  sentence: 'What a runner handed back, saved in {path}, is added to Handed back for review, replacing the one held now if it differs; a file that would change a known runner\'s tools is refused.',
  done: '', touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { path: 'remote/art-31c.json' },
  async run(values, services, caller) {
    const path = projectPath(caller, values.path!);
    try {
      // Reached only once the person confirmed the replacement the sentence names.
      const artifact = await runnersOf(services).registry.importArtifact(path, { replace: true });
      return { text: `Brought in what the runner on "${artifact.task.task || artifact.runnerContract.label}" handed back, from ${path}; it is in Handed back, in the Work place.`, data: { artifact: artifact.id } };
    } catch (error) {
      // Never the system's or the parser's words to anyone but the person (path-inputs.ts).
      throw fileWorkRefusal(path, 'a file of what a runner handed back', caller, error, 'Nothing was brought in.');
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
  async run() { return { text: ['Set this in the shell that starts a remote agent:', envSnippet()].join('\n') }; },
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
    const parsed = readJson(path, 'a start-up bundle', caller) as { sessionId?: unknown; acpAgentCommand?: unknown; links?: unknown } | null;
    const command = Array.isArray(parsed?.acpAgentCommand) ? parsed.acpAgentCommand.map(String).join(' ') : typeof parsed?.acpAgentCommand === 'string' ? parsed.acpAgentCommand : '';
    const links = Array.isArray(parsed?.links) ? parsed.links.length : 0;
    return {
      text: [
        command ? `The start-up bundle at ${path} starts a remote agent with: ${command}` : `The start-up bundle at ${path} names no agent command.`,
        // A bundle an older version saved may also name its conversation and links; the conversation is never shown by id.
        ...(typeof parsed?.sessionId === 'string' ? ['It was saved from a conversation of an older version.'] : []),
        ...(links > 0 ? [`It holds ${links} link${links === 1 ? '' : 's'}.`] : []),
      ].join('\n'),
    };
  },
});

export const REMOTE_SESSION_EXPORT: Definition = {
  capability: { id: 'remote.session-export', group: 'work', home: 'daemon', repeat: 'safe' },
  actionId: 'session-export', label: 'Save the runners to a bundle', word: 'session-export', inputs: [{ ...PATH('Where to write the bundle'), file: 'written' }],
  sentence: 'The runner pools, the runners and what they handed back are written to {path}; no conversation is.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { path: 'remote/session.json' },
  async run(values, services, caller) {
    const path = projectPath(caller, values.path!);
    // A caller that is not the owner saves only the runners and results it may reach (the same file a session import
    // reads, framed the same way).
    if (currentRecordReach()) {
      const whole = runnersOf(services).registry.buildSessionBundle();
      const bundle = { ...whole, pools: whole.pools.map(poolAsReached), contracts: whole.contracts.filter((contract) => reachesRunner(contract.runnerId)),
        artifacts: whole.artifacts.filter((artifact) => reachesArtifact(artifact.id)) };
      writeProjectFile(path, `${JSON.stringify(bundle, null, 2)}\n`);
      return { text: `Saved a runner bundle to ${path}: ${bundleWords(bundle)}. It holds no conversation.`, data: { path } };
    }
    // The registry frames and writes the bundle (the same file a session import reads).
    const exported = await runnersOf(services).registry.exportSessionBundle(undefined, path);
    return {
      text: `Saved a runner bundle to ${exported.path}: ${bundleWords(exported.bundle)}. It holds no conversation.`,
      data: { path: exported.path },
    };
  },
};

export const REMOTE_SESSION_INSPECT = read({
  actionId: 'session-inspect', label: 'Look inside a runner bundle', inputs: [PATH('A runner bundle saved from the Work place')],
  sentence: 'Shows what {path} holds and what bringing it in would replace; nothing is changed.', example: { path: 'remote/session.json' },
  async run(values, services, caller) {
    const path = projectPath(caller, values.path!);
    const described = runnersOf(services).registry.describeSessionBundleImport(readJson(path, 'a runner bundle', caller));
    if (!described.ok) throw caller.personAsked === true ? new CapabilityRefusal(`Cannot use ${path} as a runner bundle: ${described.problem}. Nothing was changed.`) : unreadableFile(path, 'a runner bundle', caller);
    return { text: bundleInspectWords(described.bundle, described.replaces), data: { replaces: described.replaces } };
  },
});

export const REMOTE_SESSION_IMPORT: Definition = {
  capability: { id: 'remote.session-import', group: 'work', home: 'daemon', repeat: 'safe' },
  actionId: 'session-import', label: 'Bring in a runner bundle', word: 'session-import', inputs: [PATH('A runner bundle saved from the Work place')],
  sentence: 'The runner pools, runners and what they handed back in {path} are brought in, replacing the ones held now that the file also holds.',
  done: '', touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { path: 'remote/session.json' },
  async run(values, services, caller) {
    const path = projectPath(caller, values.path!);
    try {
      const bundle = await runnersOf(services).registry.importSessionBundle(path, { replace: true });
      return { text: `Brought in the runner bundle: ${bundleWords(bundle)}.` };
    } catch (error) {
      // Never the system's or the parser's words to anyone but the person (path-inputs.ts).
      throw fileWorkRefusal(path, 'a runner bundle', caller, error);
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
