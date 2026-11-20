import { publishTurnTerminal } from './turn-cancellation.js';
import { isNativeConversationTurn } from './native-turn-scope.js';
import { withCompletionRepairContext } from './completion-repair-context.js';
import { withDelegationRequest } from './delegation-request-context.js';
import type { ConversationManager } from './conversation.js';
import type { ConfigManager } from '../config/manager.js';
import type { ContentPart, LLMProvider } from '../providers/interface.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { logger } from '../utils/logger.js';
import { attachToolResultImages } from './tool-result-images.js';
import type { ExecutionPlan, ExecutionPlanManager } from './execution-plan.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { emitCommunicationConsumed, emitToolReconciled, emitTurnCompleted } from '../runtime/emitters/index.js';
import { buildSyntheticResult } from './tool-reconciliation.js';
import type { ToolCall, ToolResult } from '../types/tools.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolInputProjectionOptions } from '../tools/input-projection.js';
import { captureToolInputCalls, projectToolInputBatch } from './tool-input-ingress.js';
import type { AgentManager, AgentRecord } from '../tools/agent/index.js';
import type { ContractSessionHooks } from '../contract/agent-hooks.js';
import { toolResultStartedContract } from '../contract/intake-route.js';

type EmitterContextFactory = (turnId: string) => import('../runtime/emitters/index.js').EmitterContext;
export type ChatResponseWithReasoning = Awaited<ReturnType<LLMProvider['chat']>> & {
  reasoning?: string | undefined;
  reasoningSummary?: string | undefined;
};

export interface TurnPreparationOptions {
  readonly signal?: AbortSignal;
  /** Capture the transcript boundary before awaiting a reading or cancellation. */
  readonly onMessageAdded?: () => void;
}

export async function prepareConversationForTurn(
  conversation: ConversationManager,
  providerRegistry: Pick<ProviderRegistry, 'getCurrentModel'>,
  text: string,
  content: ContentPart[] | undefined,
  sessionId?: string,
  planManager: Pick<ExecutionPlanManager, 'getActive' | 'toMarkdown'> | null = null,
  options: TurnPreparationOptions = {},
): Promise<ExecutionPlan | null> {
  const nativeTurn = isNativeConversationTurn();
  const preTurnPlan = nativeTurn ? null : planManager?.getActive(sessionId) ?? null;
  // The project work plan's open items reach the model once per user turn, on
  // its first request. The person already has the work plan view, so no
  // transcript line repeats the plan on every turn.
  if (preTurnPlan && planManager) {
    const planMd = planManager.toMarkdown(preTurnPlan);
    const planText = `## Current Work Plan\n${planMd}\nRefer to this plan. Keep item statuses current with the \`work_plan\` tool as you work.`;
    conversation.hostInstructions.set('plan', planText, { once: true });
  } else conversation.hostInstructions.clear('plan');

  if (content && content.some(p => p.type === 'image')) {
    const model = providerRegistry.getCurrentModel();
    if (!model.capabilities.multimodal) {
      conversation.addNotice(
        `Warning: ${model.displayName} does not support image input. Images have been removed from this message.`,
        { level: 'warning' },
      );
      const textOnly = content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map(p => p.text)
        .join('');
      conversation.addUserMessage(textOnly || text);
    } else {
      conversation.addUserMessage(content);
    }
  } else {
    conversation.addUserMessage(content ?? text);
  }

  options.onMessageAdded?.();
  // The person's message goes to the conversation model as it is; nothing reads it first.
  return preTurnPlan;
}

export type { ContractSessionHooks };

/** Binds this turn to the session-mode unit waiting in the session, when there is one. */
export function bindContractSession(hooks: ContractSessionHooks | undefined, sessionId: string, turnId: string): ContractSessionTurn | undefined {
  const record = hooks?.sessionTurn(sessionId, turnId) ?? null;
  return hooks === undefined || record === null ? undefined : { hooks, record, turn: 0 };
}

/**
 * A session-mode contract's unit bound to this turn (contract runner design
 * 6.6): the turn is the unit's executor. Its tool turns are reported to the
 * runner, and where the turn would complete it is held for the unit's check;
 * a nudge comes back as a user message and the turn goes on.
 */
export interface ContractSessionTurn {
  readonly hooks: ContractSessionHooks;
  /** The turn's stand-in record: `id` is the turn id, and it carries the unit binding. */
  readonly record: AgentRecord;
  /** Tool rounds reported so far this turn. */
  turn: number;
}

type ConsumedEmitterArgs = { readonly runtimeBus: RuntimeEventBus | null; readonly emitterContext: EmitterContextFactory; readonly turnId: string };

function nudgeConsumed(args: ConsumedEmitterArgs, session: ContractSessionTurn, nudgeId: string): void {
  if (!args.runtimeBus) return;
  emitCommunicationConsumed(args.runtimeBus, args.emitterContext(args.turnId), { messageId: nudgeId, agentId: session.record.id, turn: session.turn });
}

/** Reports a tool round of a session-mode turn to the contract runner; a hook fault is logged, never thrown into the turn. */
export function reportSessionToolRound(session: ContractSessionTurn, round: { readonly toolCalls: readonly ToolCall[]; readonly results: readonly ToolResult[]; readonly assistantText: string }): void {
  session.turn += 1;
  try {
    session.hooks.onTurnEnd(session.record, {
      turn: session.turn,
      toolCalls: round.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments as Record<string, unknown> })),
      results: round.results,
      assistantText: round.assistantText,
    });
  } catch (error) {
    logger.warn('Orchestrator: the contract turn-end hook failed', { turnId: session.record.id, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Takes the nudges the runner queued for this session turn and reports each as
 * consumed. The caller puts them in the next model call's private context; they
 * are host instructions, so they never enter the transcript as the person's words.
 */
export function takeSessionNudges(args: ConsumedEmitterArgs, session: ContractSessionTurn): string[] {
  const messages: string[] = [];
  for (let nudge = session.hooks.takeSessionNudge(session.record); nudge !== null; nudge = session.hooks.takeSessionNudge(session.record)) {
    messages.push(nudge.message);
    nudgeConsumed(args, session, nudge.nudgeId);
  }
  return messages;
}

/**
 * Holds a session-mode turn where it would complete, while the runner checks
 * the unit. Production keeps a rejected candidate and its nudge in private
 * revision context. Legacy embedded callers may supply a beforeNudge callback
 * and receive the nudge in their conversation. True requests another model
 * call; false lets the checked answer complete.
 */
export async function holdSessionCompletion(
  args: ConsumedEmitterArgs & { readonly conversation: ConversationManager },
  session: ContractSessionTurn,
  output: string,
  beforeNudge?: () => void,
  privateNudge?: (message: string) => void,
): Promise<boolean> {
  const outcome = await session.hooks.holdCompletion(session.record, output);
  if (outcome.kind !== 'continue') { session.record.fullOutput = output; return false; }
  beforeNudge?.();
  if (privateNudge) privateNudge(outcome.message);
  else args.conversation.addUserMessage(outcome.message);
  nudgeConsumed(args, session, outcome.nudgeId);
  return true;
}

/** Hold the candidate privately until the contract accepts it, then permit publication. */
export function holdSessionFinalResponse(
  args: ConsumedEmitterArgs & { readonly conversation: ConversationManager; readonly providerRegistry: Pick<ProviderRegistry, 'getCurrentModel'> },
  session: ContractSessionTurn,
  response: ChatResponseWithReasoning,
  privateNudge?: (message: string) => void,
): Promise<boolean> {
  return holdSessionCompletion(args, session, response.content, privateNudge ? undefined : () => args.conversation.addAssistantMessage(response.content, {
    reasoningContent: response.reasoning || undefined,
    reasoningSummary: response.reasoningSummary || undefined,
    usage: response.usage,
    model: args.providerRegistry.getCurrentModel().displayName,
    provider: args.providerRegistry.getCurrentModel().provider,
  }), privateNudge);
}

/** Said to the conversation model after its agent tool call started a contract. */
const CONTRACT_STARTED_NOTE = 'A contract is carrying out delegated work for this request. Its plan and units are checked against the acceptance criteria. You remain responsible for the original request: inspect its outcome, recover failures, consolidate the results, and produce all requested deliverables before ending. Do not duplicate work while it is running.';

function attachAuthoritativeTaskToAgentCalls(toolCalls: readonly ToolCall[], userText: string): ToolCall[] {
  const authoritativeTask = userText.trim();
  return toolCalls.map((call) => {
    if (call.name !== 'agent') return call;
    const args = call.arguments as Record<string, unknown>;
    const mode = args.mode;
    if (mode !== 'spawn' && mode !== 'batch-spawn') return call;
    if (!authoritativeTask) {
      // The task is the person's own words; the model's copy is never authoritative.
      if (!('authoritativeTask' in args)) return call;
      const { authoritativeTask: _modelSupplied, ...rest } = args;
      return { ...call, arguments: rest };
    }
    return {
      ...call,
      arguments: {
        ...args,
        authoritativeTask,
      },
    };
  });
}

type ToolResponseOutcomeArgs = {
  /** Production ingress supplies the real registry before publishing tool input. */
  toolRegistry?: ToolRegistry | undefined;
  inputProjection?: ToolInputProjectionOptions | undefined;
  onTurnTerminal?: ((publish: () => void) => void) | undefined;
  conversation: ConversationManager;
  agentManager: Pick<AgentManager, 'list' | 'spawn'>;
  planManager: Pick<ExecutionPlanManager, 'getActive'> | null;
  configManager: Pick<ConfigManager, 'get'>;
  providerRegistry: Pick<ProviderRegistry, 'getCurrentModel'>;
  runtimeBus: RuntimeEventBus | null;
  emitterContext: EmitterContextFactory;
  turnId: string;
  response: ChatResponseWithReasoning;
  userText: string;
  /** Private host-held findings; these are evidence, never replacement requirements. */
  completionRepair?: string | undefined;
  executeToolCalls: (turnId: string, calls: ToolCall[]) => Promise<ToolResult[]>;
  setPendingToolCalls: (calls: ToolCall[]) => void;
  messageQueueLength: number;
  requestRender: () => void;
  sessionId?: string | undefined;
  /** This turn's MEMORY-sourced injected knowledge ids, stamped onto TURN_COMPLETED as metadata.memory.recordIds when non-empty (absent otherwise). */
  memoryRecordIds?: readonly string[] | undefined;
  /** The session-mode contract unit this turn works on, when there is one. */
  contractSession?: ContractSessionTurn | undefined;
};

export async function handleToolResponseOutcome(args: ToolResponseOutcomeArgs): Promise<{ results: ToolResult[] }> {
  return withDelegationRequest({ request: args.userText, signal: args.inputProjection?.signal, assertCurrent: args.inputProjection?.assertCurrent }, () => withCompletionRepairContext(args.completionRepair, async () => {
    const originalCalls = attachAuthoritativeTaskToAgentCalls(captureToolInputCalls(args.response.toolCalls), args.userText);
    const batch = args.toolRegistry ? await projectToolInputBatch(args.toolRegistry, originalCalls, args.inputProjection) : undefined;
    try {
      batch?.assertCurrent();
      return await handleOwnedToolResponseOutcome({ ...args, response: { ...args.response, toolCalls: batch?.calls ?? originalCalls } });
    } finally { await batch?.release(); }
  }));
}

async function handleOwnedToolResponseOutcome(args: ToolResponseOutcomeArgs): Promise<{ results: ToolResult[] }> {
  const toolCalls = args.response.toolCalls;
  const content = args.response.content;
  args.conversation.addAssistantMessage(content, {
    toolCalls,
    reasoningContent: args.response.reasoning || undefined,
    reasoningSummary: args.response.reasoningSummary || undefined,
    usage: args.response.usage,
    model: args.providerRegistry.getCurrentModel().displayName,
    provider: args.providerRegistry.getCurrentModel().provider,
  });
  args.setPendingToolCalls(toolCalls);

  const results = await args.executeToolCalls(args.turnId, toolCalls);
  args.conversation.addToolResults(results);
  args.setPendingToolCalls([]);
  if (args.contractSession) reportSessionToolRound(args.contractSession, { toolCalls, results, assistantText: content });

  attachToolResultImages(args.conversation, results, args.providerRegistry.getCurrentModel().capabilities.multimodal);

  const spawnedAgents = !isNativeConversationTurn() && toolCalls.some((tc: ToolCall) => {
    const mode = (tc.arguments as Record<string, unknown>).mode;
    return tc.name === 'agent' && (mode === 'spawn' || mode === 'batch-spawn')
      && results.some(result => result.callId === tc.id && result.success);
  });
  const startedContract = spawnedAgents && results.some(toolResultStartedContract);

  if (spawnedAgents) {
    // Said to the model on its next request. The person is told what happened
    // in his own terms, never the instruction written for the model.
    const note = startedContract ? CONTRACT_STARTED_NOTE
      : 'You spawned agents for part of the task. You retain responsibility for the complete request. Incorporate their results, recover failures, and continue any remaining work.';
    args.conversation.hostInstructions.set('delegation', note, { once: true });
    args.conversation.addNotice(startedContract
      ? '[Agents] A contract started for part of this request; its work is checked against its acceptance criteria and the turn finishes with its results. F2 shows it.'
      : '[Agents] Agents started for part of this request; the turn waits for them and finishes with their results. F2 shows them.',
    { level: 'info', kind: 'operational' });
    // Every additional assignment must pass normal tool admission and appear
    // in the retained delegation evidence; no hidden plan-based spawns here.
    args.requestRender();
    return { results };
  }

  // A request to the model only: it no longer adds a transcript line after every tool round.
  if (!isNativeConversationTurn() && args.planManager?.getActive(args.sessionId)) {
    args.conversation.hostInstructions.set('plan',
      'Keep the work plan current: set finished items to done and started ones to in_progress with the `work_plan` tool.', { once: true, append: true });
  }

  return { results };
}

type FinalResponseOutcomeArgs = {
  assertCompletionCurrent?: (() => void) | undefined;
  signal?: AbortSignal | undefined;
  assertCurrent?: (() => void) | undefined;
  onTurnTerminal?: ((publish: () => void) => void) | undefined;
  /** The checked answer is appended and its completion is registered; nothing later can withdraw it. */
  onAnswerCommitted?: (() => void) | undefined;
  conversation: ConversationManager;
  agentManager: Pick<AgentManager, 'list' | 'spawn'>;
  configManager: Pick<ConfigManager, 'get'>;
  providerRegistry: Pick<ProviderRegistry, 'getCurrentModel'>;
  runtimeBus: RuntimeEventBus | null;
  emitterContext: EmitterContextFactory;
  turnId: string;
  response: ChatResponseWithReasoning;
  /** This turn's MEMORY-sourced injected knowledge ids, stamped onto TURN_COMPLETED as metadata.memory.recordIds when non-empty (absent otherwise). */
  memoryRecordIds?: readonly string[] | undefined;
};

export async function handleFinalResponseOutcome(args: FinalResponseOutcomeArgs): Promise<false> {
  args.assertCompletionCurrent?.();
  args.signal?.throwIfAborted();
  args.assertCurrent?.();
  args.conversation.addAssistantMessage(args.response.content, {
    reasoningContent: args.response.reasoning || undefined,
    reasoningSummary: args.response.reasoningSummary || undefined,
    usage: args.response.usage,
    model: args.providerRegistry.getCurrentModel().displayName,
    provider: args.providerRegistry.getCurrentModel().provider,
  });
  // The completion check covers the transcript exactly through this append.
  // Usage warnings and compaction legitimately change the transcript
  // afterwards; they cannot change the answer checked here, so the fence is
  // not re-run against them.
  args.assertCompletionCurrent?.();
  args.signal?.throwIfAborted();
  args.assertCurrent?.();
  if (args.runtimeBus) {
    publishTurnTerminal(() => emitTurnCompleted(args.runtimeBus!, args.emitterContext(args.turnId), {
      turnId: args.turnId,
      response: args.response.content,
      stopReason: args.response.content.trim().length > 0 ? 'completed' : 'empty_response',
      memoryRecordIds: args.memoryRecordIds,
    }), args.onTurnTerminal);
  }
  args.onAnswerCommitted?.();

  return false;
}

export function emitMalformedToolUseWarning(args: {
  conversation: ConversationManager;
  providerRegistry: Pick<ProviderRegistry, 'getCurrentModel'>;
  runtimeBus: RuntimeEventBus | null;
  emitterContext: EmitterContextFactory;
  turnId: string;
  isReconciliationEnabled: boolean;
}): void {
  logger.warn('Orchestrator: provider reported stopReason=tool_use but returned no tool calls (malformed response)', {
    model: args.providerRegistry.getCurrentModel().registryKey,
    stopReason: 'tool_call',
  });
  if (args.isReconciliationEnabled) {
    const reconciliation = '[Tool Reconciliation] Provider returned stop_reason=tool_use but no tool calls were included in the response. ' +
      'This is a malformed provider response. If this repeats, try switching models.';
    args.conversation.addNotice(reconciliation, { level: 'warning' });
    args.conversation.hostInstructions.set('correction', reconciliation, { once: true, append: true });
    if (args.runtimeBus) {
      emitToolReconciled(args.runtimeBus, args.emitterContext(args.turnId), {
        turnId: args.turnId,
        count: 0,
        callIds: [],
        toolNames: [],
        reason: 'malformed-stop-reason',
        isMalformed: true,
        timestamp: Date.now(),
      });
    }
  }
}
