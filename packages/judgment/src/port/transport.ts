import { assertSynchronousJudgmentGuard } from './attempt-guard.ts';
import { APIError, APITimeoutError, type Questions } from '@typesafe-ai/sdk';
import { checkAnswers, markCheckedAnswers, projectAnswers } from './answers.ts';
import { PreparedBody, toJudgmentError } from './client.ts';
import { acceptsBackendModel, askBackend, judgmentAdapter, validateBackendInput } from './backends.ts';
import { validateJudgmentConfig, type JudgmentConfig } from './config.ts';
import { DEADLINE_COOLDOWN_MS, DEADLINE_MISSES_BEFORE_COOLDOWN } from './deadline.ts';
import { JudgmentContextLimitError, JudgmentError, type JudgmentFailureReason } from './errors.ts';
import { checkInputBytes, requiresLongContextFor, serializeInput, validateQuestions, wireBody, wireBodyBytes } from './limits.ts';
import { withRequestId } from './request-id.ts';
import { delay, interruptible, retryable, retryDelay, retryPolicy } from './retry.ts';
import { recordNativeModelObservation } from './model-observation.ts';
import { captureJudgmentInput } from './input-snapshot.ts';
import { cooldownNotice, DECISION_MODELS_UNAVAILABLE_NOTICE, missedDeadlineNotice, slowTargetsNotice } from './availability-notice.ts';
import type { JudgmentAttempt, JudgmentEndpointHealth, JudgmentPort, JudgmentRequest, JudgmentResult } from './types.ts';

/** The reason AbortSignal.timeout gives; the owner's deadline passed. */
function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'TimeoutError';
}

function needsContextUpgrade(error: unknown): boolean {
  if (!(error instanceof APIError) || error.status !== 400) return false;
  const body = error.body;
  if (!body || typeof body !== 'object' || !('detail' in body)) return false;
  const detail = body.detail;
  return !!detail && typeof detail === 'object' && 'error_type' in detail && detail.error_type === 'max_tokens_exceeded';
}

/** The last word on a chain no target answered: what happened to the last attempt, and what to do. */
function unavailableMessage(reason: JudgmentFailureReason | undefined, status: number | undefined, timeoutMs: number, targets: number): string {
  const what = reason === 'endpoint-status' && status !== undefined ? `answered HTTP ${status}`
    : reason === 'endpoint-timeout' ? `did not answer within ${timeoutMs} ms`
    : reason === 'unreachable' ? 'could not be reached'
    : reason === 'no-credential' ? 'has no API key' : undefined;
  if (what === undefined) return DECISION_MODELS_UNAVAILABLE_NOTICE;
  const next = reason === 'no-credential' ? 'Set the judgment key (judgment.keySource and judgment.keyName, or TYPESAFE_API_KEY), then retry.'
    : reason === 'unreachable' ? 'Check that the decision endpoint is running and its address is right, then retry.'
    : 'Retry in a moment.';
  return targets === 1 ? `The decision endpoint ${what}. ${next}` : `None of the ${targets} decision targets answered; the last ${what}. ${next}`;
}

/** Each configured target gets one finite attempt; a valid answer ends the chain. */
export function createSystemOnePort(config: JudgmentConfig): JudgmentPort {
  validateJudgmentConfig(config);
  const targets = [{ endpoint: config.endpoint, model: config.model }, ...(config.fallbacks ?? [])].map(target => ({
    model: target.model, endpoint: { ...target.endpoint, ...(target.endpoint.responseModels === undefined ? {} : { responseModels: [...target.endpoint.responseModels] }) },
  }));
  const fetch = config.fetch;
  const policy = retryPolicy(config.retry);
  const timeoutMs = config.timeoutMs || 30_000;
  const cooldowns = targets.map(() => 0);
  // Why each target is cooling: missed deadlines, or a provider's Retry-After
  // with the status it came with (429 is a rate limit; anything else an outage).
  const cooledFor = targets.map((): 'deadline' | 'retry-after' => 'retry-after');
  const cooledStatus = targets.map((): number | undefined => undefined);
  const deadlineMisses = targets.map(() => 0);
  const defaultModel = config.model;
  const ownerSignal = config.signal;
  const health: JudgmentEndpointHealth[] = targets.map(({ endpoint, model }, endpointIndex) => ({ endpointIndex, endpointKind: endpoint.kind, model, attempts: 0, consecutiveFailures: 0 }));
  const keys = targets.map((target) => target.endpoint.apiKey).filter(key => key.length > 0);
  const safeId = (value: string | undefined): string | undefined => {
    // Provider request IDs are kept for support cases: the card scanner reads
    // digit runs inside identifiers as ids, not as card numbers.
    if (!value || value.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(value) || keys.some((key) => value.includes(key))) return undefined;
    return value;
  };

  return {
    model: defaultModel,
    ...(config.decisionDeadlineMs === undefined ? {} : { decisionDeadlineMs: config.decisionDeadlineMs }),
    health: () => health.map((item, index) => {
      const remaining = Math.max(0, (cooldowns[index] ?? 0) - Date.now());
      return { ...item, ...(remaining > 0 ? { cooldownRemainingMs: remaining } : {}) };
    }),
    async ask<const Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      const started = performance.now();
      const logicalRequestId = crypto.randomUUID();
      const attempts: JudgmentAttempt[] = [];
      let attemptCount = 0;
      const lineage = () => ({ logicalRequestId, attempts: [...attempts],
        ...(attemptCount > attempts.length ? { omittedAttempts: attemptCount - attempts.length } : {}) });
      const remember = (attempt: JudgmentAttempt) => {
        attempts.push(attempt);
        if (attempts.length > 128) attempts.shift();
      };
      const { signal, beforeAttempt, beforeAsyncAttempt, onRetry, deadlineMs } = request;
      const owners = [...new Set([signal, ownerSignal].filter((owner): owner is AbortSignal => owner !== undefined))];
      const requestedModel = request.model ?? defaultModel;
      const controller = new AbortController();
      const missedDeadline = new JudgmentError('unavailable', missedDeadlineNotice(deadlineMs), { reason: 'deadline-missed' });
      // An owner aborted by AbortSignal.timeout is a deadline, not a cancellation.
      const cancelled = () => controller.abort(owners.some(owner => owner.aborted && isTimeoutReason(owner.reason))
        ? missedDeadline : new JudgmentError('aborted', 'the judgment call was cancelled'));
      const pastDeadline = () => controller.signal.aborted && controller.signal.reason === missedDeadline;
      let deadlineAt: number | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      for (const owner of owners) {
        if (owner.aborted) cancelled();
        owner.addEventListener('abort', cancelled, { once: true });
      }
      const checkCancellation = () => {
        if (owners.some(owner => owner.aborted)) cancelled();
        if (controller.signal.aborted) throw controller.signal.reason;
      };
      try {
        if (owners.length === 0) throw new JudgmentError('invalid-request', 'judgment calls require an owning AbortSignal on the request or port', { reason: 'no-owner-signal' });
        if (typeof requestedModel !== 'string' || !/^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,255}$/.test(requestedModel)) {
          throw new JudgmentError('invalid-request', 'judgment model overrides must be nonempty model identifiers', { reason: 'invalid-model' });
        }
        if ('totalTimeoutMs' in request) throw new JudgmentError('invalid-request', 'judgment total-time limits are set with deadlineMs', { reason: 'invalid-deadline' });
        if (deadlineMs !== undefined && (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 2_147_483_647)) {
          throw new JudgmentError('invalid-request', 'a judgment deadline must be whole positive milliseconds', { reason: 'invalid-deadline' });
        }
        if (deadlineMs !== undefined) {
          deadlineAt = performance.now() + deadlineMs;
          deadlineTimer = setTimeout(() => controller.abort(missedDeadline), deadlineMs);
        }
        checkCancellation();
        let input: Pick<JudgmentRequest<Q>, 'state' | 'questions'>;
        try { input = captureJudgmentInput(request); }
        catch { throw new JudgmentError('invalid-request', 'judgment input must be JSON-serializable', { reason: 'not-serializable' }); }
        const { state, questions } = input;
        validateQuestions(questions);
        // The state is serialized once here; size checks and every wire body reuse it.
        const serialized = serializeInput(state, questions);
        checkInputBytes(serialized);
        let lastFailure: JudgmentError | undefined;
        // What the last failed attempt ran into, for the terminal message.
        let lastReason: JudgmentFailureReason | undefined;
        let malformedFailure: JudgmentError | undefined;
        // Targets whose latest attempt failed in a way waiting can heal (5xx,
        // 429, timeout, connection). With none, the chain was refused, not down.
        const transientTargets = new Set<number>();
        let skippedForCooldown = false;
        const eligible = targets.map((target, endpointIndex) => ({ target, endpointIndex }));
        for (let eligibleIndex = 0; eligibleIndex < eligible.length; eligibleIndex++) {
          const entry = eligible[eligibleIndex];
          if (entry === undefined) throw new JudgmentError('invalid-request', 'invalid judgment target order');
          const { target, endpointIndex } = entry;
          if (cooldowns[endpointIndex]! > Date.now()) { skippedForCooldown = true; continue; }
          const targetModel = endpointIndex === 0 ? requestedModel : target.model;
          let headers = judgmentAdapter(target.endpoint) === 'system-one' && requiresLongContextFor(serialized)
            ? { 'TypeSafe-Danger-Zone-Long-Context': 'true' } : undefined;
          let contextUpgrade = false;
          let retried = false;
          for (;;) {
            let retryWaitMs: number | undefined;
            checkCancellation();
            try {
              if (beforeAsyncAttempt) {
                let checked: unknown;
                try {
                  checked = await interruptible(Promise.resolve().then(() => {
                    checkCancellation();
                    return beforeAsyncAttempt();
                  }), controller.signal);
                } catch {
                  checkCancellation();
                  throw new JudgmentError('rejected', 'the judgment attempt is no longer authorized', { reason: 'attempt-refused' });
                }
                checkCancellation();
                if (checked !== undefined) throw new JudgmentError('invalid-request', 'the asynchronous judgment attempt guard must complete without a return value', { reason: 'invalid-attempt-guard' });
              }
              assertSynchronousJudgmentGuard(beforeAttempt);
            } catch (error) {
              checkCancellation();
              throw error instanceof JudgmentError ? error : new JudgmentError('rejected', 'the judgment attempt is no longer authorized', { reason: 'attempt-refused' });
            }
            checkCancellation();
            attemptCount += 1;
            const attemptStarted = performance.now();
            let requestId: string | undefined;
            let dispatched = false;
            const attemptController = new AbortController();
            const abortAttempt = () => attemptController.abort(controller.signal.reason);
            controller.signal.addEventListener('abort', abortAttempt, { once: true });
            let attemptTimedOut = false;
            const attemptTimer = timeoutMs > 0 ? setTimeout(() => { attemptTimedOut = true; attemptController.abort(new APITimeoutError(timeoutMs)); }, timeoutMs) : undefined;
            let failure: unknown;
            try {
              validateBackendInput(target.endpoint, targetModel, { questions }, wireBodyBytes(serialized, targetModel));
              const body = new PreparedBody(wireBody(serialized, targetModel));
              if (target.endpoint.authentication !== 'none' && !target.endpoint.apiKey.trim()) {
                throw new JudgmentError('unavailable', 'this judgment target has no resolved credential', { reason: 'no-credential' });
              }
              const { result } = await interruptible(withRequestId(
                () => askBackend<Q>({ ...target, timeoutMs, retry: {}, fetch: (input, init) => { dispatched = true; return fetch ? fetch(input, init) : globalThis.fetch(input, init); } }, body, attemptController.signal, headers),
                (id) => { requestId = safeId(id); },
              ), attemptController.signal);
              checkCancellation();
              if (!result || typeof result.model !== 'string' || keys.some((key) => result.model.includes(key)) || !result.answers || !result.usage
                || ![result.usage.input_tokens, result.usage.output_tokens].every((n) => Number.isFinite(n) && n >= 0)) {
                throw new JudgmentError('invalid-response', 'System One returned an invalid result envelope', { reason: 'malformed-response' });
              }
              try { checkAnswers(questions, result.answers, requestId); }
              catch (error) {
                if (!(error instanceof JudgmentError) || error.kind !== 'invalid-response') throw error;
                throw new JudgmentError('invalid-response', 'System One returned answers that do not match the requested questions', { reason: 'malformed-response' });
              }
              if (!acceptsBackendModel(target.endpoint, targetModel, result.model)) throw new JudgmentError('invalid-response', 'the decision model does not match this configured target or its declared alias', { reason: 'model-mismatch' });
              const attempt: JudgmentAttempt = {
                attempt: attemptCount, endpointIndex, endpointKind: target.endpoint.kind, requestedModel: targetModel, dispatched,
                latencyMs: performance.now() - attemptStarted, outcome: 'answered', ...(requestId ? { requestId } : {}),
              };
              remember(attempt);
              deadlineMisses[endpointIndex] = 0;
              health[endpointIndex] = { ...health[endpointIndex]!, attempts: health[endpointIndex]!.attempts + 1, consecutiveFailures: 0, lastOutcome: 'answered' };
              const answered = recordNativeModelObservation({
                answers: projectAnswers(questions, result.answers), requestedModel, model: result.model,
                usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens },
                latencyMs: performance.now() - started, requestId, lineage: lineage(),
              }, { requestedModel, model: result.model, targetModel, endpointIndex });
              // Checked once, here; the decision log and the readers trust this mark.
              markCheckedAnswers(questions, answered.answers);
              return answered;
            } catch (error) {
              failure = controller.signal.aborted ? controller.signal.reason : attemptController.signal.aborted ? attemptController.signal.reason : error;
              const last = toJudgmentError(failure);
              lastFailure = last;
              // Read from the converted error only: the raw thrown value may be hostile.
              lastReason = last.reason ?? (last.kind !== 'unavailable' ? undefined : attemptTimedOut ? 'endpoint-timeout'
                : last.status !== undefined ? 'endpoint-status' : 'unreachable');
              if (last.kind === 'invalid-response') malformedFailure = last;
              if (last.kind === 'unavailable' && lastReason !== 'no-credential') transientTargets.add(endpointIndex);
              else transientTargets.delete(endpointIndex);
              requestId = last.kind === 'internal' ? undefined : safeId(last.requestId) ?? requestId;
              remember({
                attempt: attemptCount, endpointIndex, endpointKind: target.endpoint.kind, requestedModel: targetModel, dispatched,
                latencyMs: performance.now() - attemptStarted, outcome: last.kind,
                ...(last.status === undefined ? {} : { status: last.status }), ...(requestId ? { requestId } : {}),
              });
              health[endpointIndex] = { ...health[endpointIndex]!, attempts: health[endpointIndex]!.attempts + 1, consecutiveFailures: health[endpointIndex]!.consecutiveFailures + 1, lastOutcome: last.kind };
              // A target that keeps missing deadlines is skipped for a while, so
              // the next decisions take their fallback, or the next target, at once.
              if (pastDeadline() || attemptTimedOut) {
                deadlineMisses[endpointIndex] = deadlineMisses[endpointIndex]! + 1;
                if (deadlineMisses[endpointIndex]! >= DEADLINE_MISSES_BEFORE_COOLDOWN) {
                  deadlineMisses[endpointIndex] = 0;
                  cooldowns[endpointIndex] = Date.now() + DEADLINE_COOLDOWN_MS;
                  cooledFor[endpointIndex] = 'deadline';
                }
              }
              // Exact server tokenization can exceed the character estimate.
              // Retry the complete input on the same endpoint in long-context
              // mode, retaining this refusal and rechecking owner authority.
              if (last.kind !== 'internal' && !contextUpgrade && headers === undefined && judgmentAdapter(target.endpoint) === 'system-one' && needsContextUpgrade(failure)) {
                headers = { 'TypeSafe-Danger-Zone-Long-Context': 'true' };
                contextUpgrade = true;
                continue;
              }
              // Host admission failures run outside this catch. A valid semantic
              // refusal or abstention is final; HTTP/config/response failures
              // belong to this target and may advance to another configured model.
              if (last.kind === 'internal' || last.kind === 'aborted' || failure instanceof JudgmentError && last.kind === 'rejected') throw last;
              // One further attempt on the same target for a transient failure,
              // when no other target is ready to take the call and the wait fits
              // inside both the backoff ceiling and the remaining deadline.
              const laterTargetReady = eligible.slice(eligibleIndex + 1).some(next => cooldowns[next.endpointIndex]! <= Date.now());
              if (!retried && !laterTargetReady && !controller.signal.aborted && retryable(failure)) {
                const wait = retryDelay(failure, 0, policy);
                if (wait <= policy.backoffMaxMs && (deadlineAt === undefined || wait < deadlineAt - performance.now())) retryWaitMs = wait;
              }
              if (retryWaitMs === undefined && failure instanceof APIError && (failure.headers.has('retry-after') || failure.headers.has('retry-after-ms'))) {
                cooldowns[endpointIndex] = Date.now() + retryDelay(failure, 0, policy);
                cooledFor[endpointIndex] = 'retry-after';
                cooledStatus[endpointIndex] = failure.status;
              }
            } finally {
              clearTimeout(attemptTimer);
              controller.signal.removeEventListener('abort', abortAttempt);
            }
            checkCancellation();
            if (retryWaitMs !== undefined) {
              retried = true;
              if (onRetry) {
                try {
                  const progress = Object.freeze({ logicalRequestId,
                    attempt: Object.freeze({ ...attempts[attempts.length - 1]! }),
                    elapsedMs: performance.now() - started, nextDelayMs: retryWaitMs });
                  await interruptible(Promise.resolve().then(() => { checkCancellation(); return onRetry(progress); }), controller.signal);
                } catch { checkCancellation(); }
              }
              await delay(retryWaitMs, controller.signal);
              continue;
            }
            if (eligibleIndex + 1 < eligible.length && onRetry) {
              // A Retry-After applies to the failed target, never to an independent backup.
              try {
                const progress = Object.freeze({ logicalRequestId,
                  attempt: Object.freeze({ ...attempts[attempts.length - 1]! }),
                  elapsedMs: performance.now() - started, nextDelayMs: 0 });
                // The observer remains owned until it settles or the call is
                // cancelled. In particular, a next endpoint cannot race an
                // asynchronous observer changing the original host authority.
                await interruptible(Promise.resolve().then(() => {
                  checkCancellation();
                  return onRetry(progress);
                }), controller.signal);
              } catch {
                // Progress failures stay isolated from provider outcomes;
                // cancellation still halts, and the next attempt rechecks its
                // actual asynchronous and synchronous host admission guards.
                checkCancellation();
              }
              checkCancellation();
            }
            break;
          }
        }
        const last = attempts.at(-1);
        // Exhausting backups cannot turn a malformed answer into an availability
        // downgrade. Preferred may enter Classic only for actual unavailability.
        if (malformedFailure) throw malformedFailure;
        // A chain no target answered is unavailable only when some target
        // failed in a way waiting can heal. When every target refused (a
        // revoked key, a context limit, a capability limit), the refusal is
        // the answer, whatever the number of targets: a fallback endpoint must
        // not turn "fix your key" into "the service is down".
        if (lastFailure && lastFailure.kind !== 'unavailable' && transientTargets.size === 0 && !skippedForCooldown) {
          if (lastFailure.kind === 'rejected' && (lastFailure.status === 401 || lastFailure.status === 403)) {
            throw new JudgmentError('rejected', `${lastFailure.message}. ${DECISION_MODELS_UNAVAILABLE_NOTICE}`, {
              status: lastFailure.status,
              ...(lastFailure.requestId === undefined ? {} : { requestId: lastFailure.requestId }),
            });
          }
          throw lastFailure;
        }
        // When every target is cooling down, the useful advice is the wait,
        // named for what caused it: missed deadlines, a rate limit (429), or
        // an outage that sent Retry-After with another status.
        const now = Date.now();
        const waits = cooldowns.map(until => until - now);
        const allCooling = waits.every(wait => wait > 0);
        if (allCooling && cooledFor.includes('deadline')) {
          throw new JudgmentError('unavailable', slowTargetsNotice(Math.ceil(Math.min(...waits))), { reason: 'targets-slow',
            ...(last?.status === undefined ? {} : { status: last.status }),
            ...(last?.requestId === undefined ? {} : { requestId: last.requestId }),
          });
        }
        if (allCooling) {
          const retryAfterMs = Math.ceil(Math.min(...waits));
          const rateLimited = cooledStatus.every(status => status === 429);
          const status = rateLimited ? 429 : cooledStatus.find(code => code !== 429);
          throw new JudgmentError('unavailable', cooldownNotice(retryAfterMs, status), {
            retryAfterMs, reason: rateLimited ? 'rate-limited' : 'endpoint-status',
            ...(status === undefined ? {} : { status }),
            ...(last?.requestId === undefined ? {} : { requestId: last.requestId }),
          });
        }
        // Name what happened to the last attempt; the configuration checklist
        // is only for a failure with nothing more specific to say.
        throw new JudgmentError('unavailable', unavailableMessage(lastReason, last?.status, timeoutMs, targets.length), {
          ...(lastReason === undefined ? {} : { reason: lastReason }),
          ...(last?.status === undefined ? {} : { status: last.status }),
          ...(last?.requestId === undefined ? {} : { requestId: last.requestId }),
        });
      } catch (error) {
        const failure = toJudgmentError(error);
        // Do not retain upstream causes, bodies, headers, URLs or API keys in a public error/log.
        const requestId = failure.kind === 'internal' ? undefined : safeId(failure.requestId) ?? attempts.at(-1)?.requestId;
        if (failure instanceof JudgmentContextLimitError) throw new JudgmentContextLimitError({
          ...(requestId ? { requestId } : {}), lineage: lineage(),
        });
        throw new JudgmentError(failure.kind, keys.reduce((message, key) => message.replaceAll(key, '[redacted]'), failure.message), {
          ...(failure.status === undefined ? {} : { status: failure.status }), ...(requestId ? { requestId } : {}),
          ...(failure.reason === undefined ? {} : { reason: failure.reason }),
          ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
          lineage: lineage(),
        });
      } finally {
        clearTimeout(deadlineTimer);
        for (const owner of owners) owner.removeEventListener('abort', cancelled);
      }
    },
  };
}
