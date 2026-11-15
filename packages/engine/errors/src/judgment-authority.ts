import { drainOwned, reuseObservedJudgmentResult } from '@goodvibes-jev/judgment/decisions';
import type { JudgmentPort, JudgmentRequest, JudgmentResult, Questions } from '@goodvibes-jev/judgment/decisions';
import { JudgmentPortMissingError, judgmentPortInstallation } from './judgment-port.js';
import { DecisionModelsDisabledError } from './decision-policy.js';

/** A composition-owned observation. It is never execution permission. */
export interface JudgmentAuthorityFrame {
  readonly identity: object;
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent: () => void;
}
export interface JudgmentReadingOptions {
  /** Bind complete response admission to the original requested schema before asking. */
  readonly prepareResultCapture?: ((questions: Questions) => {
    readonly questions: Questions;
    readonly capture: <T extends Awaited<ReturnType<JudgmentPort['ask']>>>(result: T) => T;
    readonly assertCurrent: () => void;
  }) | undefined;
  /** Admit the complete original and return a detached, immutable response for consumers. */
  readonly captureResult?: (<T extends Awaited<ReturnType<JudgmentPort['ask']>>>(result: T) => T) | undefined;
  /** Site-owned complete ORIGINAL response admission before decision-id access or retention. */
  readonly assertResult?: ((result: unknown) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}
export interface JudgmentEffectRestriction {
  /** A restriction only. The caller must independently authorize the exact effect. */
  readonly assertCurrent: () => void;
}
export interface JudgmentPortCapture {
  /** Opaque cache identity; never a hash of configuration or credential values. */
  readonly identity: object;
  /** Consume this observation forever; retain installation/function restrictions only. */
  readonly consumeObservation: () => JudgmentEffectRestriction;
  readonly port: JudgmentPort;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
}
interface OwnerBinding {
  readonly capture: (() => JudgmentAuthorityFrame) | undefined;
  readonly controller: AbortController;
  readonly identities: WeakMap<object, object>;
}
const owners = new WeakMap<JudgmentPort, OwnerBinding>();
function ownerBinding(port: JudgmentPort): OwnerBinding {
  let binding = owners.get(port);
  if (!binding) {
    binding = { capture: undefined, controller: new AbortController(), identities: new WeakMap() };
    owners.set(port, binding);
  }
  return binding;
}
const ordinaryOwners = new WeakMap<JudgmentPort, { readonly model: string; readonly identity: object }>();
function ordinaryIdentity(port: JudgmentPort, model: string): object {
  let owner = ordinaryOwners.get(port);
  if (!owner || owner.model !== model) {
    owner = { model, identity: Object.freeze({}) }; ordinaryOwners.set(port, owner);
  }
  return owner.identity;
}

export class JudgmentAuthorityRetiredError extends Error {
  constructor() { super('The judgment reading owner is no longer current.'); this.name = 'JudgmentAuthorityRetiredError'; }
}

/** Bind an actual composition's source lifetime before exposing its port. */
export function bindJudgmentPortAuthority(port: JudgmentPort, capture: () => JudgmentAuthorityFrame): void {
  const previous = owners.get(port);
  if (previous?.capture === capture) return;
  owners.set(port, { capture, controller: new AbortController(), identities: new WeakMap() });
  // Publish first so cancellation listeners cannot recapture the retired owner.
  previous?.controller.abort();
}

function synchronous(check: (() => void) | undefined): void {
  let value: unknown;
  try { value = check?.(); }
  catch (error) { drainOwned(error); throw new JudgmentAuthorityRetiredError(); }
  if (value === undefined) return;
  drainOwned(value);
  throw new JudgmentAuthorityRetiredError();
}

/** Interrupt non-cooperating readers and consume either late settlement. */
async function interrupt<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new JudgmentAuthorityRetiredError());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}

/**
 * Capture one installed/source authority, fencing requests, retention, battery
 * attachments and publication. A caller signal owns only this scoped reader.
 */
export function captureJudgmentPort(site: string, options: JudgmentReadingOptions = {}): JudgmentPortCapture {
  try { return capture(site, options); }
  catch (error) {
    drainOwned(error);
    if (error instanceof JudgmentPortMissingError || error instanceof DecisionModelsDisabledError) throw error;
    throw new JudgmentAuthorityRetiredError();
  }
}

/**
 * One owner of staleness: the capture's signal. The installation, the owner
 * binding, the source lifetime (aborted by the configuration and credential
 * change subscriptions) and the caller's signal all feed it. A check is a few
 * boolean reads plus the source's and caller's own checks; nothing re-reads
 * settings or secrets, and nothing re-proves the port object's own methods.
 */
function capture(site: string, options: JudgmentReadingOptions): JudgmentPortCapture {
  const installation = judgmentPortInstallation(site);
  const base = installation.port;
  const binding = ownerBinding(base);
  let consumed = false;
  const installed = (): boolean => !installation.signal.aborted && !binding.controller.signal.aborted && owners.get(base) === binding;
  if (!installed()) throw new JudgmentAuthorityRetiredError();
  const owner = binding.capture?.();
  if (!installed()) throw new JudgmentAuthorityRetiredError();
  const ownerIdentity = owner?.identity, sourceCurrent = owner?.assertCurrent;
  const signal = AbortSignal.any([installation.signal, binding.controller.signal, ...(owner?.signal ? [owner.signal] : []),
    ...(options.signal ? [options.signal] : [])]);
  const { model, health, recorder } = base;
  const ownedAsk = base.ask.bind(base);
  const recordReadings = recorder?.recordReadings, recordAction = recorder?.recordAction;
  const callerCurrent = options.assertCurrent, assertResult = options.assertResult, captureResult = options.captureResult, prepareResultCapture = options.prepareResultCapture;
  const current = () => {
    if (consumed || signal.aborted || !installed()) throw new JudgmentAuthorityRetiredError();
    synchronous(sourceCurrent);
    synchronous(callerCurrent);
  };
  current();
  const decisionChecks = new Map<string, () => void>();
  const checkDecision = (id: string) => { current(); decisionChecks.get(id)?.(); };
  const port: JudgmentPort = {
    get model() { current(); return model; },
    ...(recorder ? { recorder: {
      recordReadings(id, readings) { checkDecision(id); recordReadings!.call(recorder, id, readings); },
      recordAction(id, action) { checkDecision(id); recordAction!.call(recorder, id, action); },
    } satisfies NonNullable<JudgmentPort['recorder']> } : {}),
    ...(health ? { health: () => { current(); return health.call(base); } } : {}),
    async ask<const Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      current();
      const strictResultCapture = Boolean(prepareResultCapture || captureResult || assertResult);
      const originalResultCapture = request.captureResult;
      const resultFrame = prepareResultCapture?.(request.questions);
      const dispatchedQuestions = (resultFrame?.questions ?? request.questions) as typeof request.questions;
      const active = request.signal ? AbortSignal.any([signal, request.signal]) : signal;
      const check = () => {
        if (active.aborted) throw new JudgmentAuthorityRetiredError();
        current(); synchronous(resultFrame?.assertCurrent);
      };
      const admit = <T extends JudgmentResult<Q>>(original: T): T => {
        assertResult?.(original);
        return reuseObservedJudgmentResult(original, resultFrame ? resultFrame.capture(original) : captureResult ? captureResult(original) : original);
      };
      const { beforeAttempt, beforeAsyncAttempt, assertLogCurrent } = request;
      check();
      const ownedRequest: JudgmentRequest<Q> = { ...request, questions: dispatchedQuestions, signal: active,
        // The last point before a request leaves the process.
        beforeAttempt: () => { check(); synchronous(beforeAttempt); },
        beforeAsyncAttempt: async () => { check(); return beforeAsyncAttempt?.(); },
        assertLogCurrent: () => { check(); synchronous(assertLogCurrent); },
        ...(strictResultCapture ? { captureResult: <T extends JudgmentResult<Q>>(original: T): T => {
          const admitted = admit(original);
          // A caller restriction cannot replace or project the scope-owned admission. It sees its snapshot.
          if (originalResultCapture) {
            const restricted: unknown = originalResultCapture(admitted);
            if (restricted !== admitted) {
              try { void Promise.prototype.then.call(restricted, undefined, () => {}); } catch { /* Only genuine promises need rejection draining. */ }
              throw new JudgmentAuthorityRetiredError();
            }
          }
          return admitted;
        } } : {}),
      };
      const result = await interrupt(Promise.resolve().then(() => ownedAsk(ownedRequest)), active);
      check();
      // Admission runs on the untouched provider object. Never evaluate an
      // accessor or retain a site-rejected decision identifier first.
      const admitted = admit(result);
      const decision = Object.getOwnPropertyDescriptor(admitted, 'decisionId');
      if (decision?.get || decision?.set || (decision?.value !== undefined && typeof decision.value !== 'string')) throw new JudgmentAuthorityRetiredError();
      const decisionId = decision?.value as string | undefined;
      if (decisionId !== undefined) decisionChecks.set(decisionId, check);
      return admitted;
    },
  };
  const sourceIdentity = ownerIdentity ?? ordinaryIdentity(base, model);
  let identity = binding.identities.get(sourceIdentity);
  if (!identity) { identity = Object.freeze({}); binding.identities.set(sourceIdentity, identity); }
  return Object.freeze({ identity: installation.identityFor(identity), port, signal, assertCurrent: current, consumeObservation: () => {
    current(); consumed = true;
    return Object.freeze({ assertCurrent: () => { if (!installed()) throw new JudgmentAuthorityRetiredError(); } });
  } });
}
