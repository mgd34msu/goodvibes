import { APIError, APITimeoutError, type Questions } from '@typesafe-ai/sdk';
import { checkAnswers, projectAnswers } from './answers.ts';
import { toJudgmentError } from './client.ts';
import { acceptsBackendModel, askBackend, judgmentAdapter, validateBackendInput } from './backends.ts';
import { validateJudgmentConfig, type JudgmentConfig } from './config.ts';
import { JudgmentContextLimitError, JudgmentError } from './errors.ts';
import { requiresLongContext, validateContextBudget, validateQuestions } from './limits.ts';
import { withRequestId } from './request-id.ts';
import { interruptible, retryDelay, retryPolicy } from './retry.ts';
import { opaqueUuid } from './opaque-uuid.ts';
import type { JudgmentAttempt, JudgmentEndpointHealth, JudgmentPort, JudgmentRequest, JudgmentResult } from './types.ts';

function needsContextUpgrade(error: unknown): boolean {
  if (!(error instanceof APIError) || error.status !== 400) return false;
  const body = error.body;
  if (!body || typeof body !== 'object' || !('detail' in body)) return false;
  const detail = body.detail;
  return !!detail && typeof detail === 'object' && 'error_type' in detail && detail.error_type === 'max_tokens_exceeded';
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
  const defaultModel = config.model;
  const ownerSignal = config.signal;
  const health: JudgmentEndpointHealth[] = targets.map(({ endpoint, model }, endpointIndex) => ({ endpointIndex, endpointKind: endpoint.kind, model, attempts: 0, consecutiveFailures: 0 }));
  const keys = targets.map((target) => target.endpoint.apiKey).filter(key => key.length > 0);
  const safeId = (value: string | undefined): string | undefined => {
    if (!value || value.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(value) || keys.some((key) => value.includes(key))) return undefined;
    // Provider request IDs are optional diagnostics. A valid opaque ID can
    // accidentally contain a card-shaped numeric run; omit that metadata at
    // the native transport instead of rejecting an otherwise valid judgment.
    // Borrowed results and all unknown response fields remain strictly screened.
    if (/\d{13,}/.test(value.replace(/-/g, ''))) return undefined;
    return value;
  };

  return {
    model: defaultModel,
    health: () => health.map((item, index) => {
      const remaining = Math.max(0, (cooldowns[index] ?? 0) - Date.now());
      return { ...item, ...(remaining > 0 ? { cooldownRemainingMs: remaining } : {}) };
    }),
    async ask<const Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      const started = performance.now();
      const logicalRequestId = opaqueUuid();
      const attempts: JudgmentAttempt[] = [];
      let attemptCount = 0;
      const lineage = () => ({ logicalRequestId, attempts: [...attempts],
        ...(attemptCount > attempts.length ? { omittedAttempts: attemptCount - attempts.length } : {}) });
      const remember = (attempt: JudgmentAttempt) => {
        attempts.push(attempt);
        if (attempts.length > 128) attempts.shift();
      };
      const { signal, beforeAttempt, beforeAsyncAttempt, onRetry } = request;
      const owners = [...new Set([signal, ownerSignal].filter((owner): owner is AbortSignal => owner !== undefined))];
      const requestedModel = request.model ?? defaultModel;
      const controller = new AbortController();
      const cancelled = () => controller.abort(new JudgmentError('aborted', 'the judgment call was cancelled'));
      for (const owner of owners) {
        if (owner.aborted) cancelled();
        owner.addEventListener('abort', cancelled, { once: true });
      }
      const checkCancellation = () => {
        if (owners.some(owner => owner.aborted)) cancelled();
        if (controller.signal.aborted) throw controller.signal.reason;
      };
      try {
        if (owners.length === 0) throw new JudgmentError('invalid-request', 'judgment calls require an owning AbortSignal on the request or port');
        if (typeof requestedModel !== 'string' || !/^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,255}$/.test(requestedModel)) {
          throw new JudgmentError('invalid-request', 'judgment model overrides must be nonempty model identifiers');
        }
        if ('totalTimeoutMs' in request) throw new JudgmentError('invalid-request', 'judgment total-time limits are not supported; cancel through the owning signal');
        checkCancellation();
        let input: Pick<JudgmentRequest<Q>, 'state' | 'questions'>;
        try { input = JSON.parse(JSON.stringify({ state: request.state, questions: request.questions })) as typeof input; }
        catch { throw new JudgmentError('invalid-request', 'judgment input must be JSON-serializable'); }
        const { state, questions } = input;
        validateQuestions(questions);
        validateContextBudget(state, questions);
        let lastFailure: JudgmentError | undefined;
        let malformedFailure: JudgmentError | undefined;
        const eligible = targets.map((target, endpointIndex) => ({ target, endpointIndex }));
        for (let eligibleIndex = 0; eligibleIndex < eligible.length; eligibleIndex++) {
          const entry = eligible[eligibleIndex];
          if (entry === undefined) throw new JudgmentError('invalid-request', 'invalid judgment target order');
          const { target, endpointIndex } = entry;
          if (cooldowns[endpointIndex]! > Date.now()) continue;
          const targetModel = endpointIndex === 0 ? requestedModel : target.model;
          let headers = judgmentAdapter(target.endpoint) === 'system-one' && requiresLongContext(state, questions)
            ? { 'TypeSafe-Danger-Zone-Long-Context': 'true' } : undefined;
          let contextUpgrade = false;
          for (;;) {
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
                  throw new JudgmentError('rejected', 'the judgment attempt is no longer authorized');
                }
                checkCancellation();
                if (checked !== undefined) throw new JudgmentError('invalid-request', 'the asynchronous judgment attempt guard must complete without a return value');
              }
              const checked: unknown = beforeAttempt?.();
              if (checked !== undefined) {
                if (checked !== null && (typeof checked === 'object' || typeof checked === 'function')) {
                  try { void Promise.prototype.then.call(checked, undefined, () => {}); } catch { /* Only genuine promises need rejection draining. */ }
                }
                throw new JudgmentError('invalid-request', 'the judgment attempt guard must be synchronous and complete without a return value');
              }
            } catch (error) {
              checkCancellation();
              throw error instanceof JudgmentError ? error : new JudgmentError('rejected', 'the judgment attempt is no longer authorized');
            }
            checkCancellation();
            attemptCount += 1;
            const attemptStarted = performance.now();
            let requestId: string | undefined;
            let dispatched = false;
            const attemptController = new AbortController();
            const abortAttempt = () => attemptController.abort(controller.signal.reason);
            controller.signal.addEventListener('abort', abortAttempt, { once: true });
            const attemptTimer = timeoutMs > 0 ? setTimeout(() => attemptController.abort(new APITimeoutError(timeoutMs)), timeoutMs) : undefined;
            let failure: unknown;
            try {
              const body = { state, questions, model: targetModel };
              validateBackendInput(target.endpoint, targetModel, body);
              if (target.endpoint.authentication !== 'none' && !target.endpoint.apiKey.trim()) {
                throw new JudgmentError('unavailable', 'this judgment target has no resolved credential');
              }
              const response = await interruptible(withRequestId(
                () => askBackend({ ...target, timeoutMs, retry: {}, fetch: (input, init) => { dispatched = true; return fetch ? fetch(input, init) : globalThis.fetch(input, init); } }, body, attemptController.signal, headers),
                (id) => { requestId = safeId(id); },
              ), attemptController.signal);
              checkCancellation();
              const result = response.result;
              if (!result || typeof result.model !== 'string' || keys.some((key) => result.model.includes(key)) || !result.answers || !result.usage
                || ![result.usage.input_tokens, result.usage.output_tokens].every((n) => Number.isFinite(n) && n >= 0)) {
                throw new JudgmentError('invalid-response', 'System One returned an invalid result envelope');
              }
              try { checkAnswers(questions, result.answers, requestId); }
              catch { throw new JudgmentError('invalid-response', 'System One returned answers that do not match the requested questions'); }
              if (!acceptsBackendModel(target.endpoint, targetModel, result.model)) throw new JudgmentError('invalid-response', 'the decision model does not match this configured target or its declared alias');
              const attempt: JudgmentAttempt = {
                attempt: attemptCount, endpointIndex, endpointKind: target.endpoint.kind, requestedModel: targetModel, dispatched,
                latencyMs: performance.now() - attemptStarted, outcome: 'answered', ...(requestId ? { requestId } : {}),
              };
              remember(attempt);
              health[endpointIndex] = { ...health[endpointIndex]!, attempts: health[endpointIndex]!.attempts + 1, consecutiveFailures: 0, lastOutcome: 'answered' };
              return {
                answers: projectAnswers(questions, result.answers), requestedModel, model: result.model,
                usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens },
                latencyMs: performance.now() - started, requestId, lineage: lineage(),
              };
            } catch (error) {
              failure = controller.signal.aborted ? controller.signal.reason : attemptController.signal.aborted ? attemptController.signal.reason : error;
              const last = toJudgmentError(failure);
              lastFailure = last;
              if (last.kind === 'invalid-response') malformedFailure = last;
              requestId = safeId(last.requestId) ?? requestId;
              remember({
                attempt: attemptCount, endpointIndex, endpointKind: target.endpoint.kind, requestedModel: targetModel, dispatched,
                latencyMs: performance.now() - attemptStarted, outcome: last.kind,
                ...(last.status === undefined ? {} : { status: last.status }), ...(requestId ? { requestId } : {}),
              });
              health[endpointIndex] = { ...health[endpointIndex]!, attempts: health[endpointIndex]!.attempts + 1, consecutiveFailures: health[endpointIndex]!.consecutiveFailures + 1, lastOutcome: last.kind };
              // Exact server tokenization can exceed the character estimate.
              // Retry the complete input on the same endpoint in long-context
              // mode, retaining this refusal and rechecking owner authority.
              if (!contextUpgrade && headers === undefined && judgmentAdapter(target.endpoint) === 'system-one' && needsContextUpgrade(failure)) {
                headers = { 'TypeSafe-Danger-Zone-Long-Context': 'true' };
                contextUpgrade = true;
                continue;
              }
              // Host admission failures run outside this catch. A valid semantic
              // refusal or abstention is final; HTTP/config/response failures
              // belong to this target and may advance to another configured model.
              if (last.kind === 'aborted' || failure instanceof JudgmentError && last.kind === 'rejected') throw last;
              if (failure instanceof APIError && (failure.headers.has('retry-after') || failure.headers.has('retry-after-ms'))) {
                cooldowns[endpointIndex] = Date.now() + retryDelay(failure, 0, policy);
              }
            } finally {
              clearTimeout(attemptTimer);
              controller.signal.removeEventListener('abort', abortAttempt);
            }
            checkCancellation();
            if (eligibleIndex + 1 < eligible.length) {
              // A Retry-After applies to the failed target, never to an independent backup.
              try {
                const observed = onRetry?.(Object.freeze({ logicalRequestId,
                  attempt: Object.freeze({ ...attempts[attempts.length - 1]! }),
                  elapsedMs: performance.now() - started, nextDelayMs: 0 }));
                void Promise.resolve(observed).catch(() => {});
              } catch { /* Progress reporting never decides the reading. */ }
            }
            break;
          }
        }
        const last = attempts.at(-1);
        // Exhausting backups cannot turn a malformed answer into an availability
        // downgrade. Preferred may enter Classic only for actual unavailability.
        if (malformedFailure) throw malformedFailure;
        // Preserve a precise terminal protocol/configuration diagnostic when
        // there is only one target; context-limit callers can still partition
        // complete evidence. Availability failures always use the halt notice.
        if (targets.length === 1 && lastFailure && lastFailure.kind !== 'unavailable') throw lastFailure;
        throw new JudgmentError('unavailable', 'No decision models are currently available. Check API keys, endpoint addresses, model names and local model services, then retry. The operation has stopped.', {
          ...(last?.status === undefined ? {} : { status: last.status }),
          ...(last?.requestId === undefined ? {} : { requestId: last.requestId }),
        });
      } catch (error) {
        const failure = toJudgmentError(error);
        // Do not retain upstream causes, bodies, headers, URLs or API keys in a public error/log.
        const requestId = safeId(failure.requestId) ?? attempts.at(-1)?.requestId;
        if (failure instanceof JudgmentContextLimitError) throw new JudgmentContextLimitError({
          ...(requestId ? { requestId } : {}), lineage: lineage(),
        });
        throw new JudgmentError(failure.kind, keys.reduce((message, key) => message.replaceAll(key, '[redacted]'), failure.message), {
          ...(failure.status === undefined ? {} : { status: failure.status }), ...(requestId ? { requestId } : {}),
          lineage: lineage(),
        });
      } finally {
        for (const owner of owners) owner.removeEventListener('abort', cancelled);
      }
    },
  };
}
