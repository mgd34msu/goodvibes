import type { RuntimeEventBus } from '@goodvibes-jev/engine/platform/platform/runtime/state';
import type { AgentEvent, ContractEvent, GateEvent, ToolEvent, TurnEvent } from '@goodvibes-jev/engine/platform/events';
import type { PermissionExecutionOptions, PermissionPromptDecision, PermissionPromptRequest } from '@goodvibes-jev/engine/platform/platform/permissions';
import { redactDiagnosticText } from '@goodvibes-jev/engine/platform/platform/utils';
import type { NativeHeadlessTurnResult } from './native-headless.js';

/**
 * Version of the `json` / `stream-json` frame shapes. Version 1 added
 * `schemaVersion`, `sessionId`, `usage`, the tool, permission and usage frames,
 * and optional omission of `accumulated`; every earlier field is unchanged.
 */
export const HEADLESS_SCHEMA_VERSION = 1;

/** Model usage summed over every model response this invocation observed. */
export interface HeadlessUsage {
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** Present only when every observed response was priced. */
  readonly costUsdCents?: number | undefined;
}

export interface HeadlessTurnObserverOptions {
  /** stream-json deltas carry only `content`, not the whole response so far. */
  readonly omitAccumulated?: boolean | undefined;
  /** Stop once this many model responses have been read and the model still asks for tools. */
  readonly maxTurns?: number | undefined;
  /** Cancels the turn; called once when `maxTurns` is reached. */
  readonly stop?: (() => void) | undefined;
}

type Payload<U, K> = Extract<U, { type: K }>;
type ToolFrameEvent = Payload<ToolEvent, 'TOOL_EXECUTING' | 'TOOL_SUCCEEDED' | 'TOOL_FAILED' | 'TOOL_CANCELLED'>;

const MAX_FORWARDED_TEXT_CHARS = 1000;
/** Free text from tools, agents and gates often echoes a command or file content: mask credentials and bound its size. */
function forwardedText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const masked = redactDiagnosticText(value);
  return masked.length > MAX_FORWARDED_TEXT_CHARS ? `${masked.slice(0, MAX_FORWARDED_TEXT_CHARS)}...` : masked;
}
const FREE_TEXT_KEYS = new Set(['error', 'reason', 'question', 'summary', 'detail']);

// Tool arguments are never forwarded: they can hold file contents or credentials, and free text is masked and bounded.
function toolFrame(payload: ToolFrameEvent): Record<string, unknown> {
  const base = { type: payload.type, turnId: payload.turnId, callId: payload.callId, tool: payload.tool };
  if (payload.type === 'TOOL_SUCCEEDED') return { ...base, durationMs: payload.durationMs };
  if (payload.type === 'TOOL_FAILED') return { ...base, durationMs: payload.durationMs, error: forwardedText(payload.error) };
  if (payload.type === 'TOOL_CANCELLED' && payload.reason !== undefined) return { ...base, reason: forwardedText(payload.reason) };
  return base;
}

/** Copy the named fields that are present; an absent field is omitted rather than sent as null. */
function pick(payload: object, keys: readonly string[]): Record<string, unknown> {
  const source = payload as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, FREE_TEXT_KEYS.has(key) ? forwardedText(source[key]) : source[key]]));
}

/** The envelope source of the top-level turn loop's own events; delegated agents and helper models use others. */
const TOP_LEVEL_TURN_SOURCE = 'orchestrator';

/** One event observer shared by ordinary and permit-bound one-shot turns. */
export function observeHeadlessTurn(bus: Pick<RuntimeEventBus, 'on'>, format: string, initialStopReason: string, options: HeadlessTurnObserverOptions = {}) {
  const state = { response: '', error: '', stopReason: initialStopReason, exitCode: 3, events: 0 };
  const usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdCents: 0, unpriced: false };
  // The top-level turn loop's own responses. Usage sums every model call (delegated agents, helper models and
  // verification spend money too); the limit counts only the loop the caller asked to bound.
  let turns = 0;
  let limited: string | undefined;
  // A gate request is held until the gate decides it, so the frame can say whether the owner was asked.
  const requested = new Map<string, Record<string, unknown>>();
  const stream = format === 'stream-json';
  const emit = (frame: Record<string, unknown>) => {
    if (stream) process.stdout.write(JSON.stringify({ schemaVersion: HEADLESS_SCHEMA_VERSION, ...frame }) + '\n');
  };
  const forward = (payload: { readonly type: string }, keys: readonly string[]) => {
    state.events++;
    emit({ type: payload.type, ...pick(payload, keys) });
  };
  const onTool = (payload: ToolFrameEvent) => {
    state.events++;
    emit(toolFrame(payload));
  };
  const unsubs = [
    bus.on<Payload<TurnEvent, 'STREAM_DELTA'>>('STREAM_DELTA', ({ payload }) => {
      state.events++;
      emit({ type: payload.type, content: payload.content, ...(options.omitAccumulated ? {} : { accumulated: payload.accumulated }) });
    }),
    bus.on<Payload<TurnEvent, 'LLM_RESPONSE_RECEIVED'>>('LLM_RESPONSE_RECEIVED', ({ payload, source }) => {
      state.events++;
      if (source === TOP_LEVEL_TURN_SOURCE) turns++;
      usage.modelCalls++;
      usage.inputTokens += payload.inputTokens;
      usage.outputTokens += payload.outputTokens;
      usage.cacheReadTokens += payload.cacheReadTokens ?? 0;
      usage.cacheWriteTokens += payload.cacheWriteTokens ?? 0;
      if (payload.costUsdCents === undefined) usage.unpriced = true;
      else usage.costUsdCents += payload.costUsdCents;
      emit({ type: 'USAGE', turnId: payload.turnId, provider: payload.provider, model: payload.model, inputTokens: payload.inputTokens,
        outputTokens: payload.outputTokens, cacheReadTokens: payload.cacheReadTokens ?? 0, cacheWriteTokens: payload.cacheWriteTokens ?? 0,
        ...(payload.costUsdCents === undefined ? {} : { costUsdCents: payload.costUsdCents }) });
      const max = options.maxTurns;
      if (max !== undefined && !limited && source === TOP_LEVEL_TURN_SOURCE && turns >= max && payload.toolCallCount > 0) {
        limited = `Stopped after ${turns} model responses (--max-turns ${max}); the model still asked for ${payload.toolCallCount} tool call(s).`;
        options.stop?.();
      }
    }),
    bus.on<Payload<ToolEvent, 'TOOL_EXECUTING'>>('TOOL_EXECUTING', ({ payload }) => onTool(payload)),
    bus.on<Payload<ToolEvent, 'TOOL_SUCCEEDED'>>('TOOL_SUCCEEDED', ({ payload }) => onTool(payload)),
    bus.on<Payload<ToolEvent, 'TOOL_FAILED'>>('TOOL_FAILED', ({ payload }) => onTool(payload)),
    bus.on<Payload<ToolEvent, 'TOOL_CANCELLED'>>('TOOL_CANCELLED', ({ payload }) => onTool(payload)),
    bus.on<Payload<GateEvent, 'GATE_REQUESTED'>>('GATE_REQUESTED', ({ payload }) => {
      state.events++;
      requested.set(payload.callId, { type: 'PERMISSION_REQUESTED', callId: payload.callId, tool: payload.tool, category: payload.category,
        ...(payload.riskLevel === undefined ? {} : { riskLevel: payload.riskLevel }), ...(payload.summary === undefined ? {} : { summary: forwardedText(payload.summary) }) });
    }),
    bus.on<Payload<GateEvent, 'DECISION_EMITTED'>>('DECISION_EMITTED', ({ payload }) => {
      state.events++;
      // The gate has already waited for any owner answer by the time it reports; `user_prompt` is the layer that did.
      const ownerPrompt = payload.sourceLayer === 'user_prompt';
      const request = requested.get(payload.callId);
      if (request) {
        requested.delete(payload.callId);
        emit({ ...request, ownerPrompt });
      }
      emit({ type: 'PERMISSION_DECIDED', callId: payload.callId, tool: payload.tool, category: payload.category, approved: payload.approved,
        source: payload.source, ownerPrompt, ...(payload.reasonCode === undefined ? {} : { reasonCode: payload.reasonCode }) });
    }),
    // Delegated agents and contracts. Identifiers, states and outcomes only: the task text, the ask and agent
    // output can hold file contents or credentials, as tool arguments can.
    bus.on<Payload<AgentEvent, 'AGENT_SPAWNING'>>('AGENT_SPAWNING', ({ payload }) => forward(payload, ['agentId', 'taskId', 'parentAgentId', 'contractId', 'contractRole'])),
    bus.on<Payload<AgentEvent, 'AGENT_RUNNING'>>('AGENT_RUNNING', ({ payload }) => forward(payload, ['agentId', 'taskId', 'parentAgentId', 'contractId', 'contractRole'])),
    bus.on<Payload<AgentEvent, 'AGENT_COMPLETED'>>('AGENT_COMPLETED', ({ payload }) => forward(payload, ['agentId', 'taskId', 'durationMs', 'toolCallsMade'])),
    bus.on<Payload<AgentEvent, 'AGENT_FAILED'>>('AGENT_FAILED', ({ payload }) => forward(payload, ['agentId', 'taskId', 'error', 'durationMs'])),
    bus.on<Payload<AgentEvent, 'AGENT_CANCELLED'>>('AGENT_CANCELLED', ({ payload }) => forward(payload, ['agentId', 'taskId', 'reason'])),
    bus.on<Payload<ContractEvent, 'CONTRACT_CREATED'>>('CONTRACT_CREATED', ({ payload }) => forward(payload, ['contractId', 'sessionId', 'origin', 'ownerAgentId'])),
    bus.on<Payload<ContractEvent, 'CONTRACT_STATUS_CHANGED'>>('CONTRACT_STATUS_CHANGED', ({ payload }) => forward(payload, ['contractId', 'from', 'to'])),
    bus.on<Payload<ContractEvent, 'CONTRACT_ESCALATED'>>('CONTRACT_ESCALATED', ({ payload }) => forward(payload, ['contractId', 'escalationId', 'scope', 'targetId', 'reason', 'question'])),
    bus.on<Payload<ContractEvent, 'CONTRACT_PASSED'>>('CONTRACT_PASSED', ({ payload }) => forward(payload, ['contractId', 'criteriaMet', 'criteriaJudged'])),
    bus.on<Payload<ContractEvent, 'CONTRACT_FAILED'>>('CONTRACT_FAILED', ({ payload }) => forward(payload, ['contractId', 'reason', 'failureKind'])),
    bus.on<Payload<ContractEvent, 'CONTRACT_CANCELLED'>>('CONTRACT_CANCELLED', ({ payload }) => forward(payload, ['contractId', 'reason'])),
    bus.on<Payload<TurnEvent, 'TURN_COMPLETED'>>('TURN_COMPLETED', ({ payload }) => {
      state.events++;
      state.response = payload.response;
      state.stopReason = payload.stopReason;
      state.exitCode = 0;
    }),
    bus.on<Payload<TurnEvent, 'TURN_ERROR'>>('TURN_ERROR', ({ payload }) => {
      state.events++;
      state.error = payload.error;
      state.stopReason = payload.stopReason;
      state.exitCode = 1;
    }),
    bus.on<Payload<TurnEvent, 'TURN_CANCEL'>>('TURN_CANCEL', ({ payload }) => {
      state.events++;
      state.error = payload.reason ?? 'cancelled';
      state.stopReason = payload.stopReason;
      state.exitCode = 130;
    }),
  ];
  return {
    state,
    /** Write one versioned frame on the same stream as the observed events (nothing in other output formats). */
    frame: emit,
    dispose: () => {
      for (const unsubscribe of unsubs) unsubscribe();
      // A request the gate never decided is still reported, without a claim about the owner.
      for (const request of requested.values()) emit(request);
      requested.clear();
    },
    result(
      signal: AbortSignal,
      runtime: { readonly sessionId: string; readonly model: string; readonly provider: string },
    ): NativeHeadlessTurnResult {
      if (signal.aborted) state.exitCode = 130;
      else if (limited) {
        // The stop it requested surfaces as a cancellation; report the limit instead.
        state.exitCode = 1;
        state.stopReason = 'max_turns';
        state.error = limited;
      }
      if (state.exitCode === 0 && !state.response.trim()) {
        state.exitCode = 1;
        state.stopReason = 'empty_response';
        state.error ||= 'The model returned no response.';
      }
      const { unpriced, costUsdCents, ...counts } = usage;
      return { ...state, sessionId: runtime.sessionId, model: runtime.model, provider: runtime.provider,
        usage: { ...counts, ...(unpriced || counts.modelCalls === 0 ? {} : { costUsdCents }) } };
    },
  };
}

// Argument parsing lives with the other pre-parse options, which load nothing.
export { catalogValueOptions, extractHeadlessRunFlags, type HeadlessRunFlags } from './native-headless-options.js';
import type { HeadlessRunFlags } from './native-headless-options.js';
/**
 * Refuse run-only flags on any other command instead of ignoring them, and
 * `--answer-permissions` without the stream a script needs to see the prompt.
 */
export function headlessRunFlagErrors(flags: HeadlessRunFlags, command: string, outputFormat?: string): string[] {
  if (Object.keys(flags).length === 0) return [];
  if (command !== 'run') return ['--timeout, --max-turns, --omit-accumulated and --answer-permissions apply only to the run command.'];
  if (flags.answerPermissions && outputFormat !== 'stream-json') {
    return ['--answer-permissions needs --output stream-json: the prompt frame carries the callId the answer must name.'];
  }
  return [];
}

/**
 * Answering permission prompts of a headless `run` from a script.
 *
 * Without this a headless run has nobody to ask, so every call the gate wants an
 * owner for is refused at once. With `--answer-permissions` the run writes a
 * `PERMISSION_PROMPT` frame for each such call and waits for one line of JSON on
 * stdin:
 *
 *   {"type":"PERMISSION_ANSWER","callId":"<callId>","approved":true}
 *
 * `remember` (boolean) and `note` (text the model sees on a refusal) are optional.
 * Lines that are not a well-formed answer are ignored, so a script can keep other
 * input on the same pipe. A call that is never answered is refused when stdin ends
 * or the run is cancelled; it is never approved by silence.
 */
export interface HeadlessPermissionInputSource {
  on(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown;
  on(event: 'end' | 'close', listener: () => void): unknown;
  off(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown;
  off(event: 'end' | 'close', listener: () => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

export interface HeadlessPermissionInputOptions {
  readonly input: HeadlessPermissionInputSource;
  /** Writes one versioned frame to the run's output stream. */
  readonly emit: (frame: Record<string, unknown>) => void;
  /** The invocation's own cancellation. */
  readonly signal: AbortSignal;
}

export interface HeadlessPermissionInput {
  /** The handler to install as the surface's permission prompt. */
  readonly prompt: (request: PermissionPromptRequest, options?: PermissionExecutionOptions) => Promise<PermissionPromptDecision>;
  readonly dispose: () => void;
}

const MAX_LINE_CHARS = 64 * 1024;
const MAX_NOTE_CHARS = 2000;

export function createHeadlessPermissionInput(options: HeadlessPermissionInputOptions): HeadlessPermissionInput {
  const pending = new Map<string, { readonly resolve: (decision: PermissionPromptDecision) => void; readonly detach: () => void }>();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;

  const refuse = (callId: string, why: string): PermissionPromptDecision => ({
    approved: false,
    remember: false,
    reason: `${why} Nothing ran for call ${callId}; ask again in a run that can answer.`,
  });

  const settle = (callId: string, decision: PermissionPromptDecision): void => {
    const entry = pending.get(callId);
    if (!entry) return;
    pending.delete(callId);
    // An answered prompt must not leave its abort listeners on the run's signals.
    entry.detach();
    entry.resolve(decision);
  };

  const handleLine = (line: string): void => {
    if (line.length === 0 || line.length > MAX_LINE_CHARS) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { return; }
    if (typeof value !== 'object' || value === null) return;
    const answer = value as Record<string, unknown>;
    if (answer['type'] !== 'PERMISSION_ANSWER' || typeof answer['callId'] !== 'string' || typeof answer['approved'] !== 'boolean') return;
    const note = typeof answer['note'] === 'string' ? answer['note'].slice(0, MAX_NOTE_CHARS) : undefined;
    settle(answer['callId'], {
      approved: answer['approved'],
      remember: answer['remember'] === true,
      ...(note ? { reason: note } : {}),
    });
  };

  const onData = (chunk: string | Uint8Array): void => {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
      handleLine(buffer.slice(0, newline).trim());
      buffer = buffer.slice(newline + 1);
    }
    // A line that never ends must not grow without bound.
    if (buffer.length > MAX_LINE_CHARS) buffer = '';
  };

  const onEnd = (): void => {
    if (ended) return;
    ended = true;
    for (const callId of [...pending.keys()]) settle(callId, refuse(callId, 'The input stream ended before this call was answered.'));
  };

  options.input.on('data', onData);
  options.input.on('end', onEnd);
  options.input.on('close', onEnd);
  options.input.resume?.();

  const prompt = (request: PermissionPromptRequest, execution?: PermissionExecutionOptions): Promise<PermissionPromptDecision> => {
    const { callId } = request;
    if (ended) return Promise.resolve(refuse(callId, 'The input stream has ended, so this call cannot be answered.'));
    if (options.signal.aborted || execution?.signal?.aborted) return Promise.resolve(refuse(callId, 'The run was cancelled before this call was answered.'));
    // A second prompt under a live call id would replace the first and leave it unanswered forever.
    if (pending.has(callId)) return Promise.resolve(refuse(callId, 'Another prompt for this call id is still waiting.'));
    return new Promise<PermissionPromptDecision>((resolve) => {
      const cancel = (): void => settle(callId, refuse(callId, 'The run was cancelled before this call was answered.'));
      const executionSignal = execution?.signal;
      pending.set(callId, {
        resolve,
        detach: () => {
          options.signal.removeEventListener('abort', cancel);
          executionSignal?.removeEventListener('abort', cancel);
        },
      });
      options.signal.addEventListener('abort', cancel, { once: true });
      executionSignal?.addEventListener('abort', cancel, { once: true });
      options.emit({
        type: 'PERMISSION_PROMPT',
        callId,
        tool: request.tool,
        category: request.category,
        riskLevel: request.analysis.riskLevel,
        summary: forwardedText(request.analysis.summary),
        answer: `Write one line to stdin: {"type":"PERMISSION_ANSWER","callId":"${callId}","approved":true} (or false).`,
      });
    });
  };

  return {
    prompt,
    dispose: () => {
      options.input.off('data', onData);
      options.input.off('end', onEnd);
      options.input.off('close', onEnd);
      options.input.pause?.();
      for (const callId of [...pending.keys()]) settle(callId, refuse(callId, 'The run ended before this call was answered.'));
    },
  };
}
