import { captureOwnedJson } from '../gate/judgment-input.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDecisionModelFailure, type DecisionModelFailure } from '@goodvibes/judgment';
import {
  DecisionModelsDisabledError, JudgmentPortMissingError, decisionModelPolicyState,
  decisionModelFailingLine, installDecisionModelPolicyObserver, type NoDecisionModelReason, type DecisionModelFailureState, type DecisionModelPolicy, type DecisionModelPolicyState,
  parseDecisionModelPolicy, runDecisionOrClassic,
} from '@goodvibes/engine/errors';

export type { NoDecisionModelReason, DecisionModelFailureState, DecisionModelPolicy, DecisionModelPolicyState } from '@goodvibes/engine/errors';
export { DECISION_MODEL_POLICIES, DEFAULT_DECISION_MODEL_POLICY, decisionModelFailingLine, decisionModelPolicyLabel, decisionModelUse, parseDecisionModelPolicy, type DecisionModelUse } from '@goodvibes/engine/errors';

export class DecisionModelPolicyChangedError extends Error {
  constructor() {
    super('Decision-model policy changed. Start a fresh operation with the current policy.');
    this.name = 'DecisionModelPolicyChangedError';
    hostState.revocations.add(this);
  }
  static override [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && hostState.revocations.has(value);
  }
}

export type RefusedDecisionAction = string | Readonly<{ tool: string; args: Readonly<Record<string, unknown>>; directory: string | null }>;

interface RefusalIndex {
  readonly keys: Set<string>;
  readonly pending: Iterator<RefusedDecisionAction>;
  observed: number;
}
// The v1 shared host keeps its original append-only Set for mixed source/dist
// consumers. This cache dies with that operation; it retains no global history.
const refusalIndexes = new WeakMap<Set<RefusedDecisionAction>, RefusalIndex>();

/** Exact structural encoding of a captured snapshot, without a digest.
 * JSON.stringify alone merges undefined/missing, sparse arrays and -0/0.
 * Explicit types, lengths and sorted own keys preserve those distinctions.
 * The iterative walk also accepts the same deep inputs as captureOwnedJson.
 */
function refusalKey(value: RefusedDecisionAction): string {
  const parts: string[] = [];
  type Work = { readonly value: unknown } | { readonly key: string };
  const pending: Work[] = [{ value }];
  while (pending.length > 0) {
    const work = pending.pop();
    if (work === undefined) break;
    if ('key' in work) { parts.push(JSON.stringify(work.key)); continue; }
    const entry = work.value;
    if (entry === null) { parts.push('null;'); continue; }
    switch (typeof entry) {
      case 'undefined': parts.push('undefined;'); break;
      case 'boolean': parts.push(entry ? 'true;' : 'false;'); break;
      case 'number': parts.push(Object.is(entry, -0) ? '-0;' : `${entry};`); break;
      case 'string': parts.push(JSON.stringify(entry)); break;
      case 'object': {
        // Every value came from captureOwnedJson: plain frozen data only.
        const keys = Object.keys(entry).sort();
        parts.push(Array.isArray(entry) ? `array:${entry.length}:` : 'object:', `${keys.length}:`);
        const object = entry as Readonly<Record<string, unknown>>;
        for (const key of keys.reverse()) pending.push({ value: object[key] }, { key });
        break;
      }
      default: throw new Error('Decision refusal snapshot is unavailable');
    }
  }
  return parts.join('');
}

function refusalIndex(refusals: Set<RefusedDecisionAction>): RefusalIndex {
  let index = refusalIndexes.get(refusals);
  if (index === undefined) {
    index = { keys: new Set(), pending: refusals.values(), observed: 0 };
    refusalIndexes.set(refusals, index);
  }
  // Another published/source entrypoint may have appended. Never request an
  // iterator's done result: a completed Set iterator cannot see future adds.
  while (index.observed < refusals.size) {
    const next = index.pending.next();
    if (next.done) throw new Error('Decision refusal memory is unavailable');
    if (typeof next.value !== 'string') index.keys.add(refusalKey(next.value));
    index.observed++;
  }
  return index;
}

interface PolicyScope {
  readonly policy: DecisionModelPolicy;
  readonly current: () => void;
  readonly onChange: ((state: DecisionModelPolicyState) => void) | undefined;
  readonly state: {
    reason: DecisionModelPolicyState['reason'];
    revision: number;
    readonly refusals: Set<RefusedDecisionAction>;
  };
}
interface PolicyHostState {
  readonly schemaVersion: 1;
  readonly scopes: AsyncLocalStorage<PolicyScope>;
  readonly configurations: { readonly read: () => unknown; readonly isSet?: () => boolean; active: boolean }[];
  readonly revocations: WeakSet<object>;
}
// Source and published entrypoints may coexist in an embedding process. They
// must share operation ownership, configuration lifetime and refusal memory;
// installing a second observer cannot erase the first entrypoint's scope.
const hostStateKey = Symbol.for('goodvibes.engine.decision-policy.host.v1');
function sharedPolicyHostState(): PolicyHostState {
  const existing = Object.getOwnPropertyDescriptor(globalThis, hostStateKey);
  if (existing) {
    if (!('value' in existing) || (existing.value as PolicyHostState | undefined)?.schemaVersion !== 1)
      throw new Error('Decision-model policy host state is unavailable.');
    return existing.value as PolicyHostState;
  }
  const created: PolicyHostState = Object.freeze({ schemaVersion: 1,
    scopes: new AsyncLocalStorage<PolicyScope>(), configurations: [], revocations: new WeakSet<object>() });
  Object.defineProperty(globalThis, hostStateKey, { value: created });
  return created;
}
const hostState = sharedPolicyHostState();
const { scopes, configurations } = hostState;
/** The set model's current failure episode, process-wide; undefined while it answers. */
const episode: { failure: DecisionModelFailureState | undefined } = { failure: undefined };
const episodeListeners = new Set<(notice: DecisionModelEpisodeNotice) => void>();
const configured = (): unknown => configurations.findLast(source => source.active)?.read();
/** Whether the current composition has a decision model set; with no composition, nothing says otherwise. */
const configuredSet = (): boolean => configurations.findLast(source => source.active)?.isSet?.() ?? true;

/** Why a fresh operation runs without a decision model from its start, or null when it asks decision models. */
function startingReason(): NoDecisionModelReason | null {
  // Nothing to ask: every decision takes its fallback at once, with no request and no error.
  return configuredSet() ? null : 'not-set';
}

/**
 * A composition owns the default; retiring it cannot replace a newer composition.
 * `isSet` says whether a decision model is set at all; when none is, every
 * operation runs without a decision model with reason `not-set`, so nothing is asked, nothing
 * waits and nothing reports an error.
 */
export function configureDecisionModelPolicy(read: () => unknown, isSet?: () => boolean): () => void {
  const source = { read, ...(isSet === undefined ? {} : { isSet }), active: true };
  configurations.push(source);
  return () => {
    source.active = false;
    while (configurations.at(-1)?.active === false) configurations.pop();
  };
}

function observe(): DecisionModelPolicyState {
  const scope = scopes.getStore();
  scope?.current();
  const policy = scope?.policy ?? parseDecisionModelPolicy(configured());
  const reason = scope === undefined ? startingReason() : scope.state.reason;
  const failure = episode.failure;
  return Object.freeze({ policy, operation: reason === null ? 'decision' : 'no-decision-model', reason, revision: scope?.state.revision ?? 0,
    ...(failure === undefined ? {} : { failure }) });
}
/** Make the platform's observer the process one again after something else replaced it. */
export function installPlatformDecisionPolicyObserver(): void {
  installDecisionModelPolicyObserver(observe, activateClassicFallback, withConfiguredDecisionModelPolicy, takesDecisionFallback);
}

/** The decision model gave no usable answer (the judgment layer's one rule), or none is installed. */
function takesDecisionFallback(error: unknown): boolean {
  return error instanceof JudgmentPortMissingError || isDecisionModelFailure(error);
}
installPlatformDecisionPolicyObserver();

export function isClassicOperation(): boolean { return decisionModelPolicyState().operation === 'no-decision-model'; }

/** Pin one operation. Changing policy revokes it; fallback changes no host permission or completed action. */
export function withDecisionModelPolicy<T>(read: () => unknown, operation: () => T,
  onChange?: (state: DecisionModelPolicyState) => void): T {
  const parent = scopes.getStore();
  if (parent) {
    if (!onChange) return operation();
    // Nested consumers observe this operation without replacing its pinned
    // policy, refusal memory or fallback state. ALS owns callback lifetime;
    // another operation cannot retain this consumer's notice sink.
    return scopes.run({ ...parent, onChange(state) { parent.onChange?.(state); onChange(state); } }, () => {
      const state = observe();
      if (state.operation === 'no-decision-model') onChange(state);
      return operation();
    });
  }
  const readPolicy = () => parseDecisionModelPolicy(read() ?? configured());
  const policy = readPolicy();
  const current = () => { if (readPolicy() !== policy) throw new DecisionModelPolicyChangedError(); };
  return scopes.run({ policy, current, onChange, state: { reason: startingReason(), revision: 0, refusals: new Set() } }, () => {
    current();
    if (scopes.getStore()?.state.reason !== null) onChange?.(observe());
    return operation();
  });
}

/** Entry point for owned daemon/background operations that use the composition's policy source. */
export function withConfiguredDecisionModelPolicy<T>(operation: () => T, onChange?: (state: DecisionModelPolicyState) => void): T {
  return withDecisionModelPolicy(configured, operation, onChange);
}

/** Re-enter one owned operation across separate events; fallback persists and a setting change revokes it. */
export function captureDecisionModelPolicyOperation(onChange?: (state: DecisionModelPolicyState) => void): <T>(operation: () => T) => T {
  return withConfiguredDecisionModelPolicy(() => {
    const scope = scopes.getStore();
    if (!scope) throw new Error('Decision-model operation has no policy owner');
    return <T>(operation: () => T): T => scopes.run(scope, () => { scope.current(); return operation(); });
  }, onChange);
}

/**
 * A decision the decision model did not make (any judgment failure but a
 * cancellation, or no port installed) moves a Hybrid operation to its no-model
 * path; a cancellation never does, and unrelated failures are never unwrapped.
 */
export function activateClassicFallback(error: unknown): boolean {
  const scope = scopes.getStore();
  scope?.current();
  if (!scope || scope.policy !== 'Hybrid') return false;
  if (!(error instanceof JudgmentPortMissingError) && !isDecisionModelFailure(error)) return false;
  return inheritClassicDecisionFallback();
}

/** Continue an authenticated host admission's fallback after its request scope ends.
 * Callers must validate the retained admission capability first; request fields are not authority.
 */
export function inheritClassicDecisionFallback(): boolean {
  const scope = scopes.getStore();
  scope?.current();
  if (!scope || scope.policy !== 'Hybrid') return false;
  if (scope.state.reason === null) {
    scope.state.reason = 'unavailable'; scope.state.revision++;
    scope.onChange?.(observe());
  }
  return true;
}

/**
 * Re-enter only a caller's side-effect-free decision phase, never replay its executed operation.
 * A decision the model did not make takes `classic`, handed the failure, under every policy.
 */
export function decisionOrClassic<T>(decision: () => Promise<T>, classic: (failure?: unknown) => T | Promise<T>, fallbackAllowed: () => boolean = () => true): Promise<T> {
  return runDecisionOrClassic(decision, classic, fallbackAllowed);
}

/** A later outage cannot reopen the same refused action within its owning operation. Keys stay host-private. */
export function rememberDecisionRefusal(action: RefusedDecisionAction): void {
  const refusals = scopes.getStore()?.state.refusals;
  if (!refusals) return;
  if (typeof action === 'string') { refusals.add(action); return; }
  const captured = captureOwnedJson(action) as RefusedDecisionAction;
  const index = refusalIndex(refusals);
  if (index.keys.has(refusalKey(captured))) return;
  refusals.add(captured);
}
export function wasDecisionRefused(action: RefusedDecisionAction): boolean {
  const refusals = scopes.getStore()?.state.refusals;
  if (!refusals) return false;
  if (typeof action === 'string') return refusals.has(action);
  const captured = captureOwnedJson(action) as RefusedDecisionAction;
  return refusalIndex(refusals).keys.has(refusalKey(captured));
}

/** A set decision model's failure episode, told once when it starts and once when the model answers again. */
export interface DecisionModelEpisodeNotice {
  readonly kind: 'failing' | 'recovered';
  readonly level: 'error' | 'info';
  readonly model: string;
  /** The line to show: the model, what failed, the next step, and whether work continued without a decision model. */
  readonly message: string;
  readonly failure?: DecisionModelFailureState;
}


function tellEpisode(notice: DecisionModelEpisodeNotice): void {
  for (const listener of [...episodeListeners]) {
    // A listener's own failure never turns a decision or its fallback into an error.
    try { listener(notice); } catch { /* best effort */ }
  }
}

/**
 * Records a set model's failure. The first failure of an episode is told once,
 * naming the model, what failed and the next step; later failures of the same
 * episode only update the standing status, so a model that stays down does not
 * repeat itself. Called by the settings port; costs nothing while models answer.
 */
export function noteDecisionModelFailure(failure: DecisionModelFailure, policy: DecisionModelPolicy = parseDecisionModelPolicy(configured())): void {
  const known = episode.failure;
  episode.failure = Object.freeze({ model: failure.model, what: failure.what, nextStep: failure.nextStep, since: known?.since ?? Date.now() });
  if (known !== undefined) return;
  tellEpisode({ kind: 'failing', level: 'error', model: failure.model, failure: episode.failure, message: decisionModelFailingLine(episode.failure, policy) });
}

/** Records an answer; ends a failure episode with one notice. */
export function noteDecisionModelAnswered(model: string): void {
  const ended = episode.failure;
  if (ended === undefined) return;
  episode.failure = undefined;
  tellEpisode({ kind: 'recovered', level: 'info', model, message: `The decision model ${model} is answering again.` });
}

/** The set model's current failure, when it is failing; the standing status every product shows. */
export function decisionModelFailure(): DecisionModelFailureState | undefined {
  return episode.failure;
}

/** Subscribes to failure-episode notices; returns the unsubscribe. */
export function onDecisionModelEpisode(listener: (notice: DecisionModelEpisodeNotice) => void): () => void {
  episodeListeners.add(listener);
  return () => { episodeListeners.delete(listener); };
}

/** Forgets the failure episode (a composition that retires, or a proof that starts over). */
export function resetDecisionModelEpisode(): void {
  episode.failure = undefined;
}

/** Explicit capability report for genuinely decision-only features. */
export function requireDecisionFeature(feature: string): void {
  if (isClassicOperation()) throw new DecisionModelsDisabledError(feature);
}

/**
 * Ends a running decision phase once its operation has moved to no decision
 * model (a sibling call found the set model failing under Hybrid), so no
 * further request is made and `decisionOrClassic` runs the phase's no-model
 * path. Only for code inside a phase that `decisionOrClassic` runs: the error
 * is that function's signal and never reaches a user.
 */
export function endDecisionPhaseWithoutModel(phase: string): void {
  if (isClassicOperation()) throw new DecisionModelsDisabledError(phase);
}
