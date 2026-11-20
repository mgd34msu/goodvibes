import { directOwnerRemoteInput, isDirectOwnerCommandContext, type CommandRegistry, type CommandContext } from '../command-registry.ts';
import { AGENT_TEMPLATES } from '@goodvibes/engine/platform/platform/tools';
import { defineCommand, defineList, type ActionDescription, type InputDescription, type ListRow } from '@goodvibes/engine/terminal-shell/command-actions';
import { doAction, listInput, readAction, textInput } from '@goodvibes/engine/terminal-shell/described-command-kit';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import {
  exportRemoteBootstrap,
  exportRemoteFile,
  inspectRemoteBootstrap,
  remoteEnvSnippet,
  remoteSetupLines,
  remoteSetupPayload,
  remoteTunnelLines,
  runRemoteSessionBundle,
} from './remote-runtime-setup.ts';
import { runnerReviewText, runnerToolsText, runnerWriteScopeText } from './remote-ceiling-text.ts';
import { requireAgentManager, requireAcpManager, requirePeerClient, requireShellPaths } from './runtime-services.ts';

// ---------------------------------------------------------------------------
// /remote, described once (command-actions/): self-hosted remote runners, the
// pools they run in, the work they hand back for review, and what another
// machine needs to run them. Every remote subject is an action of this one
// command; there are no other front doors.
// ---------------------------------------------------------------------------

/** Own keys only: `constructor` or `toString` are not templates. */
function isAgentTemplate(name: string | undefined): name is string {
  return name !== undefined && Object.hasOwn(AGENT_TEMPLATES, name);
}

function peerOf(ctx: CommandContext) {
  try {
    return requirePeerClient(ctx);
  } catch {
    throw commandRefusal('Remote runtime services are not available in this runtime.');
  }
}
function runnersOf(ctx: CommandContext) { return peerOf(ctx).runners; }

type Supervisor = ReturnType<ReturnType<typeof requirePeerClient>['getSnapshot']>['supervisor'];
type SupervisorSession = Supervisor['sessions'][number];

function sessionFor(ctx: CommandContext, runnerId: string, pick: (sessions: readonly SupervisorSession[]) => SupervisorSession | undefined = (sessions) => sessions[0]): SupervisorSession {
  const supervisor = peerOf(ctx).getSnapshot().supervisor;
  const selected = runnerId ? supervisor.sessions.find((entry) => entry.runnerId === runnerId) : pick(supervisor.sessions);
  if (selected) return selected;
  const local = runnerId ? supervisor.localRunners.find((entry) => entry.runnerId === runnerId) : undefined;
  if (local) throw commandRefusal(`${runnerId} is a local runner (${local.template}) in this process; it has no transport or heartbeat.`, `/remote contract ${runnerId} shows its contract.`);
  throw commandRefusal(runnerId ? `Unknown remote runner: ${runnerId}` : 'No remote supervisor sessions are currently tracked.');
}

function reviewModeText(selected: SupervisorSession): string {
  return selected.negotiation.trustClass === 'self-hosted-acp' && selected.negotiation.reviewMode === 'contract' ? 'contract (not applied to an external runner)' : selected.negotiation.reviewMode;
}

/** The owner's own words for a dispatch: the typed line exactly as typed, or the form's task while the owner's command runs. */
function remoteDispatchSource(ctx: CommandContext, task: string) {
  const goal = directOwnerRemoteInput(ctx) ?? (isDirectOwnerCommandContext(ctx, 'remote') ? task : undefined);
  if (!goal) return undefined;
  const runtime = ctx.session.runtime, sessionId = runtime.sessionId, manager = ctx.ops.acpManager;
  const source = Object.freeze({ goal, criteria: Object.freeze([] as string[]) });
  return { sourceOf: () => source, assertCurrent() {
    if (ctx.session.runtime !== runtime || runtime.sessionId !== sessionId || ctx.ops.acpManager !== manager)
      throw new Error('Remote dispatch owner changed');
  } };
}

type RunnerPool = NonNullable<ReturnType<ReturnType<typeof requirePeerClient>['runners']['getPool']>>;

async function dispatchRunner(ctx: CommandContext, task: string, templateName: string, pool: RunnerPool | undefined): Promise<string> {
  if (!ctx.ops.acpManager) throw commandRefusal('ACP manager is not available for remote dispatch in this runtime.');
  const operation = remoteDispatchSource(ctx, task);
  if (!operation) throw commandRefusal('A remote runner starts only from your own words typed in the terminal; nothing was started.', 'Type /remote dispatch <task>.');
  const template = isAgentTemplate(templateName) ? templateName : 'general';
  const templateDef = AGENT_TEMPLATES[template] ?? AGENT_TEMPLATES.general;
  const remoteRunners = runnersOf(ctx);
  const runnerId = await ctx.ops.acpManager.spawn({
    description: task,
    context: `Self-hosted remote runner dispatched from session ${ctx.session.runtime.sessionId}${pool ? ` via pool ${pool.id}` : ''}. Follow ${template} discipline and return concise evidence.`,
    tools: [...templateDef.defaultTools],
    workingDirectory: requireShellPaths(ctx).workingDirectory,
    // The runner's progress events carry the session that dispatched it.
    sessionId: ctx.session.runtime.sessionId,
  }, operation);
  const now = Date.now();
  remoteRunners.registerContract({
    id: `runner:${runnerId}`,
    runnerId,
    ...(pool ? { poolId: pool.id } : {}),
    label: `${template} remote runner`,
    sourceTransport: 'acp',
    trustClass: !pool || pool.trustClass === 'mixed' ? 'self-hosted-acp' : pool.trustClass,
    template,
    capabilityCeiling: Object.freeze({
      allowedTools: [...templateDef.defaultTools],
      capabilityCeilingTools: [...templateDef.defaultTools],
      executionProtocol: 'gather-plan-apply',
      reviewMode: 'none',
      communicationLane: 'direct',
      orchestrationDepth: 0,
      successCriteria: [],
      requiredEvidence: [],
      writeScope: [],
    }),
    createdAt: now,
    lastUpdatedAt: now,
    transport: Object.freeze({ state: 'initializing', errorCount: 0 }),
  });
  const assigned = pool ? remoteRunners.assignRunnerToPool(pool.id, runnerId) : undefined;
  return [
    !pool ? `Dispatched remote runner ${runnerId}`
      : assigned ? `Dispatched remote runner ${runnerId} via pool ${pool.id}`
        : `Dispatched remote runner ${runnerId}; pool ${pool.id} filled up meanwhile, so the runner is not in it (stop it with /remote stop ${runnerId} if it should not run outside the pool)`,
    `  template: ${template}`,
    `  tools: ${templateDef.defaultTools.join(', ')} (a permission ask for any other kind of call is refused)`,
    `  task: ${task}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Live lists
// ---------------------------------------------------------------------------

const TERMINAL_ONLY = 'Remote runners belong to the terminal app that dispatched them.';

const CONNECTIONS = defineList<CommandContext>({
  name: 'remote.connections',
  async read(ctx) {
    let peer;
    try { peer = requirePeerClient(ctx); } catch { return []; }
    return peer.getSnapshot().acp.activeConnections.map((connection): ListRow => ({ value: connection.agentId, label: connection.label || connection.agentId, state: connection.transportState }));
  },
  operator: { terminalOnly: TERMINAL_ONLY },
});
const RUNNERS = defineList<CommandContext>({
  name: 'remote.runners',
  async read(ctx) {
    let peer;
    try { peer = requirePeerClient(ctx); } catch { return []; }
    return peer.runners.listContracts().map((contract): ListRow => ({ value: contract.runnerId, label: contract.label, detail: `${contract.template}${contract.poolId ? `, pool ${contract.poolId}` : ''}`, state: contract.transport?.state ?? 'local' }));
  },
  operator: { terminalOnly: TERMINAL_ONLY },
});
const SUPERVISED = defineList<CommandContext>({
  name: 'remote.supervised',
  async read(ctx) {
    let peer;
    try { peer = requirePeerClient(ctx); } catch { return []; }
    return peer.getSnapshot().supervisor.sessions.map((session): ListRow => ({ value: session.runnerId, label: session.label, state: `${session.transportState}, heartbeat ${session.heartbeat.status}` }));
  },
  operator: { terminalOnly: TERMINAL_ONLY },
});
const POOLS = defineList<CommandContext>({
  name: 'remote.pools',
  async read(ctx) {
    let peer;
    try { peer = requirePeerClient(ctx); } catch { return []; }
    return peer.runners.listPools().map((pool): ListRow => ({ value: pool.id, label: pool.label, state: `${pool.runnerIds.length} runner${pool.runnerIds.length === 1 ? '' : 's'}` }));
  },
  operator: { terminalOnly: TERMINAL_ONLY },
});
const POOL_RUNNERS = defineList<CommandContext>({
  name: 'remote.pool-runners',
  async read(ctx, earlier) {
    let peer;
    try { peer = requirePeerClient(ctx); } catch { return []; }
    return (peer.runners.getPool(earlier.pool ?? '')?.runnerIds ?? []).map((runnerId): ListRow => ({ value: runnerId, label: runnerId }));
  },
  operator: { terminalOnly: TERMINAL_ONLY },
});
const ARTIFACTS = defineList<CommandContext>({
  name: 'remote.artifacts',
  async read(ctx) {
    let peer;
    try { peer = requirePeerClient(ctx); } catch { return []; }
    return peer.runners.listArtifacts().map((artifact): ListRow => ({
      value: artifact.id,
      label: artifact.task.summary || artifact.id,
      detail: `runner ${artifact.runnerId}; tools: ${artifact.runnerContract.capabilityCeiling.allowedTools.join(', ') || 'none'}; task: ${artifact.task.task}`,
      state: artifact.task.status,
    }));
  },
  operator: { terminalOnly: TERMINAL_ONLY },
});

const TEMPLATE_CHOICES = Object.keys(AGENT_TEMPLATES).map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }));

const RUNNER = listInput({ id: 'runner', label: 'Runner', help: 'Runners this session knows', list: RUNNERS });
const SUPERVISED_RUNNER = listInput({ id: 'runner', label: 'Runner', help: 'Runners connected over a transport', list: SUPERVISED, optional: { default: '', means: 'the first one' } });
const POOL = listInput({ id: 'pool', label: 'Pool', help: 'Your runner pools', list: POOLS });
const ARTIFACT = listInput({ id: 'artifact', label: 'Artifact', help: 'Work runners handed back for review', list: ARTIFACTS });
const PATH = (help: string): InputDescription => textInput({ id: 'path', label: 'File', help, why: 'a file path in this project', kind: 'path', typed: { position: 1 } });
const OPTIONAL_PATH = (help: string): InputDescription => textInput({ id: 'path', label: 'File', help, why: 'a file path in this project', kind: 'path', typed: { flag: '--to' }, optional: { default: '', means: 'the usual place in this project' } });
const TASK = textInput({ id: 'task', label: 'Task', help: 'What the runner should do, in your own words', why: 'your own words', kind: 'long-text', typed: { tail: true } });
const TEMPLATE = (means: string): InputDescription => ({ id: 'template', label: 'Kind of agent', help: 'Which agent template it follows', kind: 'choice', choices: TEMPLATE_CHOICES, required: { default: '', defaultMeans: means }, typed: { flag: '--template' } });
const DISPATCH_OWNER = { reason: 'it starts a runner with this machine\'s tools from your own words', instead: 'Ask the owner to type the /remote dispatch line.' } as const;

function exportAction(fields: Pick<ActionDescription<CommandContext>, 'id' | 'label' | 'word' | 'sentence'> & { readonly help: string; readonly write: (ctx: CommandContext, path: string) => string }): ActionDescription<CommandContext> {
  return doAction<CommandContext>({
    id: fields.id, label: fields.label, word: fields.word, sentence: fields.sentence,
    inputs: [PATH(fields.help)], example: { path: 'remote/setup.json' },
    operator: { terminalOnly: 'The file is written in this project.' },
    async run(values, ctx) { return fields.write(ctx, requireShellPaths(ctx).resolveWorkspacePath(values.path!)); },
  });
}

// ---------------------------------------------------------------------------
// The description
// ---------------------------------------------------------------------------

const REMOTE_COMMAND = defineCommand<CommandContext>({
  name: 'remote',
  // --yes confirms only right after the action word: the same word in the text is text.
  leadingFlagsOnly: true,
  title: 'Remote runners',
  summary: 'Run work on self-hosted runners and review what they hand back',
  group: 'Work',
  report: 'list',
  firstScreenRows: [
    'list',
    'dispatch',
    'dispatch-pool',
    { label: 'Follow and stop runners', actions: ['show', 'contract', 'supervisor', 'capabilities', 'recover', 'stop'] },
    { label: 'Review what runners handed back', actions: ['artifacts', 'review', 'export', 'artifact-export', 'rerun-local', 'import'] },
    { label: 'Runner pools', actions: ['pools', 'pool', 'create-pool', 'assign', 'unassign'] },
    { label: 'Set up another machine', actions: ['setup', 'setup-export', 'env', 'env-export', 'tunnel', 'tunnel-export', 'bootstrap-export', 'bootstrap-inspect'] },
    { label: 'Move runners between sessions', actions: ['session-export', 'session-inspect', 'session-import'] },
    'open',
  ],
  actions: [
    readAction<CommandContext>({
      id: 'list', label: 'See remote runners at a glance', word: 'list',
      sentence: 'Shows connections, runner contracts, pools, artifacts and supervisor sessions.',
      async run(_values, ctx) {
        const peerSnapshot = peerOf(ctx).getSnapshot();
        const activeConnections = peerSnapshot.acp.activeConnections;
        const supervisor = peerSnapshot.supervisor;
        const { contracts, pools, artifacts } = peerSnapshot.runners;
        const lines = [
          'Remote runners',
          `  active connections: ${activeConnections.length}`,
          `  runner contracts: ${contracts.length}`,
          `  runner pools: ${pools.length}`,
          `  review artifacts: ${artifacts.length}`,
          `  supervisor sessions: ${supervisor.sessions.length}`,
          `  degraded sessions: ${supervisor.degradedConnections}`,
          `  local runners (no transport): ${supervisor.localRunners.length}`,
        ];
        if (activeConnections.length > 0) {
          lines.push('  connections:');
          for (const connection of activeConnections.slice(0, 12)) lines.push(`    ${connection.agentId}  ${connection.transportState}  errs=${connection.errorCount}  ${connection.label}`);
        }
        if (contracts.length > 0) {
          lines.push('  contracts:');
          for (const contract of contracts.slice(0, 12)) lines.push(`    ${contract.runnerId}  ${contract.template}  ${contract.transport?.state ?? 'local'}  ${contract.capabilityCeiling.executionProtocol}/${runnerReviewText(contract)}`);
        }
        if (supervisor.localRunners.length > 0) {
          lines.push('  local runners (sub-agents and graph nodes in this process):');
          for (const runner of supervisor.localRunners.slice(0, 12)) lines.push(`    ${runner.runnerId}  ${runner.template}  ${runner.label}${runner.taskId ? `  task ${runner.taskId}` : ''}`);
        }
        return lines.join('\n');
      },
    }),
    doAction<CommandContext>({
      id: 'open', label: 'Open the remote screen', word: 'open', touches: 'reads',
      sentence: 'Opens the full-screen view of remote runners, pools and artifacts.',
      operator: { terminalOnly: 'It is a terminal screen.' },
      async run(_values, ctx) {
        if (!ctx.openModal) throw commandRefusal('The remote screen is not available in this runtime.', '/remote list shows the same facts.');
        ctx.openModal('remote-modal');
      },
    }),
    readAction<CommandContext>({
      id: 'show', label: 'See a remote connection', word: 'show',
      inputs: [listInput({ id: 'connection', label: 'Connection', help: 'Connections open now', list: CONNECTIONS, optional: { default: '', means: 'the first one' } })],
      sentence: 'Shows {connection}\'s transport, errors, task, contract and tools.', example: { connection: 'acp-7f2' },
      async run(values, ctx) {
        const peer = peerOf(ctx);
        const connections = peer.getSnapshot().acp.activeConnections;
        const connection = values.connection ? connections.find((entry) => entry.agentId === values.connection) : connections[0];
        if (!connection) throw commandRefusal(values.connection ? `Unknown remote connection: ${values.connection}` : 'No active remote connections.');
        const contract = peer.runners.readContractForAgent(connection.agentId);
        return [
          `Remote connection ${connection.agentId}`,
          `  label: ${connection.label}`,
          `  transport: ${connection.transportState}`,
          `  connectedAt: ${connection.connectedAt ? new Date(connection.connectedAt).toISOString() : 'n/a'}`,
          `  errorCount: ${connection.errorCount}`,
          `  taskId: ${contract?.taskId ?? 'n/a'}`,
          `  lastError: ${connection.lastError ?? 'n/a'}`,
          `  contract: ${contract?.id ?? 'n/a'}`,
          `  pool: ${contract?.poolId ?? 'n/a'}`,
          `  executionProtocol: ${contract?.capabilityCeiling.executionProtocol ?? 'n/a'}`,
          `  reviewMode: ${contract ? runnerReviewText(contract) : 'n/a'}`,
          `  tools: ${contract ? runnerToolsText(contract) : 'n/a'}`,
          `  communicationLane: ${contract?.capabilityCeiling.communicationLane ?? 'n/a'}`,
        ].join('\n');
      },
    }),
    readAction<CommandContext>({
      id: 'contract', label: 'See a runner\'s contract', word: 'contract', inputs: [RUNNER],
      sentence: 'Shows {runner}\'s template, trust, transport, tools, write scope and review mode.', example: { runner: 'acp-7f2' },
      async run(values, ctx) {
        const contract = runnersOf(ctx).readContractForAgent(values.runner!);
        if (!contract) throw commandRefusal(`Unknown remote runner: ${values.runner}`);
        return [
          `Remote runner contract ${contract.id}`,
          `  runnerId: ${contract.runnerId}`,
          `  label: ${contract.label}`,
          `  pool: ${contract.poolId ?? '(none)'}`,
          `  trustClass: ${contract.trustClass}`,
          `  template: ${contract.template}`,
          `  transport: ${contract.transport?.state ?? 'none (local runner in this process)'}`,
          `  tools: ${runnerToolsText(contract)}`,
          `  protocol: ${contract.capabilityCeiling.executionProtocol}`,
          `  reviewMode: ${runnerReviewText(contract)}`,
          `  communicationLane: ${contract.capabilityCeiling.communicationLane}`,
          `  writeScope: ${runnerWriteScopeText(contract)}`,
        ].join('\n');
      },
    }),
    readAction<CommandContext>({
      id: 'supervisor', label: 'See a runner\'s supervisor session', word: 'supervisor', inputs: [SUPERVISED_RUNNER],
      sentence: 'Shows {runner}\'s transport, heartbeat, negotiated protocol, capabilities and recovery steps.', example: { runner: 'acp-7f2' },
      async run(values, ctx) {
        const selected = sessionFor(ctx, values.runner ?? '');
        return [
          `Remote Supervisor ${selected.runnerId}`,
          `  label: ${selected.label}`,
          `  transport: ${selected.transportState}`,
          `  heartbeat: ${selected.heartbeat.status}`,
          `  heartbeat detail: ${selected.heartbeat.detail}`,
          `  executionProtocol: ${selected.negotiation.executionProtocol}`,
          `  reviewMode: ${reviewModeText(selected)}`,
          `  communicationLane: ${selected.negotiation.communicationLane}`,
          `  trustClass: ${selected.negotiation.trustClass}`,
          `  taskId: ${selected.taskId ?? 'n/a'}`,
          `  errorCount: ${selected.errorCount}`,
          ...(selected.lastError ? [`  lastError: ${selected.lastError}`] : []),
          '  capabilities:',
          ...selected.capabilities.map((capability) => `    ${capability.id}: ${capability.supported ? 'yes' : 'no'} (${capability.detail})`),
          '  recovery:',
          ...selected.recovery.map((action) => `    ${action.command}: ${action.reason}`),
        ].join('\n');
      },
    }),
    readAction<CommandContext>({
      id: 'capabilities', label: 'See what a runner can do', word: 'capabilities', inputs: [SUPERVISED_RUNNER],
      sentence: 'Shows which capabilities {runner} supports and which it lacks.', example: { runner: 'acp-7f2' },
      async run(values, ctx) {
        const selected = sessionFor(ctx, values.runner ?? '');
        return [
          `Remote Capabilities ${selected.runnerId}`,
          `  label: ${selected.label}`,
          `  transport: ${selected.transportState}`,
          `  executionProtocol: ${selected.negotiation.executionProtocol}`,
          `  reviewMode: ${reviewModeText(selected)}`,
          `  communicationLane: ${selected.negotiation.communicationLane}`,
          `  trustClass: ${selected.negotiation.trustClass}`,
          '  capabilities:',
          ...selected.capabilities.map((capability) => `    ${capability.id}: ${capability.supported ? 'supported' : 'missing'}; ${capability.detail}`),
        ].join('\n');
      },
    }),
    readAction<CommandContext>({
      id: 'recover', label: 'See how to recover a runner', word: 'recover', inputs: [{ ...SUPERVISED_RUNNER, required: { default: '', defaultMeans: 'the first one that needs it' } }],
      sentence: 'Shows {runner}\'s heartbeat and last error, and the steps that recover it.', example: { runner: 'acp-7f2' },
      async run(values, ctx) {
        const selected = sessionFor(ctx, values.runner ?? '', (sessions) => sessions.find((entry) => entry.recovery.length > 0) ?? sessions[0]);
        const nextSteps = selected.recovery.length > 0
          ? selected.recovery
          : [{ command: `/remote show ${selected.runnerId}`, reason: 'Inspect the current remote session before deciding on recovery.' }];
        return [
          `Remote Recovery ${selected.runnerId}`,
          `  label: ${selected.label}`,
          `  transport: ${selected.transportState}`,
          `  heartbeat: ${selected.heartbeat.status}`,
          `  detail: ${selected.heartbeat.detail}`,
          ...(selected.lastError ? [`  lastError: ${selected.lastError}`] : []),
          ...(selected.taskId ? [`  bound task: ${selected.taskId}`] : []),
          '  actions:',
          ...nextSteps.map((action) => `    ${action.command}: ${action.reason}`),
        ].join('\n');
      },
    }),
    {
      id: 'stop', label: 'Stop a remote runner', word: 'stop',
      inputs: [listInput({ id: 'connection', label: 'Connection', help: 'Connections open now', list: CONNECTIONS })],
      sentence: 'The runner on {connection} is stopped; what it was doing is not finished.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
      operator: { terminalOnly: TERMINAL_ONLY }, example: { connection: 'acp-7f2' },
      async run(values, ctx) {
        const agentId = values.connection!;
        if (!peerOf(ctx).getSnapshot().acp.activeConnections.some((entry) => entry.agentId === agentId)) throw commandRefusal(`Unknown remote connection: ${agentId}`);
        if (requireAgentManager(ctx).cancel(agentId)) return `Stopped remote agent ${agentId}.`;
        if (!ctx.ops.acpManager) throw commandRefusal(`Remote agent ${agentId} could not be stopped in this runtime.`);
        try {
          await requireAcpManager(ctx).cancel(agentId);
        } catch (error) {
          throw commandRefusal(`Stopping remote runner ${agentId} failed: ${summarizeError(error)}. The runner may still be running.`, `Try /remote stop ${agentId} again.`);
        }
        return `Stop requested for remote runner ${agentId}.`;
      },
    },
    {
      id: 'dispatch', label: 'Start a remote runner on a task', word: 'dispatch', inputs: [TASK, TEMPLATE('a general agent')],
      sentence: 'A self-hosted runner starts on "{task}" now, with only its template\'s tools; it runs until it finishes or you stop it.',
      done: '', touches: 'this-machine', lasts: 'not-a-change', risk: 'none', undoneBy: 'stop', ownerOnly: DISPATCH_OWNER,
      operator: { terminalOnly: TERMINAL_ONLY }, example: { task: 'run the test suite and report failures', template: 'tester' },
      async run(values, ctx) { return dispatchRunner(ctx, values.task!, values.template || 'general', undefined); },
    },
    {
      id: 'dispatch-pool', label: 'Start a runner from a pool on a task', word: 'dispatch-pool', inputs: [POOL, TASK, TEMPLATE('the pool\'s usual agent')],
      sentence: 'A runner from pool {pool} starts on "{task}" now, with only its template\'s tools; it runs until it finishes or you stop it.',
      done: '', touches: 'this-machine', lasts: 'not-a-change', risk: 'none', undoneBy: 'stop', ownerOnly: DISPATCH_OWNER,
      operator: { terminalOnly: TERMINAL_ONLY }, example: { pool: 'ci', task: 'run the test suite and report failures' },
      async run(values, ctx) {
        const pool = runnersOf(ctx).getPool(values.pool!);
        if (!pool) throw commandRefusal(`Unknown remote runner pool: ${values.pool}`);
        if (pool.maxRunners !== undefined && pool.runnerIds.length >= pool.maxRunners) {
          throw commandRefusal(`Pool ${pool.id} already holds its ${pool.maxRunners} runner(s). Nothing was started.`, `Take one out with /remote unassign ${pool.id} <runner>, or dispatch to another pool.`);
        }
        return dispatchRunner(ctx, values.task!, values.template || pool.preferredTemplate || 'general', pool);
      },
    },
    readAction<CommandContext>({
      id: 'pools', label: 'See runner pools', word: 'pools',
      sentence: 'Shows every runner pool with its runners, trust and template.',
      async run(_values, ctx) {
        const pools = runnersOf(ctx).listPools();
        if (pools.length === 0) return 'No remote runner pools defined yet. Make one with /remote create-pool <id> <label>.';
        return [`Remote Runner Pools (${pools.length})`, ...pools.map((pool) => `  ${pool.id}  ${pool.runnerIds.length} runners  trust=${pool.trustClass}  template=${pool.preferredTemplate ?? '(none)'}`)].join('\n');
      },
    }),
    readAction<CommandContext>({
      id: 'pool', label: 'See a runner pool', word: 'pool', inputs: [POOL],
      sentence: 'Shows {pool}\'s label, trust, template, limit and runners.', example: { pool: 'ci' },
      async run(values, ctx) {
        const pool = runnersOf(ctx).getPool(values.pool!);
        if (!pool) throw commandRefusal(`Unknown remote runner pool: ${values.pool}`);
        return [
          `Remote Runner Pool ${pool.id}`,
          `  label: ${pool.label}`,
          `  trustClass: ${pool.trustClass}`,
          `  preferredTemplate: ${pool.preferredTemplate ?? '(none)'}`,
          `  maxRunners: ${pool.maxRunners ?? '(unbounded)'}`,
          `  runners: ${pool.runnerIds.join(', ') || '(none)'}`,
          `  description: ${pool.description ?? '(none)'}`,
        ].join('\n');
      },
    }),
    {
      id: 'create-pool', label: 'Make a runner pool', word: 'create-pool',
      inputs: [
        textInput({ id: 'pool', label: 'Pool id', help: 'A short id you choose', why: 'a new id you choose', typed: { position: 1 } }),
        textInput({ id: 'label', label: 'Label', help: 'A name people will read', why: 'your own words', typed: { tail: true }, optional: { default: '', means: 'the same as its id' } }),
      ],
      sentence: 'Runner pool {pool} is made, until you change it.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: { terminalOnly: TERMINAL_ONLY }, example: { pool: 'ci', label: 'CI machines' },
      async run(values, ctx) {
        const pool = runnersOf(ctx).createPool({ id: values.pool!, label: values.label || values.pool! });
        return `Made runner pool ${pool.id} (${pool.label}).`;
      },
    },
    {
      id: 'assign', label: 'Put a runner in a pool', word: 'assign', inputs: [POOL, { ...RUNNER, typed: { position: 2 } }],
      sentence: 'Runner {runner} joins pool {pool} until you change it.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'unassign',
      operator: { terminalOnly: TERMINAL_ONLY }, example: { pool: 'ci', runner: 'acp-7f2' },
      async run(values, ctx) {
        if (!runnersOf(ctx).assignRunnerToPool(values.pool!, values.runner!)) throw commandRefusal(`Could not put ${values.runner} in pool ${values.pool}.`, '/remote pool <pool> shows its limit and runners.');
        return `Runner ${values.runner} is in pool ${values.pool}.`;
      },
    },
    {
      id: 'unassign', label: 'Take a runner out of a pool', word: 'unassign',
      inputs: [POOL, listInput({ id: 'runner', label: 'Runner', help: 'Runners in this pool', list: POOL_RUNNERS, position: 2, dependsOn: 'pool' })],
      sentence: 'Runner {runner} leaves pool {pool} until you change it.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'assign',
      operator: { terminalOnly: TERMINAL_ONLY }, example: { pool: 'ci', runner: 'acp-7f2' },
      async run(values, ctx) {
        if (!runnersOf(ctx).removeRunnerFromPool(values.pool!, values.runner!)) throw commandRefusal(`Unknown remote runner pool: ${values.pool}`);
        return `Runner ${values.runner} left pool ${values.pool}.`;
      },
    },
    readAction<CommandContext>({
      id: 'artifacts', label: 'See what runners handed back', word: 'artifacts',
      sentence: 'Shows the review artifacts runners handed back, with their state and summary.',
      async run(_values, ctx) {
        const artifacts = runnersOf(ctx).listArtifacts();
        if (artifacts.length === 0) return 'No remote review artifacts captured yet.';
        return [`Remote Review Artifacts (${artifacts.length})`, ...artifacts.slice(0, 12).map((artifact) => `  ${artifact.id}  ${artifact.runnerId}  ${artifact.task.status}  ${artifact.task.summary}`)].join('\n');
      },
    }),
    readAction<CommandContext>({
      id: 'review', label: 'Review an artifact', word: 'review', inputs: [ARTIFACT],
      sentence: 'Shows what {artifact} holds: the task, its result and the evidence.', example: { artifact: 'art-31c' },
      async run(values, ctx) {
        const summary = runnersOf(ctx).buildReviewSummary(values.artifact!);
        if (!summary) throw commandRefusal(`Unknown remote artifact: ${values.artifact}`);
        return summary;
      },
    }),
    doAction<CommandContext>({
      id: 'export', label: 'Save a runner\'s work for review', word: 'export', inputs: [RUNNER, OPTIONAL_PATH('Where to write it')],
      sentence: 'What {runner} did is captured as an artifact and written to a file in this project.',
      operator: { terminalOnly: 'The file is written in this project.' }, example: { runner: 'acp-7f2' },
      async run(values, ctx) {
        const runners = runnersOf(ctx);
        const artifact = runners.captureArtifactForRunner(values.runner!);
        const exported = artifact ? await runners.exportArtifact(artifact.id, values.path ? requireShellPaths(ctx).resolveWorkspacePath(values.path) : undefined) : null;
        if (!exported) throw commandRefusal(`Remote artifact export failed for ${values.runner}.`);
        return `Saved remote review artifact ${exported.artifact.id} to ${exported.path}`;
      },
    }),
    doAction<CommandContext>({
      id: 'artifact-export', label: 'Save an artifact to a file', word: 'artifact-export', inputs: [ARTIFACT, OPTIONAL_PATH('Where to write it')],
      sentence: '{artifact} is written to a file in this project.',
      operator: { terminalOnly: 'The file is written in this project.' }, example: { artifact: 'art-31c' },
      async run(values, ctx) {
        const exported = await runnersOf(ctx).exportArtifact(values.artifact!, values.path ? requireShellPaths(ctx).resolveWorkspacePath(values.path) : undefined);
        if (!exported) throw commandRefusal(`Unknown remote artifact: ${values.artifact}`);
        return `Saved remote review artifact ${exported.artifact.id} to ${exported.path}`;
      },
    }),
    {
      id: 'rerun-local', label: 'Run an artifact\'s task here', word: 'rerun-local', inputs: [ARTIFACT],
      sentence: 'A local agent starts in this project on the task {artifact} recorded, with only the tools it recorded (shown beside each artifact); it may come from another machine.',
      done: '', touches: 'this-machine', lasts: 'not-a-change', risk: 'loosens-a-protection',
      ownerOnly: { reason: 'it runs task text and a tool list that may come from another machine', instead: 'Ask the owner to type /remote rerun-local <artifact>.' },
      operator: { terminalOnly: 'The agent runs in this terminal app.' }, example: { artifact: 'art-31c' },
      async run(values, ctx) {
        const artifactId = values.artifact!;
        const artifact = runnersOf(ctx).getArtifact(artifactId);
        if (!artifact) throw commandRefusal(`Unknown remote artifact: ${artifactId}`);
        const template = isAgentTemplate(artifact.runnerContract.template) ? artifact.runnerContract.template : 'general';
        const agentManager = ctx.ops.agentManager;
        if (!agentManager) throw commandRefusal('Agent manager is not available in this runtime.');
        if (!isDirectOwnerCommandContext(ctx, 'remote')) throw commandRefusal('A local rerun starts only from your own command typed in the terminal; nothing was started.');
        const ceiling = artifact.runnerContract.capabilityCeiling;
        if (ceiling.allowedTools.length === 0) throw commandRefusal(`Artifact ${artifactId} recorded no allowed tools, so a local rerun would have no tools. Nothing was started.`);
        const agent = agentManager.spawn({
          mode: 'spawn',
          task: artifact.task.task,
          template,
          // The session's own agent: its model lists and reads it with the agent tool.
          sessionId: ctx.session.runtime.sessionId,
          tools: [...ceiling.allowedTools],
          // Without this the spawn adds the template's default tools to the recorded set.
          restrictTools: true,
          successCriteria: [...ceiling.successCriteria],
          requiredEvidence: [...ceiling.requiredEvidence],
          writeScope: [...ceiling.writeScope],
          executionProtocol: ceiling.executionProtocol,
          reviewMode: ceiling.reviewMode,
          communicationLane: ceiling.communicationLane,
        });
        return [
          `Started local agent ${agent.id} from remote artifact ${artifactId}.`,
          `  template: ${template}`,
          `  tools (only these): ${ceiling.allowedTools.join(', ')}`,
          `  writeScope: ${ceiling.writeScope.join(', ') || '(none)'}`,
          `  task: ${artifact.task.task}`,
        ].join('\n');
      },
    },
    {
      id: 'import', label: 'Bring in an artifact from a file', word: 'import', inputs: [PATH('An artifact file written by /remote export')],
      sentence: 'The artifact in {path} is added for review, until you change it; a file that would replace a known runner\'s tools is refused.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: { terminalOnly: 'The file is read from this project.' }, example: { path: 'remote/art-31c.json' },
      async run(values, ctx) {
        try {
          const artifact = await runnersOf(ctx).importArtifact(requireShellPaths(ctx).resolveWorkspacePath(values.path!));
          return `Imported remote review artifact ${artifact.id} for runner ${artifact.runnerId}. Review it with /remote review ${artifact.id}; /remote rerun-local ${artifact.id} asks before anything starts.`;
        } catch (error) {
          throw commandRefusal(`Remote import refused: ${summarizeError(error)}`);
        }
      },
    },
    readAction<CommandContext>({
      id: 'setup', label: 'See how remote running is set up', word: 'setup',
      sentence: 'Shows the agent command a remote runner starts, whether the daemon and listener are on, and what to do next.',
      async run(_values, ctx) {
        const peer = peerOf(ctx);
        return remoteSetupLines(ctx, peer.getSnapshot().acp.activeConnections.length, peer.runners.listContracts().length).join('\n');
      },
    }),
    exportAction({
      id: 'setup-export', label: 'Save the remote setup to a file', word: 'setup-export', help: 'Where to write the setup file',
      sentence: 'The remote setup is written as JSON to {path}.',
      write: (ctx, path) => { exportRemoteFile(path, `${JSON.stringify(remoteSetupPayload(ctx, runnersOf(ctx).listContracts().length), null, 2)}\n`); return `Saved the remote setup to ${path}`; },
    }),
    readAction<CommandContext>({
      id: 'env', label: 'See the environment a remote agent needs', word: 'env',
      sentence: 'Shows the shell lines that point a remote agent at this session.',
      async run(_values, ctx) { return ['Remote Environment', remoteEnvSnippet(ctx)].join('\n'); },
    }),
    exportAction({
      id: 'env-export', label: 'Save the remote environment to a file', word: 'env-export', help: 'Where to write the shell snippet',
      sentence: 'The shell lines a remote agent needs are written to {path}.',
      write: (ctx, path) => { exportRemoteFile(path, `${remoteEnvSnippet(ctx)}\n`); return `Saved the remote environment to ${path}`; },
    }),
    readAction<CommandContext>({
      id: 'tunnel', label: 'See how to tunnel remote traffic', word: 'tunnel',
      sentence: 'Shows how remote agent traffic reaches this session through a tunnel you run.',
      async run(_values, ctx) { return remoteTunnelLines(ctx, peerOf(ctx).getSnapshot().acp.activeConnections.length).join('\n'); },
    }),
    exportAction({
      id: 'tunnel-export', label: 'Save the tunnel guidance to a file', word: 'tunnel-export', help: 'Where to write the guidance',
      sentence: 'The tunnel guidance is written to {path}.',
      write: (ctx, path) => { exportRemoteFile(path, `${remoteTunnelLines(ctx, peerOf(ctx).getSnapshot().acp.activeConnections.length).join('\n')}\n`); return `Saved the tunnel guidance to ${path}`; },
    }),
    exportAction({
      id: 'bootstrap-export', label: 'Save a start-up bundle for another machine', word: 'bootstrap-export', help: 'Where to write the bundle',
      sentence: 'A bundle with the agent command, environment and links another machine starts from is written to {path}.',
      write: (ctx, path) => exportRemoteBootstrap(ctx, path),
    }),
    readAction<CommandContext>({
      id: 'bootstrap-inspect', label: 'Look inside a start-up bundle', word: 'bootstrap-inspect', inputs: [PATH('A bundle written by /remote bootstrap-export')],
      sentence: 'Shows the session, agent command and links in {path}.', example: { path: 'remote/bootstrap.json' },
      async run(values, ctx) { return inspectRemoteBootstrap(requireShellPaths(ctx).resolveWorkspacePath(values.path!)); },
    }),
    doAction<CommandContext>({
      id: 'session-export', label: 'Save this session\'s runners to a bundle', word: 'session-export', inputs: [PATH('Where to write the bundle')],
      sentence: 'This session\'s runner pools, runner contracts and artifacts are written to {path}; the conversation is not.',
      operator: { terminalOnly: 'The file is written in this project.' }, example: { path: 'remote/session.json' },
      async run(values, ctx) { return runRemoteSessionBundle('export', requireShellPaths(ctx).resolveWorkspacePath(values.path!), runnersOf(ctx)); },
    }),
    readAction<CommandContext>({
      id: 'session-inspect', label: 'Look inside a session bundle', word: 'session-inspect', inputs: [PATH('A bundle written by /remote session-export')],
      sentence: 'Shows what {path} holds and what bringing it in here would replace; nothing is changed.', example: { path: 'remote/session.json' },
      async run(values, ctx) { return runRemoteSessionBundle('inspect', requireShellPaths(ctx).resolveWorkspacePath(values.path!), runnersOf(ctx)); },
    }),
    {
      id: 'session-import', label: 'Bring in a session bundle', word: 'session-import', inputs: [PATH('A bundle written by /remote session-export')],
      sentence: 'The runner pools, contracts and artifacts in {path} are brought in, replacing any held here with the same ids.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
      operator: { terminalOnly: 'The file is read from this project.' }, example: { path: 'remote/session.json' },
      async run(values, ctx) { return runRemoteSessionBundle('import', requireShellPaths(ctx).resolveWorkspacePath(values.path!), runnersOf(ctx)); },
    },
  ],
});

export function registerRemoteRuntimeCommands(registry: CommandRegistry): void {
  registry.register(REMOTE_COMMAND);
}
