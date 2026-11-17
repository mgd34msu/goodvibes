import { retainNativeModelObservation, recordImmutableJudgmentResult } from '../port/model-observation.ts';
import { drainOwned } from '../drain-owned.ts';
import { assertSynchronousJudgmentGuard } from '../port/attempt-guard.ts';
import { captureJudgmentInput } from '../port/input-snapshot.ts';
import { cooldownNotice, DECISION_MODELS_UNAVAILABLE_NOTICE, rateLimitedNotice } from '../port/availability-notice.ts';
import { types as nodeTypes } from 'node:util';
import { answersCheckedFor, checkAnswers, projectAnswers } from '../port/answers.ts';
import { isJudgmentFailureReason, JUDGMENT_FAILURE_REASONS, JudgmentContextLimitError, JudgmentError, type JudgmentErrorKind } from '../port/errors.ts';
import {
  toJson, type JsonValue, type JudgmentAttempt, type JudgmentLineage, type JudgmentPort, type JudgmentRequest,
  type JudgmentResult, type Questions,
} from '../port/types.ts';
import { hashState, isoTime, type DecisionLog, type DecisionNote, type NewDecisionEntry } from './types.ts';

interface RecordedInput {
  readonly state: JudgmentRequest<Questions>['state'];
  readonly questions: Questions;
  readonly context: NonNullable<JudgmentRequest<Questions>['context']>;
  readonly stateHash: string;
  readonly decisionId: string;
}
// Only explicitly committed answers retain their immutable input here. Ordinary
// audit results retain no private state. Original result GC releases the binding.
const recordedInputResults = new WeakMap<object, RecordedInput>();
const applyRecordedInput = Reflect.apply, getRecordedInput = WeakMap.prototype.get, setRecordedInput = WeakMap.prototype.set;

/** Descriptor-only JSON comparison. Never execute a getter/toJSON/thenable in
 * a borrowed requested image merely to recover its recorded commitment. */
function sameRecordedData(left: unknown, right: unknown): boolean {
  const pending: [unknown, unknown][] = [[left, right]];
  while (pending.length) {
    const pair = pending.pop(); if (!pair) break;
    const [a, b] = pair;
    if (a === b) continue;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || nodeTypes.isProxy(b) || Array.isArray(a) !== Array.isArray(b)) return false;
    const prototype: unknown = Object.getPrototypeOf(b);
    if (Array.isArray(b) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(a), other = Reflect.ownKeys(b);
    if (keys.length !== other.length || other.some(key => typeof key !== 'string')) return false;
    for (const key of keys) {
      const original = Object.getOwnPropertyDescriptor(a, key), supplied = Object.getOwnPropertyDescriptor(b, key);
      if (!original || !supplied || !('value' in original) || !('value' in supplied) || original.enumerable !== supplied.enumerable) return false;
      pending.push([original.value, supplied.value]);
    }
  }
  return true;
}
/** Existing private-state commitment for THIS original recorded result/input.
 * Copies and forgeable decision IDs cannot acquire this observation. The hash
 * was computed once by withDecisionLog; this read performs no serialization or
 * hashing and conveys no authority beyond the actual saved call identity. */
export function recordedJudgmentInputHash(value: unknown, request: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !request || typeof request !== 'object' || nodeTypes.isProxy(request)) return undefined;
  const recorded = applyRecordedInput(getRecordedInput, recordedInputResults, [value]) as RecordedInput | undefined; if (!recorded || typeof recorded.decisionId !== 'string' || !recorded.decisionId) return undefined;
  try {
    const id = Object.getOwnPropertyDescriptor(value, 'decisionId'), state = Object.getOwnPropertyDescriptor(request, 'state'), questions = Object.getOwnPropertyDescriptor(request, 'questions'), context = Object.getOwnPropertyDescriptor(request, 'context');
    if (!id || !('value' in id) || id.value !== recorded.decisionId || !state || !questions || !('value' in state) || !('value' in questions)
      || (context !== undefined && !('value' in context))
      || !sameRecordedData(recorded.state, state.value) || !sameRecordedData(recorded.questions, questions.value)
      || !sameRecordedData(recorded.context, context?.value ?? {})) return undefined;
    return recorded.stateHash;
  } catch { return undefined; }
}

const FAILURE_MESSAGES: Readonly<Record<JudgmentErrorKind, string>> = {
  'invalid-request': 'the judgment request was invalid',
  rejected: 'the judgment request was rejected',
  unavailable: DECISION_MODELS_UNAVAILABLE_NOTICE,
  aborted: 'the judgment call was cancelled',
  'invalid-response': 'the judgment provider returned an invalid response',
  internal: 'The decision client failed internally. The operation has stopped.',
  unrecorded: 'the decision log could not record this judgment',
};
const failureKind = (value: unknown): value is JudgmentErrorKind =>
  typeof value === 'string' && Object.hasOwn(FAILURE_MESSAGES, value);
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const statusCode = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Enforce bounded wire identifier syntax, without guessing which words are secrets.
 * Only the configured transport knows the real keys; valid-looking unknown secrets
 * in documented metadata cannot be classified by a borrowed-port wrapper.
 */
function identifier(value: unknown, model = false): string | undefined {
  const syntax = model ? /^[A-Za-z0-9@][A-Za-z0-9._:/@+-]*$/ : /^[A-Za-z0-9._:-]+$/;
  if (typeof value !== 'string' || value.length > 256 || !syntax.test(value) || value.includes('://')) return undefined;
  return value;
}

const invalidResponse = (): JudgmentError => new JudgmentError('invalid-response', FAILURE_MESSAGES['invalid-response']);

/** Only documented, validated attempt evidence may cross the log boundary. */
function projectLineage(value: unknown): JudgmentLineage | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) throw invalidResponse();
  const rawAttempts = value.attempts;
  if (!Array.isArray(rawAttempts)) throw invalidResponse();
  const logicalRequestId = identifier(value.logicalRequestId);
  if (logicalRequestId === undefined) throw invalidResponse();
  const attempts: JudgmentAttempt[] = [];
  for (let index = 0; index < rawAttempts.length; index += 1) {
    const item: unknown = rawAttempts[index];
    if (!object(item)) throw invalidResponse();
    const { attempt, endpointIndex, endpointKind, latencyMs, outcome, status, dispatched } = item;
    const requestedModel = identifier(item.requestedModel, true);
    if (!nonnegative(attempt) || !Number.isInteger(attempt) || attempt < 1
      || !nonnegative(endpointIndex) || !Number.isInteger(endpointIndex)
      || (endpointKind !== 'hosted' && endpointKind !== 'local') || requestedModel === undefined
      || !nonnegative(latencyMs) || (outcome !== 'answered' && !failureKind(outcome))
      || (status !== undefined && !statusCode(status)) || (dispatched !== undefined && typeof dispatched !== 'boolean')) throw invalidResponse();
    const requestId = identifier(item.requestId);
    attempts.push({
      attempt, endpointIndex, endpointKind, requestedModel, latencyMs, outcome,
      ...(dispatched === undefined ? {} : { dispatched }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(statusCode(status) ? { status } : {}),
    });
  }
  const omittedAttempts = value.omittedAttempts;
  if (omittedAttempts !== undefined && (!nonnegative(omittedAttempts) || !Number.isSafeInteger(omittedAttempts))) throw invalidResponse();
  return { logicalRequestId, attempts, ...(omittedAttempts === undefined ? {} : { omittedAttempts }) };
}

/** A broken optional provider field must not erase other independently valid evidence. */
function optional<T>(read: () => T): T | undefined {
  try { return read(); }
  catch { return undefined; }
}

/** Never retain upstream exception text, stack, cause, arbitrary properties or malformed metadata. */
function asFailure(error: unknown, overrideKind?: JudgmentErrorKind): JudgmentError {
  const source = optional(() => error instanceof JudgmentError ? error : undefined);
  const rawKind = optional(() => source?.kind);
  const kind = overrideKind ?? (failureKind(rawKind) ? rawKind : 'internal');
  const rawStatus = kind === 'internal' ? undefined : optional(() => source?.status);
  const status = kind !== 'internal' && statusCode(rawStatus) ? rawStatus : undefined;
  const requestId = kind === 'internal' ? undefined : optional(() => identifier(source?.requestId));
  const lineage = optional(() => projectLineage(source?.lineage));
  const rawRetryAfter = kind === 'unavailable' ? optional(() => source?.retryAfterMs) : undefined;
  const retryAfterMs = nonnegative(rawRetryAfter) && rawRetryAfter > 0 ? Math.ceil(rawRetryAfter) : undefined;
  // A reason is a member of a closed list, so it is kept; the sentence shown
  // for it is this package's own, never the text the port wrote.
  const rawReason = kind === 'internal' || overrideKind !== undefined ? undefined : optional(() => source?.reason);
  const reason = isJudgmentFailureReason(rawReason) ? rawReason : undefined;
  if (kind === 'rejected' && status === 400 && optional(() => source instanceof JudgmentContextLimitError)) {
    return new JudgmentContextLimitError({
      ...(requestId === undefined ? {} : { requestId }), ...(lineage === undefined ? {} : { lineage }),
    });
  }
  // HTTP status is validated metadata, not private upstream exception text.
  // Preserve it in the displayed diagnostic as well as the structured error:
  // a billing refusal must not look like Jev rejected the task itself.
  const sentence = reason === undefined ? FAILURE_MESSAGES[kind] : JUDGMENT_FAILURE_REASONS[reason];
  const http = status === undefined ? '' : `HTTP ${status}${status === 402 ? ': Payment Required' : ''}`;
  // A wait is called a rate limit only when a rate limit caused it.
  const diagnostic = retryAfterMs !== undefined ? (reason === 'rate-limited' ? rateLimitedNotice(retryAfterMs) : cooldownNotice(retryAfterMs, status))
    : reason === 'endpoint-status' && status !== undefined ? `The decision endpoint answered ${http}; retry in a moment.`
    : status === undefined ? sentence
    : sentence.endsWith('.') ? `${sentence.slice(0, -1)} (${http}).` : `${sentence} (${http})`;
  const message = kind === 'rejected' && (status === 401 || status === 403)
    ? `${diagnostic.replace(/\.$/, '')}. ${DECISION_MODELS_UNAVAILABLE_NOTICE}` : diagnostic;
  return new JudgmentError(kind, message, {
    ...(reason === undefined ? {} : { reason }),
    ...(status === undefined ? {} : { status }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(lineage === undefined ? {} : { lineage }),
  });
}

/** Abort reasons are not text; only explicitly typed timeouts preserve unavailable. */
function cancellationKind(signal: AbortSignal | undefined): 'aborted' | 'unavailable' | undefined {
  if (!signal?.aborted) return undefined;
  const reason: unknown = signal.reason;
  const timedOut = optional(() => (reason instanceof JudgmentError && reason.kind === 'unavailable')
    || (reason instanceof DOMException && reason.name === 'TimeoutError'));
  return timedOut ? 'unavailable' : 'aborted';
}

function checkCancellation(signal: AbortSignal | undefined): void {
  const kind = cancellationKind(signal);
  if (kind !== undefined) throw asFailure(signal?.reason, kind);
}

/** Runs a log write; a failure becomes a value-free `unrecorded` judgment error. */
function recorded<T>(write: () => T): T {
  try { return write(); }
  catch { throw new JudgmentError('unrecorded', FAILURE_MESSAGES.unrecorded); }
}

/** What the composition hears about notes the log could not write. */
export interface DecisionLogOptions {
  readonly now?: () => Date;
  /**
   * Called once per note that could not be written, with the running count.
   * A note describes something that already happened, so its failure never
   * fails the caller; the composition raises one notice from this.
   */
  readonly onUnrecordedNote?: (count: number) => void;
}

/** A retention refusal never copies private assertion text or creates a log entry. */
function assertLogCurrent(check: (() => void) | undefined): void {
  try { assertSynchronousJudgmentGuard(check, 'retention'); }
  catch { throw new JudgmentError('rejected', FAILURE_MESSAGES.rejected); }
}

/** Object-spread semantics, but the admitted assertion accessor is read only once. */
function captureRequest<Q extends Questions>(request: JudgmentRequest<Q>, check: (() => void) | undefined, inputBinding: JudgmentRequest<Q>['inputBinding']): JudgmentRequest<Q> {
  const entries: [PropertyKey, unknown][] = [];
  for (const key of Reflect.ownKeys(request)) {
    if (Object.prototype.propertyIsEnumerable.call(request, key)) {
      entries.push([key, key === 'assertLogCurrent' ? check : key === 'inputBinding' ? inputBinding : Reflect.get(request, key)]);
    }
  }
  return Object.fromEntries(entries) as unknown as JudgmentRequest<Q>;
}

/** A borrowed port is as untrusted as a wire response; normalize before writing or returning it. */
function projectResult<Q extends Questions>(questions: Q, expectedModel: string, result: JudgmentResult<Q>): JudgmentResult<Q> {
  let requestId: string | undefined;
  let lineage: JudgmentLineage | undefined;
  try {
    requestId = identifier(result.requestId);
    lineage = projectLineage(result.lineage);
    const { requestedModel: rawRequestedModel, model: rawModel, usage, latencyMs, answers } = result;
    const { inputTokens, outputTokens } = usage;
    const requestedModel = identifier(rawRequestedModel, true);
    const model = identifier(rawModel, true);
    if (requestedModel !== expectedModel || model === undefined
      || !nonnegative(inputTokens) || !nonnegative(outputTokens) || !nonnegative(latencyMs)) throw invalidResponse();
    // The native transport already checked, projected and froze these
    // answers for these very questions. A borrowed or injected port's answers
    // are checked here, and the projection again: a borrowed object can have
    // changing getters.
    const trusted = answersCheckedFor(questions, answers);
    if (!trusted) checkAnswers(questions, answers);
    const normalizedAnswers = trusted ? answers : projectAnswers(questions, answers);
    if (!trusted) checkAnswers(questions, normalizedAnswers);
    return {
      answers: normalizedAnswers, requestedModel, model,
      usage: { inputTokens, outputTokens },
      latencyMs, requestId,
      ...(lineage === undefined ? {} : { lineage }),
    };
  } catch {
    throw new JudgmentError('invalid-response', FAILURE_MESSAGES['invalid-response'], {
      ...(requestId === undefined ? {} : { requestId }),
      ...(lineage === undefined ? {} : { lineage }),
    });
  }
}

/**
 * Wraps a port so every admitted call is recorded, answered or failed. An
 * optional current-retention assertion can refuse capture or a later write.
 * When the log cannot record a call, the call fails with `unrecorded`: no
 * decision acts on a reading the log does not hold. A note written after the
 * answer (later readings, the action code took) never fails its caller: the
 * work it describes is done, so a failed note is counted and reported through
 * `onUnrecordedNote` instead.
 */
export function withDecisionLog(inner: JudgmentPort, log: DecisionLog, options: DecisionLogOptions | (() => Date) = {}): JudgmentPort {
  const { now = () => new Date(), onUnrecordedNote } = typeof options === 'function' ? { now: options } : options;
  let unrecordedNotes = 0;
  const note = (id: string, value: DecisionNote): void => {
    try { log.attach(id, value); }
    catch {
      unrecordedNotes += 1;
      try { onUnrecordedNote?.(unrecordedNotes); } catch { /* a listener cannot turn finished work into a failure */ }
    }
  };
  return {
    get model() { return inner.model; },
    get decisionDeadlineMs() { return inner.decisionDeadlineMs; },
    ...(inner.revision ? { revision: () => inner.revision!() } : {}),
    ...(inner.health ? { health: () => inner.health!() } : {}),
    recorder: {
      recordReadings: (id, readings) => note(id, { kind: 'readings', readings }),
      recordAction: (id, action) => note(id, { kind: 'action', action }),
    },
    async ask<const Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      const started = performance.now();
      let requestedModel: string | undefined;
      let logAssertion: (() => void) | undefined;
      let resultCapture: JudgmentRequest<Q>['captureResult'];
      let inputBinding: JudgmentRequest<Q>['inputBinding'];
      let conclude: JudgmentRequest<Q>['conclude'];
      try { logAssertion = request.assertLogCurrent; resultCapture = request.captureResult; inputBinding = request.inputBinding; conclude = request.conclude; }
      catch (error) { drainOwned(error); throw new JudgmentError('rejected', FAILURE_MESSAGES.rejected); }
      // Observe malformed owned work immediately, even if a later retention
      // guard refuses before enum validation. Never assimilate borrowed thenables.
      if (inputBinding !== undefined && inputBinding !== 'state') drainOwned(inputBinding);
      assertLogCurrent(logAssertion);
      // Admit one immutable payload before settings/key acquisition can await.
      // The captured input is deeply frozen, so the port it is lent to cannot
      // alter the questions answers are validated against.
      const { signal, input, questions, at, context } = (() => {
        try {
          const signal = request.signal;
          const input = captureJudgmentInput(request, { immutable: true });
          return { signal, input, questions: input.questions, at: isoTime(now()), context: Object.freeze({ ...request.context }) };
        } finally {
          // Borrowed accessors can revoke retention even when they throw. The
          // detached state has no borrowed getters left when it is hashed.
          assertLogCurrent(logAssertion);
        }
      })();
      const call = {
        at,
        context,
        // Plain JSON already: the capture above is a JSON round trip.
        questions: questions as unknown as JsonValue,
      };
      let originalResult: JudgmentResult<Q> | undefined;
      let result: JudgmentResult<Q>;
      let resultToReturn: JudgmentResult<Q>;
      let notes: DecisionNote[] = [];
      try {
        if (inputBinding !== undefined && inputBinding !== 'state') throw new JudgmentError('invalid-request', FAILURE_MESSAGES['invalid-request']);
        requestedModel = identifier(request.model ?? inner.model, true);
        if (requestedModel === undefined) throw new JudgmentError('invalid-request', FAILURE_MESSAGES['invalid-request']);
        checkCancellation(signal);
        const original = await inner.ask(Object.freeze({ ...captureRequest(request, logAssertion, inputBinding), ...input, context: call.context, model: requestedModel }));
        originalResult = original;
        checkCancellation(signal);
        // An owned strict scope must see every original field before the
        // ordinary known-field projection can discard it or record success.
        const response = (() => {
          if (!resultCapture) return original;
          assertLogCurrent(logAssertion);
          const admitted = (() => {
            try { return resultCapture(original); }
            catch (error) { drainOwned(error); throw error; }
          })();
          if (nodeTypes.isPromise(admitted)) {
            drainOwned(admitted);
            throw invalidResponse();
          }
          checkCancellation(signal);
          assertLogCurrent(logAssertion);
          return admitted;
        })();
        result = projectResult(questions as unknown as Q, requestedModel, response);
        resultToReturn = resultCapture ? response : result;
        // The returned object must freeze cleanly. Learn that now, not after an
        // answered entry is written for a result nobody can receive.
        try { recordImmutableJudgmentResult({ ...resultToReturn }); }
        catch { throw invalidResponse(); }
        checkCancellation(signal);
        if (conclude) {
          const concluded = conclude(result);
          notes = [
            ...(concluded.readings === undefined ? [] : [{ kind: 'readings' as const, readings: concluded.readings }]),
            ...(concluded.action === undefined ? [] : [{ kind: 'action' as const, action: concluded.action }]),
          ];
        }
      } catch (error) {
        const failure = asFailure(error, cancellationKind(signal));
        const entry: NewDecisionEntry = {
          ...call,
          status: 'failed',
          // An unsafe configured model has no identifier that can be persisted.
          requestedModel: requestedModel ?? '',
          latencyMs: performance.now() - started,
          requestId: failure.requestId,
          lineage: failure.lineage ?? { logicalRequestId: crypto.randomUUID(), attempts: [] },
          error: { kind: failure.kind, message: failure.message, ...(failure.reason === undefined ? {} : { reason: failure.reason }) },
        };
        // Failure projection can itself call borrowed getters. A refused
        // retention assertion escapes this catch without a replacement entry.
        assertLogCurrent(logAssertion);
        recorded(() => log.record(entry));
        throw failure;
      }
      assertLogCurrent(logAssertion);
      const entry: NewDecisionEntry = recorded(() => ({
        ...call,
        ...(inputBinding === 'state' ? { stateHash: hashState(input.state) } : {}),
        status: 'answered',
        requestedModel: result.requestedModel,
        model: result.model,
        answers: toJson(result.answers),
        latencyMs: result.latencyMs,
        usage: result.usage,
        requestId: result.requestId,
        lineage: result.lineage ?? { logicalRequestId: crypto.randomUUID(), attempts: [] },
      }));
      assertLogCurrent(logAssertion);
      // The answer and what code concluded from it go in one write when the log can.
      const decisionId = recorded(() => {
        if (notes.length === 0) return log.record(entry);
        if (log.recordWithNotes) return log.recordWithNotes(entry, notes);
        const id = log.record(entry);
        for (const note of notes) log.attach(id, note);
        return id;
      });
      const returned = recordImmutableJudgmentResult(retainNativeModelObservation(originalResult, { ...resultToReturn, decisionId }));
      if (entry.stateHash !== undefined) applyRecordedInput(setRecordedInput, recordedInputResults, [returned, { state: input.state, questions: input.questions, context: call.context, stateHash: entry.stateHash, decisionId }]);
      return returned;
    },
  };
}
