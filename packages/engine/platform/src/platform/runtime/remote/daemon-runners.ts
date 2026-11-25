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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AcpManager } from '../../acp/manager.js';
import type { AgentManager } from '../../tools/agent/index.js';
import { AGENT_TEMPLATES } from '../../tools/agent/manager.js';
import type { RuntimeEventBus } from '../events/index.js';
import { createDomainDispatch, type RuntimeStore } from '../store/index.js';
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
      noteListChanged({ list: 'remote-runners', change: 'changed', id: event.transportId.slice('acp:'.length) });
    });
    this.lifetime.signal.addEventListener('abort', () => stop(), { once: true });
  }

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
  async dispatch(input: { readonly task: string; readonly template: string; readonly pool?: RemoteRunnerPool | undefined; readonly workingDirectory: string }): Promise<{ readonly runnerId: string; readonly template: string; readonly tools: readonly string[]; readonly inPool: boolean }> {
    const template = isAgentTemplate(input.template) ? input.template : 'general';
    const templateDef = { defaultTools: [...templateTools(template)] };
    const goal = Object.freeze({ goal: input.task, criteria: Object.freeze([] as string[]) });
    const runnerId = await this.manager().spawn({
      description: input.task,
      context: `Self-hosted remote runner started by the daemon${input.pool ? ` from pool ${input.pool.id}` : ''}. Follow ${template} discipline and return concise evidence.`,
      tools: [...templateDef.defaultTools],
      workingDirectory: input.workingDirectory,
      sessionId: 'daemon-remote-runners',
    }, { sourceOf: () => goal, assertCurrent() {}, signal: this.lifetime.signal });
    const now = Date.now();
    this.registry.registerContract({
      id: `runner:${runnerId}`,
      runnerId,
      ...(input.pool ? { poolId: input.pool.id } : {}),
      label: `${template} remote runner`,
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
      transport: Object.freeze({ state: 'initializing', errorCount: 0 }),
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

  /** Start an agent here on the task an artifact recorded, with only the tools it recorded. */
  rerunLocal(artifact: RemoteExecutionArtifact): { readonly agentId: string; readonly template: string } {
    const template = isAgentTemplate(artifact.runnerContract.template) ? artifact.runnerContract.template : 'general';
    const ceiling = artifact.runnerContract.capabilityCeiling;
    const agent = this.sources.agentManager.spawn({
      mode: 'spawn',
      task: artifact.task.task,
      template,
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
