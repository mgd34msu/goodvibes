import type { RuntimeEventProvenance } from '../../events/occurrence.js';
export type { RuntimeEventProvenance } from '../../events/occurrence.js';
import type { NoticeLevel } from '../core/conversation.js';
import type { ConversationFollowUpItem } from '../core/conversation-follow-ups.js';
import type { AgentEvent, CompactionEvent, ProviderEvent, RuntimeEventBus } from './events/index.js';
import type { GateEvent } from '../../events/gate.js';
import type { ContractEvent } from '../../events/contract.js';
import type { createDomainDispatch } from './store/index.js';
import type { ContractRunner } from '../contract/runner.js';
import type { AgentManager } from '../tools/agent/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import { logger } from '../utils/logger.js';
import { decisionModelFailure } from './decision-policy.js';
import { isWaitingForPlannerRoute } from '../contract/planner-route-wait.js';
import { hasContractPlanConsumer } from '../tools/agent/contract-binding.js';
import { finishWorkstreamLabel, rememberWorkstreamLabel, workstreamLabel } from '../channels/workstream-labels.js';

export interface HostRuntimeMessageRouter {
  low(message: string, runtimeEvent?: RuntimeEventProvenance): void;
  high(message: string, level?: NoticeLevel): void;
  /** Contract lifecycle lines for the operator feed (`ui.contractMessages` decides where they show). */
  contract(message: string, priority?: 'high' | 'low', runtimeEvent?: RuntimeEventProvenance): void;
}

export interface HostRuntimeEventBridgeOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly domainDispatch: ReturnType<typeof createDomainDispatch>;
  readonly getSystemMessageRouter: () => HostRuntimeMessageRouter | null;
  readonly queueConversationFollowUp?: ((item: ConversationFollowUpItem) => void) | undefined;
  readonly requestRender: () => void;
  readonly agentManager: AgentManager;
  readonly contractRunner: Pick<ContractRunner, 'get' | 'list'>;
  /**
   * How agent lifecycle lines are worded: the terminal app's `[Agents]` lines
   * (default) or the Agent app's `[Delegated task]` lines. Only the words differ.
   */
  readonly agentLineVoice?: HostAgentLineVoice | undefined;
  /**
   * Post a high-priority line for each compaction receipt. A host that renders
   * the receipt as its own transcript block leaves this off.
   */
  readonly compactionReceiptLines?: boolean | undefined;
  /**
   * When given, a failed agent's line carries the structured failure the
   * `agent` tool reports for it (reason code, phase, turns completed).
   */
  readonly toolRegistry?: Pick<ToolRegistry, 'execute'> | undefined;
}

export type HostAgentLineVoice = 'agents' | 'delegated-task';

/** The bridge's subscriptions; `dispose` ends them. Running agents are shown by the fleet view, not by a periodic line. */
export interface HostRuntimeEventBridge {
  dispose(): void;
  readonly unsubs: Array<() => void>;
}

export { runtimeEventOfNotice, runtimeEventKey, type RuntimeEventNotice } from './runtime-event-notices.js';

function withRouter(
  getSystemMessageRouter: () => HostRuntimeMessageRouter | null,
  action: (router: HostRuntimeMessageRouter) => void,
): void {
  const router = getSystemMessageRouter();
  if (router) action(router);
}

function buildCohortReport(agentManager: AgentManager, cohort: string): string {
  const agents = agentManager.listByCohort(cohort);
  if (agents.length === 0) return `[Agents] Cohort '${cohort}' complete (no agents found).`;
  const completed = agents.filter((agent) => agent.status === 'completed').length;
  const failed = agents.filter((agent) => agent.status === 'failed').length;
  const cancelled = agents.filter((agent) => agent.status === 'cancelled').length;
  const lines: string[] = [
    `[Agents] Cohort '${cohort}' complete: ${completed} completed, ${failed} failed, ${cancelled} cancelled (${agents.length} total)`,
  ];
  for (const agent of agents) {
    const durationSeconds = agent.completedAt !== undefined ? Math.round((agent.completedAt - agent.startedAt) / 1000) : 0;
    const icon = agent.status === 'completed' ? '\u2713' : agent.status === 'failed' ? '\u2717' : '~';
    const errorSuffix = agent.error ? ` \u2014 ${agent.error.slice(0, 60)}` : '';
    lines.push(`  ${icon} ${agent.id.slice(-8)}: ${agent.status} in ${durationSeconds}s (${agent.toolCallCount} tool calls)${errorSuffix}`);
  }
  return lines.join('\n');
}

/** A follow-up with the turn whose request started the work, when one did (recovery reruns only that request). */
function forTurn(item: ConversationFollowUpItem, turnId: string | undefined): ConversationFollowUpItem {
  return turnId === undefined ? item : { ...item, turnId };
}

/** The turn whose tool call started a contract's owner agent; undefined when unknown (a restart, a schedule). */
function contractTurn(agentManager: Pick<AgentManager, 'requestTurnOf'>, contract: ReturnType<ContractRunner['get']>): string | undefined {
  return contract?.ownerAgentId ? agentManager.requestTurnOf(contract.ownerAgentId) : undefined;
}

function buildCohortFollowUp(agentManager: AgentManager, cohort: string): ConversationFollowUpItem {
  const agents = agentManager.listByCohort(cohort);
  const completed = agents.filter((agent) => agent.status === 'completed').length;
  const failed = agents.filter((agent) => agent.status === 'failed').length;
  const cancelled = agents.filter((agent) => agent.status === 'cancelled').length;
  return forTurn({
    key: `cohort:${cohort}:complete`,
    summary: `Agent cohort "${cohort}" finished with ${completed} completed, ${failed} failed, and ${cancelled} cancelled out of ${agents.length} total agents.`,
  }, agents.map((agent) => agentManager.requestTurnOf(agent.id)).find((turnId) => turnId !== undefined));
}

/**
 * The last finished state reported for each cohort, so a late event for an agent that already
 * ended (the same terminal statuses) does not repeat the completion line. Only the most recent
 * cohorts are kept: a late event arrives right after the end it follows.
 */
const reportedCohortStates = new WeakMap<AgentManager, Map<string, string>>();
const REPORTED_COHORTS_KEPT = 64;

/** Report a cohort once every agent and contract in it has ended; hosts call it from their own agent-end handlers. */
export function checkCohortCompletion(
  agentManager: AgentManager,
  contractRunner: Pick<ContractRunner, 'list'>,
  record: { cohort?: string | undefined } | null,
  getSystemMessageRouter: () => HostRuntimeMessageRouter | null,
  queueConversationFollowUp?: (item: ConversationFollowUpItem) => void,
): void {
  if (!record?.cohort) return;
  const cohortAgents = agentManager.listByCohort(record.cohort);
  const allAgentsDone = cohortAgents.every((agent) => agent.status !== 'running' && agent.status !== 'pending');
  if (!allAgentsDone) return;

  // A cohort is done only when every contract one of its agents worked a unit of has ended too.
  // An ended contract is terminal by definition, so only the live ones are read (no ended record is loaded).
  const cohortAgentIds = new Set(cohortAgents.map((agent) => agent.id));
  const live = contractRunner.list({ includeInputSnapshot: false });
  if (live.some((contract) => contract.units.some((unit) => unit.agentIds.some((agentId) => cohortAgentIds.has(agentId))))) return;

  const state = cohortAgents.map((agent) => `${agent.id}:${agent.status}`).sort().join('|');
  let reported = reportedCohortStates.get(agentManager);
  if (!reported) { reported = new Map(); reportedCohortStates.set(agentManager, reported); }
  if (reported.get(record.cohort) === state) return;
  reported.delete(record.cohort);
  reported.set(record.cohort, state);
  if (reported.size > REPORTED_COHORTS_KEPT) reported.delete(reported.keys().next().value!);

  withRouter(getSystemMessageRouter, (router) => {
    router.low(buildCohortReport(agentManager, record.cohort!));
  });
  queueConversationFollowUp?.(buildCohortFollowUp(agentManager, record.cohort));
}

/** Contract lifecycle presentation without general state dispatch or agent timers. */
export type ContractRuntimeEventBridgeOptions = Pick<HostRuntimeEventBridgeOptions,
  'runtimeBus' | 'getSystemMessageRouter' | 'queueConversationFollowUp' |
  'requestRender' | 'agentManager' | 'contractRunner'>;

/**
 * Feed the gate's decisions into the runtime store: the permissions domain's
 * last decision and counters (what `approvals.list` serves) are set only from
 * here, one store write per decided call. The gate's intermediate steps are
 * not forwarded; nothing reads them. Every product composition calls it once per store.
 */
export function registerGateRuntimeEvents(
  runtimeBus: RuntimeEventBus,
  domainDispatch: Pick<ReturnType<typeof createDomainDispatch>, 'dispatchGateEvent'>,
): () => void {
  return runtimeBus.on<Extract<GateEvent, { type: 'DECISION_EMITTED' }>>('DECISION_EMITTED', (env) => {
    domainDispatch.dispatchGateEvent(env.payload);
  });
}

/** Share canonical contract labels, operator lines, follow-ups and cohort handling. */
export function registerContractRuntimeEvents(options: ContractRuntimeEventBridgeOptions): Array<() => void> {
  const { runtimeBus, getSystemMessageRouter, queueConversationFollowUp, requestRender, agentManager, contractRunner } = options;
  const unsubs: Array<() => void> = [];

  const onContract = <T extends ContractEvent['type']>(type: T, handler: (payload: Extract<ContractEvent, { type: T }>) => void): void => {
    // The bus delivers only events of `type`, so the payload is that member of the union.
    unsubs.push(runtimeBus.on<ContractEvent>(type, ({ payload }) => {
      handler(payload as Extract<ContractEvent, { type: T }>);
      requestRender();
    }));
  };
  /** A notice: something that needs the owner or tells them what became of work they asked for. */
  const contractLine = (message: string, runtimeEvent: RuntimeEventProvenance): void => {
    withRouter(getSystemMessageRouter, (router) => router.contract(`[Contract] ${message}`, 'high', runtimeEvent));
  };
  /**
   * Progress of a contract in flight (its start, its states, checks, nudges,
   * gates, stalls): the agents view (F2) shows the contract's current state on
   * its own row, so the line goes to the activity log, never to the notices.
   */
  const contractProgress = (message: string): void => {
    logger.info(`[Contract] ${message}`);
  };
  /** The cohort check for a contract that ended: any cohort one of its unit agents belongs to. */
  const checkContractCohorts = (contract: ReturnType<typeof contractRunner.get>): void => {
    if (!contract) return;
    const agentId = contract.units.flatMap((unit) => unit.agentIds).find((id) => agentManager.getStatus(id)?.cohort !== undefined);
    if (agentId === undefined) return;
    checkCohortCompletion(agentManager, contractRunner, agentManager.getStatus(agentId), getSystemMessageRouter, queueConversationFollowUp);
  };

  onContract('CONTRACT_CREATED', (payload) => {
    // Registered here as well as in the channel renderer, so two same-named
    // workstreams are numbered in a TUI-only run that never goes through a
    // channel. The words themselves come from the record at each ending.
    // Remembering twice is a no-op.
    rememberWorkstreamLabel(payload.contractId, payload.ask);
    // Activity log: the id belongs here, where it is used for correlation.
    contractProgress(`${payload.contractId} started: ${payload.ask}`);
  });

  onContract('CONTRACT_STATUS_CHANGED', (payload) => {
    contractProgress(`${payload.contractId} ${payload.from} -> ${payload.to}`);
  });

  // Contracts whose owner was already told the decision model could not judge some of the work.
  const notJudgedTold = new Set<string>();
  onContract('CONTRACT_CHECKED', (payload) => {
    // A turn-end check that only records history is not worth a line.
    if (payload.result === 'recorded') return;
    if (payload.decisionIds.length === 0) {
      const contract = contractRunner.get(payload.contractId);
      const checks = payload.scope === 'unit'
        ? contract?.units.flatMap((unit) => [unit, ...(unit.attemptUnits ?? [])]).find((unit) => unit.id === payload.targetId)?.checks
        : payload.scope === 'group' ? contract?.groups.find((group) => group.id === payload.targetId)?.checks : contract?.checks;
      const notJudged = checks?.find((check) => check.id === payload.checkId)?.notJudged;
      if (notJudged !== undefined) {
        // One line per contract, not one per check; a failing set model was already named by its own notice.
        if (!notJudgedTold.has(payload.contractId) && decisionModelFailure() === undefined) {
          contractLine(`${payload.contractId}: the decision model could not judge part of this work (${notJudged}); that work is kept as delivered and the contract goes on. Its result lists what was not judged.`, payload);
        }
        notJudgedTold.add(payload.contractId);
        return;
      }
    }
    const met = payload.criteria.filter((criterion) => criterion.verdict === 'met').length;
    const icon = payload.result === 'pass' ? '\u2713' : '\u2717';
    contractProgress(`${icon} Check ${payload.checkId} of ${payload.scope} ${payload.targetId}: ${met}/${payload.criteria.length} criteria met, ${payload.result}`);
  });

  onContract('CONTRACT_NUDGED', (payload) => {
    const criteria = payload.criterionIds.length > 0 ? ` on ${payload.criterionIds.join(', ')}` : '';
    contractProgress(`Nudged unit ${payload.unitId} (${payload.kinds.join(', ')})${criteria}`);
  });

  onContract('CONTRACT_CRITERION_REGRESSED', (payload) => {
    contractProgress(`Criterion ${payload.criterionId} of unit ${payload.unitId} regressed (met at ${payload.metAtCheckId})`);
  });

  onContract('CONTRACT_STALLED', (payload) => {
    contractProgress(`${payload.scope} ${payload.targetId} stalled, routed to ${payload.route}: ${payload.reason}`);
  });

  onContract('CONTRACT_ESCALATED', (payload) => {
    contractLine(`${payload.contractId} needs the owner: ${payload.question}`, payload);
  });

  // A contract that cannot go on yet (no model can be routed to plan it): what, why and how it goes on, once.
  onContract('CONTRACT_WAITING', (payload) => {
    contractLine(payload.reason, payload);
  });
  // One that began waiting before this conversation was wired (a contract resumed at start) is said now.
  for (const contract of contractRunner.list()) {
    if (isWaitingForPlannerRoute(contract) && contract.statusLine !== undefined) contractLine(contract.statusLine, { type: 'CONTRACT_WAITING' });
  }

  onContract('CONTRACT_GATE_RESULT', (payload) => {
    // A skipped gate is not a failure: it is drawn without a mark, with why it did not run.
    if (payload.skipped) {
      contractProgress(`  - Gate: ${payload.gate} ${payload.reason === 'dependencies-missing' ? 'could not run here: the project\'s dependencies are not installed where the work is' : 'skipped: it does not apply to this project'}`);
      return;
    }
    contractProgress(`  ${payload.passed ? '\u2713' : '\u2717'} Gate: ${payload.gate} ${payload.passed ? 'passed' : 'FAILED'}`);
  });

  onContract('CONTRACT_COMMITTED', (payload) => {
    const hash = payload.hash ? ` (${payload.hash.slice(0, 7)})` : '';
    contractLine(`Commit ${payload.status} for ${payload.contractId}${hash}: ${payload.note}`, payload);
  });

  onContract('CONTRACT_PASSED', (payload) => {
    notJudgedTold.delete(payload.contractId);
    // A routine success: the answer its follow-up brings reports it, so it is not a notice.
    contractProgress(`\u2713 ${payload.contractId} PASSED: ${payload.criteriaMet} of ${payload.criteriaJudged} criteria met, ${payload.nudges} corrections`);
    const contract = contractRunner.get(payload.contractId);
    queueConversationFollowUp?.(forTurn(contractEndFollowUp(payload, contract), contractTurn(agentManager, contract)));
    finishWorkstreamLabel(payload.contractId);
    checkContractCohorts(contract);
  });

  onContract('CONTRACT_FAILED', (payload) => {
    notJudgedTold.delete(payload.contractId);
    contractLine(`\u2717 ${payload.contractId} FAILED: ${payload.reason}`, payload);
    const contract = contractRunner.get(payload.contractId);
    queueConversationFollowUp?.(forTurn(contractEndFollowUp(payload, contract), contractTurn(agentManager, contract)));
    finishWorkstreamLabel(payload.contractId);
    checkContractCohorts(contract);
  });

  onContract('CONTRACT_CANCELLED', (payload) => {
    notJudgedTold.delete(payload.contractId);
    // Stopped by the owner or by the turn that owned it; the follow-up reports it, so it is not a notice.
    contractProgress(`${payload.contractId} cancelled: ${payload.reason} (${payload.filesModified} files modified)`);
    const contract = contractRunner.get(payload.contractId);
    queueConversationFollowUp?.(forTurn(contractEndFollowUp(payload, contract), contractTurn(agentManager, contract)));
    finishWorkstreamLabel(payload.contractId);
    checkContractCohorts(contract);
  });

  return unsubs;
}

export function registerHostRuntimeEvents(options: HostRuntimeEventBridgeOptions): HostRuntimeEventBridge {
  const {
    runtimeBus,
    domainDispatch,
    getSystemMessageRouter,
    queueConversationFollowUp,
    requestRender,
    agentManager,
    contractRunner,
  } = options;
  const unsubs: Array<() => void> = [];

  // The conversation domain describes the foreground conversation; the
  // envelope's session lets the store ignore other sessions' turns on this bus.
  unsubs.push(runtimeBus.onDomain('turn', (env) => {
    domainDispatch.dispatchTurnEvent(env.payload, env.sessionId);
  }));
  // The store's unfinished-tool-call list, read by the stuck-turn diagnostic, is fed only from here.
  unsubs.push(runtimeBus.onDomain('tools', (env) => {
    domainDispatch.dispatchToolEvent(env.payload, env.sessionId);
  }));
  unsubs.push(runtimeBus.onDomain('agents', (env) => {
    domainDispatch.dispatchAgentEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('contracts', (env) => {
    domainDispatch.dispatchContractEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('communication', (env) => {
    domainDispatch.dispatchCommunicationEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('compaction', (env) => {
    domainDispatch.dispatchCompactionEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('transport', (env) => {
    domainDispatch.dispatchTransportEvent(env.payload);
  }));
  unsubs.push(registerGateRuntimeEvents(runtimeBus, domainDispatch));
  // The MCP registry publishes its lifecycle on the bus; the runtime store
  // (health, read models, recommendations) only learns of it here. Plugin
  // state is read from the plugin manager itself.
  unsubs.push(runtimeBus.onDomain('mcp', (env) => {
    domainDispatch.dispatchMcpEvent(env.payload);
  }));

  unsubs.push(runtimeBus.on<Extract<ProviderEvent, { type: 'MODEL_FALLBACK' }>>('MODEL_FALLBACK', ({ payload }) => {
    withRouter(getSystemMessageRouter, (router) => {
      router.high(`[Model] ${payload.from} exhausted across all providers. Automatically falling back to ${payload.to} via ${payload.provider}.`, 'warning');
    });
    requestRender();
  }));

  unsubs.push(...registerContractRuntimeEvents({
    runtimeBus, getSystemMessageRouter, queueConversationFollowUp,
    requestRender, agentManager, contractRunner,
  }));

  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_STREAM_DELTA' }>>('AGENT_STREAM_DELTA', () => {
    requestRender();
  }));
  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_PROGRESS' }>>('AGENT_PROGRESS', () => {
    requestRender();
  }));

  const voice = agentLineWording(options.agentLineVoice ?? 'agents');
  const checkCohort = (record: ReturnType<AgentManager['getStatus']>): void => {
    checkCohortCompletion(agentManager, contractRunner, record ?? null, getSystemMessageRouter, queueConversationFollowUp);
  };

  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', ({ payload }) => {
    const record = agentManager.getStatus(payload.agentId);
    if (record) {
      const facts = agentLineFacts(record, payload.agentId, voice);
      logger.info(voice.completedLine(facts));
      const followUp = agentEndFollowUp(record, payload.agentId, undefined, voice);
      if (followUp) queueConversationFollowUp?.(forTurn(followUp, agentManager.requestTurnOf(payload.agentId)));
    }
    checkCohort(record);
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>('AGENT_FAILED', ({ payload }) => {
    const record = agentManager.getStatus(payload.agentId);
    if (record && record.status !== 'cancelled') {
      const facts = agentLineFacts(record, payload.agentId, voice);
      // A spent turn budget is stamped on the record at the source
      // (failureReason 'max_turns' plus the applied limit and what set it): an
      // expected, nameable outcome, worded as a budget line, not as a failure.
      // An agent's end is not a notice: the turn or follow-up that waits for it
      // gives the model its result and the answer reports it, and the agents
      // view shows the agent's state. The line goes to the activity log.
      if (record.failureReason === 'max_turns' && record.turnBudget) {
        const budget = { limit: record.turnBudget.limit, source: turnBudgetSourceLabel(record.turnBudget.source) };
        logger.info(voice.budgetLine(facts, budget));
      } else {
        const postLine = (envelope: string | null): void => {
          logger.info(voice.failedLine(facts, payload.error, envelope));
        };
        const toolRegistry = options.toolRegistry;
        if (toolRegistry) {
          void fetchChildFailureSummary(toolRegistry, payload.agentId).then((envelope) => {
            postLine(envelope);
            requestRender();
          });
        } else {
          postLine(null);
        }
      }
      const followUp = agentEndFollowUp(record, payload.agentId, payload.error, voice);
      if (followUp) queueConversationFollowUp?.(forTurn(followUp, agentManager.requestTurnOf(payload.agentId)));
    }
    checkCohort(record);
    requestRender();
  }));

  // A cancelled run emits AGENT_CANCELLED, never AGENT_FAILED; when it is the
  // last of its cohort to end, the cohort is reported from here.
  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_CANCELLED' }>>('AGENT_CANCELLED', ({ payload }) => {
    checkCohort(agentManager.getStatus(payload.agentId));
    requestRender();
  }));

  // A change of the mode in force is the status bar's: its mode segment shows
  // the new words and flashes (terminal-shell session-permission-mode.ts).
  // Nothing is written into the conversation or posted as a notice.
  unsubs.push(runtimeBus.on<Extract<GateEvent, { type: 'PRESET_CHANGED' }>>('PRESET_CHANGED', () => {
    requestRender();
  }));

  if (options.compactionReceiptLines) {
    // When the compaction did not apply, `detail` carries the reason, so a
    // silent revert is never silent.
    unsubs.push(runtimeBus.on<Extract<CompactionEvent, { type: 'COMPACTION_RECEIPT' }>>('COMPACTION_RECEIPT', ({ payload }) => {
      withRouter(getSystemMessageRouter, (router) => {
        // A compaction that did not apply says so here, once, at its level; nothing else repeats it.
        router.high(`[Compaction] ${formatCompactionReceipt(payload)}`,
          payload.outcome === 'failed' ? 'error' : payload.outcome === 'kept-original' ? 'warning' : undefined);
      });
      requestRender();
    }));
  }

  return {
    unsubs,
    dispose: () => {
      for (const unsub of unsubs.splice(0)) unsub();
    },
  };
}

/**
 * The conversation follow-up for an agent that ended (`error` undefined: it
 * completed), or null when its end is no reply of its own: a contract's agents
 * (its units, its owner, and the planners that write its plan and its fix
 * plans, whose output the contract reads itself) report through the contract,
 * and a cancelled run was stopped on purpose.
 */
function agentEndFollowUp(record: NonNullable<ReturnType<AgentManager['getStatus']>>, agentId: string, error: string | undefined,
  voice: AgentLineWording): ConversationFollowUpItem | null {
  if (record.contractId || hasContractPlanConsumer(record)) return null;
  const facts = agentLineFacts(record, agentId, voice);
  if (error === undefined) {
    const output = record.fullOutput?.trim();
    return { key: `agent:${agentId}:completed`, summary: voice.completedSummary(facts), ...(output ? { result: output } : {}) };
  }
  if (record.status === 'cancelled') return null;
  if (record.failureReason === 'max_turns' && record.turnBudget) {
    return { key: `agent:${agentId}:failed`, summary: voice.budgetSummary(facts, { limit: record.turnBudget.limit, source: turnBudgetSourceLabel(record.turnBudget.source) }) };
  }
  return { key: `agent:${agentId}:failed`, summary: voice.failedSummary(facts, error) };
}

type ContractEndEvent = Extract<ContractEvent, { type: 'CONTRACT_PASSED' | 'CONTRACT_FAILED' | 'CONTRACT_CANCELLED' }>;

/**
 * The conversation follow-up for a contract that ended. It is read by the
 * person, not the operator, so it is named in plain words, from the record so
 * it still names the request after a restart. The `key` keeps the id: it is a
 * dedupe key nobody reads. See channels/workstream-labels.ts.
 */
function contractEndFollowUp(event: ContractEndEvent, contract: ReturnType<ContractRunner['get']>): ConversationFollowUpItem {
  const label = workstreamLabel(event.contractId, contract?.ask);
  if (event.type === 'CONTRACT_PASSED') {
    const answer = contract?.answer?.trim();
    return { key: `contract:${event.contractId}:passed`, summary: `${label} passed all its checks.`, ...(answer ? { result: answer } : {}) };
  }
  if (event.type === 'CONTRACT_FAILED') {
    return { key: `contract:${event.contractId}:failed`, summary: `${label} could not be finished: ${event.reason.slice(0, 120)}` };
  }
  return { key: `contract:${event.contractId}:cancelled`, summary: `${label} was cancelled: ${event.reason.slice(0, 120)}` };
}

/**
 * Follow-ups for one conversation session on a bus several sessions share (a
 * hosted session on a daemon floor): only the agents and contracts that session
 * started, so its next turn hears its own background work and never another
 * session's. Returns the call that stops it.
 */
export function registerSessionFollowUps(options: {
  readonly runtimeBus: RuntimeEventBus;
  readonly agentManager: Pick<AgentManager, 'getStatus' | 'requestTurnOf'>;
  readonly contractRunner: Pick<ContractRunner, 'get'>;
  readonly sessionId: string;
  readonly queueConversationFollowUp: (item: ConversationFollowUpItem) => void;
}): () => void {
  const { runtimeBus, agentManager, contractRunner, sessionId, queueConversationFollowUp } = options;
  const voice = agentLineWording('agents');
  const onAgentEnd = (agentId: string, error: string | undefined): void => {
    const record = agentManager.getStatus(agentId);
    if (!record || record.sessionId !== sessionId) return;
    const followUp = agentEndFollowUp(record, agentId, error, voice);
    if (followUp) queueConversationFollowUp(forTurn(followUp, agentManager.requestTurnOf(agentId)));
  };
  const onContractEnd = (event: ContractEndEvent): void => {
    const contract = contractRunner.get(event.contractId);
    if (contract?.sessionId !== sessionId) return;
    queueConversationFollowUp(forTurn(contractEndFollowUp(event, contract), contractTurn(agentManager, contract)));
  };
  const unsubs = [
    runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', ({ payload }) => onAgentEnd(payload.agentId, undefined)),
    runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>('AGENT_FAILED', ({ payload }) => onAgentEnd(payload.agentId, payload.error)),
    runtimeBus.on<Extract<ContractEvent, { type: 'CONTRACT_PASSED' }>>('CONTRACT_PASSED', ({ payload }) => onContractEnd(payload)),
    runtimeBus.on<Extract<ContractEvent, { type: 'CONTRACT_FAILED' }>>('CONTRACT_FAILED', ({ payload }) => onContractEnd(payload)),
    runtimeBus.on<Extract<ContractEvent, { type: 'CONTRACT_CANCELLED' }>>('CONTRACT_CANCELLED', ({ payload }) => onContractEnd(payload)),
  ];
  return () => { for (const unsub of unsubs.splice(0)) unsub(); };
}

interface AgentLineFacts {
  readonly template: string;
  readonly id: string;
  readonly task: string;
  readonly seconds: number;
  readonly toolCalls: number;
}

interface AgentLineWording {
  readonly ellipsis: string;
  completedLine(facts: AgentLineFacts): string;
  completedSummary(facts: AgentLineFacts): string;
  failedLine(facts: AgentLineFacts, error: string, envelope: string | null): string;
  failedSummary(facts: AgentLineFacts, error: string): string;
  budgetLine(facts: AgentLineFacts, budget: { limit: number; source: string }): string;
  budgetSummary(facts: AgentLineFacts, budget: { limit: number; source: string }): string;
}

const AGENT_LINE_WORDING: Record<HostAgentLineVoice, AgentLineWording> = {
  agents: {
    ellipsis: '\u2026',
    completedLine: (f) => `[Agents] \u2713 ${f.template} ${f.id}: "${f.task}" \u2014 completed in ${f.seconds}s (${f.toolCalls} tool calls)`,
    completedSummary: (f) => `${f.template} agent ${f.id} completed "${f.task}" in ${f.seconds}s after ${f.toolCalls} tool calls.`,
    failedLine: (f, error, envelope) => `[Agents] \u2717 ${f.template} ${f.id}: "${f.task}" \u2014 failed in ${f.seconds}s: ${error}${envelope ? ` (${envelope})` : ''}`,
    failedSummary: (f, error) => `${f.template} agent ${f.id} failed after ${f.seconds}s while working on "${f.task}": ${error.slice(0, 120)}`,
    // Kept in the failed-line shape the operator feed reads (runtime-event-notices.ts); the detail names the budget.
    budgetLine: (f, b) => `[Agents] \u2717 ${f.template} ${f.id}: "${f.task}" \u2014 failed in ${f.seconds}s: spent its ${b.limit}-turn budget (${b.source})`,
    budgetSummary: (f, b) => `${f.template} agent ${f.id} spent its ${b.limit}-turn budget (${b.source}) while working on "${f.task}".`,
  },
  'delegated-task': {
    ellipsis: '...',
    completedLine: (f) => `[Delegated task] ${f.template} ${f.id} completed in ${f.seconds}s "${f.task}"`,
    completedSummary: (f) => `${f.template} delegated task ${f.id} completed "${f.task}" in ${f.seconds}s after ${f.toolCalls} tool calls.`,
    failedLine: (f, error, envelope) => `[Delegated task] ${f.template} ${f.id} failed in ${f.seconds}s ${error}${envelope ? ` (${envelope})` : ''}`,
    failedSummary: (f, error) => `${f.template} delegated task ${f.id} failed while working on "${f.task}" ${error.slice(0, 120)}`,
    budgetLine: (f, b) => `[Delegated task] ${f.template} ${f.id} spent its turn budget in ${f.seconds}s, ${b.limit} turns (${b.source}) while working on "${f.task}"`,
    budgetSummary: (f, b) => `${f.template} delegated task ${f.id} spent its ${b.limit}-turn budget (${b.source}) while working on "${f.task}".`,
  },
};

function agentLineWording(voice: HostAgentLineVoice): AgentLineWording {
  return AGENT_LINE_WORDING[voice];
}

function agentLineFacts(record: NonNullable<ReturnType<AgentManager['getStatus']>>, agentId: string, voice: AgentLineWording): AgentLineFacts {
  return {
    template: record.template,
    id: agentId.slice(-8),
    task: record.task.length > 50 ? `${record.task.slice(0, 50)}${voice.ellipsis}` : record.task,
    seconds: record.completedAt !== undefined ? Math.round((record.completedAt - record.startedAt) / 1000) : 0,
    toolCalls: record.toolCallCount,
  };
}

function turnBudgetSourceLabel(source: string): string {
  return source === 'default'
    ? 'the default agents.maxTurns'
    : source === 'spawn-override'
      ? 'a per-spawn override'
      : 'the agents.maxTurnsCap policy ceiling';
}

/** One line per compaction receipt: strategy, trigger and outcome, with the reason when it did not apply. */
function formatCompactionReceipt(payload: Extract<CompactionEvent, { type: 'COMPACTION_RECEIPT' }>): string {
  const { strategy, trigger, outcome, tokensBefore, tokensAfter, detail } = payload;
  if (outcome === 'applied') {
    const saved = Math.max(0, tokensBefore - tokensAfter);
    return `${strategy} (${trigger}) applied, ${saved.toLocaleString()} tokens reclaimed`;
  }
  const reason = detail ? `: ${detail}` : '';
  return `${strategy} (${trigger}) ${outcome}${reason}`;
}

interface ChildFailureEnvelopeLike {
  readonly phase?: string;
  readonly reason?: { readonly code?: string };
  readonly partialOutputs?: { readonly note?: string; readonly turnsCompleted?: number };
}

/**
 * The structured failure the `agent` tool attaches to its `status` result,
 * read through the same tool the model calls, as
 * `reason: <code>, phase: <phase>[, N turns completed][, note]`. Read-only;
 * null when the record or result cannot be read, so the base line still lands.
 */
async function fetchChildFailureSummary(toolRegistry: Pick<ToolRegistry, 'execute'>, agentId: string): Promise<string | null> {
  try {
    const result = await toolRegistry.execute('agent-runtime-events:child-failure-envelope', 'agent', { mode: 'status', agentId });
    if (!result.success || !result.output) return null;
    const parsed = JSON.parse(result.output) as { failure?: ChildFailureEnvelopeLike };
    const failure = parsed.failure;
    if (!failure) return null;
    const parts = [`reason: ${failure.reason?.code ?? 'error'}`];
    if (failure.phase) parts.push(`phase: ${failure.phase}`);
    if (failure.partialOutputs?.turnsCompleted !== undefined) parts.push(`${failure.partialOutputs.turnsCompleted} turns completed`);
    if (failure.partialOutputs?.note) parts.push(failure.partialOutputs.note);
    return parts.join(', ');
  } catch (err) {
    logger.debug('runtime events: child-failure envelope could not be read', { agentId, error: String(err) });
    return null;
  }
}

export type BootstrapRuntimeEventBridgeOptions = HostRuntimeEventBridgeOptions;
export const registerBootstrapRuntimeEvents = registerHostRuntimeEvents;
