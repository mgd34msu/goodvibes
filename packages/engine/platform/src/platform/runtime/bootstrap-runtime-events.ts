import type { RuntimeEventProvenance } from '../../events/occurrence.js';
export type { RuntimeEventProvenance } from '../../events/occurrence.js';
import type { ConversationFollowUpItem } from '../core/conversation-follow-ups.js';
import type { AgentEvent, CompactionEvent, ProviderEvent, RuntimeEventBus } from './events/index.js';
import type { GateEvent } from '../../events/gate.js';
import type { ContractEvent } from '../../events/contract.js';
import type { createDomainDispatch } from './store/index.js';
import type { ContractRunner } from '../contract/runner.js';
import type { AgentManager } from '../tools/agent/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import { logger } from '../utils/logger.js';
import { finishWorkstreamLabel, rememberWorkstreamLabel, workstreamLabel } from '../channels/workstream-labels.js';

const AGENT_STATUS_INTERVAL_MS = 30_000;

export interface HostRuntimeMessageRouter {
  low(message: string, runtimeEvent?: RuntimeEventProvenance): void;
  high(message: string): void;
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

/** The bridge's subscriptions and its status timer; `dispose` ends both. */
export interface HostRuntimeEventBridge {
  dispose(): void;
  readonly unsubs: Array<() => void>;
  readonly agentStatusIntervalRef: { value: ReturnType<typeof setInterval> | null };
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

function buildCohortFollowUp(agentManager: AgentManager, cohort: string): ConversationFollowUpItem {
  const agents = agentManager.listByCohort(cohort);
  const completed = agents.filter((agent) => agent.status === 'completed').length;
  const failed = agents.filter((agent) => agent.status === 'failed').length;
  const cancelled = agents.filter((agent) => agent.status === 'cancelled').length;
  return {
    key: `cohort:${cohort}:complete`,
    summary: `Agent cohort "${cohort}" finished with ${completed} completed, ${failed} failed, and ${cancelled} cancelled out of ${agents.length} total agents.`,
  };
}

/**
 * The last finished state reported for each cohort, so a late event for an agent that already
 * ended (the same terminal statuses) does not repeat the completion line.
 */
const reportedCohortStates = new WeakMap<AgentManager, Map<string, string>>();

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
  const cohortAgentIds = new Set(cohortAgents.map((agent) => agent.id));
  const cohortContracts = contractRunner.list({ includeTerminal: true }).filter((contract) =>
    contract.units.some((unit) => unit.agentIds.some((agentId) => cohortAgentIds.has(agentId))),
  );
  const terminalStatuses = new Set(['passed', 'failed', 'cancelled']);
  if (!cohortContracts.every((contract) => terminalStatuses.has(contract.status))) return;

  const state = cohortAgents.map((agent) => `${agent.id}:${agent.status}`).sort().join('|');
  let reported = reportedCohortStates.get(agentManager);
  if (!reported) { reported = new Map(); reportedCohortStates.set(agentManager, reported); }
  if (reported.get(record.cohort) === state) return;
  reported.set(record.cohort, state);

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
 * Feed the gate's events into the runtime store: the permissions domain's
 * last decision, counters and in-flight calls (what `approvals.list` serves)
 * are set only from here. Every product composition calls it once per store.
 */
export function registerGateRuntimeEvents(
  runtimeBus: RuntimeEventBus,
  domainDispatch: Pick<ReturnType<typeof createDomainDispatch>, 'dispatchGateEvent'>,
): () => void {
  return runtimeBus.onDomain('gate', (env) => {
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
  const contractLine = (message: string, runtimeEvent: RuntimeEventProvenance): void => {
    withRouter(getSystemMessageRouter, (router) => router.contract(`[Contract] ${message}`, 'high', runtimeEvent));
  };
  /** The cohort check for a contract that ended: any cohort one of its unit agents belongs to. */
  const checkContractCohorts = (contractId: string): void => {
    const contract = contractRunner.get(contractId);
    if (!contract) return;
    const agentId = contract.units.flatMap((unit) => unit.agentIds).find((id) => agentManager.getStatus(id)?.cohort !== undefined);
    if (agentId === undefined) return;
    checkCohortCompletion(agentManager, contractRunner, agentManager.getStatus(agentId), getSystemMessageRouter, queueConversationFollowUp);
  };

  onContract('CONTRACT_CREATED', (payload) => {
    // Registered here as well as in the channel renderer, because the
    // conversation follow-ups below need a name for this contract and a
    // TUI-only run never goes through a channel. Remembering twice is a no-op.
    rememberWorkstreamLabel(payload.contractId, payload.ask);
    // Operator feed: the id belongs here, where it is used for correlation.
    contractLine(`${payload.contractId} started: ${payload.ask}`, payload);
  });

  onContract('CONTRACT_STATUS_CHANGED', (payload) => {
    contractLine(`${payload.contractId} ${payload.from} -> ${payload.to}`, payload);
  });

  onContract('CONTRACT_CHECKED', (payload) => {
    // A turn-end check that only records history is not worth a line.
    if (payload.result === 'recorded') return;
    const met = payload.criteria.filter((criterion) => criterion.verdict === 'met').length;
    const icon = payload.result === 'pass' ? '\u2713' : '\u2717';
    contractLine(`${icon} Check ${payload.checkId} of ${payload.scope} ${payload.targetId}: ${met}/${payload.criteria.length} criteria met, ${payload.result}`, payload);
  });

  onContract('CONTRACT_NUDGED', (payload) => {
    const criteria = payload.criterionIds.length > 0 ? ` on ${payload.criterionIds.join(', ')}` : '';
    contractLine(`Nudged unit ${payload.unitId} (${payload.kinds.join(', ')})${criteria}`, payload);
  });

  onContract('CONTRACT_CRITERION_REGRESSED', (payload) => {
    contractLine(`Criterion ${payload.criterionId} of unit ${payload.unitId} regressed (met at ${payload.metAtCheckId})`, payload);
  });

  onContract('CONTRACT_STALLED', (payload) => {
    contractLine(`${payload.scope} ${payload.targetId} stalled, routed to ${payload.route}: ${payload.reason}`, payload);
  });

  onContract('CONTRACT_ESCALATED', (payload) => {
    contractLine(`${payload.contractId} needs the owner: ${payload.question}`, payload);
  });

  onContract('CONTRACT_GATE_RESULT', (payload) => {
    const icon = payload.passed ? '\u2713' : '\u2717';
    contractLine(`  ${icon} Gate: ${payload.gate} ${payload.skipped ? 'skipped' : payload.passed ? 'passed' : 'FAILED'}`, payload);
  });

  onContract('CONTRACT_COMMITTED', (payload) => {
    const hash = payload.hash ? ` (${payload.hash.slice(0, 7)})` : '';
    contractLine(`Commit ${payload.status} for ${payload.contractId}${hash}: ${payload.note}`, payload);
  });

  onContract('CONTRACT_PASSED', (payload) => {
    contractLine(`\u2713 ${payload.contractId} PASSED: ${payload.criteriaMet} of ${payload.criteriaJudged} criteria met, ${payload.nudges} corrections`, payload);
    const answer = contractRunner.get(payload.contractId)?.answer?.trim();
    // A conversation follow-up is read by the person, not the operator, so it
    // is named in plain words. The `key` keeps the id: it is a dedupe key
    // nobody reads. See channels/workstream-labels.ts.
    queueConversationFollowUp?.({
      key: `contract:${payload.contractId}:passed`,
      summary: `${workstreamLabel(payload.contractId)} passed all its checks.`,
      ...(answer ? { result: answer } : {}),
    });
    finishWorkstreamLabel(payload.contractId);
    checkContractCohorts(payload.contractId);
  });

  onContract('CONTRACT_FAILED', (payload) => {
    contractLine(`\u2717 ${payload.contractId} FAILED: ${payload.reason}`, payload);
    queueConversationFollowUp?.({
      key: `contract:${payload.contractId}:failed`,
      summary: `${workstreamLabel(payload.contractId)} could not be finished: ${payload.reason.slice(0, 120)}`,
    });
    finishWorkstreamLabel(payload.contractId);
    checkContractCohorts(payload.contractId);
  });

  onContract('CONTRACT_CANCELLED', (payload) => {
    contractLine(`${payload.contractId} cancelled: ${payload.reason} (${payload.filesModified} files modified)`, payload);
    queueConversationFollowUp?.({
      key: `contract:${payload.contractId}:cancelled`,
      summary: `${workstreamLabel(payload.contractId)} was cancelled: ${payload.reason.slice(0, 120)}`,
    });
    finishWorkstreamLabel(payload.contractId);
    checkContractCohorts(payload.contractId);
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

  unsubs.push(runtimeBus.onDomain('turn', (env) => {
    domainDispatch.dispatchTurnEvent(env.payload);
  }));
  // The store's unfinished-tool-call list, read by the stuck-turn diagnostic, is fed only from here.
  unsubs.push(runtimeBus.onDomain('tools', (env) => {
    domainDispatch.dispatchToolEvent(env.payload);
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
  // The MCP registry and plugin manager publish their lifecycle on the bus; the
  // runtime store (health, read models, recommendations) only learns of it here.
  unsubs.push(runtimeBus.onDomain('mcp', (env) => {
    domainDispatch.dispatchMcpEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('plugins', (env) => {
    domainDispatch.dispatchPluginEvent(env.payload);
  }));

  unsubs.push(runtimeBus.on<Extract<ProviderEvent, { type: 'MODEL_FALLBACK' }>>('MODEL_FALLBACK', ({ payload }) => {
    withRouter(getSystemMessageRouter, (router) => {
      router.high(`[Model] ${payload.from} exhausted across all providers. Automatically falling back to ${payload.to} via ${payload.provider}.`);
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
      withRouter(getSystemMessageRouter, (router) => {
        router.low(voice.completedLine(facts), payload);
      });
      // A contract delivers its checked answer when the owner finishes.
      // Planner/unit milestones are not separate replies to the user.
      if (!record.contractId) queueConversationFollowUp?.({
        key: `agent:${payload.agentId}:completed`,
        summary: voice.completedSummary(facts),
        ...(record.fullOutput?.trim() ? { result: record.fullOutput.trim() } : {}),
      });
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
      if (record.failureReason === 'max_turns' && record.turnBudget) {
        const budget = { limit: record.turnBudget.limit, source: turnBudgetSourceLabel(record.turnBudget.source) };
        withRouter(getSystemMessageRouter, (router) => {
          router.low(voice.budgetLine(facts, budget), payload);
        });
        if (!record.contractId) queueConversationFollowUp?.({
          key: `agent:${payload.agentId}:failed`,
          summary: voice.budgetSummary(facts, budget),
        });
      } else {
        const postLine = (envelope: string | null): void => {
          withRouter(getSystemMessageRouter, (router) => {
            router.low(voice.failedLine(facts, payload.error, envelope), payload);
          });
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
        if (!record.contractId) queueConversationFollowUp?.({
          key: `agent:${payload.agentId}:failed`,
          summary: voice.failedSummary(facts, payload.error),
        });
      }
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

  unsubs.push(runtimeBus.on<Extract<GateEvent, { type: 'PRESET_CHANGED' }>>('PRESET_CHANGED', ({ payload }) => {
    withRouter(getSystemMessageRouter, (router) => {
      router.high(`[Permissions] Permission preset changed: ${payload.previousPreset} -> ${payload.preset}.`);
    });
    requestRender();
  }));

  if (options.compactionReceiptLines) {
    // When the compaction did not apply, `detail` carries the reason, so a
    // silent revert is never silent.
    unsubs.push(runtimeBus.on<Extract<CompactionEvent, { type: 'COMPACTION_RECEIPT' }>>('COMPACTION_RECEIPT', ({ payload }) => {
      withRouter(getSystemMessageRouter, (router) => {
        router.high(`[Compaction] ${formatCompactionReceipt(payload)}`);
      });
      requestRender();
    }));
  }

  const agentStatusIntervalRef: { value: ReturnType<typeof setInterval> | null } = { value: null };
  agentStatusIntervalRef.value = setInterval(() => {
    const running = agentManager.list().filter((agent) => agent.status === 'running');
    if (running.length === 0) return;
    withRouter(getSystemMessageRouter, (router) => {
      router.low(voice.runningLine(running.map((agent) => ({ id: agent.id.slice(-8), progress: agent.progress ?? agent.status }))));
    });
    requestRender();
  }, AGENT_STATUS_INTERVAL_MS);
  // Don't block clean process exit.
  (agentStatusIntervalRef.value as unknown as { unref?: () => void }).unref?.();

  return {
    unsubs,
    agentStatusIntervalRef,
    dispose: () => {
      if (agentStatusIntervalRef.value) clearInterval(agentStatusIntervalRef.value);
      agentStatusIntervalRef.value = null;
      for (const unsub of unsubs.splice(0)) unsub();
    },
  };
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
  runningLine(running: ReadonlyArray<{ id: string; progress: string }>): string;
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
    runningLine: (running) => `[Agents] ${running.length} running:\n${running.map((agent) => `  ${agent.id}: ${agent.progress}`).join('\n')}`,
  },
  'delegated-task': {
    ellipsis: '...',
    completedLine: (f) => `[Delegated task] ${f.template} ${f.id} completed in ${f.seconds}s "${f.task}"`,
    completedSummary: (f) => `${f.template} delegated task ${f.id} completed "${f.task}" in ${f.seconds}s after ${f.toolCalls} tool calls.`,
    failedLine: (f, error, envelope) => `[Delegated task] ${f.template} ${f.id} failed in ${f.seconds}s ${error}${envelope ? ` (${envelope})` : ''}`,
    failedSummary: (f, error) => `${f.template} delegated task ${f.id} failed while working on "${f.task}" ${error.slice(0, 120)}`,
    budgetLine: (f, b) => `[Delegated task] ${f.template} ${f.id} spent its turn budget in ${f.seconds}s, ${b.limit} turns (${b.source}) while working on "${f.task}"`,
    budgetSummary: (f, b) => `${f.template} delegated task ${f.id} spent its ${b.limit}-turn budget (${b.source}) while working on "${f.task}".`,
    runningLine: (running) => `[Delegated task] ${running.length} running\n${running.map((agent) => `  ${agent.id} ${agent.progress}`).join('\n')}`,
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
