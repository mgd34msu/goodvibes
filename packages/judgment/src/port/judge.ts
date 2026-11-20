import { contextFor, sharedContextFor } from '../batteries/asking.ts';
import { readItem, type Battery, type BatteryItems, type BatteryRun, type PartialBatteryRun } from '../batteries/battery.ts';
import { DEFAULT_DECISION_DEADLINE_MS } from './deadline.ts';
import { JudgmentError } from './errors.ts';
import { toJson, type EntryType, type JudgmentConclusion, type JudgmentPort, type JudgmentResult, type Questions } from './types.ts';

/** The banded readings of a battery's questions, as `settle` receives them. */
export type BandedReadings<Items extends BatteryItems> = BatteryRun<Items>['readings'];

/** The readings of a call that asked only some questions: an unasked question has none. */
export type PartialBandedReadings<Items extends BatteryItems> = PartialBatteryRun<Items>['readings'];

/**
 * Why a decision took its fallback:
 * - `deadline`: no answer arrived within the deadline;
 * - `unsure`: the model answered and `settle` could not act on the readings;
 * - `unavailable`: no model could answer (none installed, every target skipped, an error);
 * - `off`: decision models are switched off for this operation.
 */
export type JudgeFallbackReason = 'deadline' | 'unsure' | 'unavailable' | 'off';

/** How long a settled answer is reused: one turn, one session, or the life of the process. */
export type JudgeCacheScope = 'turn' | 'session' | 'process';

type CachedJudgment =
  | { readonly settled: true; readonly value: unknown; readonly decisionId: string | undefined }
  | { readonly settled: false; readonly decisionId: string | undefined };

/**
 * Settled answers for one turn or one session. The owner of the turn or
 * session creates one and drops it when the turn or session ends; the
 * process scope has one per port, held here.
 */
export interface JudgeCache {
  readonly size: number;
  get(key: string): CachedJudgment | undefined;
  set(key: string, entry: CachedJudgment): void;
  clear(): void;
}

const DEFAULT_CACHE_ENTRIES = 512;

/** A bounded cache; the least recently used answer leaves first. */
export function createJudgeCache(options: { readonly maxEntries?: number } = {}): JudgeCache {
  const maxEntries = options.maxEntries ?? DEFAULT_CACHE_ENTRIES;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('a judgment cache holds at least one entry');
  const entries = new Map<string, CachedJudgment>();
  return {
    get size() { return entries.size; },
    get(key) {
      const entry = entries.get(key);
      if (entry !== undefined) { entries.delete(key); entries.set(key, entry); }
      return entry;
    },
    set(key, entry) {
      entries.delete(key);
      entries.set(key, entry);
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
    },
    clear() { entries.clear(); },
  };
}

let processCaches = new WeakMap<JudgmentPort, JudgeCache>();

function processCache(port: JudgmentPort): JudgeCache {
  let cache = processCaches.get(port);
  if (cache === undefined) { cache = createJudgeCache(); processCaches.set(port, cache); }
  return cache;
}

/** Forgets every process-scope answer (a test reset, or a change that makes every stored answer wrong). */
export function forgetProcessJudgments(): void {
  processCaches = new WeakMap();
}

/**
 * Where a settled answer is kept. `key` names the question's input: include
 * every owner revision the answer depends on, so a changed fact misses the cache.
 */
export type JudgeCacheOption =
  | { readonly key: string; readonly scope: 'process' }
  | { readonly key: string; readonly scope: 'turn' | 'session'; readonly store: JudgeCache };

export interface JudgeOptions<Items extends BatteryItems, R> {
  /** The port to ask; undefined when no decision model is installed (the fallback applies at once). */
  readonly port: JudgmentPort | undefined;
  /** True when decision models are off for this operation (the fallback applies at once). */
  readonly off?: boolean;
  /** The decision site, recorded in the decision log and part of the cache key. */
  readonly site: string;
  readonly battery: Battery<Items>;
  readonly state: EntryType;
  /** Total time allowed; defaults to the port's decision deadline, then 1500 ms. */
  readonly deadlineMs?: number;
  readonly cache?: JudgeCacheOption;
  /** Turns the readings into a value; undefined means unsure, and the fallback applies. */
  settle(readings: BandedReadings<Items>): R | undefined;
  /** The value when the model is not asked, does not answer in time, or is unsure. Never throws for a known reason. */
  fallback(why: JudgeFallbackReason): R;
  /** Names the settled value in the decision log; defaults to "settled". */
  readonly describe?: (value: R) => string;
  /** Whether the caller still wants the answer. Aborting it rejects; it never selects the fallback. */
  readonly signal?: AbortSignal;
}

/** A judgment that asks only `only`; `settle` must handle a question without a reading. */
export interface JudgeSomeOptions<Items extends BatteryItems, R> extends Omit<JudgeOptions<Items, R>, 'settle'> {
  /** Ask only these questions of the battery. */
  readonly only: readonly (keyof Items & string)[];
  /** Turns the readings into a value; undefined means unsure, and the fallback applies. */
  settle(readings: PartialBandedReadings<Items>): R | undefined;
}

export interface JudgeOutcome<R> {
  readonly value: R;
  readonly source: 'model' | 'cache' | 'fallback';
  /** Set when the fallback decided. */
  readonly why?: JudgeFallbackReason;
  /** What went wrong, when the fallback applied because of an error. */
  readonly detail?: string;
  /** The decision log entry the value was read from. */
  readonly decisionId?: string;
  /** True when a request went to the decision model (an answer, an unsure answer, a missed deadline or a failed request). */
  readonly requested?: boolean;
}

const UNIT_SEPARATOR = '\u001f';

/** The decision a cached answer belongs to: site, battery and version, the port's model and revision, the questions, the caller's key. */
function cacheKey(site: string, battery: Battery<BatteryItems>, port: JudgmentPort, model: string, asked: readonly string[], key: string): string {
  return [site, battery.name, String(battery.version), model, String(port.revision?.() ?? 0), asked.join(','), key].join(UNIT_SEPARATOR);
}

/** Settles with the work, or rejects with the signal's reason as soon as it aborts, even when the port ignores the signal. */
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop = (): void => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
  // A late settlement after the race is decided is observed, never surfaced.
  void work.catch(() => {});
  try { return await Promise.race([work, stopped]); }
  finally { signal.removeEventListener('abort', stop); }
}

function failureDetail(error: unknown): string {
  if (error instanceof JudgmentError) return `${error.kind}: ${error.message}`;
  return error instanceof Error ? error.message : 'the decision request failed';
}

/** A host's "decision models are off" error, recognised by its stable code. */
function isDecisionModelsOff(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { readonly code?: unknown }).code === 'decision-models-disabled';
}

/** Every configured target is being skipped (missed deadlines or a rate limit). */
function everyTargetCooling(port: JudgmentPort): boolean {
  const health = port.health?.();
  return health !== undefined && health.length > 0 && health.every(target => (target.cooldownRemainingMs ?? 0) > 0);
}

/**
 * The one judgment request. Asks one battery about one state, with a
 * deadline, an optional cache and a fallback, so a decision never halts the
 * work that waits on it:
 * - policy off, no port, or every target skipped: the fallback, at once, no request;
 * - a cache hit: the stored answer, no request;
 * - otherwise one request bounded by the deadline; the answer, its readings and
 *   the action are written to the decision log once, when it completes.
 */
export function judge<const Items extends BatteryItems, R>(o: JudgeOptions<Items, R>): Promise<JudgeOutcome<R>> {
  return judgeAsked(o, Object.keys(o.battery.items));
}

/** `judge` asking only the named questions; `settle` receives readings for those alone. */
export function judgeSome<const Items extends BatteryItems, R>(o: JudgeSomeOptions<Items, R>): Promise<JudgeOutcome<R>> {
  return judgeAsked(o, o.only);
}

async function judgeAsked<Items extends BatteryItems, R>(o: Omit<JudgeOptions<Items, R>, 'settle'> & { settle(readings: PartialBandedReadings<Items>): R | undefined },
  asked: readonly string[]): Promise<JudgeOutcome<R>> {
  const fallback = (why: JudgeFallbackReason, detail?: string, decisionId?: string, requested = false): JudgeOutcome<R> => ({
    value: o.fallback(why), source: 'fallback', why,
    ...(detail === undefined ? {} : { detail }),
    ...(decisionId === undefined ? {} : { decisionId }),
    ...(requested ? { requested } : {}),
  });
  if (o.signal?.aborted) throw new JudgmentError('aborted', 'the judgment call was cancelled');
  if (o.off) return fallback('off');
  const port = o.port;
  if (port === undefined) return fallback('unavailable', 'no decision model is installed');

  const battery = o.battery as unknown as Battery<BatteryItems>;
  const model = battery.model ?? port.model;
  const cache = o.cache === undefined ? undefined : o.cache.scope === 'process' ? processCache(port) : o.cache.store;
  const key = o.cache === undefined ? undefined : cacheKey(o.site, battery, port, model, asked, o.cache.key);
  const hit = key === undefined ? undefined : cache?.get(key);
  if (hit !== undefined) {
    if (!hit.settled) return fallback('unsure', undefined, hit.decisionId);
    return { value: hit.value as R, source: 'cache', ...(hit.decisionId === undefined ? {} : { decisionId: hit.decisionId }) };
  }
  if (everyTargetCooling(port)) return fallback('unavailable', 'every decision target is being skipped for now');

  const questions: Questions = Object.fromEntries(asked.map((name) => {
    const item = battery.items[name];
    if (item === undefined) throw new RangeError(`battery ${battery.name}: no question "${name}"`);
    return [name, item.question];
  }));
  const readAll = (answers: Readonly<Record<string, unknown>>): PartialBandedReadings<Items> =>
    Object.fromEntries(asked.map(name => [name, readItem(battery.items[name]!, answers[name])])) as PartialBandedReadings<Items>;
  const action = (value: R | undefined): string => value === undefined ? 'unsure' : o.describe?.(value) ?? 'settled';

  let concluded: { readonly value: R | undefined } | undefined;
  let settleFailure: { readonly error: unknown } | undefined;
  const conclude = (result: JudgmentResult<Questions>): JudgmentConclusion => {
    try {
      const readings = readAll(result.answers);
      const value = o.settle(readings);
      concluded = { value };
      return { readings: toJson(readings), action: action(value) };
    } catch (error) {
      settleFailure = { error };
      throw error;
    }
  };

  const deadlineMs = o.deadlineMs ?? port.decisionDeadlineMs ?? DEFAULT_DECISION_DEADLINE_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException('The decision deadline passed.', 'TimeoutError')), deadlineMs);
  const signal = o.signal === undefined ? deadline.signal : AbortSignal.any([o.signal, deadline.signal]);
  let result: JudgmentResult<Questions>;
  try {
    result = await untilAborted(port.ask({
      state: o.state, questions, signal, deadlineMs, conclude,
      ...sharedContextFor(battery, Object.keys(questions)),
      ...(battery.model === undefined ? {} : { model: battery.model }),
      context: contextFor(battery, 'battery', { site: o.site }),
    }), signal);
  } catch (error) {
    if (settleFailure !== undefined) throw settleFailure.error;
    if (o.signal?.aborted) throw error;
    if (deadline.signal.aborted) return fallback('deadline', `no answer within ${deadlineMs} ms`, undefined, true);
    if (isDecisionModelsOff(error)) return fallback('off');
    return fallback('unavailable', failureDetail(error), undefined, true);
  } finally {
    clearTimeout(timer);
  }

  const decisionId = result.decisionId;
  if (concluded === undefined) {
    // A port without a decision log does not call conclude.
    const readings = readAll(result.answers);
    const value = o.settle(readings);
    concluded = { value };
    if (decisionId !== undefined && port.recorder) {
      port.recorder.recordReadings(decisionId, toJson(readings));
      port.recorder.recordAction(decisionId, action(value));
    }
  }
  const value = concluded.value;
  if (key !== undefined) cache?.set(key, value === undefined ? { settled: false, decisionId } : { settled: true, value, decisionId });
  if (value === undefined) return fallback('unsure', undefined, decisionId, true);
  return { value, source: 'model', requested: true, ...(decisionId === undefined ? {} : { decisionId }) };
}
