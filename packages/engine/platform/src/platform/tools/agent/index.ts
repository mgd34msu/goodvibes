import { decideDelegation, delegationRefusalResult, type DelegationOwnerAsk } from '../../agents/delegation-authority.js';
import { readDelegationRequest } from '../../core/delegation-request-context.js';
import { classicAgentInput } from './classic-policy.js';
import { decisionModelPolicyState } from '@goodvibes/engine/errors';
import { readAgentJournalActivity, readAgentSessionHistory } from '../../agents/session-history.js';
import { readCompletionRepairContext } from '../../core/completion-repair-context.js';
import type { Tool, ToolExecuteOptions } from '../../types/tools.js';
import { assertCurrentToolInvocation } from '../registry.js';
import type { ConfigManager } from '../../config/manager.js';
import { AGENT_TOOL_SCHEMA, agentInputFields } from './schema.js';
import type { AgentInput, ProposedUnit } from './schema.js';
import { ArchetypeLoader } from '../../agents/archetypes.js';
import { AgentMessageBus } from '../../agents/message-bus.js';
import type { ContractRunner, StartedContract } from '../../contract/runner.js';
import { contractChecks, summarizeCheck, summarizeContract, summarizeContractDecision, summarizeEscalation } from './contract-views.js';
import { AGENT_TEMPLATES, AgentManager, type AgentRecord, type OwnedAgentExecution } from './manager.js';
import { evaluateOrchestrationSpawn, ORCHESTRATION_CAP_KEYS } from '../../runtime/orchestration/spawn-policy.js';
import { isNativeConversationTurn, NATIVE_TURN_EXECUTION_REFUSAL } from '../../core/native-turn-scope.js';
import { describeErrorInFull } from '../../utils/error-display.js';
import { currentTurn } from '../../security/turn-boundary.js';
import {
  buildChildFailureEnvelope,
  isChildFailureTerminal,
  type ChildFailureEnvelope,
} from './child-failure-envelope.js';
export type { AgentContractRunner, AgentExecutor, AgentRecord, AgentFleetOwnership, OwnedAgentExecution } from './manager.js';
export { AGENT_TEMPLATES, AgentManager, OwnedAgentExecutionUnavailableError } from './manager.js';
export { isActiveAgent } from './predicates.js';
export { cancelAllAgentRuns, type CancellableAgentRuns } from './cancel-all.js';

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

function agentTopology(record: AgentRecord) {
  return {
    parentAgentId: record.parentAgentId ?? null,
    contractId: record.contractId ?? null,
    contractRole: record.contractRole ?? null,
    contractUnitId: record.contractUnitId ?? null,
    routeReason: record.routeReason ?? null,
    orchestrationGraphId: record.orchestrationGraphId ?? null,
    orchestrationNodeId: record.orchestrationNodeId ?? null,
    parentNodeId: record.parentNodeId ?? null,
  };
}

function agentExecutionContract(record: AgentRecord) {
  return {
    ...(record.decisionPolicy ? { decisionPolicy: record.decisionPolicy } : {}),
    executionIntent: record.executionIntent ?? null,
    tools: record.tools,
    capabilityCeilingTools: record.capabilityCeilingTools ?? record.tools,
    successCriteria: record.successCriteria ?? [],
    requiredEvidence: record.requiredEvidence ?? [],
    writeScope: record.writeScope ?? [],
    executionProtocol: record.executionProtocol,
    reviewMode: record.reviewMode,
    communicationLane: record.communicationLane,
    knowledgeInjections: record.knowledgeInjections ?? [],
  };
}

/**
 * Build the child-failure envelope for a terminally-failed/cancelled record so
 * the supervising model receives {agentId, phase, reason, partialOutputs} as the
 * RESULT of its poll, never a bare status. Returns null for non-terminal or
 * cleanly-completed agents. The transcript tail is pulled from the manager's
 * live-or-frozen snapshot (honest partial output, never fabricated).
 */
async function childFailureFor(manager: AgentManager, record: AgentRecord,
  options?: { readonly signal?: AbortSignal | undefined; readonly assertCurrent?: (() => void) | undefined },
): Promise<ChildFailureEnvelope | null> {
  if (!isChildFailureTerminal(record)) return null;
  // A finished agent's classification is read once: a free-text error is a model reading, and
  // repeated polls of the same dead agent must neither spend a request each nor change their answer.
  const key = [record.status, record.terminationKind ?? '', record.failureReason ?? '', record.error ?? ''].join('\0');
  const cached = failureEnvelopes.get(record);
  if (cached?.key === key) return cached.envelope;
  const transcriptTail = manager.getConversationSnapshot(record.id);
  const envelope = await buildChildFailureEnvelope(record, { transcriptTail, ...options });
  options?.signal?.throwIfAborted();
  options?.assertCurrent?.();
  failureEnvelopes.set(record, { key, envelope });
  return envelope;
}
const failureEnvelopes = new WeakMap<AgentRecord, { readonly key: string; readonly envelope: ChildFailureEnvelope }>();

function agentSummary(record: AgentRecord) {
  return {
    ...(record.decisionPolicy ? { decisionPolicy: record.decisionPolicy } : {}),
    id: record.id,
    task: record.task,
    template: record.template,
    status: record.status,
    startedAt: record.startedAt,
    toolCallCount: record.toolCallCount,
    cohort: record.cohort,
    progress: record.progress,
    ...agentTopology(record),
  };
}

/** The fields a result carries for a contract the call started: read as code by core (contract/intake-route.ts toolResultStartedContract). */
/**
 * A delegation handed to the daemon as a piece of work (a terminal program, AgentManager.delegatesToDaemon): the
 * record that follows it here, and where the work is seen. `agent wait` on the id gives the work's result.
 */
function delegatedWorkFields(record: AgentRecord) {
  return {
    agentId: record.id,
    status: 'spawned',
    handedTo: 'the daemon, as a piece of work for this project',
    seenIn: 'Work (the Work and agents place); it runs on when this program closes, and its result then waits there',
    ...(record.delegatedWorkId ? { workId: record.delegatedWorkId } : {}),
  };
}

function startedContractFields(started: StartedContract) {
  return {
    contractStarted: true as const,
    contractId: started.contract.id,
    ownerAgentId: started.owner.id,
  };
}

function validateTemplate(
  template: string | undefined,
  archetypeLoader: Pick<ArchetypeLoader, 'loadArchetype'>,
): string | null {
  if (!template || AGENT_TEMPLATES[template]) return null;
  // Also allow custom archetypes loaded from .goodvibes/agents/*.md
  const customArchetype = archetypeLoader.loadArchetype(template);
  if (!customArchetype || customArchetype.isCustom === false) {
    return `Unknown template: '${template}'. Available: ${Object.keys(AGENT_TEMPLATES).join(', ')}`;
  }
  return null;
}

function batchTaskToSpawnInput(input: AgentInput, taskDef: NonNullable<AgentInput['tasks']>[number]): AgentInput {
  return {
    mode: 'spawn',
    task: taskDef.task,
    authoritativeTask: input.authoritativeTask ?? input.task,
    template: taskDef.template ?? input.template ?? 'general',
    model: taskDef.model ?? input.model,
    provider: taskDef.provider ?? input.provider,
    fallbackModels: taskDef.fallbackModels ?? input.fallbackModels,
    routing: taskDef.routing ?? input.routing,
    executionIntent: taskDef.executionIntent === undefined ? input.executionIntent
      : { ...input.executionIntent, ...taskDef.executionIntent },
    reasoningEffort: taskDef.reasoningEffort ?? input.reasoningEffort,
    tools: taskDef.tools ?? input.tools,
    restrictTools: taskDef.restrictTools ?? input.restrictTools,
    context: taskDef.context ?? input.context,
    successCriteria: taskDef.successCriteria ?? input.successCriteria,
    requiredEvidence: taskDef.requiredEvidence ?? input.requiredEvidence,
    writeScope: taskDef.writeScope ?? input.writeScope,
    executionProtocol: taskDef.executionProtocol ?? input.executionProtocol,
    reviewMode: taskDef.reviewMode ?? input.reviewMode,
    communicationLane: taskDef.communicationLane ?? input.communicationLane,
    parentAgentId: input.parentAgentId,
    orchestrationGraphId: taskDef.orchestrationGraphId ?? input.orchestrationGraphId,
    orchestrationNodeId: taskDef.orchestrationNodeId,
    parentNodeId: taskDef.parentNodeId ?? input.parentNodeId,
    outsideContract: taskDef.outsideContract ?? input.outsideContract,
    cohort: input.cohort,
    sessionId: input.sessionId,
  };
}

/** The actual delivered brief, including shared or task-specific constraints. */
function briefAssignment(input: AgentInput) {
  return { task: input.task!, ...(input.context ? { context: input.context } : {}),
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.restrictTools === undefined ? {} : { restrictTools: input.restrictTools }),
    ...(input.executionIntent ? { executionIntent: input.executionIntent } : {}),
    ...(input.successCriteria ? { successCriteria: input.successCriteria } : {}),
    ...(input.requiredEvidence ? { requiredEvidence: input.requiredEvidence } : {}),
    ...(input.writeScope ? { writeScope: input.writeScope } : {}) };
}

/**
 * The ask of a contract this call starts: the work as the owner asked for it
 * (stamped by the host from the owner's standing request, never only their latest
 * message), then the units planned for it. Its first line names the contract.
 */
function contractAsk(input: AgentInput, units: readonly ProposedUnit[]): string {
  const planned = units.map((unit) => `- ${unit.task}`).join('\n');
  const request = input.authoritativeTask?.trim();
  return request ? `${request}\n\nPlanned for the agents:\n${planned}` : planned;
}

/** A message to an agent never expires on a clock: an agent inside one long turn reads its messages only at the next turn. The bus drops it when the agent is forgotten. */
const AGENT_MESSAGE_TTL_MS = Number.POSITIVE_INFINITY;

/** Fields only the host sets: a model must not choose a tool root, its own write authority, or its own prompt. */
const HOST_ONLY_INPUT_KEYS = agentInputFields('host-only');

/** The call's arguments as the model may set them: every host-only field is removed, including from batch tasks. */
function modelAgentInput(args: AgentInput): AgentInput {
  const input: Record<string, unknown> = { ...args };
  for (const key of HOST_ONLY_INPUT_KEYS) delete input[key];
  if (Array.isArray(input.tasks)) {
    input.tasks = input.tasks.map((task: unknown) => {
      if (task === null || typeof task !== 'object') return task;
      const cleaned: Record<string, unknown> = { ...(task as Record<string, unknown>) };
      for (const key of HOST_ONLY_INPUT_KEYS) delete cleaned[key];
      return cleaned;
    });
  }
  return input as unknown as AgentInput;
}

/** Limits on a worker's authority; a contract's planner chooses these per unit, so a request for them cannot be kept on the contract path. */
const CONTRACT_PATH_FENCES = agentInputFields('contract-fence');
/** Settings that only apply to a standalone agent; the contract path does not carry them. */
const CONTRACT_PATH_IGNORED = agentInputFields('standalone-only');

function suppliedParameters(inputs: readonly AgentInput[], keys: readonly (keyof AgentInput)[]): string[] {
  return keys.filter((key) => inputs.some((input) => {
    const value = input[key];
    return value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0);
  }));
}

/** The refusal for limits a contract cannot keep, naming them and the way to get them. */
function contractPathFenceError(inputs: readonly AgentInput[]): string | null {
  const fenced = suppliedParameters(inputs, CONTRACT_PATH_FENCES);
  if (fenced.length === 0) return null;
  return `Not started: ${fenced.join(', ')} cannot be applied when the work runs as a contract (the default), because the contract's planner chooses each unit's tools and write scope and would drop them. Remove ${fenced.length === 1 ? 'it' : 'them'}, or set outsideContract=true to run a bounded helper with ${fenced.length === 1 ? 'that limit' : 'those limits'}.`;
}

/** What the contract path did not carry, for the result, so an absent effect is never read as accepted. */
function contractPathNotApplied(inputs: readonly AgentInput[]): { notApplied: { parameters: string[]; reason: string } } | Record<string, never> {
  const ignored = suppliedParameters(inputs, CONTRACT_PATH_IGNORED);
  return ignored.length === 0 ? {} : { notApplied: { parameters: ignored,
    reason: 'These apply only with outsideContract=true; the contract path did not carry them.' } };
}

export interface AgentToolConfig {
  /** Session-local user selection, rather than the shared workspace registry's selection. */
  readonly getSelectedModel?: (() => import('../../providers/registry-types.js').ModelDefinition) | undefined;
  readonly manager: AgentManager;
  readonly messageBus: Pick<AgentMessageBus, 'getMessages' | 'send'>;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly archetypeLoader?: Pick<ArchetypeLoader, 'loadArchetype'> | undefined;
  /** Starts the contract spawn and batch-spawn hand work to, and answers the contracts and contract-history modes. */
  /** Absent in a program that runs no contracts (its delegation goes to the daemon as work: AgentManager.delegatesToDaemon). */
  readonly contractRunner?: (Pick<ContractRunner, 'start' | 'list' | 'get'> & Partial<Pick<ContractRunner, 'cancel' | 'join'>>) | undefined;
  /** The project a contract started here works in. */
  readonly projectRoot: string;
  /** Where the agents run here keep their journals, when not in `projectRoot` (the daemon's records of the project). */
  readonly journalRoot?: string | undefined;
  readonly surfaceRoot?: string | undefined;
  readonly readAccessFilter?: import('../shared/read-access.js').ReadAccessFilter | undefined;
  /** The conversation session a contract started here belongs to, read on each call. */
  readonly resolveSessionId: () => string;
  /**
   * Puts a delegation nothing settled to the owner, in the product's ordinary
   * ask (PermissionManager.askDelegation). Absent: nobody can be asked from
   * here, and a delegation the gate admitted starts.
   */
  readonly delegationAsk?: DelegationOwnerAsk | undefined;
}

/** True when `work` settles within `ms`, false at the deadline; rejects with the abort reason when `signal` aborts. */
function awaitWithin(work: Promise<unknown>, ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  signal?.throwIfAborted();
  return new Promise<boolean>((resolve, reject) => {
    const finish = (settle: () => void): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); settle(); };
    const abort = (): void => finish(() => reject(signal!.reason));
    const timer = setTimeout(() => finish(() => resolve(false)), ms);
    signal?.addEventListener('abort', abort, { once: true });
    work.then(() => finish(() => resolve(true)), () => finish(() => resolve(true)));
  });
}

export function createAgentTool(config: AgentToolConfig): Tool {
  const archetypeLoader = config.archetypeLoader ?? new ArchetypeLoader();

  /**
   * Starts one contract for work handed to the tool. The unit
   * leaf refusal runs first, in AgentManager, so it is decided in one place.
   */
  function startContract(input: AgentInput, ask: string, proposedUnits: readonly ProposedUnit[], assertCurrent: () => void, dispatch: ContractRunner['start']): Promise<StartedContract> {
    config.manager.guardContractLeafSpawn(input.parentAgentId);
    const completionRepair = readCompletionRepairContext();
    const taskEvidence = [completionRepair, input.context,
      ...(input.tasks ?? []).flatMap(task => task.context || task.successCriteria || task.requiredEvidence || task.writeScope
        ? [JSON.stringify(briefAssignment(batchTaskToSpawnInput(input, task)))] : [])].filter(Boolean).join('\n\n');
    const contractInput = {
      ask,
      ...(config.getSelectedModel === undefined ? {} : { selectedModel: config.getSelectedModel() }),
      sessionId: input.sessionId ?? config.resolveSessionId(),
      origin: 'agent-tool' as const,
      projectRoot: config.projectRoot,
      proposedUnits,
      ...(taskEvidence ? { taskEvidence } : {}),
      ...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
    };
    assertCurrent();
    return dispatch(contractInput);
  }
  return {
    definition: AGENT_TOOL_SCHEMA,

    async execute(args: Record<string, unknown>, options?: ToolExecuteOptions): Promise<{ success: boolean; output?: string; error?: string }> {
    const signal = options?.signal;
    const ownedSpawns: OwnedAgentExecution[] = [];
    const ownedContracts: (() => void)[] = [];
    let retired = false;
    const cancelOwned = () => {
      const failures: unknown[] = [];
      for (const owned of ownedSpawns) { try { owned.cancel(); } catch (error) { failures.push(error); } }
      for (const cancel of ownedContracts) { try { cancel(); } catch (error) { failures.push(error); } }
      if (failures.length) throw new AggregateError(failures, 'Owned Agent cancellation failed');
    };
    const assertCurrent = () => {
      try {
        if (retired) throw new Error('Agent invocation is no longer current');
        signal?.throwIfAborted();
        assertCurrentToolInvocation(args, options);
        signal?.throwIfAborted();
      } catch (error) {
        retired = true;
        cancelOwned();
        throw error;
      }
    };
    const publish = <T>(result: T): T => { assertCurrent(); return result; };
    const spawnOwned = (input: AgentInput): AgentRecord => {
      assertCurrent();
      if (options === undefined) return manager.spawn(input);
      const owned = manager.spawnOwned(input, { signal });
      ownedSpawns.push(owned);
      assertCurrent();
      return owned.record;
    };
    const startOwnedContract = async (input: AgentInput, ask: string, units: readonly ProposedUnit[]): Promise<StartedContract> => {
      assertCurrent();
      const runner = config.contractRunner;
      if (!runner) throw new Error('This program runs no contracts: a task is handed to the daemon as a piece of work in Work.');
      if (options === undefined) {
        return startContract(input, ask, units, assertCurrent, (contractInput) => runner.start(contractInput));
      }
      const start = runner.start, cancel = runner.cancel, join = runner.join;
      if ((signal !== undefined || options?.assertCurrent !== undefined)
        && (typeof cancel !== 'function' || typeof join !== 'function')) {
        throw new Error('Agent caller cancellation requires contract cancellation and settlement');
      }
      let started: StartedContract | undefined;
      let contractId: string | undefined;
      let cancelRequested = false, cancelIssued = false, settlementTracked = false;
      const cancelStarted = () => {
        cancelRequested = true;
        if (contractId !== undefined && !cancelIssued && cancel) {
          cancelIssued = true;
          cancel.call(runner, contractId, 'The owning Agent tool invocation was cancelled');
        }
      };
      const cleanup = () => signal?.removeEventListener('abort', cancelStarted);
      signal?.addEventListener('abort', cancelStarted, { once: true });
      try {
        assertCurrent();
        started = await startContract(input, ask, units, assertCurrent, (contractInput) => {
          signal?.throwIfAborted();
          return start.call(runner, contractInput, { signal, assertCurrent });
        });
        contractId = started.contract.id;
        ownedContracts.push(cancelStarted);
        if (cancelRequested || signal?.aborted) cancelStarted();
        const settled = started.settled ?? join?.call(runner, contractId);
        if (settled) { void settled.then(cleanup, cleanup); settlementTracked = true; }
        else cleanup();
        assertCurrent();
        return started;
      } catch (error) {
        try { if (started) cancelStarted(); } finally { if (!settlementTracked) cleanup(); }
        throw error;
      }
    };
    assertCurrent();
    // Validate required fields before casting
    if (!args || typeof args !== 'object') {
      return { success: false, error: 'Invalid args: expected an object' };
    }
    if (!('mode' in args) || typeof (args as Record<string, unknown>).mode !== 'string') {
      return { success: false, error: 'Missing required parameter: mode' };
    }
    // The session is the host's, never the model's: every agent started here belongs to it, and every agent read here must.
    const session = config.resolveSessionId();
    // The parent is the agent this call runs inside, as the host recorded it on the turn; none for the conversation's own turn.
    const callerAgentId = currentTurn()?.callerAgentId ?? undefined;
    // An agent started here works in the project of the turn that started it (a daemon-run turn in a project: that
    // project, never the daemon's own folder), as a contract started here does.
    const input = classicAgentInput({ ...modelAgentInput(args as unknown as AgentInput), sessionId: session,
      ...(config.projectRoot ? { workingDirectory: config.projectRoot } : {}),
      ...(callerAgentId ? { parentAgentId: callerAgentId } : {}) });
    if (isNativeConversationTurn() && decisionModelPolicyState().operation !== 'no-decision-model' && (input.mode === 'spawn' || input.mode === 'batch-spawn')) {
      // A task handed to the daemon as a piece of work is new work on the daemon's one runner, as the daemon's intake
      // would make it; an agent that would run in this process is not started from a turn the daemon admitted.
      const runsHere = !config.manager.delegatesToDaemon() || input.outsideContract === true
        || (input.tasks ?? []).some((task) => task.outsideContract === true);
      if (runsHere) return { success: false, error: NATIVE_TURN_EXECUTION_REFUSAL };
    }

    if (!input.mode) {
      return { success: false, error: 'Missing required parameter: mode' };
    }

    const validModes = ['spawn', 'batch-spawn', 'status', 'cancel', 'list', 'templates', 'get', 'budget', 'plan', 'wait', 'message', 'contracts', 'contract-history', 'activity', 'cohort-status', 'cohort-report'];
    if (!validModes.includes(input.mode)) {
      return { success: false, error: `Invalid mode: '${input.mode}'. Must be one of: ${validModes.join(', ')}` };
    }

    const manager = config.manager;
    /**
     * An agent id this process holds no record of. The session's contracts are read for it (the contract record
     * survives a restart; its agents do not), so the model is told what the agent was and what its contract is
     * now, never just "unknown". `answered` is true for the reading modes (status, get, wait), which succeed
     * with this as their answer; the acting modes (cancel, message, budget, plan) fail with it.
     */
    const notLive = (agentId: string, answered: boolean): { success: boolean; output?: string; error?: string } => {
      let fact = `Agent '${agentId}' is not running in this process, and no contract of this session names it. Agents do not survive a restart of the app.`;
      try {
        for (const contract of config.contractRunner?.list({ sessionId: session, includeTerminal: true, includeInputSnapshot: false }) ?? []) {
          const unit = contract.units.find((candidate) => candidate.agentIds.includes(agentId));
          const role = contract.ownerAgentId === agentId ? 'the owner record'
            : contract.plannerAgentIds.includes(agentId) ? 'a planner'
              : unit !== undefined ? `the agent of unit ${unit.id} (${unit.title}, now ${unit.status})` : undefined;
          if (role === undefined) continue;
          fact = `Agent '${agentId}' is not running in this process. It was ${role} of contract ${contract.id}, which is now ${contract.status}${contract.statusLine ? ` (${contract.statusLine})` : ''}. `
            + 'An agent does not survive a restart of the app; its contract does, and continues with fresh agents.';
          break;
        }
      } catch { /* the contract records could not be read; the plain fact stands */ }
      fact += ' agent mode=activity shows what each agent of this session read, changed and reported.';
      return answered
        ? { success: true, output: JSON.stringify({ id: agentId, live: false, status: 'not running', fact }) }
        : { success: false, error: fact };
    };
    // Another session's agent is not this session's to read, steer or cancel: it is unknown here.
    if (typeof input.agentId === 'string' && input.agentId.trim() !== '') {
      const named = manager.getStatus(input.agentId);
      if (named && named.sessionId === undefined) return { success: false, error: `Agent '${input.agentId}' belongs to no session (it was started outside any conversation), so this session cannot read, steer or cancel it.` };
      if (named && named.sessionId !== session) return { success: false, error: `Unknown agent: '${input.agentId}'` };
    }
    /**
     * Whether the owner's words let these agents start (agents/delegation-authority.ts):
     * null when they start, else the refusal, whole, with the owner's words it rests
     * on and what would be accepted. The conversation's own turn answers to everything
     * its owner said; an agent delegating further answers to its own task.
     */
    const authorize = async (tasks: readonly string[]) => {
      const source = readDelegationRequest();
      const ownerMessages = input.parentAgentId === undefined && source !== undefined ? source.ownerMessages
        : input.authoritativeTask?.trim() ? [input.authoritativeTask] : [];
      try {
        // The conversation's earlier answers are kept per owner object: the runner's, or the manager's where none runs.
        const verdict = await decideDelegation(config.contractRunner ?? config.manager, { sessionId: session, ownerMessages, tasks },
          { ask: config.delegationAsk, signal, assertCurrent });
        assertCurrent();
        return verdict.start ? null : publish(delegationRefusalResult(verdict.refusal));
      } catch (error) {
        return publish({ success: false, error: `Not started: whether the owner allows these agents could not be settled: ${describeErrorInFull(error)}` });
      }
    };

    switch (input.mode) {
      case 'spawn': {
        if (!input.task || typeof input.task !== 'string' || input.task.trim() === '') {
          return { success: false, error: 'Missing required parameter for spawn: task' };
        }

        const templateError = validateTemplate(input.template, archetypeLoader);
        if (templateError) return { success: false, error: templateError };
        if (!input.outsideContract) {
          const fenceError = contractPathFenceError([input]);
          if (fenceError) return { success: false, error: fenceError };
        }

        const refused = await authorize([input.task]);
        if (refused) return refused;

        // In a terminal program the task is handed to the daemon as a piece of work: one runner, on the daemon.
        if (!input.outsideContract && manager.delegatesToDaemon()) {
          let record;
          try {
            // Not owned by this call: the work is the daemon's and runs on after the call, the turn and the program
            // (the call answers at once, as a contract's start did; `agent wait` follows it to its end).
            assertCurrent();
            record = manager.spawn(input);
          } catch (error) {
            return { success: false, error: describeErrorInFull(error) };
          }
          return publish({ success: true, output: JSON.stringify({ ...delegatedWorkFields(record), template: record.template, task: input.task }) });
        }

        if (!input.outsideContract) {
          let started: StartedContract;
          try {
            const units: ProposedUnit[] = [{ task: input.task, ...(input.template ? { template: input.template } : {}) }];
            started = await startOwnedContract(input, contractAsk(input, units), units);
          } catch (error) {
            return { success: false, error: describeErrorInFull(error) };
          }
          const owner = started.owner;
          return publish({
            success: true,
            output: JSON.stringify({
              ...startedContractFields(started),
              agentId: owner.id,
              status: 'spawned',
              template: owner.template,
              task: owner.task,
              ...agentExecutionContract(owner),
              ...agentTopology(owner),
              ...contractPathNotApplied([input]),
            }),
          });
        }

        let record;
        try {
          record = spawnOwned(input);
        } catch (error) {
          return {
            success: false,
            error: describeErrorInFull(error, {
              ...(typeof input.provider === 'string' ? { provider: input.provider } : {}),
            }),
          };
        }

        return publish({
          success: true,
          output: JSON.stringify({
            agentId: record.id,
            status: 'spawned',
            template: record.template,
            task: record.task,
            ...agentExecutionContract(record),
            ...agentTopology(record),
          }),
        });
      }

      case 'status': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for status: agentId' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return notLive(input.agentId, true);
        }

        const duration =
          record.completedAt !== undefined
            ? record.completedAt - record.startedAt
            : Date.now() - record.startedAt;

        const statusFailure = await childFailureFor(manager, record, { signal, assertCurrent });
        return publish({
          success: true,
          output: JSON.stringify({
            id: record.id,
            task: record.task,
            template: record.template,
            status: record.status,
            durationMs: duration,
            toolCallCount: record.toolCallCount,
            progress: record.progress,
            error: record.error,
            ...(statusFailure ? { failure: statusFailure } : {}),
            ...agentTopology(record),
          }),
        });
      }

      case 'cancel': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for cancel: agentId' };
        }

        const before = manager.getStatus(input.agentId);
        if (!before) {
          return notLive(input.agentId, false);
        }
        const cancelled = manager.cancel(input.agentId);
        const record = manager.getStatus(input.agentId);
        if (!record) {
          return { success: true, output: JSON.stringify({ agentId: input.agentId, status: 'deleted', error: 'Agent was removed after cancel' }) };
        }
        if (!cancelled) {
          return { success: false, error: `Agent '${input.agentId}' is already ${record.status}; there is nothing to cancel. Read its result with mode=get.` };
        }
        return {
          success: true,
          output: JSON.stringify({ agentId: input.agentId, status: record.status }),
        };
      }

      case 'list': {
        const allRecords = manager.list({ sessionId: session });
        const records = input.cohort
          ? allRecords.filter(r => r.cohort === input.cohort)
          : allRecords;
        return {
          success: true,
          output: JSON.stringify({
            agents: records.map(agentSummary),
            count: records.length,
            ...(input.cohort ? { cohort: input.cohort } : {}),
          }),
        };
      }

      case 'templates': {
        return {
          success: true,
          output: JSON.stringify({
            templates: Object.entries(AGENT_TEMPLATES).map(([name, def]) => ({
              name,
              description: def.description,
              defaultTools: def.defaultTools,
            })),
          }),
        };
      }

      case 'get': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for get: agentId' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          let unreadable: string | undefined;
          const history = await readAgentSessionHistory({ projectRoot: config.journalRoot ?? config.projectRoot, surfaceRoot: config.surfaceRoot,
            agentId: input.agentId, readAccessFilter: config.readAccessFilter, signal, assertCurrent,
            onUnreadable: (reason) => { unreadable = reason; } });
          assertCurrent();
          if (history) {
            const detail = input.detail ?? 'full';
            const selected = detail === 'full' || detail === 'messages' ? history : {
              kind: history.kind, agentId: history.agentId, executionActive: false, timestamp: history.timestamp,
              messageCount: Array.isArray(history.messages) ? history.messages.length : 0,
              archiveCount: Array.isArray(history.archive) ? history.archive.length : 0, meaning: history.meaning,
            };
            return publish({ success: true, output: JSON.stringify({ id: input.agentId, historical: true, history: selected }) });
          }
          if (unreadable !== undefined) {
            return { success: false, error: `Agent '${input.agentId}' has saved history that cannot be read (${unreadable}). It is not running; do not treat it as unknown. Ask the operator to check the agent's session journal.` };
          }
          return notLive(input.agentId, true);
        }

        const recentMessages = config.messageBus.getMessages(input.agentId).slice(-10);
        const duration =
          record.completedAt !== undefined
            ? record.completedAt - record.startedAt
            : Date.now() - record.startedAt;
        const detail = input.detail ?? 'full';

        let historyUnreadable: string | undefined;
        const history = !record.fullOutput && !['pending', 'running'].includes(record.status)
          && (detail === 'full' || detail === 'messages') ? await readAgentSessionHistory({ projectRoot: config.journalRoot ?? config.projectRoot,
            surfaceRoot: config.surfaceRoot, agentId: input.agentId, readAccessFilter: config.readAccessFilter, signal, assertCurrent,
            onUnreadable: (reason) => { historyUnreadable = reason; } }) : undefined;
        assertCurrent();
        // History that exists but cannot be read is labelled, so an empty result is not taken for "nothing was recorded".
        const historicalField = history ? { history } : historyUnreadable !== undefined ? { historyUnreadable } : {};

        const base = {
          id: record.id,
          task: record.task,
          template: record.template,
          model: record.model,
          provider: record.provider,
          executionIntent: record.executionIntent ?? null,
          status: record.status,
          durationMs: duration,
          toolCallCount: record.toolCallCount,
          progress: record.progress,
          error: record.error,
          executionProtocol: record.executionProtocol,
          reviewMode: record.reviewMode,
          communicationLane: record.communicationLane,
          ...agentTopology(record),
        };

        const contract = {
          tools: record.tools,
          capabilityCeilingTools: record.capabilityCeilingTools ?? record.tools,
          successCriteria: record.successCriteria ?? [],
          requiredEvidence: record.requiredEvidence ?? [],
          writeScope: record.writeScope ?? [],
          knowledgeInjections: record.knowledgeInjections ?? [],
        };

        const messages = {
          recentMessages: recentMessages.map((m) => ({
            from: m.from,
            content: m.content,
            timestamp: m.timestamp,
          })),
        };

        const getFailure = await childFailureFor(manager, record, { signal, assertCurrent });
        const failureField = getFailure ? { failure: getFailure } : {};
        return publish({
          success: true,
          output: JSON.stringify(detail === 'full'
            ? { ...base, ...failureField, ...contract, ...messages, ...historicalField }
            : detail === 'contract'
              ? { ...base, ...failureField, ...contract }
              : detail === 'messages'
                ? { ...base, ...failureField, ...messages, ...historicalField }
                : { ...base, ...failureField }),
        });
      }

      case 'budget': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for budget: agentId' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return notLive(input.agentId, false);
        }

        // The agent's own recorded usage (orchestrator-runner.ts), never an estimate.
        const usage = record.usage;
        return {
          success: true,
          output: JSON.stringify({
            agentId: record.id,
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            cacheReadTokens: usage?.cacheReadTokens ?? 0,
            cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
            totalTokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
            llmCallCount: usage?.llmCallCount ?? 0,
            turnCount: usage?.turnCount ?? 0,
            toolCallCount: record.toolCallCount,
            ...(usage === undefined ? { note: 'No model call has been recorded for this agent yet.' } : {}),
          }),
        };
      }

      case 'plan': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for plan: agentId' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return notLive(input.agentId, false);
        }

        const templateDef = AGENT_TEMPLATES[record.template];

        return {
          success: true,
          output: JSON.stringify({
            agentId: record.id,
            task: record.task,
            template: record.template,
            templateDescription: templateDef?.description ?? null,
            tools: record.tools,
            capabilityCeilingTools: record.capabilityCeilingTools ?? record.tools,
            model: record.model ?? null,
            provider: record.provider ?? null,
            successCriteria: record.successCriteria ?? [],
            requiredEvidence: record.requiredEvidence ?? [],
            writeScope: record.writeScope ?? [],
            parentAgentId: record.parentAgentId ?? null,
          }),
        };
      }

      case 'wait': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for wait: agentId' };
        }

        assertCurrent();
        const record = manager.getStatus(input.agentId);
        assertCurrent();
        if (!record) {
          return notLive(input.agentId, true);
        }

        // A terminal agent is answered at once; otherwise the call awaits the agent's run (no polling)
        // for the requested time, up to the limit a waiting turn may stay silent.
        const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

        if (terminalStatuses.has(record.status)) {
          const waitFailure = await childFailureFor(manager, record, { signal, assertCurrent });
          assertCurrent();
          return publish({
            success: true,
            output: JSON.stringify({
              agentId: input.agentId,
              status: record.status,
              timedOut: false,
              ...(waitFailure ? { failure: waitFailure } : {}),
            }),
          });
        }

        // The wait the caller asked for, whole: no product cap shortens it (the agent's end, or the turn being stopped,
        // ends it first).
        const requestedMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) ? Math.max(0, input.timeoutMs) : 0;
        const timeoutMs = requestedMs;
        const startedAt = Date.now();
        const joined = timeoutMs > 0 ? await awaitWithin(manager.join(input.agentId), timeoutMs, signal) : false;
        const waitedMs = Date.now() - startedAt;

        assertCurrent();
        const finalRecord = manager.getStatus(input.agentId);
        if (!finalRecord) {
          return publish({ success: true, output: JSON.stringify({ agentId: input.agentId, status: 'deleted', error: 'Agent was removed during wait' }) });
        }
        const finalStatus = finalRecord.status;
        const ended = terminalStatuses.has(finalStatus);
        const finalFailure = await childFailureFor(manager, finalRecord, { signal, assertCurrent });
        assertCurrent();
        return publish({
          success: true,
          output: JSON.stringify({
            agentId: input.agentId,
            status: finalStatus,
            timedOut: !ended && !joined,
            waitedMs,
            ...(ended ? {} : joined
              ? { hint: 'No run of this agent is executing in this process now; it will not end by itself. Use mode=message to wake it or mode=cancel to stop it.' }
              : { hint: 'Agent still running. Call mode=wait again with timeoutMs to keep waiting.' }),
            ...(finalFailure ? { failure: finalFailure } : {}),
          }),
        });
      }

      case 'message': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for message: agentId' };
        }
        if (!input.message || typeof input.message !== 'string' || input.message.trim() === '') {
          return { success: false, error: 'message cannot be empty or whitespace only' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return notLive(input.agentId, false);
        }

        if (record.status === 'failed' || record.status === 'completed' || record.status === 'cancelled') {
          return { success: false, error: `Agent '${record.id}' is ${record.status} and has no active turn to consume this message. No message was queued. Read its retained result with mode=get; continue only unfinished authorized work with a focused assignment when needed.` };
        }

        // A contract's owner record runs no turn loop, so nothing would read a
        // message queued for it. The instruction goes to the agents working
        // the contract's units now, and the result says which received it.
        if (record.contractRole === 'owner' && record.contractId) {
          const contract = config.contractRunner?.get(record.contractId);
          if (!contract) {
            return { success: false, error: `Agent '${record.id}' is the owner of contract ${record.contractId}, which is no longer loaded here. No message was queued. Use mode=contract-history to read its result.` };
          }
          const working = contract.units.filter((unit) => unit.activeAgentId !== undefined
            && manager.getStatus(unit.activeAgentId)?.status === 'running');
          const unitStates = contract.units.map((unit) => `${unit.id} ${unit.status}`).join(', ') || 'none planned yet';
          if (working.length === 0) {
            return { success: false, error: `Agent '${record.id}' is contract ${contract.id} (status ${contract.status}); no unit agent is working now to read this (units: ${unitStates}). No message was queued. Send it again once a unit is working (mode=contracts shows them), or cancel the contract and start again with the changed requirement.` };
          }
          const text = `Instruction from the owner of contract ${contract.id}: ${input.message}`;
          const delivered: { unitId: string; agentId: string }[] = [];
          const refused: string[] = [];
          for (const unit of working) {
            const agentId = unit.activeAgentId!;
            if (config.messageBus.send('orchestrator', agentId, text, { kind: input.kind ?? 'directive', ttlMs: AGENT_MESSAGE_TTL_MS })) delivered.push({ unitId: unit.id, agentId });
            else refused.push(unit.id);
          }
          if (delivered.length === 0) {
            return { success: false, error: `Communication to the agents of contract ${contract.id} (units ${refused.join(', ')}) was blocked by policy. No message was queued.` };
          }
          return {
            success: true,
            output: JSON.stringify({
              agentId: record.id,
              contractId: contract.id,
              sent: true,
              content: input.message,
              kind: input.kind ?? 'directive',
              deliveredTo: delivered,
              ...(refused.length ? { blockedUnits: refused } : {}),
              delivery: `Queued for the agents working units ${delivered.map((item) => item.unitId).join(', ')}; each reads it at the start of its next turn. Units that start later do not receive it (units: ${unitStates}).`,
            }),
          };
        }

        const sent = config.messageBus.send('orchestrator', input.agentId, input.message, {
          kind: input.kind ?? 'directive',
          ttlMs: AGENT_MESSAGE_TTL_MS,
        });
        if (!sent) {
          return {
            success: false,
            error: `Communication to agent '${input.agentId}' was blocked by policy.`,
          };
        }

        return {
          success: true,
          output: JSON.stringify({
            agentId: input.agentId,
            sent: true,
            content: input.message,
            kind: input.kind ?? 'directive',
            delivery: `Queued. The agent reads it at the start of its next turn, which may be after a long tool call or model reply; it stays queued until the agent reads it or is removed. Use mode=status to see whether the agent is still running.`,
          }),
        };
      }

      case 'batch-spawn': {
        if (!input.tasks || !Array.isArray(input.tasks) || input.tasks.length === 0) {
          return { success: false, error: 'batch-spawn requires a non-empty tasks array.' };
        }
        if (input.tasks.length > 20) {
          return { success: false, error: 'batch-spawn limited to 20 tasks per batch.' };
        }
        for (const taskDef of input.tasks) {
          if (!taskDef.task || typeof taskDef.task !== 'string' || taskDef.task.trim() === '') {
            return { success: false, error: 'Each task in batch-spawn must have a non-empty task string.' };
          }
          const templateError = validateTemplate(taskDef.template, archetypeLoader);
          if (templateError) return { success: false, error: templateError };
        }
        const spawnInputs = input.tasks.map((taskDef) => classicAgentInput(batchTaskToSpawnInput(input, taskDef)));
        // Every requester is checked before anything starts, so a refused task never leaves half a batch running.
        try {
          for (const requester of new Set([input.parentAgentId, ...spawnInputs.map((spawnInput) => spawnInput.parentAgentId)])) {
            manager.guardContractLeafSpawn(requester);
          }
        } catch (error) {
          return { success: false, error: describeErrorInFull(error) };
        }
        const outsideInputs = spawnInputs.filter((spawnInput) => spawnInput.outsideContract === true);
        const contractTasks = input.tasks.filter((_, index) => spawnInputs[index]!.outsideContract !== true);
        const contractInputs = spawnInputs.filter((spawnInput) => spawnInput.outsideContract !== true);
        const fenceError = contractPathFenceError(contractInputs);
        if (fenceError) return { success: false, error: fenceError };
        const refused = await authorize(input.tasks.map((taskDef) => taskDef.task));
        if (refused) return refused;

        const batchOutput: Record<string, unknown> = { cohort: input.cohort };
        if (contractTasks.length > 0 && manager.delegatesToDaemon()) {
          // In a terminal program the tasks are handed to the daemon as one piece of work, its steps proposed from them.
          const units: ProposedUnit[] = contractTasks.map((taskDef) => ({
            task: taskDef.task,
            ...(taskDef.template ?? input.template ? { template: taskDef.template ?? input.template } : {}),
          }));
          let owner;
          try {
            // Not owned by this call (the daemon's work runs on after it), as a single hand-over.
            assertCurrent();
            owner = manager.spawn({ ...input, mode: 'spawn', task: contractAsk(input, units), proposedUnits: units, outsideContract: false });
          } catch (error) {
            return { success: false, error: describeErrorInFull(error) };
          }
          // `contractStarted` keeps its meaning for the rest of the batch: the delegated work already started.
          Object.assign(batchOutput, { contractStarted: true, owner: agentSummary(owner), contractTaskCount: contractTasks.length }, delegatedWorkFields(owner));
          delete batchOutput['status'];
        } else if (contractTasks.length > 0) {
          const units: ProposedUnit[] = contractTasks.map((taskDef) => ({
            task: taskDef.task,
            ...(taskDef.template ?? input.template ? { template: taskDef.template ?? input.template } : {}),
          }));
          let started: StartedContract;
          try {
            started = await startOwnedContract(input, contractAsk(input, units), units);
          } catch (error) {
            return { success: false, error: describeErrorInFull(error) };
          }
          Object.assign(batchOutput, startedContractFields(started), {
            owner: agentSummary(started.owner),
            contractTaskCount: contractTasks.length,
          }, contractPathNotApplied(contractInputs));
        }

        const results: ReturnType<typeof agentSummary>[] = [];
        const skippedTasks: string[] = [];
        let skipped = 0;
        if (outsideInputs.length > 0) {
          const currentCount = manager.fleetCount();
          const spawnDecision = evaluateOrchestrationSpawn({
            configManager: config.configManager,
            mode: 'manual-batch',
            activeAgents: currentCount,
            requestedDepth: 0,
          });
          if (!spawnDecision.allowed || spawnDecision.availableSlots === 0) {
            const boundCap = spawnDecision.boundCap
              ?? { key: ORCHESTRATION_CAP_KEYS.maxActiveAgents, value: spawnDecision.maxAgents };
            const capError = spawnDecision.reason
              ?? `agent capacity reached (${currentCount}/${spawnDecision.maxAgents}), cap: ${boundCap.key}=${boundCap.value}. No capacity for batch-spawn.`;
            if (batchOutput.contractStarted !== true) {
              return { success: false, error: capError, output: JSON.stringify({ cap: boundCap }) };
            }
            // The contract already started; the outside-contract tasks found no capacity.
            skippedTasks.push(...outsideInputs.map((spawnInput) => spawnInput.task!));
            skipped = outsideInputs.length;
            batchOutput.cap = boundCap;
            batchOutput.capMessage = `${capError} Nothing is queued; the outside-contract tasks (listed in notStarted) were not started.`;
            batchOutput.notStarted = skippedTasks;
          } else {
            const toSpawn = outsideInputs.slice(0, spawnDecision.availableSlots);
            skippedTasks.push(...outsideInputs.slice(spawnDecision.availableSlots).map((spawnInput) => spawnInput.task!));
            skipped = skippedTasks.length;
            for (const [index, spawnInput] of toSpawn.entries()) {
              let record;
              try {
                record = spawnOwned(spawnInput);
              } catch (error) {
                // Name everything that already started, so a retry does not repeat it.
                const notStarted = [...toSpawn.slice(index).map((remaining) => remaining.task!), ...skippedTasks];
                return {
                  success: false,
                  error: `${describeErrorInFull(error)} The batch stopped partway: ${results.length} agent${results.length === 1 ? '' : 's'}${batchOutput.contractStarted === true ? ' and the contract' : ''} already started and keep running. Do not resubmit them; submit only the tasks listed in notStarted.`,
                  output: JSON.stringify({ ...batchOutput, agents: results, count: results.length, notStarted }),
                };
              }
              results.push({ ...agentSummary(record), task: record.task.slice(0, 80) });
            }
            batchOutput.maxAgents = spawnDecision.maxAgents;
            if (skipped > 0) {
              // The active-agents cap bound: the excess tasks were not started and nothing holds them. Name the cap and its value.
              batchOutput.cap = { key: ORCHESTRATION_CAP_KEYS.maxActiveAgents, value: spawnDecision.maxAgents };
              batchOutput.capMessage =
                `not started: ${skipped} task${skipped === 1 ? '' : 's'} (listed in notStarted) found no free slot: ${spawnDecision.maxAgents}/${spawnDecision.maxAgents} active, cap: ${ORCHESTRATION_CAP_KEYS.maxActiveAgents}=${spawnDecision.maxAgents}. Nothing is queued; submit them again when agents finish.`;
              batchOutput.notStarted = skippedTasks;
            }
          }
        }
        batchOutput.agents = results;
        batchOutput.count = results.length;
        batchOutput.skipped = skipped;
        return publish({
          success: true,
          output: JSON.stringify(batchOutput),
        });
      }

      case 'cohort-status': {
        if (!input.cohort) {
          return { success: false, error: 'cohort-status requires a cohort name.' };
        }
        const cohortAgents = manager.listByCohort(input.cohort).filter((agent) => agent.sessionId === session);
        if (cohortAgents.length === 0) {
          return { success: true, output: JSON.stringify({ cohort: input.cohort, count: 0, agents: [], note: `No agents found in cohort '${input.cohort}'. Check the cohort name with mode=list.` }) };
        }
        const summary = [];
        for (const a of cohortAgents) {
          const failure = await childFailureFor(manager, a, { signal, assertCurrent });
          summary.push({
            id: a.id,
            task: a.task?.slice(0, 80),
            status: a.status,
            template: a.template,
            contractId: a.contractId,
            toolCallCount: a.toolCallCount,
            ...(failure ? { failure: { code: failure.reason.code, message: failure.reason.message } } : {}),
          });
        }
        return publish({ success: true, output: JSON.stringify({ cohort: input.cohort, count: cohortAgents.length, agents: summary }) });
      }

      case 'cohort-report': {
        if (!input.cohort) {
          return { success: false, error: 'cohort-report requires a cohort name.' };
        }
        const reportAgents = manager.listByCohort(input.cohort).filter((agent) => agent.sessionId === session);
        if (reportAgents.length === 0) {
          return { success: true, output: `No agents found in cohort '${input.cohort}'.` };
        }
        const lines: string[] = [
          `## Cohort: ${input.cohort} (${reportAgents.length} agents)`,
          '',
          '| Agent | Task | Status | Template | Contract | Tool Calls |',
          '|-------|------|--------|----------|----------|------------|',
        ];
        const failures: string[] = [];
        for (const a of reportAgents) {
          const taskShort = (a.task ?? '').slice(0, 40).replace(/\|/g, '\\|');
          const contractCell = a.contractId ? `${a.contractId}${a.contractUnitId ? `/${a.contractUnitId}` : ''}` : 'n/a';
          lines.push(`| ${a.id.slice(-8)} | ${taskShort} | ${a.status} | ${a.template ?? 'general'} | ${contractCell} | ${a.toolCallCount ?? 0} |`);
          const failure = await childFailureFor(manager, a, { signal, assertCurrent });
          if (failure) failures.push(`- ${a.id.slice(-8)} ${a.status}: ${failure.reason.code}: ${failure.reason.message.replace(/\s+/g, ' ').slice(0, 200)}`);
        }
        if (failures.length > 0) lines.push('', '### Failures', '', ...failures);
        return publish({ success: true, output: lines.join('\n') });
      }

      case 'contracts': {
        try {
          const detail = input.detail ?? 'summary';
          // The summary reads no captured repository manifest, so it is built only for the full view.
          const contracts = config.contractRunner?.list({
            sessionId: session,
            includeTerminal: input.includeTerminal ?? true,
            includeInputSnapshot: detail === 'full',
          }) ?? [];
          return {
            success: true,
            output: JSON.stringify({
              mode: 'contracts',
              detail,
              count: contracts.length,
              contracts: detail === 'full' ? contracts : contracts.map(summarizeContract),
            }),
          };
        } catch (err) {
          return { success: false, error: `Failed to list contracts: ${describeErrorInFull(err)}` };
        }
      }

      case 'activity': {
        // One answer to "what did my agents and contracts actually do", from the product's own records: the
        // session's contracts (also those from before a restart) and every agent they or this session started,
        // with what each read, changed and reported from its saved journal.
        try {
          const contracts = config.contractRunner?.list({ sessionId: session, includeTerminal: true, includeInputSnapshot: false }) ?? [];
          const roles = new Map<string, string>();
          for (const contract of contracts) {
            for (const planner of contract.plannerAgentIds) roles.set(planner, `planner of contract ${contract.id}`);
            for (const unit of contract.units) for (const agentId of unit.agentIds) roles.set(agentId, `unit ${unit.id} of contract ${contract.id}`);
          }
          const owners = new Set(contracts.map((contract) => contract.ownerAgentId));
          const ids = [...new Set([...manager.list({ sessionId: session }).map((record) => record.id).filter((id) => !owners.has(id)), ...roles.keys()])];
          const agents = [];
          for (const agentId of ids) {
            const record = manager.getStatus(agentId);
            let unreadable: string | undefined;
            const journal = await readAgentJournalActivity({ projectRoot: config.journalRoot ?? config.projectRoot, surfaceRoot: config.surfaceRoot, agentId,
              readAccessFilter: config.readAccessFilter, signal, assertCurrent, onUnreadable: (reason) => { unreadable = reason; } });
            assertCurrent();
            const state = record ? record.status
              : journal === undefined ? 'not running; no saved journal'
                : journal.cutOff ? 'cut off: not running, and its run never ended (the app stopped or the run was killed)' : 'ended';
            const report = record?.fullOutput ?? journal?.report;
            agents.push({
              id: agentId, state, ...(roles.has(agentId) ? { role: roles.get(agentId) } : {}),
              task: (record?.task ?? journal?.task ?? '').slice(0, 300),
              read: journal?.read ?? {}, changed: journal?.changed ?? [], commandsRun: journal?.commandsRun ?? 0,
              ...(report ? { report: report.length > 1_500 ? `${report.slice(0, 1_500)}...` : report }
                : record && ['pending', 'running'].includes(record.status) ? {}
                  : { report: null, noReport: 'it stopped before it wrote a final reply (its contract ended it, its run failed, or the app stopped); what it read is still listed' }),
              ...(unreadable === undefined ? {} : { journalUnreadable: unreadable }),
            });
          }
          return publish({
            success: true,
            output: JSON.stringify({
              mode: 'activity',
              meaning: 'Recorded by GoodVibes: each contract of this session and each agent it or this session started, with what the agent read (whole file or line ranges), changed and last reported. An agent does not survive a restart of the app; its record does.',
              contracts: contracts.map((contract) => ({
                id: contract.id, status: contract.status, statusLine: contract.statusLine ?? null,
                units: contract.units.map((unit) => ({ id: unit.id, title: unit.title, status: unit.status, agentIds: [...unit.agentIds],
                  ...(unit.answer ? { answer: unit.answer.length > 1_000 ? `${unit.answer.slice(0, 1_000)}...` : unit.answer } : {}) })),
              })),
              agents,
            }),
          });
        } catch (err) {
          if (signal?.aborted) throw err;
          return { success: false, error: `Failed to read this session's agent and contract records: ${describeErrorInFull(err)}` };
        }
      }

      case 'contract-history': {
        if (!input.contractId) {
          return { success: false, error: 'contract-history requires contractId' };
        }
        try {
          const contract = config.contractRunner?.get(input.contractId);
          if (!contract || contract.sessionId !== session) {
            return { success: false, error: `Unknown contract: '${input.contractId}'` };
          }
          const detail = input.detail ?? 'summary';
          const checks = contractChecks(contract);
          return {
            success: true,
            output: JSON.stringify({
              mode: 'contract-history',
              detail,
              contractId: contract.id,
              status: contract.status,
              decisions: detail === 'full' ? contract.decisions : contract.decisions.map(summarizeContractDecision),
              checks: detail === 'full' ? checks : checks.map(summarizeCheck),
              escalations: detail === 'full'
                ? contract.escalations
                : contract.escalations.map(summarizeEscalation),
            }),
          };
        } catch (err) {
          return { success: false, error: `Failed to read the contract's history: ${describeErrorInFull(err)}` };
        }
      }

      default: {
        return { success: false, error: `Unhandled mode: '${input.mode}'` };
      }
    }
    },
  };
}
