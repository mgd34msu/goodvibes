import { activateClassicFallback, decisionOrClassic, isClassicOperation } from '../../runtime/decision-policy.js';
import { assertSynchronousJudgmentGuard } from '@goodvibes/judgment/decisions';
import { types as nodeTypes } from 'node:util';
import { captureJudgmentPort, DecisionModelsDisabledError, JudgmentAuthorityRetiredError, JudgmentPortMissingError, type JudgmentPortCapture } from '@goodvibes/engine/errors';
import type { JudgmentPort } from '@goodvibes/judgment';
import { assertJudgmentInput, JudgmentInputError } from '../../gate/judgment-input.js';
import { prepareJudgmentResult, retainStrictJudgmentJson } from '../../gate/judgment-result.js';
import { knowledgeUriRef } from './battery.js';
import { KNOWLEDGE_URI_LIMITS as LIMITS, KnowledgeUriCanonicalizationHeldError as Held,
  type KnowledgeUriCanonicalizer, type KnowledgeUriOptions } from './types.js';
export * from './types.js';

interface UriInput {
  readonly input: string; readonly parameters: readonly (readonly [string, string])[];
  /** False when the URL cannot be shown to a decision model (credentials, unacceptable text): its ref occurrences are kept unread. */
  readonly readable: boolean;
}
interface RefInput { readonly uri: UriInput; readonly position: number; readonly value: string; }
const failure = (error: unknown): Error => {
  if (error instanceof DecisionModelsDisabledError || (activateClassicFallback(error) && error instanceof Error)) return error;
  return error instanceof Held || error instanceof JudgmentInputError ? error
    : new Held(error instanceof JudgmentPortMissingError ? 'unconfigured' : error instanceof JudgmentAuthorityRetiredError ? 'stale' : 'unavailable');
};
const admission = (reason: 'malformed' | 'stale') => new Held(reason);
function normalized(uri: UriInput, referralPositions: ReadonlySet<number>): string {
  const url = new URL(uri.input);
  url.hash = ''; url.protocol = url.protocol.toLowerCase(); url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  // A fixed locale: the order is part of a stored identity, so it cannot follow the machine's locale.
  const parameters = uri.parameters.filter(([key], position) => !/^(?:utm_|gclid$|fbclid$)/i.test(key)
    && !(key === 'ref' && referralPositions.has(position))).sort(([a], [b]) => a.localeCompare(b, 'en'));
  url.search = '';
  for (const [key, value] of parameters) url.searchParams.append(key, value);
  if (url.pathname !== '/' && url.pathname.endsWith('/')) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}
/** Only exact ref occurrences need a reading. A URL that cannot be read keeps its ref occurrences; it never stops the batch. */
function captureInputs(inputs: readonly string[]) {
  const owned = retainStrictJudgmentJson(inputs, admission), originals = owned.snapshot;
  if (!Array.isArray(originals) || !originals.every((input) => typeof input === 'string')) throw new Held('malformed');
  const uris = originals.map((input): UriInput | null => {
    let url: URL; try { url = new URL(input); } catch { return null; }
    const parameters = [...url.searchParams.entries()];
    // A URI without ref has only the original mechanical contract and makes no outward request.
    if (!parameters.some(([key]) => key === 'ref')) return { input, parameters, readable: false };
    if (url.username || url.password) return { input, parameters, readable: false };
    const fields: Record<string, string[]> = Object.create(null);
    for (const [key, value] of parameters) (fields[key] ??= []).push(value);
    let decoded = input; try { decoded = decodeURIComponent(input); } catch { /* URL parsing retains malformed escape spelling. */ }
    try { assertJudgmentInput({ uri: input, decodedUri: decoded, query: fields }); }
    catch (error) { if (error instanceof JudgmentInputError) return { input, parameters, readable: false }; throw error; }
    return { input, parameters, readable: true };
  });
  owned.assertCurrent(); return { uris, assertCurrent: owned.assertCurrent };
}
/** One actual operation owns the settled URI cache, source/caller restriction and installed judgment lifetime. */
export function createKnowledgeUriCanonicalizer(options: KnowledgeUriOptions = {}): KnowledgeUriCanonicalizer {
  if (nodeTypes.isProxy(options)) throw new Held('malformed');
  const prototype = Object.getPrototypeOf(options), descriptors = Object.getOwnPropertyDescriptors(options);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(options).length
    || Object.values(descriptors).some((descriptor) => !('value' in descriptor))) throw new Held('malformed');
  const { signal, assertCurrent: ownerCurrent, timeoutMs: configuredTimeout } = options;
  if ((signal !== undefined && !(signal instanceof AbortSignal)) || (ownerCurrent !== undefined
    && (typeof ownerCurrent !== 'function' || nodeTypes.isProxy(ownerCurrent) || nodeTypes.isAsyncFunction(ownerCurrent)))) throw new Held('malformed');
  const timeoutMs = configuredTimeout ?? LIMITS.defaultTimeoutMs;
  // Infinity is the only "no bound"; a finite value must fit a timer.
  if (!(timeoutMs === Infinity || (Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= LIMITS.timeoutMs))) throw new Held('malformed');
  let authority: JudgmentPortCapture | undefined, resultModel: string | undefined, failed: Error | undefined;
  let classic = isClassicOperation();
  let requests = 0, queue: Promise<unknown> = Promise.resolve();
  const cache = new Map<string, string>(), retained: (() => void)[] = [];
  const assertOptions = () => {
    if (signal?.aborted) throw new Held('aborted');
    if (Object.getPrototypeOf(options) !== prototype) throw new Held('stale');
    for (const key of ['signal', 'assertCurrent', 'timeoutMs']) {
      const current = Object.getOwnPropertyDescriptor(options, key), original = descriptors[key];
      if ((original === undefined) !== (current === undefined) || current?.get || current?.set || current?.value !== original?.value
        || current?.enumerable !== original?.enumerable || current?.configurable !== original?.configurable || current?.writable !== original?.writable) throw new Held('stale');
    }
  };
  const assertOwnerCurrent = () => {
    assertOptions();
    try { assertSynchronousJudgmentGuard(ownerCurrent, () => new Held('stale')); }
    catch (error) { throw error instanceof Held ? error : new Held('stale'); }
    assertOptions();
    for (const check of retained) check();
  };
  const assertCurrent = () => {
    if (failed) throw failed;
    try {
      assertOwnerCurrent();
      if (isClassicOperation()) classic = true;
      if (!classic) authority?.assertCurrent();
    }
    catch (error) { failed ??= failure(error); throw failed; }
  };
  async function run(batch: ReturnType<typeof captureInputs>): Promise<readonly (string | null)[]> {
    batch.assertCurrent(); assertCurrent();
    const pending = [...new Map(batch.uris.filter((uri): uri is UriInput => uri !== null && !cache.has(uri.input)).map((uri) => [uri.input, uri])).values()];
    // Each distinct URL is read once per operation (the cache keeps its result);
    // occurrences past the request cap are kept unread.
    const refs: RefInput[] = pending.flatMap((uri) => uri.readable
      ? uri.parameters.flatMap(([key, value], position) => key === 'ref' ? [{ uri, position, value }] : []) : [])
      .slice(0, Math.max(0, LIMITS.requests - requests));
    const removals = new Map<string, Set<number>>();
    if (refs.length) await decisionOrClassic(async () => {
      try {
        authority ??= captureJudgmentPort(knowledgeUriRef.name, { signal, assertCurrent: assertOwnerCurrent,
          prepareResultCapture: (questions) => prepareJudgmentResult(questions, admission) });
      } catch (error) {
        // No reader installed: every ref occurrence is kept, as with no decision model at all.
        if (error instanceof JudgmentPortMissingError && !activateClassicFallback(error)) return;
        throw error;
      }
      const captured = authority.port, configuredModel = captured.model;
      if (typeof configuredModel !== 'string' || !configuredModel.trim()) return;
      requests += refs.length;
      // The batch timer ends the readings, not the operation: what is unread is kept.
      const controller = new AbortController(), active = AbortSignal.any([controller.signal, authority.signal, ...(signal ? [signal] : [])]);
      let stoppedError: Error | undefined, closed = false, rejectStopped: (error: Error) => void = () => {}, resolveExpired: () => void = () => {};
      const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
      const expired = new Promise<void>((resolve) => { resolveExpired = resolve; });
      const stop = (error: Error) => { stoppedError ??= error; closed = true; controller.abort(); rejectStopped(stoppedError); };
      const abort = () => { if (!closed) stop(new Held(signal?.aborted ? 'aborted' : 'stale')); };
      authority.signal.addEventListener('abort', abort, { once: true });
      signal?.addEventListener('abort', abort, { once: true });
      const timer = Number.isFinite(timeoutMs) ? setTimeout(() => { closed = true; controller.abort(); resolveExpired(); }, timeoutMs) : undefined;
      const check = () => { if (stoppedError) throw stoppedError; batch.assertCurrent(); assertCurrent(); };
      const port: JudgmentPort = { model: configuredModel, ...(captured.recorder ? { recorder: captured.recorder } : {}), async ask(request) {
        check(); const result = await captured.ask({ ...request, model: configuredModel }); check();
        if (typeof result.model !== 'string' || !result.model.trim() || typeof result.requestedModel !== 'string' || !result.requestedModel.trim()) throw new Held('malformed');
        if (result.requestedModel !== configuredModel || (resultModel !== undefined && result.model !== resultModel)) throw new Held('stale');
        resultModel = result.model; return result;
      } };
      let next = 0;
      const readOne = async (ref: RefInput) => {
        const state = { url: ref.uri.input, parameters: ref.uri.parameters.map(([key, entry]) => ({ key, value: entry })),
          target: { position: ref.position, key: 'ref', value: ref.value } };
        try {
          const result = await knowledgeUriRef.run(port, state, { signal: active, site: knowledgeUriRef.name });
          if (closed) return;
          const reading = result.readings.referral;
          const referral = reading.outcome === 'act' && reading.verdict === 'yes';
          if (referral) { const positions = removals.get(ref.uri.input) ?? new Set<number>(); positions.add(ref.position); removals.set(ref.uri.input, positions); }
          result.recordAction(referral ? 'referral occurrence omitted from URI identity; no fetch or write permission'
            : reading.outcome === 'act' && reading.verdict === 'no' ? 'page-address ref occurrence retained in URI identity; no fetch or write permission'
              : 'ref occurrence retained in URI identity because its role did not settle; no fetch or write permission');
        } catch (error) {
          // The operation's own state decides whether to stop; a reading that
          // failed or did not settle only keeps this one occurrence.
          if (closed) return;
          check();
          if (error instanceof DecisionModelsDisabledError || activateClassicFallback(error)) throw error;
        }
      };
      const work = async () => {
        await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, refs.length) }, async () => {
          while (!closed && next < refs.length) {
            try { check(); await readOne(refs[next++]!); } catch (error) { const held = failure(error); stop(held); throw held; }
          }
        }));
      };
      try { await Promise.race([work(), stopped, expired]); closed = true; check(); }
      finally {
        closed = true; clearTimeout(timer);
        authority.signal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort); controller.abort();
      }
    }, () => {
      classic = true;
      batch.assertCurrent(); assertCurrent();
      // Keep unresolved ref occurrences. Known page-address refs remain intact;
      // an outage never authorizes stripping a parameter or merging identities.
    });
    batch.assertCurrent(); assertCurrent();
    const settled = pending.map((uri) => [uri.input, normalized(uri, removals.get(uri.input) ?? new Set<number>())] as const);
    batch.assertCurrent(); assertCurrent();
    for (const [input, result] of settled) cache.set(input, result);
    retained.push(batch.assertCurrent);
    return Object.freeze(batch.uris.map((uri) => uri === null ? null : cache.get(uri.input)!));
  }
  const canonicalizeAll = async (inputs: readonly string[]) => {
    let batch: ReturnType<typeof captureInputs>;
    try { batch = captureInputs(inputs); assertCurrent(); }
    catch (error) { failed ??= failure(error); throw failed; }
    const result = queue.then(() => run(batch)).catch((error: unknown) => { failed ??= failure(error); throw failed; });
    queue = result.catch(() => {}); return result;
  };
  assertCurrent();
  return Object.freeze({ assertCurrent, canonicalizeAll, async canonicalize(input: string) { return (await canonicalizeAll([input]))[0] ?? null; } });
}
