import { bindContractInputAuthority } from '../../contract/input-authority.js';
import { classicAgentInput } from './classic-policy.js';
import { decisionModelPolicyState } from '@goodvibes/engine/errors';
import { currentTurn, withAgentTurn, type TurnContext } from '../../security/turn-boundary.js';
import { turnInputParty, withOtherPartyInput } from '../../security/turn-input-party.js';
import type { Actor } from '@goodvibes/engine/daemon-api/http-policy';
import { currentExecutionModeOwner, detachedFromInvocation, type ExecutionModeOwner } from '../../gate/execution-context.js';
import { AgentCapacityError } from './capacity-error.js';
import { bindContractActionSource, bindContractActionSignal, bindContractPlanConsumer } from './contract-binding.js';
import type { AgentConstructionBinding } from './contract-binding.js';
import { ArchetypeLoader } from '../../agents/archetypes.js';
import { BUILTIN_AGENT_TEMPLATES } from '../../agents/builtin-templates.js';
import { AgentOrchestrator } from '../../agents/orchestrator.js';
import { AgentMessageBus } from '../../agents/message-bus.js';
import type { ContractRunner, ContractStartOptions, OwnedStartedContract, StartedContract } from '../../contract/runner.js';
import type { ConfigManager } from '../../config/manager.js';
import type { ConversationMessageSnapshot } from '../../core/conversation.js';
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import {
  emitAgentCancelled,
  emitAgentCompleted,
  emitAgentFailed,
  emitAgentProgress,
  emitAgentRunning,
  emitAgentSpawning,
  emitContractSpawnGuardTriggered,
} from '../../runtime/emitters/index.js';
import type { AgentTaskContract } from '../../runtime/events/index.js';
import { evaluateOrchestrationSpawn } from '../../runtime/orchestration/spawn-policy.js';
import { logger } from '../../utils/logger.js';
import { spendingName } from '../../runtime/cost/model-usage.js';
import type { AgentInput } from './schema.js';
import { describeErrorInFull, summarizeError } from '../../utils/error-display.js';
import { OwnedScope } from '../../utils/owned-work.js';
import { splitModelRegistryKey } from '../../providers/registry-helpers.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { AgentSpawnInputError, requireProviderQualifiedModel, normalizeProviderQualifiedModelList } from './model-routing.js';
import { sameProviderCatalog } from '../../providers/provider-aliases.js';
import { moveAgentRun, type AgentRecord } from './record.js';
import { splitContractBinding, startContractOwner, type ContractOwnerBinding, type ContractUnitBinding } from './contract-binding.js';
import type { AgentWorkDelegation, DelegatedWorkUpdate } from './work-delegation.js';
import { setAgentProgress } from '../../agents/progress-audience.js';

export type { AgentRecord } from './record.js';

export type AgentExecutor = {
  runAgent(record: AgentRecord): Promise<void>;
};

/** Execution ownership for one real agent, including terminal cleanup. */
export interface AgentFleetOwnership {
  readonly id: string;
  readonly active: boolean;
}

// Only the synchronous live-read/reservation boundary is guarded. The guard
// ends before publishing events or entering an executor, so ordinary reentrant
// spawning still sees the newly reserved record and the real remaining cap.
let readingSharedFleetAdmission = false;
function reserveSharedFleet<T>(reserve: () => T): T {
  if (readingSharedFleetAdmission) throw new Error('Shared fleet admission is already reading live ownership');
  readingSharedFleetAdmission = true;
  try { return reserve(); } finally { readingSharedFleetAdmission = false; }
}

export interface AgentManagerDependencies {
  readonly archetypeLoader?: Pick<ArchetypeLoader, 'loadArchetype'> | undefined;
  readonly messageBus?: (Pick<AgentMessageBus, 'registerAgent'> & Partial<Pick<AgentMessageBus, 'unregisterAgent'>>) | undefined;
  /** Starts the contract a spawn that is not outside every contract becomes the owner of. */
  readonly contractRunner?: AgentContractRunner | null | undefined;
  readonly executor?: AgentExecutor | null | undefined;
  readonly configManager?: Pick<ConfigManager, 'get'> | undefined;
  /**
   * Bound on how many finished agents' final conversation snapshot are kept
   * in the retention ring (see getConversationSnapshot). Defaults to
   * DEFAULT_CONVERSATION_SNAPSHOT_RETENTION. Test-only knob in practice.
   */
  readonly conversationSnapshotRetention?: number | undefined;
  /**
   * How many finished agent records stay listed and readable; the oldest finished record past
   * this is dropped when a new agent is admitted. Defaults to DEFAULT_TERMINAL_AGENT_RETENTION.
   */
  readonly terminalAgentRetention?: number | undefined;
  /** The live provider registry, when wired up, enables bare model id resolution for spawn() overrides. */
  readonly providerRegistry?: Pick<ProviderRegistry, 'listModels'> | undefined;
  /** Trusted sibling graphs sharing this runtime's existing fleet.maxSize. */
  readonly additionalFleetOwnership?: (() => readonly AgentFleetOwnership[]) | undefined;
}

export type { ContractOwnerBinding, ContractUnitBinding } from './contract-binding.js';
/**
 * Conversation-snapshot tab attach point: default bound on how many recently
 * finished agents' final conversation snapshot AgentManager keeps around
 * after their live source is released. Without a bound, a long-lived process
 * that spawns many short-lived agents would retain every finished agent's
 * full message history forever, this is the "leaking unbounded memory" the
 * brief calls out. RUNNING agents are unaffected by this bound: their
 * snapshot is read live from the still-open ConversationManager, whose size
 * is already governed by the existing context-window compaction machinery
 * (core/context-compaction.ts), not by this retention ring.
 */
export const DEFAULT_CONVERSATION_SNAPSHOT_RETENTION = 20;

/** Finished agent records kept by default; each holds its full output and usage, so a long-lived process cannot keep them all. */
export const DEFAULT_TERMINAL_AGENT_RETENTION = 500;

/** The built-in agent kinds, by name, from the one template table. */
export const AGENT_TEMPLATES: Record<string, { description: string; defaultTools: string[] }> = Object.fromEntries(
  BUILTIN_AGENT_TEMPLATES.map((template) => [template.name, { description: template.description, defaultTools: [...template.tools] }]),
);


/** Legacy starts remain valid; owned starts require an explicit real receipt. */
export interface AgentContractRunner {
  startForOwner(record: AgentRecord, options?: ContractStartOptions): StartedContract | Promise<StartedContract>;
  assertOwnedExecution?: ContractRunner['assertOwnedExecution'];
  startOwnedForOwner?: ((record: AgentRecord, options?: ContractStartOptions) => OwnedStartedContract | Promise<OwnedStartedContract>);
}

/** An owned spawn was refused before admission because its driver cannot join. */
export class OwnedAgentExecutionUnavailableError extends Error {
  override readonly name = 'OwnedAgentExecutionUnavailableError';
  readonly code = 'OWNED_AGENT_EXECUTION_UNSUPPORTED' as const;
}

/** One captured invocation, not a later wake of the same mutable agent record. */
export interface OwnedAgentExecution {
  readonly record: AgentRecord;
  /** Immutable-at-settlement snapshot, taken before any queued wake starts. */
  readonly settled: Promise<AgentRecord>;
  cancel(): void;
}

interface OwnedSpawnContext {
  reserved(record: AgentRecord, slot: AgentExecutionSlot): void;
  startContract(record: AgentRecord, signal: AbortSignal): Promise<{ readonly settled: Promise<void>; cancel(reason: string): boolean }>;
}

interface AgentExecutionSlot {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  active: boolean;
}

interface AgentExecutionState {
  readonly work: OwnedScope;
  readonly slots: Set<AgentExecutionSlot>;
  tail?: Promise<void> | undefined;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private readonly executionModeOwners = new WeakMap<AgentRecord, ExecutionModeOwner>();
  /** The third-party surface an agent was started for, so a later wake runs under it instead of the waker's. */
  /** The channel turn an agent was started from: its surface, and its actor when that was a guest. */
  private readonly triggerSurfaces = new WeakMap<AgentRecord, { readonly surface: string; readonly actor?: Actor | undefined }>();
  /** Agents a turn acting on someone else's input started, with who that was (security/turn-input-party.ts). */
  private readonly otherPartySpawns = new WeakMap<AgentRecord, string>();
  /** The turn whose tool call started each agent: its request, and the id work it leaves is recovered against. */
  private readonly spawnTurns = new WeakMap<AgentRecord, TurnContext>();
  private readonly restoredContractUnits = new Set<string>();
  /** Agents with an admitted wake that has not started yet. */
  private readonly queuedWakes = new Set<string>();
  private readonly executionBoundaries = new Map<string, NonNullable<ContractUnitBinding['withCurrentExecution']>>();
  /** Actual per-agent invocations; terminal records alone do not prove cleanup. */
  private readonly executions = new Map<string, AgentExecutionState>();
  private runtimeBus: RuntimeEventBus | null = null;
  private readonly archetypeLoader: Pick<ArchetypeLoader, 'loadArchetype'>;
  private readonly messageBus: Pick<AgentMessageBus, 'registerAgent'> & Partial<Pick<AgentMessageBus, 'unregisterAgent'>>;
  private contractRunner: AgentContractRunner | null;
  /** A terminal program's way to the daemon's runner, in place of a contract runner (setWorkDelegation). */
  private workDelegation: AgentWorkDelegation | null = null;
  private executor: AgentExecutor | null;
  private readonly configManager: Pick<ConfigManager, 'get'> | null;
  private readonly additionalFleetOwnership: (() => readonly AgentFleetOwnership[]) | undefined;
  /** Told when a fleet slot becomes free (onFleetSlotReleased). */
  private readonly fleetSlotListeners = new Set<() => void>();
  /**
   * Live snapshot accessors for RUNNING agents (conversation-snapshot bridge).
   * Registered by the executor (orchestrator-runner.ts) right after it
   * creates the agent's ConversationManager; the manager never stores
   * messages itself while an agent is running, it just holds a callback.
   */
  private readonly conversationSources = new Map<string, (last?: number) => ConversationMessageSnapshot[]>();
  /**
   * Cooperative cancellation bridge: per-agent AbortSignal
   * registered by an orchestration-engine work item for the duration of one
   * phase run. AgentOrchestrator reads this via
   * setCancellationSource/getCancellationSignal and threads it into
   * toolRegistry.execute opts so opted-in tools (exec, fetch) can abort an
   * in-flight child process/request immediately, instead of only at the next
   * turn boundary's status poll. Purely additive, no caller is required to
   * register anything, and an agent with no registered signal behaves
   * exactly as before this change.
   */
  private readonly cancellationSignals = new Map<string, AbortSignal>();
  private readonly combinedCancellationSignals = new Map<string, { external: AbortSignal; owned: AbortSignal; signal: AbortSignal }>();
  /**
   * Manager-owned abort controllers, one per agent, the seam that lets
   * cancel()/kill genuinely abort an in-flight provider call (not only
   * cooperatively at the next turn/tool boundary). An orchestration engine may
   * ALSO register its own signal via registerCancellationSignal (either signal
   * then cancels the run); a
   * plain broker/ACP-spawned agent has no external signal and falls back to this
   * owned controller, which cancel() aborts.
   */
  private readonly cancellationControllers = new Map<string, AbortController>();
  /**
   * Frozen final snapshots for agents whose live source was released (their
   * run ended). Map insertion order doubles as the bounded ring's age order:
   * oldest entry (first key) is evicted once conversationSnapshotRetention is
   * exceeded. See getConversationSnapshot for the read-side contract.
   */
  private readonly frozenConversationSnapshots = new Map<string, ConversationMessageSnapshot[]>();
  private readonly conversationSnapshotRetention: number;
  private readonly terminalAgentRetention: number;
  private readonly providerRegistry: Pick<ProviderRegistry, 'listModels'> | null;

  constructor(deps: AgentManagerDependencies = {}) {
    this.archetypeLoader = deps.archetypeLoader ?? new ArchetypeLoader();
    this.messageBus = deps.messageBus ?? new AgentMessageBus();
    this.providerRegistry = deps.providerRegistry ?? null;
    this.contractRunner = deps.contractRunner ?? null;
    this.executor = deps.executor ?? null;
    this.configManager = deps.configManager ?? null;
    this.additionalFleetOwnership = deps.additionalFleetOwnership;
    this.conversationSnapshotRetention = deps.conversationSnapshotRetention ?? DEFAULT_CONVERSATION_SNAPSHOT_RETENTION;
    this.terminalAgentRetention = Math.max(0, deps.terminalAgentRetention ?? DEFAULT_TERMINAL_AGENT_RETENTION);
  }

  /**
   * Drops the oldest finished records beyond the retention bound. A record with live execution
   * work, a queued wake, or an unfinished child is never dropped, so nothing a running agent
   * still reads disappears.
   */
  private pruneTerminalRecords(): void {
    const terminal = [...this.agents.values()].filter(record =>
      (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled')
      && !this.executions.has(record.id) && !this.queuedWakes.has(record.id));
    const excess = terminal.length - this.terminalAgentRetention;
    if (excess <= 0) return;
    const parentsOfLive = new Set([...this.agents.values()]
      .filter(record => record.status === 'pending' || record.status === 'running')
      .map(record => record.parentAgentId));
    const oldestFirst = terminal.filter(record => !parentsOfLive.has(record.id))
      .sort((a, b) => (a.completedAt ?? a.startedAt) - (b.completedAt ?? b.startedAt));
    for (const record of oldestFirst.slice(0, excess)) {
      const id = record.id;
      this.agents.delete(id);
      // The bus keeps an identity and an inbox per agent; they go with the record.
      this.messageBus.unregisterAgent?.(id);
      this.executionBoundaries.delete(id);
      this.restoredContractUnits.delete(id);
      this.conversationSources.delete(id);
      this.cancellationSignals.delete(id);
      this.combinedCancellationSignals.delete(id);
      this.cancellationControllers.delete(id);
      this.frozenConversationSnapshots.delete(id);
    }
  }

  setRuntimeBus(runtimeBus: RuntimeEventBus | null): void {
    this.runtimeBus = runtimeBus;
  }

  /**
   * Be told each time an agent slot of this fleet becomes free: one of this
   * manager's executions settled (its cleanup included), or an owner counted
   * through additionalFleetOwnership reported a release with
   * {@link notifyFleetSlotReleased}. A listener runs after the slot no longer
   * counts, so {@link hasFleetCapacity} already sees it. Returns the unsubscribe.
   */
  onFleetSlotReleased(listener: () => void): () => void {
    this.fleetSlotListeners.add(listener);
    return () => { this.fleetSlotListeners.delete(listener); };
  }

  /** A slot of this fleet became free; also called by the owners counted through additionalFleetOwnership. */
  notifyFleetSlotReleased(): void {
    for (const listener of [...this.fleetSlotListeners]) {
      try {
        listener();
      } catch (error) {
        logger.warn('AgentManager: a fleet slot listener failed', { error: summarizeError(error) });
      }
    }
  }

  /** Local read-only occupancy; never recursively consults sibling views. */
  fleetOwnership(): readonly AgentFleetOwnership[] {
    const ids = new Set([...this.agents.keys(), ...this.executions.keys()]);
    return Object.freeze([...ids].map(id => {
      const status = this.agents.get(id)?.status;
      const active = status === 'pending' || status === 'running'
        || [...(this.executions.get(id)?.slots ?? [])].some(slot => slot.active);
      return Object.freeze({ id, active });
    }));
  }

  /**
   * The one count fleet.maxSize is checked against, by every admission (spawn,
   * batch spawn, wake, the elastic pool, a hosted ACP session): this manager's
   * active agents, its queued wakes (they take a slot as soon as they start),
   * and what the composition owns beyond them (sibling execution graphs, hosted
   * ACP sessions), passed in as additionalFleetOwnership.
   */
  fleetCount(): number {
    const active = new Set<string>();
    for (const agent of this.fleetOwnership()) if (agent.active) active.add(agent.id);
    for (const id of this.queuedWakes) active.add(id);
    for (const agent of this.additionalFleetOwnership?.() ?? []) if (agent.active) active.add(agent.id);
    return active.size;
  }

  /**
   * Whether a top-level spawn would find a free agent slot now: the same fleet
   * cap `spawn` refuses with an AgentCapacityError. Reads counts and settings
   * only, so a caller can learn the fleet is full before doing costly work for
   * a spawn that would be refused.
   */
  hasFleetCapacity(): boolean {
    if (!this.configManager) return true;
    const decision = evaluateOrchestrationSpawn({
      configManager: this.configManager, mode: 'manual-batch', activeAgents: this.fleetCount(), requestedDepth: 0,
    });
    return decision.allowed || decision.boundCap?.key !== 'fleet.maxSize';
  }

  private deriveEffectiveTools(
    input: AgentInput,
    defaultTools: string[],
  ): {
    tools: string[];
    capabilityCeilingTools?: string[] | undefined;
  } {
    const requestedTools = input.restrictTools
      ? [...(input.tools ?? [])]
      : input.tools
        ? [...new Set([...defaultTools, ...input.tools])]
        : [...defaultTools];

    if (!input.parentAgentId) {
      return { tools: requestedTools };
    }

    const parentRecord = this.agents.get(input.parentAgentId);
    if (!parentRecord) {
      throw new Error(`Unknown parent agent: '${input.parentAgentId}'`);
    }

    if (parentRecord.contractRole === 'owner' && input.outsideContract) {
      return {
        tools: requestedTools,
        capabilityCeilingTools: requestedTools,
      };
    }

    const parentCeiling = parentRecord.capabilityCeilingTools ?? parentRecord.tools;
    const tools = requestedTools.filter((tool) => parentCeiling.includes(tool));
    if (tools.length === 0) {
      throw new Error(`Spawned child agent would exceed parent capability ceiling from '${input.parentAgentId}'`);
    }

    return {
      tools,
      capabilityCeilingTools: [...parentCeiling],
    };
  }

  /**
   * Refuses a spawn requested by a contract leaf: a unit's
   * sub-agent or the contract planner never spawns agents of its own; the
   * contract plans sub-work. Emits CONTRACT_SPAWN_GUARD_TRIGGERED and throws.
   * AgentManager.spawn and the agent tool both call it before anything starts,
   * so the refusal is decided in this one place.
   */
  guardContractLeafSpawn(requesterAgentId: string | undefined): void {
    if (requesterAgentId === undefined) return;
    const requester = this.agents.get(requesterAgentId);
    if (!requester?.contractId || requester.contractRole === 'owner' || requester.contractRole === undefined) return;
    const reason = requester.contractRole === 'unit'
      ? 'units are leaves; the contract plans sub-work'
      : 'the contract planner is read-only; the contract plans sub-work';
    if (this.runtimeBus) {
      emitContractSpawnGuardTriggered(this.runtimeBus, {
        sessionId: 'agent-manager',
        traceId: `agent-manager:spawn-guard:${requester.id}`,
        source: 'agent-manager',
        agentId: requester.id,
      }, {
        contractId: requester.contractId,
        agentId: requester.id,
        depth: requester.orchestrationDepth + 1,
        activeAgents: this.fleetCount(),
        reason,
      });
    }
    throw new Error(reason);
  }

  /**
   * Spawn an agent. `binding` marks it as a contract unit's sub-agent (the
   * phase runner passes it for a contract work item) or as a contract's owner
   * record (the contract runner passes it). A spawn with neither binding and
   * without `outsideContract` becomes the owner of a new contract through the
   * composed contract runner's startForOwner, and runs no executor.
   */
  spawn(input: AgentInput, spawnBinding?: AgentConstructionBinding): AgentRecord {
    return this.spawnInternal(input, spawnBinding);
  }

  /**
   * Captures one spawn's cancellation and genuine settlement before publishing
   * it. A legacy contract driver is refused before any record/event/work exists.
   */
  spawnOwned(input: AgentInput, options: { readonly signal?: AbortSignal | undefined } = {}): OwnedAgentExecution {
    options = { ...options };
    input = classicAgentInput(input);
    options.signal?.throwIfAborted();
    const runner = this.contractRunner;
    const startOwned = runner?.startOwnedForOwner;
    // A terminal program hands it to the daemon as a piece of work; its settlement is the record's, followed there.
    const delegated = !input.outsideContract && this.delegatesToDaemon();
    if (!input.outsideContract && !delegated) {
      if (typeof startOwned !== 'function' || typeof this.contractRunner?.assertOwnedExecution !== 'function') {
        throw new OwnedAgentExecutionUnavailableError('Owned agent spawn requires a contract runner with owned execution settlement');
      }
      try {
        this.contractRunner.assertOwnedExecution();
      } catch (error) {
        throw new OwnedAgentExecutionUnavailableError(describeErrorInFull(error));
      }
    }
    let handle: OwnedAgentExecution | undefined;
    let abortRequested = false;
    let cancelContract: ((reason: string) => boolean) | undefined;
    const onAbort = (): void => { abortRequested = true; handle?.cancel(); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    try {
      if (abortRequested) options.signal!.throwIfAborted();
      this.spawnInternal(input, undefined, {
        reserved: (record, slot) => {
          // Attach this snapshot before a re-entrant observer can queue a wake.
          const settled = slot.settled.then(() => structuredClone(record));
          handle = {
            record,
            settled,
            cancel: () => {
              if (!slot.active) return;
              const cancelRecord = moveAgentRun(record, 'cancelled');
              if (cancelRecord) {
                record.terminationKind = 'kill';
                record.completedAt = Date.now();
              }
              slot.controller.abort();
              cancelContract?.('the owning hook was cancelled');
              if (cancelRecord && this.runtimeBus) {
                emitAgentCancelled(this.runtimeBus, {
                  sessionId: 'agent-manager', traceId: `agent-manager:${record.id}:cancel`, source: 'agent-manager', agentId: record.id,
                }, { agentId: record.id, reason: 'owning hook cancellation' });
              }
            },
          };
          void settled.then(
            () => options.signal?.removeEventListener('abort', onAbort),
            () => options.signal?.removeEventListener('abort', onAbort),
          );
          if (abortRequested) handle.cancel();
        },
        startContract: async (record, signal) => {
          if (delegated) {
            const work = await this.startDelegatedWork(record, signal);
            cancelContract = (reason) => work.cancel(reason);
            if (abortRequested || signal.aborted) cancelContract('the owning hook was cancelled');
            return work;
          }
          const current = () => {
            if (this.contractRunner !== runner || runner?.startOwnedForOwner !== startOwned)
              throw new OwnedAgentExecutionUnavailableError('The original owned contract driver changed');
          };
          current();
          const started = await startOwned!.call(runner, record, { signal, assertCurrent: current });
          cancelContract = (reason) => started.cancel(reason);
          if (abortRequested || signal.aborted) cancelContract('the owning hook was cancelled');
          try { current(); } catch (error) { started.cancel('the owned contract driver changed'); await started.settled; throw error; }
          return started;
        },
      });
      return handle!;
    } catch (error) {
      options.signal?.removeEventListener('abort', onAbort);
      throw error;
    }
  }

  private spawnInternal(input: AgentInput, spawnBinding?: AgentConstructionBinding, owned?: OwnedSpawnContext): AgentRecord {
    if (spawnBinding === undefined) input = classicAgentInput(input);
    const executionModeOwner = currentExecutionModeOwner();
    const triggerTurn = currentTurn();
    const triggerSurface = triggerTurn?.surface;
    const { unit: binding, owner: ownerBinding } = splitContractBinding(spawnBinding);
    const task = input.task;
    if (!task || typeof task !== 'string' || task.trim() === '') {
      throw new Error('spawn() requires a non-empty task string');
    }
    if (!this.configManager) {
      throw new Error('AgentManager requires configManager');
    }
    this.guardContractLeafSpawn(input.parentAgentId);
    const template = input.template ?? 'general';

    const archetype = this.archetypeLoader.loadArchetype(template);
    const templateDef = AGENT_TEMPLATES[template]! ?? AGENT_TEMPLATES.general;
    const defaultTools = archetype ? archetype.tools : templateDef.defaultTools;
    const toolResolution = this.deriveEffectiveTools(input, defaultTools);
    const tools = toolResolution.tools;

    if (!input.model && archetype?.model) {
      input = { ...input, model: archetype.model };
    }
    if (!input.provider && archetype?.provider) {
      input = { ...input, provider: archetype.provider };
    }

    const parentRecord = input.parentAgentId ? this.agents.get(input.parentAgentId) : undefined;
    if (input.parentAgentId && !parentRecord) {
      throw new Error(`Unknown parent agent: '${input.parentAgentId}'`);
    }
    const orchestrationDepth = parentRecord ? parentRecord.orchestrationDepth + 1 : 0;
    const activeAgents = this.fleetCount();
    const isContractOwnerChild = Boolean(parentRecord?.contractRole === 'owner' && input.outsideContract);
    const spawnDecision = evaluateOrchestrationSpawn({
      configManager: this.configManager,
      mode: input.parentAgentId && !isContractOwnerChild ? 'recursive-child' : 'manual-batch',
      activeAgents,
      requestedDepth: orchestrationDepth,
      ...(isContractOwnerChild ? { overrides: { recursionEnabled: true } } : {}),
    });
    if (!spawnDecision.allowed) {
      if (this.runtimeBus) {
        const guardContractId = parentRecord?.contractId;
        emitContractSpawnGuardTriggered(this.runtimeBus, {
          sessionId: 'agent-manager',
          traceId: `agent-manager:spawn-guard:${input.parentAgentId ?? 'root'}`,
          source: 'agent-manager',
          ...(input.parentAgentId ? { agentId: input.parentAgentId } : {}),
        }, {
          ...(guardContractId ? { contractId: guardContractId } : {}),
          agentId: input.parentAgentId ?? 'root',
          depth: orchestrationDepth,
          activeAgents,
          reason: spawnDecision.reason ?? 'spawn policy rejected the child worker',
        });
      }
      if (spawnDecision.boundCap?.key === 'fleet.maxSize') throw new AgentCapacityError(spawnDecision.reason ?? 'Fleet capacity reached');
      throw new Error(spawnDecision.reason ?? 'Spawn policy rejected the child worker');
    }

    const executionProtocol = input.executionProtocol ?? 'gather-plan-apply';
    const reviewMode = input.reviewMode ?? (input.outsideContract && !binding ? 'none' : 'contract');
    const communicationLane = input.communicationLane
      ?? (input.parentAgentId ? 'parent-only' : input.cohort ? 'cohort' : 'direct');
    const modelCandidates = this.providerRegistry?.listModels();
    const provider = input.provider?.trim() || undefined;
    const model = requireProviderQualifiedModel(input.model, 'Agent model overrides', modelCandidates, provider);
    if (!model && provider) {
      throw new AgentSpawnInputError('Agent provider routing requires a provider-qualified model when provider is supplied.');
    }
    if (model && provider && !sameProviderCatalog(splitModelRegistryKey(model).providerId, provider)) {
      throw new AgentSpawnInputError(`Agent model override '${model}' conflicts with provider '${provider}'.`);
    }
    const fallbackModels = normalizeProviderQualifiedModelList(input.fallbackModels, 'Agent fallback models', modelCandidates);
    const routingFallbackModels = normalizeProviderQualifiedModelList(input.routing?.fallbackModels, 'Agent routing fallback models', modelCandidates);
    const effectiveFallbackModels = input.routing?.providerFailurePolicy === 'fail'
      ? undefined
      : routingFallbackModels ?? fallbackModels;
    if (
      input.routing?.providerFailurePolicy === 'ordered-fallbacks'
      && !effectiveFallbackModels?.length
    ) {
      throw new AgentSpawnInputError('Agent ordered fallback routing requires at least one provider-qualified fallback model.');
    }
    if (input.routing?.providerFailurePolicy === 'fail' && (routingFallbackModels?.length || fallbackModels?.length)) {
      throw new AgentSpawnInputError('Agent fail routing cannot include fallback models; use ordered-fallbacks to enable model failover.');
    }

    const startsContract = !input.outsideContract && !binding && !ownerBinding;
    if (startsContract && !this.contractRunner && !this.workDelegation) {
      throw new Error('No contract runner is composed: a spawn that is not outside every contract starts a contract, and this AgentManager has no contract runner to start it.');
    }

    const id = ownerBinding?.restoredOwnerId ?? `agent-${crypto.randomUUID().slice(0, 8)}`;
    const assertOwnerIdentity = (): void => {
      const existing = this.agents.get(id);
      if (existing && (existing.contractId !== ownerBinding?.contractId || existing.contractRole !== 'owner'
        || existing.status === 'running' || existing.status === 'pending' || this.executions.has(id))) {
        throw new Error(`Cannot restore contract owner over an existing agent: '${id}'`);
      }
    };
    assertOwnerIdentity();
    const orchestrationGraphId = input.orchestrationGraphId
      ?? parentRecord?.orchestrationGraphId
      ?? (input.cohort ? `cohort:${input.cohort}` : undefined);
    const orchestrationNodeId = orchestrationGraphId ? (input.orchestrationNodeId ?? id) : undefined;
    const parentNodeId = input.parentNodeId ?? parentRecord?.orchestrationNodeId;
    // The session that started this agent: the spawner's, else its parent's, else (a contract unit) its contract owner's.
    const sessionId = input.sessionId ?? parentRecord?.sessionId ?? (binding ? this.contractSessionId(binding.contractId) : undefined);
    // What its spending is for (Money, Spending): the host's word, else the agent that started it, else the work it is a
    // step of; a piece of work's own record is named by what was asked.
    const spendingSource = input.spendingSource ?? parentRecord?.spendingSource
      ?? (binding ? this.contractSpendingSource(binding.contractId) : undefined)
      ?? (ownerBinding || startsContract ? `work "${spendingName(task)}"` : undefined);
    const record: AgentRecord = {
      ...(decisionModelPolicyState().operation === 'no-decision-model' ? { decisionPolicy: decisionModelPolicyState() } : {}),
      id,
      task,
      template,
      model,
      provider,
      fallbackModels: effectiveFallbackModels,
      routing: input.routing
        ? {
            ...input.routing,
            ...(effectiveFallbackModels ? { fallbackModels: effectiveFallbackModels } : {}),
          }
        : undefined,
      executionIntent: input.executionIntent,
      reasoningEffort: input.reasoningEffort,
      context: input.context,
      tools, ...(input.captureAuthority ? { captureAuthority: input.captureAuthority } : {}),
      orchestrationDepth,
      executionProtocol,
      reviewMode,
      communicationLane,
      systemPromptAddendum: input.systemPromptAddendum,
      proposedUnits: input.proposedUnits,
      status: 'pending',
      startedAt: Date.now(),
      toolCallCount: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        llmCallCount: 0,
        turnCount: 0,
        reasoningSummaryCount: 0,
      },
      outsideContract: input.outsideContract,
      ...(input.replyStyle ? { replyStyle: input.replyStyle } : {}),
      workingDirectory: input.workingDirectory,
      cohort: input.cohort,

      ...(orchestrationGraphId ? {
        orchestrationGraphId,
        orchestrationNodeId,
      } : {}),
      ...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
      ...(parentNodeId ? { parentNodeId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(spendingSource ? { spendingSource } : {}),
      ...(binding ? { contractId: binding.contractId, contractRole: 'unit' as const, contractUnitId: binding.contractUnitId } : {}),
      ...(ownerBinding ? { contractId: ownerBinding.contractId, contractRole: 'owner' as const } : {}),
      ...(binding?.routeReason ? { routeReason: binding.routeReason } : {}),
      ...(toolResolution.capabilityCeilingTools ? { capabilityCeilingTools: toolResolution.capabilityCeilingTools } : {}),
      ...(input.successCriteria ? { successCriteria: [...input.successCriteria] } : {}),
      ...(input.requiredEvidence ? { requiredEvidence: [...input.requiredEvidence] } : {}),
      ...(input.writeScope ? { writeScope: [...input.writeScope] } : {}),
    };

    if (spawnBinding && 'proposalConsumer' in spawnBinding && spawnBinding.proposalConsumer === 'contract-plan') bindContractPlanConsumer(record);
    if (spawnBinding && 'inputReadAuthority' in spawnBinding) bindContractInputAuthority(record, spawnBinding.inputReadAuthority);
    bindContractActionSignal(record, spawnBinding && 'autonomousSignal' in spawnBinding ? spawnBinding.autonomousSignal : undefined);
    bindContractActionSource(record, spawnBinding && 'autonomousSource' in spawnBinding ? spawnBinding.autonomousSource : undefined,
      spawnBinding && 'autonomousPort' in spawnBinding ? spawnBinding.autonomousPort : undefined);
    const reserve = () => {
      assertOwnerIdentity();
      if (this.additionalFleetOwnership) {
        // Routing and supplied registry readers above can re-enter a sibling
        // manager. Recheck at the synchronous reservation boundary, with no
        // await or published callback between this check and pending insertion.
        const admission = evaluateOrchestrationSpawn({ configManager: this.configManager!, mode: 'manual-batch',
          activeAgents: this.fleetCount(), requestedDepth: orchestrationDepth });
        if (!admission.allowed) {
          if (admission.boundCap?.key === 'fleet.maxSize') throw new AgentCapacityError(admission.reason ?? 'Shared fleet capacity reached');
          throw new Error(admission.reason ?? 'Shared fleet admission refused');
        }
      }
      if (executionModeOwner) this.executionModeOwners.set(record, executionModeOwner);
      if (triggerSurface !== undefined) this.triggerSurfaces.set(record, { surface: triggerSurface, ...(triggerTurn?.actor !== undefined ? { actor: triggerTurn.actor } : {}) });
      if (triggerTurn) this.spawnTurns.set(record, triggerTurn);
      // An agent a turn on someone else's input started acts on that input too (security/turn-input-party.ts).
      const spawnParty = turnInputParty();
      if (spawnParty.party === 'other') this.otherPartySpawns.set(record, spawnParty.who);
      this.pruneTerminalRecords();
      this.agents.set(id, record);
      return this.reserveExecution(id);
    };
    // Reserve before publishing the record or invoking any re-entrant callback.
    const { begin, controller, slot } = this.additionalFleetOwnership ? reserveSharedFleet(reserve) : reserve();
    this.cancellationControllers.set(id, controller);
    if (binding?.withCurrentExecution !== undefined) this.executionBoundaries.set(id, binding.withCurrentExecution);
    owned?.reserved(record, slot);
    try {
      this.messageBus.registerAgent({
        agentId: id,
        template,
        parentAgentId: input.parentAgentId,
        cohort: input.cohort,
        contractId: record.contractId,
      });
      if (this.runtimeBus) {
        const taskContract: AgentTaskContract = {
          allowedTools: [...record.tools],
          capabilityCeiling: [...(record.capabilityCeilingTools ?? record.tools)],
          ...(record.successCriteria ? { successCriteria: [...record.successCriteria] } : {}),
          ...(record.requiredEvidence ? { requiredEvidence: [...record.requiredEvidence] } : {}),
          ...(record.writeScope ? { writeScope: [...record.writeScope] } : {}),
          executionProtocol: record.executionProtocol,
          reviewMode: record.reviewMode,
          inheritsParentConstraints: Boolean(record.parentAgentId),
          communicationLane: record.communicationLane,
        };
        emitAgentSpawning(this.runtimeBus, {
          sessionId: 'agent-manager',
          traceId: `agent-manager:${id}`,
          source: 'agent-manager',
        }, {
          agentId: id,
          task,
          ...(record.parentAgentId ? { parentAgentId: record.parentAgentId } : {}),
          ...(record.contractUnitId ? { contractId: record.contractId, contractRole: record.contractRole, contractUnitId: record.contractUnitId } : {}),
          ...(ownerBinding ? { contractId: ownerBinding.contractId, contractRole: 'owner' as const } : {}),
          ...(record.orchestrationGraphId ? { orchestrationGraphId: record.orchestrationGraphId } : {}),
          ...(record.parentNodeId ? { parentNodeId: record.parentNodeId } : {}),
          taskContract,
        });
      }
      if (ownerBinding) {
        begin(ownerBinding.settled);
        return startContractOwner(record, ownerBinding, this.runtimeBus);
      }

      if (startsContract) {
        try {
          const starting = owned ? owned.startContract(record, controller.signal)
            // A terminal program's spawn (a team's, a recipe's agents): handed to the daemon as a piece of work.
            : this.delegatesToDaemon() ? this.startDelegatedWork(record, controller.signal)
              : this.contractRunner!.startForOwner(record, { signal: controller.signal });
          const notStarted = this.delegatesToDaemon() ? 'It was not handed to the daemon as a piece of work' : 'The contract could not start';
          begin(Promise.resolve(starting).then(started => started.settled).catch(error => {
            // Publish the failed/cancelled record only after startup and its
            // cleanup drained, just as standalone executor settlement does.
            if (moveAgentRun(record, 'failed')) this.publishFailed(record, `${notStarted}: ${describeErrorInFull(error)}`);
          }));
        } catch (error) {
          if (moveAgentRun(record, 'failed')) this.publishFailed(record, `${this.delegatesToDaemon() ? 'It was not handed to the daemon as a piece of work' : 'The contract could not start'}: ${describeErrorInFull(error)}`);
          throw error;
        }
        return record;
      }

      if (this.executor && record.status !== 'cancelled') {
        const executor = this.executor;
        const execute = () => {
          if (controller.signal.aborted || record.status === 'cancelled') return Promise.resolve();
          const owner = this.executionModeOwners.get(record);
          return this.runUnderTriggerSurface(record, () => detachedFromInvocation(owner, () => executor.runAgent(record)));
        };
        const boundary = this.executionBoundaries.get(id);
        begin((boundary === undefined ? execute() : Promise.resolve().then(() => boundary(execute))).catch((error) => {
          // A late rejection must not relabel a cancelled run, and a run that
          // already failed keeps its first, more specific error; neither is lost silently.
          this.failRejectedRun(record, error, 'Agent run rejected after it had settled');
        }));
      } else if (moveAgentRun(record, 'failed')) {
        this.publishFailed(record, 'Agent executor is not configured');
        begin();
      } else {
        begin();
      }

      return record;
    } catch (error) {
      begin();
      // A spawn that failed after reservation must not stay pending: a pending record holds a fleet slot for good.
      if (moveAgentRun(record, 'failed')) {
        try { this.publishFailed(record, `The agent could not start: ${describeErrorInFull(error)}`); }
        catch (publishError) { logger.warn('AgentManager: could not publish a failed spawn', { agentId: id, error: summarizeError(publishError) }); }
      }
      throw error;
    }
  }

  private reserveExecution(agentId: string): {
    readonly begin: (operation: PromiseLike<void> | void) => void;
    readonly controller: AbortController;
    readonly previous: Promise<void> | undefined;
    readonly slot: AgentExecutionSlot;
  } {
    let state = this.executions.get(agentId);
    if (!state) {
      state = { work: new OwnedScope('agent execution'), slots: new Set() };
      this.executions.set(agentId, state);
    }
    const owner = state;
    const previous = owner.tail;
    let begin!: (operation: PromiseLike<void> | void) => void;
    const settled = new Promise<void>((resolve) => { begin = resolve; });
    const slot: AgentExecutionSlot = { settled, controller: new AbortController(), active: true };
    const release = (): void => {
      slot.active = false;
      this.notifyFleetSlotReleased();
    };
    void settled.then(release, release);
    owner.slots.add(slot);
    owner.tail = settled;
    const reclaim = (): void => {
      owner.slots.delete(slot);
      // Identity plus actual idleness prevents an old cleanup from removing a
      // newer admission. clear() does not drop still-live execution ownership.
      if (owner.work.idle && this.executions.get(agentId) === owner) {
        this.executions.delete(agentId);
        this.cancellationControllers.delete(agentId);
        this.combinedCancellationSignals.delete(agentId);
      }
    };
    void owner.work.run('agent execution', () => settled).then(reclaim, reclaim);
    return { begin, controller: slot.controller, previous, slot };
  }

  /**
   * Joins admitted executor/contract work, including async finally cleanup.
   * Cancellation and outward terminal statuses are deliberately not evidence.
   * A later independent wake after this barrier is a new execution.
   */
  join(agentId: string): Promise<void> {
    return this.executions.get(agentId)?.work.join() ?? Promise.resolve();
  }

  /**
   * Re-trigger a wedged agent's processing loop with a steer message as input.
   *
   * Only a terminally-FAILED agent is woken by default. Its outward status
   * may precede async cleanup, so the admitted wake waits for that actual
   * invocation before re-entering the executor. A
   * genuinely-running agent is left alone (its steer is delivered through the
   * message bus and drained at its next turn boundary); a cancelled agent is
   * never woken. A completed agent is woken only with `allowCompleted` and only
   * when it is a contract unit's sub-agent (`contractUnitId` set): the contract
   * runner reopens a unit whose work a later check found failing. The fleet
   * steer path passes no options, so operator behaviour is unchanged. The re-run
   * restores context from the frozen transcript tail (a summary, not a risky
   * tool-call replay) and appends the steer as a fresh user turn.
   */
  wakeWithSteer(agentId: string, steer: string, options: { readonly allowCompleted?: boolean; readonly referenceOnly?: true } = {}): { woke: boolean; reason: string } {
    const referenceOnly = options.referenceOnly === true;
    const record = this.agents.get(agentId);
    if (!record) return { woke: false, reason: 'unknown-agent' };
    if (this.restoredContractUnits.has(agentId)) return { woke: false, reason: 'contract-unit-requires-resume' };
    // The record keeps its outcome until the queued run starts (an owned
    // handle's settled snapshot reads it), so the queue itself refuses a second wake.
    if (this.queuedWakes.has(agentId)) return { woke: false, reason: `a wake for agent ${agentId} is already queued; it starts when the previous run's clean-up ends` };
    const wakeCompleted = record.status === 'completed' && options.allowCompleted === true && Boolean(record.contractUnitId);
    if (record.status !== 'failed' && !wakeCompleted) {
      return { woke: false, reason: `agent status is '${record.status}', not a wedged/failed loop` };
    }
    if (!this.executor) return { woke: false, reason: 'no executor configured' };
    if (typeof steer !== 'string' || steer.trim().length === 0) {
      return { woke: false, reason: 'empty steer message' };
    }
    const executor = this.executor;
    // One admission for both compositions: the fleet cap is checked, and the record keeps its previous
    // outcome until the queued run starts (the reserved slot already counts as occupied).
    const admit = (): ReturnType<AgentManager['reserveExecution']> => {
      if (this.configManager) {
        const alreadyOwned = this.fleetOwnership().some(agent => agent.id === agentId && agent.active);
        const admission = evaluateOrchestrationSpawn({ configManager: this.configManager, mode: 'manual-batch',
          activeAgents: this.fleetCount() - (alreadyOwned ? 1 : 0), requestedDepth: record.orchestrationDepth });
        if (!admission.allowed) throw new Error(admission.reason ?? 'Fleet capacity reached');
      }
      return this.reserveExecution(agentId);
    };
    let reservation: ReturnType<AgentManager['reserveExecution']>;
    try {
      reservation = this.additionalFleetOwnership ? reserveSharedFleet(admit) : admit();
    } catch (error) { return { woke: false, reason: error instanceof Error ? error.message : String(error) }; }
    this.queuedWakes.add(agentId);
    const { begin, controller, previous } = reservation;
    const start = (): Promise<void> | void => {
      this.queuedWakes.delete(agentId);
      // Cancellation covers the queued admission too, without aborting an
      // unrelated future wake admitted after this one actually settles.
      if (controller.signal.aborted) return;
      // An aborted engine signal belongs to the ended phase. A fresh wake
      // cannot inherit that old cancellation; a still-live phase keeps its
      // exact external signal identity and authority.
      if (this.cancellationSignals.get(agentId)?.aborted) this.cancellationSignals.delete(agentId);
      this.cancellationControllers.set(agentId, controller);
      const priorSummary = this.summarizeTranscriptTailForWake(agentId);
      const execute = () => {
        if (controller.signal.aborted || record.status === 'cancelled') return Promise.resolve();
        // From here the previous run's outcome no longer describes the record. A
        // boundary that refuses the run never calls this, so the outcome stays.
        record.resumeSteer = { steer, ...(priorSummary ? { priorSummary } : {}), ...(referenceOnly ? { referenceOnly: true as const } : {}) };
        record.error = undefined;
        record.failureStatus = undefined;
        record.failureCode = undefined;
        record.failureRetryAfterMs = undefined;
        record.failureReason = undefined;
        record.turnBudget = undefined;
        record.completedAt = undefined;
        moveAgentRun(record, 'pending');
        // Surfaces dropped every event for a finished run; this marked event is
        // the one that tells them the run lives again.
        if (this.runtimeBus) {
          emitAgentRunning(this.runtimeBus, {
            sessionId: 'agent-manager', traceId: `agent-manager:${record.id}:wake`, source: 'agent-manager', agentId: record.id,
          }, { agentId: record.id, wake: true });
        }
        const owner = this.executionModeOwners.get(record);
        return this.runUnderTriggerSurface(record, () => detachedFromInvocation(owner, () => executor.runAgent(record)));
      };
      const boundary = this.executionBoundaries.get(agentId);
      return boundary === undefined ? execute() : boundary(execute);
    };
    let running: Promise<void>;
    try {
      running = previous ? previous.then(start, start) : Promise.resolve(start());
    } catch (error) {
      running = Promise.reject(error);
    }
    begin(running.catch((error) => {
      // The started wake made the record pending; a run the executor already
      // failed itself has reported that, so it is not reported again. A wake
      // refused before it started leaves the previous run's outcome as it was.
      this.failRejectedRun(record, error, 'Agent wake rejected after the run had settled');
    }));
    return { woke: true, reason: previous ? 'wake admitted; waiting for prior execution cleanup' : `re-triggered from ${wakeCompleted ? 'completed' : 'failed'} state with steer` };
  }

  /**
   * Runs as a turn of the agent itself: under the surface (and guest actor)
   * it was started for, so an owner-started agent runs as the owner's even
   * when the waker is a channel turn; with its own id as the caller, so what
   * it spawns names it as the parent; with the request it was started for.
   */
  private runUnderTriggerSurface<T>(record: AgentRecord, run: () => T): T {
    const trigger = this.triggerSurfaces.get(record);
    const spawnTurn = this.spawnTurns.get(record);
    const turn = (): T => withAgentTurn({
      agentId: record.id,
      surface: trigger?.surface,
      ...(trigger?.actor !== undefined ? { actor: trigger.actor } : {}),
      sessionId: record.sessionId ?? spawnTurn?.ownerSessionId ?? null,
      requestText: spawnTurn?.requestText ?? null,
    }, run);
    const otherParty = this.otherPartySpawns.get(record);
    return otherParty === undefined ? turn() : withOtherPartyInput(otherParty, turn);
  }

  /** The id of the turn whose call started an agent; undefined for an agent no turn started (a schedule, a channel spawn outside one). */
  requestTurnOf(agentId: string): string | undefined {
    const record = this.agents.get(agentId);
    return record ? this.spawnTurns.get(record)?.turnId : undefined;
  }

  /**
   * Records an executor rejection. Only a run this rejection actually moves to
   * failed publishes AGENT_FAILED: a run the executor already settled (and
   * reported) or one that was cancelled keeps its outcome and is not reported twice.
   */
  private failRejectedRun(record: AgentRecord, error: unknown, settledMessage: string): void {
    if (!moveAgentRun(record, 'failed')) {
      logger.warn(settledMessage, { agentId: record.id, status: record.status, error: summarizeError(error) });
      return;
    }
    this.publishFailed(record, describeErrorInFull(error, { ...(record.provider ? { provider: record.provider } : {}) }));
  }

  /**
   * Completes a record this manager just moved to failed and reports it. Phase
   * runners and the contract runner learn of an agent's end only from its
   * terminal event; a failure without one leaves them waiting forever.
   */
  private publishFailed(record: AgentRecord, error: string): void {
    record.error = error;
    record.completedAt = Date.now();
    if (!this.runtimeBus) return;
    emitAgentFailed(this.runtimeBus, {
      sessionId: 'agent-manager',
      traceId: `agent-manager:${record.id}:failed`,
      source: 'agent-manager',
      agentId: record.id,
    }, { agentId: record.id, error, durationMs: Math.max(0, record.completedAt - record.startedAt) });
  }

  /** Build an honest prior-context summary from the frozen transcript tail for a wake. */
  private summarizeTranscriptTailForWake(agentId: string): string | undefined {
    const snapshot = this.getConversationSnapshot(agentId);
    if (!snapshot || snapshot.length === 0) return undefined;
    const tail = snapshot.slice(-6).map((message) => {
      const raw = (message as { content?: unknown }).content;
      const text = typeof raw === 'string' ? raw : '[structured content]';
      const preview = text.replace(/\s+/g, ' ').trim().slice(0, 200);
      return `${message.role}: ${preview}`;
    });
    return `Prior run before this steer, last ${tail.length} transcript message(s):\n${tail.join('\n')}`;
  }

  getStatus(id: string): AgentRecord | null {
    return this.agents.get(id) ?? null;
  }

  cancel(id: string, kind: 'interrupt' | 'kill' = 'kill'): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    const cancelRecord = moveAgentRun(record, 'cancelled');
    if (cancelRecord) {
      record.terminationKind = kind;
      record.completedAt = Date.now();
    }
    // Snapshot admission before abort listeners run: they may admit a later
    // independent wake, which this cancellation must not accidentally inherit.
    const slots = [...(this.executions.get(id)?.slots ?? [])];
    for (const slot of slots) slot.controller.abort();
    // Outward failure/completion can precede finally cleanup. The abort above
    // still reaches it without rewriting the terminal record or emitting twice.
    if (cancelRecord) {
      // Abort the manager-owned controller so an in-flight provider call for this
      // agent is interrupted mid-stream, not only cooperatively at the next
      // boundary, including when an orchestration signal also owns the run. Create the
      // controller if the runner has not read the signal yet, so a later
      // getCancellationSignal() returns THIS already-aborted controller, no race
      // where a cancel is dropped because the signal was requested afterwards.
      let controller = this.cancellationControllers.get(id);
      if (!controller) {
        controller = new AbortController();
        this.cancellationControllers.set(id, controller);
      }
      controller.abort();
      if (this.runtimeBus) {
        emitAgentCancelled(this.runtimeBus, {
          sessionId: 'agent-manager',
          traceId: `agent-manager:${record.id}:cancel`,
          source: 'agent-manager',
          agentId: record.id,
        }, {
          agentId: record.id,
          reason: 'operator cancellation',
        });
      }
    }
    this.agents.set(id, record);
    // True only when the cancellation took effect: the run moved to cancelled, or live work for it was aborted.
    // A record that had already finished has nothing left to stop.
    return cancelRecord || slots.some(slot => slot.active);
  }

  /**
   * Register the live conversation-snapshot source for a running agent
   * (conversation-snapshot bridge). Called by the executor (orchestrator-runner.ts)
   * once its ConversationManager exists, `source` is invoked on demand by
   * getConversationSnapshot(); the manager never copies or stores the
   * messages itself while the agent is running.
   */
  registerConversationSource(agentId: string, source: (last?: number) => ConversationMessageSnapshot[]): void {
    this.conversationSources.set(agentId, source);
  }

  /**
   * Cooperative cancellation bridge: register the AbortSignal
   * an orchestration engine's cancellation registry created for a work
   * item's current agent. Called by the engine right after
   * AgentManager.spawn() so the signal is in place before the agent's first
   * turn/tool call.
   */
  registerCancellationSignal(agentId: string, signal: AbortSignal): void {
    this.cancellationSignals.set(agentId, signal);
    this.combinedCancellationSignals.delete(agentId);
  }

  /** Drop the registered signal + owned controller once the run ends (success, failure, or cancel). Safe to call unconditionally. */
  releaseCancellationSignal(agentId: string, expectedSignal?: AbortSignal): void {
    if (expectedSignal !== undefined && this.cancellationSignals.get(agentId) !== expectedSignal) return;
    this.cancellationSignals.delete(agentId);
    this.combinedCancellationSignals.delete(agentId);
    // A delayed prior phase release must not delete a newly admitted wake's
    // owned controller. Its actual execution settlement reclaims that itself.
    if (!this.executions.has(agentId)) this.cancellationControllers.delete(agentId);
  }

  /**
   * The cancellation signal for an agent's in-flight work. An
   * engine-registered external signal and manager cancellation both stop work.
   * Without an external owner, a manager-owned controller's signal is
   * returned (created on first read), so a plain broker/ACP-spawned agent still
   * has an abortable signal that cancel() will trip.
   */
  getCancellationSignal(agentId: string): AbortSignal | undefined {
    const external = this.cancellationSignals.get(agentId);
    let controller = this.cancellationControllers.get(agentId);
    if (!controller) {
      controller = new AbortController();
      this.cancellationControllers.set(agentId, controller);
    }
    if (external) {
      const retained = this.combinedCancellationSignals.get(agentId);
      if (retained?.external === external && retained.owned === controller.signal) return retained.signal;
      const signal = AbortSignal.any([external, controller.signal]);
      this.combinedCancellationSignals.set(agentId, { external, owned: controller.signal, signal });
      return signal;
    }
    return controller.signal;
  }

  /**
   * Release the live source for an agent whose run has ended, freezing one
   * final snapshot into the bounded retention ring (see
   * DEFAULT_CONVERSATION_SNAPSHOT_RETENTION) so a transcript tab that was
   * open at the moment of completion keeps showing content instead of going
   * blank. Once evicted (oldest-first, beyond the retention bound),
   * getConversationSnapshot falls back to an empty array, callers past that
   * point are expected to degrade to the on-disk event ledger (TUI
   * Part C6's documented fallback for completed/detached agents).
   *
   * Safe to call even when no source was ever registered for this agentId
   * (e.g. a contract owner record, which never runs its own turn loop).
   */
  releaseConversationSource(agentId: string): void {
    const source = this.conversationSources.get(agentId);
    if (!source) return;
    this.conversationSources.delete(agentId);
    let finalSnapshot: ConversationMessageSnapshot[];
    try {
      finalSnapshot = source();
    } catch (error) {
      logger.warn('AgentManager: conversation source threw on release', { agentId, error: summarizeError(error) });
      return;
    }
    // Re-insert at the end (freshest) even if already present, so the ring's
    // insertion order tracks recency of completion, not first appearance.
    this.frozenConversationSnapshots.delete(agentId);
    this.frozenConversationSnapshots.set(agentId, finalSnapshot);
    while (this.frozenConversationSnapshots.size > this.conversationSnapshotRetention) {
      const oldestKey = this.frozenConversationSnapshots.keys().next().value;
      if (oldestKey === undefined) break;
      this.frozenConversationSnapshots.delete(oldestKey);
    }
  }

  /**
   * The conversation-snapshot tab attach point: a full-fidelity conversation history for a
   * fleet agent (ConversationMessageSnapshot[], the same shape the main
   * session surface renders via MessageLineCache/conversation.ts).
   *
   * - RUNNING agent with a registered source → the current live snapshot.
   * - Agent whose run just ended → the frozen final snapshot, until evicted
   *   from the bounded retention ring (oldest-first beyond
   *   conversationSnapshotRetention completed agents).
   * - Unknown agent, or one long since evicted → empty array. The disk
   *   ledger (<agentId>.jsonl, written by AgentSession) is NOT a substitute
   *   for this array, it is a truncated event log (tool args/results
   *   sliced to 500 chars, no assistant message text), so callers past
   *   eviction get a degraded activity view, never a fabricated replay.
   *
   * `last` limits the read to the newest messages: a live source copies only
   * those, so a view that shows a tail does not copy the whole history.
   */
  getConversationSnapshot(agentId: string, options: { readonly last?: number | undefined } = {}): ConversationMessageSnapshot[] {
    const last = options.last !== undefined ? Math.max(0, Math.floor(options.last)) : undefined;
    const liveSource = this.conversationSources.get(agentId);
    if (liveSource) {
      try {
        return liveSource(last);
      } catch (error) {
        logger.warn('AgentManager: conversation source threw', { agentId, error: summarizeError(error) });
        return [];
      }
    }
    const frozen = this.frozenConversationSnapshots.get(agentId) ?? [];
    return last === undefined ? frozen : frozen.slice(frozen.length - Math.min(last, frozen.length));
  }

  listByGraph(graphId: string): AgentRecord[] {
    return this.list().filter((agent) => agent.orchestrationGraphId === graphId);
  }

  cancelSubtree(rootAgentId: string): string[] {
    const cancelled: string[] = [];
    const queue = [rootAgentId];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (seen.has(currentId)) continue;
      seen.add(currentId);
      const record = this.agents.get(currentId);
      if (!record) continue;
      if (this.cancel(currentId)) cancelled.push(currentId);
      for (const child of this.agents.values()) {
        if (child.parentAgentId === currentId) queue.push(child.id);
      }
    }
    return cancelled;
  }

  cancelGraph(graphId: string): string[] {
    const cancelled: string[] = [];
    for (const agent of this.listByGraph(graphId)) {
      if (this.cancel(agent.id)) cancelled.push(agent.id);
    }
    return cancelled;
  }

  /** Every record, or with `sessionId` only the agents that session started (AgentRecord.sessionId). */
  list(filter?: { readonly sessionId?: string | undefined }): AgentRecord[] {
    const records = Array.from(this.agents.values());
    const sessionId = filter?.sessionId;
    return sessionId === undefined ? records : records.filter((agent) => agent.sessionId === sessionId);
  }

  /** The session that started a contract, read from its owner record. */
  private contractSessionId(contractId: string): string | undefined {
    for (const agent of this.agents.values()) {
      if (agent.contractId === contractId && agent.contractRole === 'owner') return agent.sessionId;
    }
    return undefined;
  }

  /** What a contract's spending is for: its owner record's (the work, or the schedule or session that started it). */
  private contractSpendingSource(contractId: string): string | undefined {
    for (const agent of this.agents.values()) {
      if (agent.contractId === contractId && agent.contractRole === 'owner') return agent.spendingSource;
    }
    return undefined;
  }

  listByCohort(cohort: string): AgentRecord[] {
    return [...this.agents.values()].filter((agent) => agent.cohort === cohort);
  }

  /** The agents still pending or running. */
  listActive(): AgentRecord[] {
    return [...this.agents.values()].filter((agent) => agent.status === 'pending' || agent.status === 'running');
  }

  /**
   * Forgets every record, running ones included: a running agent keeps running
   * with nothing left to list, message or cancel it. A caller that replaces the
   * records (loading a saved session) refuses first while {@link listActive} is not empty.
   */
  clear(): void {
    this.agents.clear();
    this.executionBoundaries.clear();
    this.restoredContractUnits.clear();
    this.conversationSources.clear();
    this.frozenConversationSnapshots.clear();
  }

  exportState(): AgentRecord[] {
    return [...this.agents.values()].map((agent) => {
      const { fullOutput, ...rest } = agent;
      return {
        ...rest,
        ...(agent.status === 'running' || agent.status === 'pending'
          ? { status: 'failed' as const, error: agent.error ?? 'interrupted by a restart' }
          : {}),
      };
    });
  }

  importState(records: AgentRecord[]): void {
    for (const record of records) {
      if (record.status === 'running' || record.status === 'pending' || this.executionBoundaries.has(record.id)) continue;
      // A serialized record cannot carry the live native execution fence. The contract runner
      // must recover its checkpoint and obtain current authority before creating a fresh unit.
      if (record.contractUnitId !== undefined) this.restoredContractUnits.add(record.id);
      this.agents.set(record.id, record);
    }
  }

  setExecutor(executor: AgentExecutor | null): void {
    this.executor = executor;
  }

  /** Composes the contract runner that spawns not outside every contract start through. */
  setContractRunner(runner: AgentContractRunner | null): void {
    this.contractRunner = runner;
  }

  /**
   * A terminal program's way to the daemon's runner (work-delegation.ts): with it, a spawn that is not outside every
   * contract becomes a piece of work on the daemon, not a contract here. A program composes it and no contract runner.
   */
  setWorkDelegation(delegation: AgentWorkDelegation | null): void {
    this.workDelegation = delegation;
  }

  /** True when spawns that are not outside every contract are handed to the daemon as work (a terminal program). */
  delegatesToDaemon(): boolean {
    return this.workDelegation !== null && this.contractRunner === null;
  }

  /**
   * Stop following the work handed to the daemon (a headless run ending or cancelled): each runs on on the daemon and
   * its result waits in Work; a cancel of their records after this never stops a work.
   */
  stopFollowingDelegatedWork(): void {
    this.workDelegation?.close?.();
  }

  /**
   * Hand a reserved record to the daemon as a piece of work: it runs while the work runs, says where the work stands,
   * and is settled with its result. A delegation the daemon did not take fails the record with the daemon's words.
   */
  private startDelegatedWork(record: AgentRecord, signal: AbortSignal): Promise<{ readonly settled: Promise<void>; cancel(reason: string): boolean }> {
    const delegation = this.workDelegation!;
    record.status = 'running';
    const ctx = { sessionId: record.sessionId ?? 'agent-manager', traceId: `agent-manager:${record.id}:work`, source: 'agent-manager', agentId: record.id };
    if (this.runtimeBus) emitAgentRunning(this.runtimeBus, ctx, { agentId: record.id });
    const say = (line: string): void => {
      setAgentProgress(record, line, 'operator');
      if (this.runtimeBus) emitAgentProgress(this.runtimeBus, ctx, { agentId: record.id, progress: line, audience: 'operator' });
    };
    say('Handing it to the daemon as a piece of work');
    // The work's end settles the record as a contract's end settled its owner record (contract/runner.ts settleEnded).
    const report = (update: DelegatedWorkUpdate): void => {
      if (update.kind === 'progress') {
        if (record.status !== 'running') return;
        // Set before the progress is announced, so whoever reads the record on that event sees it waiting.
        record.delegatedWorkWaiting = update.waiting === true ? update.line : undefined;
        say(update.line);
        return;
      }
      if (record.status !== 'running') return;
      record.delegatedWorkWaiting = undefined;
      record.completedAt = Date.now();
      const durationMs = Math.max(0, record.completedAt - record.startedAt);
      if (update.kind === 'done') {
        record.status = 'completed';
        record.fullOutput = update.output;
        say('Done');
        if (this.runtimeBus) emitAgentCompleted(this.runtimeBus, ctx, { agentId: record.id, durationMs, output: update.output, toolCallsMade: record.toolCallCount, usage: record.usage });
      } else if (update.kind === 'failed') {
        record.status = 'failed';
        record.error = update.error;
        say(`Failed: ${update.error}`);
        if (this.runtimeBus) emitAgentFailed(this.runtimeBus, ctx, { agentId: record.id, durationMs, error: update.error });
      } else {
        record.status = 'cancelled';
        say(`Stopped: ${update.reason}`);
        if (this.runtimeBus) emitAgentCancelled(this.runtimeBus, ctx, { agentId: record.id, reason: update.reason });
      }
    };
    return delegation.delegate(record, { signal, report }).then((work) => {
      record.delegatedWorkId = work.workId;
      return { settled: work.settled, cancel: (reason: string) => work.cancel(reason) };
    });
  }
}
