/**
 * daemon-runners.ts, the remote runners the daemon holds: its runner
 * registry (pools, runner contracts, the artifacts runners hand back), kept
 * in one file in the daemon's home so they outlast a restart, and the
 * self-hosted ACP runners it starts and stops. Every terminal program, the web
 * UI and a script see the same runners, and a runner keeps running when the
 * window that started it closes.
 *
 * One per registry: the daemon builds its capability services in more than
 * one place, and each gets this same holder (`daemonRemoteRunners`). Every
 * change a person, a model or a script makes is written to the file and
 * announced as the list `remote-runners`; a runner starting, ending or failing
 * is announced on the `agents` domain by the ACP connection itself.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AcpManager } from '../../acp/manager.js';
import { withUntrustedContentScope } from '../../security/untrusted-content.js';
import type { AgentManager } from '../../tools/agent/index.js';
import { AGENT_TEMPLATES } from '../../tools/agent/manager.js';
import type { RuntimeEventBus } from '../events/index.js';
import { createDomainDispatch, type RuntimeStore } from '../store/index.js';
import { AgentTaskAdapter } from '../tasks/adapters/agent-adapter.js';
import type { AcpConnection } from '../store/domains/acp.js';
import type { HookDispatcher } from '../../hooks/dispatcher.js';
import type { ExternalPermissionHost } from '../../permissions/external-request.js';
import { noteListChanged } from '../list-changes.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import type { RemoteRunnerRegistry } from './runner-registry.js';
import type { RemoteSupervisor, RemoteSupervisorSnapshot } from './supervisor.js';
import type { RemoteExecutionArtifact, RemoteRunnerContract, RemoteRunnerPool } from './types.js';

/** The file the daemon keeps its runner records in, under its own home. */
export const DAEMON_REMOTE_RUNNERS_FILE = 'remote-runners.json';

export interface DaemonRemoteRunnerSources {
  readonly remoteRunnerRegistry: RemoteRunnerRegistry;
  readonly remoteSupervisor: RemoteSupervisor;
  readonly runtimeStore: RuntimeStore;
  readonly runtimeBus: RuntimeEventBus;
  readonly agentManager: AgentManager;
  readonly hookDispatcher: Pick<HookDispatcher, 'fire'>;
  /** The permission host every runner's asks go through (the daemon's gate under the owner's mode). */
  readonly permissionHost: () => Omit<ExternalPermissionHost, 'signal'> | undefined;
  /** The daemon's own home folder (`~/.goodvibes/daemon`), where the runner file is kept. */
  readonly daemonHome: string;
  /** The daemon's sessions: each runner is one, titled by its task, so its questions and rules name it in words. */
  readonly sessionBroker?: Pick<import('../../control-plane/session-broker.js').SharedSessionBroker, 'register'> | undefined;
}

/** Everything a place, a script or a model reads about the runners, in one answer. */
export interface DaemonRemoteRunnerSnapshot {
  readonly connections: readonly AcpConnection[];
  readonly supervisor: RemoteSupervisorSnapshot;
  readonly contracts: readonly RemoteRunnerContract[];
  readonly pools: readonly RemoteRunnerPool[];
  readonly artifacts: readonly RemoteExecutionArtifact[];
}

/** Own keys only: `constructor` or `toString` are not templates. */
export function isAgentTemplate(name: string | undefined): name is string {
  return name !== undefined && Object.hasOwn(AGENT_TEMPLATES, name);
}

/** A template's own tools; the general agent's for a name that is no template. */
export function templateTools(name: string): readonly string[] {
  return (AGENT_TEMPLATES[name] ?? AGENT_TEMPLATES['general'])?.defaultTools ?? [];
}

export class DaemonRemoteRunners {
  private acp: AcpManager | undefined;
  private readonly lifetime = new AbortController();
  private writing: Promise<void> = Promise.resolve();
  private readonly file: string;
  /** Why the file could not be read at start, when it could not: said beside the lists, never shown as empty. */
  readonly unreadable: string | undefined;

  constructor(private readonly sources: DaemonRemoteRunnerSources) {
    this.file = join(sources.daemonHome, DAEMON_REMOTE_RUNNERS_FILE);
    this.unreadable = this.load();
    sources.remoteRunnerRegistry.onChange(() => this.changed());
    // The daemon's store learns a runner's connection from its transport events (the terminal app's host bridge did
    // this for its own runners; the daemon has none for the ACP transports): each step is in the store and announced.
    const dispatch = createDomainDispatch(sources.runtimeStore);
    const stop = sources.runtimeBus.onDomain('transport', (envelope) => {
      const event = envelope.payload as { readonly transportId?: unknown };
      if (typeof event.transportId !== 'string' || !event.transportId.startsWith('acp:')) return;
      dispatch.dispatchTransportEvent(envelope.payload);
      const runnerId = event.transportId.slice('acp:'.length);
      // The runner's contract says the state its connection is in, so the two never say different things.
      const contract = sources.remoteRunnerRegistry.getContract(runnerId);
      const connection = sources.runtimeStore.getState().acp.connections.get(runnerId);
      if (contract && connection && (contract.transport?.state !== connection.transportState || contract.transport?.errorCount !== connection.errorCount)) {
        sources.remoteRunnerRegistry.registerContract(Object.freeze({
          ...contract,
          lastUpdatedAt: Date.now(),
          transport: Object.freeze({
            state: connection.transportState, errorCount: connection.errorCount,
            ...(connection.connectedAt !== undefined ? { connectedAt: connection.connectedAt } : {}),
            ...(connection.lastError !== undefined ? { lastError: connection.lastError } : {}),
          }),
        }));
        return;
      }
      noteListChanged({ list: 'remote-runners', change: 'changed', id: runnerId });
    });
    this.lifetime.signal.addEventListener('abort', () => stop(), { once: true });
    // An agent started here from what a runner handed back is a daemon task (Daemon tasks lists it, follows it to its
    // end and stops it), as every agent the daemon starts for a request is (daemon/facade.ts trySpawnAgent).
    this.tasks = new AgentTaskAdapter(sources.runtimeStore);
    const detach = this.tasks.attachRuntimeBus(sources.runtimeBus);
    this.lifetime.signal.addEventListener('abort', () => detach(), { once: true });
  }

  private readonly tasks: AgentTaskAdapter;

  get registry(): RemoteRunnerRegistry { return this.sources.remoteRunnerRegistry; }

  private load(): string | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined;
      return `the runner file ${this.file} could not be read (${summarizeError(error)})`;
    }
    try {
      const restored = this.sources.remoteRunnerRegistry.restore(JSON.parse(raw) as unknown);
      if (restored.skipped > 0) logger.warn('Remote runner file: records that could not be read were left out', { file: this.file, skipped: restored.skipped });
      return undefined;
    } catch (error) {
      return `the runner file ${this.file} is not readable JSON (${summarizeError(error)}); it is left as it is`;
    }
  }

  /** Write the records (one write at a time, the newest state each time) and announce the change. */
  private changed(): void {
    noteListChanged({ list: 'remote-runners', change: 'changed' });
    // A file that could not be read at start is not overwritten: the person's records in it stay until it is fixed.
    if (this.unreadable) return;
    this.writing = this.writing.then(() => {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        const next = `${this.file}.next`;
        writeFileSync(next, `${JSON.stringify({ version: 1, ...this.sources.remoteRunnerRegistry.records() }, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
        renameSync(next, this.file);
      } catch (error) {
        logger.warn('Remote runner file could not be written', { file: this.file, error: summarizeError(error) });
      }
    });
  }

  private manager(): AcpManager {
    if (this.acp) return this.acp;
    const host = this.sources.permissionHost();
    // A runner's every ask goes through the daemon's gate: with no gate to ask, no runner starts.
    if (!host) throw new Error('this daemon has no permission gate to put a runner\'s asks to, so no runner is started');
    this.acp = new AcpManager({
      permissionHost: { ...host, signal: this.lifetime.signal },
      runtimeBus: this.sources.runtimeBus,
      hookDispatcher: this.sources.hookDispatcher,
    });
    return this.acp;
  }

  snapshot(): DaemonRemoteRunnerSnapshot {
    // The supervisor's read brings the contracts up to date with the runners first.
    const supervisor = this.sources.remoteSupervisor.getSnapshot(this.sources.runtimeStore);
    const acp = this.sources.runtimeStore.getState().acp;
    return {
      connections: acp.activeConnectionIds.map((id) => acp.connections.get(id)).filter((connection): connection is AcpConnection => connection !== undefined),
      supervisor,
      contracts: this.registry.listContracts(),
      pools: this.registry.listPools(),
      artifacts: this.registry.listArtifacts(),
    };
  }

  /** Start a self-hosted runner on a task, from the person's own words, in `workingDirectory`. */
  async dispatch(input: { readonly task: string; readonly template: string; readonly pool?: RemoteRunnerPool | undefined; readonly workingDirectory: string;
    /** Who started it (the capability call's cause): its asks are decided as that party's turn. Absent: someone else's. */
    readonly inputParty?: { readonly party: 'owner' } | { readonly party: 'other'; readonly who: string } | undefined }): Promise<{ readonly runnerId: string; readonly template: string; readonly tools: readonly string[]; readonly inPool: boolean }> {
    const template = isAgentTemplate(input.template) ? input.template : 'general';
    const templateDef = { defaultTools: [...templateTools(template)] };
    const goal = Object.freeze({ goal: input.task, criteria: Object.freeze([] as string[]) });
    // The gate's check reads the untrusted-content window of the scope an ask is decided in and fails if that window
    // moves while the owner is being asked. Started from a request, the runner would ask in its starter's scope, and
    // the owner's answer from the same credential starts a new turn in exactly that scope: every answer, yes or no,
    // then failed with "untrusted content evidence changed during comparison". A runner's task is the person's own
    // words and what it reads stays in its own process, never in this daemon's ledger, so it runs, and its asks are
    // decided, in a window of its own, which only it can move.
    // Each runner is a session of its own: "allow for this session" given to one runner is that runner's alone, and
    // two runners' identical asks are two questions (its asks are also decided for its own project, acp/connection.ts).
    const session = `remote-runner:${randomUUID()}`;
    // Registered before it starts, titled by its task, so its first question already names it ("Runner: <task>").
    const title = `Runner: ${input.task.length > 60 ? `${input.task.slice(0, 59)}…` : input.task}`;
    await this.sources.sessionBroker?.register({ sessionId: session, kind: 'acp', title, project: input.workingDirectory,
      participant: { surfaceKind: 'service', surfaceId: 'remote-runner', lastSeenAt: Date.now() } })
      .catch((error: unknown) => { logger.warn('Remote runner session could not be registered; its questions name no runner', { error: summarizeError(error) }); });
    const runnerId = await withUntrustedContentScope(session, () => this.manager().spawn({
      description: input.task,
      context: `Self-hosted remote runner started by the daemon${input.pool ? ` from pool ${input.pool.id}` : ''}. Follow ${template} discipline and return concise evidence.`,
      tools: [...templateDef.defaultTools],
      workingDirectory: input.workingDirectory,
      sessionId: session,
      // Who started it, recorded on it: a runner anyone but the owner started acts on someone else's input (reads only).
      inputParty: input.inputParty ?? { party: 'other', who: 'a runner no owner started' },
    }, { sourceOf: () => goal, assertCurrent() {}, signal: this.lifetime.signal }));
    const now = Date.now();
    // Its connection may have moved on while it started: the contract starts from the state the connection is in.
    const connection = this.sources.runtimeStore.getState().acp.connections.get(runnerId);
    this.registry.registerContract({
      id: `runner:${runnerId}`,
      runnerId,
      ...(input.pool ? { poolId: input.pool.id } : {}),
      // Named by its task: two runners of one template are told apart by what they were started on.
      label: input.task.length > 60 ? `${input.task.slice(0, 59)}…` : input.task,
      sourceTransport: 'acp',
      trustClass: !input.pool || input.pool.trustClass === 'mixed' ? 'self-hosted-acp' : input.pool.trustClass,
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
      workspaceRoot: input.workingDirectory,
      createdAt: now,
      lastUpdatedAt: now,
      transport: Object.freeze(connection
        ? { state: connection.transportState, errorCount: connection.errorCount, ...(connection.connectedAt !== undefined ? { connectedAt: connection.connectedAt } : {}), ...(connection.lastError !== undefined ? { lastError: connection.lastError } : {}) }
        : { state: 'initializing' as const, errorCount: 0 }),
    });
    const inPool = input.pool ? this.registry.assignRunnerToPool(input.pool.id, runnerId) !== null : false;
    return { runnerId, template, tools: [...templateDef.defaultTools], inPool };
  }

  /** Stop a runner this daemon started; false when it holds no runner by that id. */
  async stop(runnerId: string): Promise<boolean> {
    if (this.sources.agentManager.cancel(runnerId)) { noteListChanged({ list: 'remote-runners', change: 'changed', id: runnerId }); return true; }
    const live = this.acp?.getActive().some((info) => info.id === runnerId) === true
      || this.sources.runtimeStore.getState().acp.activeConnectionIds.includes(runnerId);
    if (!live || !this.acp) return false;
    await this.acp.cancel(runnerId);
    noteListChanged({ list: 'remote-runners', change: 'changed', id: runnerId });
    return true;
  }

  /**
   * Start an agent here on the task an artifact recorded, with only the tools it recorded, working in `workingDirectory`
   * (the asking program's project): never the daemon's own folder.
   */
  rerunLocal(artifact: RemoteExecutionArtifact, workingDirectory: string): { readonly agentId: string; readonly template: string } {
    const template = isAgentTemplate(artifact.runnerContract.template) ? artifact.runnerContract.template : 'general';
    const ceiling = artifact.runnerContract.capabilityCeiling;
    const agent = this.sources.agentManager.spawn({
      mode: 'spawn',
      task: artifact.task.task,
      template,
      workingDirectory,
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
    // One agent, one task row under the agent's own id (as the daemon's own starts do): Daemon tasks shows it.
    this.tasks.wrapAgent(agent.id, artifact.task.task || artifact.runnerContract.label, { sessionId: 'daemon' }, agent.id);
    noteListChanged({ list: 'remote-runners', change: 'created', id: agent.id });
    return { agentId: agent.id, template };
  }

  /** Stop every runner this daemon started; called when the daemon stops. */
  async close(): Promise<void> {
    this.lifetime.abort();
    await this.acp?.close();
    await this.writing;
  }
}

const held = new WeakMap<RemoteRunnerRegistry, DaemonRemoteRunners>();

/** The daemon's one runner holder for this registry, made on first use. */
export function daemonRemoteRunners(sources: DaemonRemoteRunnerSources): DaemonRemoteRunners {
  let runners = held.get(sources.remoteRunnerRegistry);
  if (!runners) {
    runners = new DaemonRemoteRunners(sources);
    held.set(sources.remoteRunnerRegistry, runners);
  }
  return runners;
}
