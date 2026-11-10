import { checkAnswers, drainOwned, JudgmentError, type DecisionContext, type JudgmentPort, type JudgmentRequest, type JudgmentResult, type Questions } from '@goodvibes-jev/judgment';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import { captureStrictJudgmentJson } from '../platform/src/platform/gate/judgment-result.js';
import type { StaticCallCapture, StaticCallEvidence } from './static-source-reading-types.ts';
import { appendFileSync, closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { types as nodeTypes } from 'node:util';

export interface StaticSourceCallRecord {
  readonly format: 1;
  readonly call: StaticCallEvidence;
  readonly usage: JudgmentResult<Questions>['usage'];
  readonly latencyMs: number;
}

/** Append actual wire observations without replacing another log format. */
export function openStaticCallLog(path: string) {
  const header = Buffer.from('{"format":"static-source-calls","version":1}\n');
  const flags = constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let fd: number, created = false;
  try { fd = openSync(path, flags | constants.O_CREAT | constants.O_EXCL, 0o600); created = true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    fd = openSync(path, flags);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Static source call output must be a single-link regular file');
    if (created) appendFileSync(fd, header);
    else {
      const observed = Buffer.alloc(header.length);
      if (readSync(fd, observed, 0, observed.length, 0) !== header.length || !observed.equals(header)) {
        throw new Error('Static source calls use JSON Lines; choose a new log file');
      }
    }
    return {
      write(entry: StaticSourceCallRecord): void { appendFileSync(fd, JSON.stringify(entry) + '\n'); },
      [Symbol.dispose](): void { closeSync(fd); },
    };
  } catch (error) { closeSync(fd); throw error; }
}

/** Keep the actual request and answer for this development cache. No digest or
 * default decision-log decorator is needed to compare those saved inputs. */
export function createStaticCallRecorder(inner: JudgmentPort, record?: (entry: StaticSourceCallRecord) => void): {
  readonly port: JudgmentPort;
  readonly capture: StaticCallCapture;
  readonly calls: readonly StaticCallEvidence[];
} {
  if (inner.recorder) throw new JudgmentError('invalid-request', 'Static source capture requires an undecorated judgment port');
  const calls: StaticCallEvidence[] = [];
  const entries = new Map<string, StaticCallEvidence>();
  const health = inner.health;
  const active = (request: JudgmentRequest<Questions>) => {
    request.signal?.throwIfAborted();
    let result: unknown;
    try { result = request.assertLogCurrent?.(); }
    catch (error) { drainOwned(error); throw error; }
    if (result !== undefined) {
      drainOwned(result);
      throw new JudgmentError('unrecorded', 'Static source retention requires a synchronous current owner');
    }
  };
  const port: JudgmentPort = {
    model: inner.model,
    ...(health ? { health: () => health.call(inner) } : {}),
    async ask<const Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      // Read the envelope as data too; accessing state before inspecting its
      // descriptor would execute a borrowed getter before admission.
      if (!request || typeof request !== 'object' || nodeTypes.isProxy(request)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(request))) {
        throw new JudgmentError('invalid-request', 'Static source capture requires a plain request');
      }
      const descriptors = Object.getOwnPropertyDescriptors(request);
      if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')
        || Object.values(descriptors).some(descriptor => !descriptor.enumerable || !('value' in descriptor))) {
        throw new JudgmentError('invalid-request', 'Static source capture requires request data properties');
      }
      request = Object.freeze(Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))) as unknown as JudgmentRequest<Q>;
      active(request);
      const requestedModel = request.model ?? inner.model;
      const context: DecisionContext = request.context ?? {};
      const input = captureStrictJudgmentJson({ state: request.state, questions: request.questions, context });
      active(request);
      const original = await inner.ask({ ...request, state: input.state, questions: input.questions, context: input.context });
      active(request);
      let admitted: JudgmentResult<Q>;
      try { admitted = request.captureResult ? request.captureResult(original) : original; }
      catch (error) { drainOwned(error); throw error; }
      let result: JudgmentResult<Q>;
      try { result = captureStrictJudgmentJson(admitted); }
      catch (error) { drainOwned(admitted); throw error; }
      active(request);
      checkAnswers(input.questions, result.answers);
      if (result.requestedModel !== requestedModel || typeof result.model !== 'string' || !result.model
        || !result.usage || ![result.usage.inputTokens, result.usage.outputTokens, result.latencyMs].every(value => Number.isFinite(value) && value >= 0)) {
        throw new JudgmentError('invalid-response', 'Static source capture requires an attributed, metered response');
      }
      const attribution = input.context;
      if (!attribution.battery || attribution.batteryVersion === undefined || !attribution.site) {
        throw new JudgmentError('unrecorded', 'Static source capture requires a named battery, version and site');
      }
      const id = opaqueUuid();
      const call: StaticCallEvidence = captureStrictJudgmentJson({ id, at: new Date().toISOString(),
        battery: attribution.battery, version: attribution.batteryVersion, site: attribution.site,
        state: input.state, questions: input.questions, requestedModel: result.requestedModel,
        observedModel: result.model, requestId: result.requestId ?? null, answers: result.answers });
      active(request);
      let retained: unknown;
      try { retained = record?.({ format: 1, call, usage: result.usage, latencyMs: result.latencyMs }); }
      catch (error) { drainOwned(error); throw error; }
      if (retained !== undefined) {
        drainOwned(retained);
        throw new JudgmentError('unrecorded', 'Static source capture must finish recording before publication');
      }
      active(request);
      entries.set(id, call); calls.push(call);
      return Object.freeze({ ...result, decisionId: id });
    },
  };
  return { port, capture: { get: id => entries.get(id) }, calls };
}
