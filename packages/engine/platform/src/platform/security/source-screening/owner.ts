import { assertScreeningOperation, captureScreeningOperation as captureOperation } from './operation.js';
import { createClassicProtectedSourceOwner, classicScreeningParts } from './classic-owner.js';
import { activateClassicFallback, isClassicOperation, withConfiguredDecisionModelPolicy } from '../../runtime/decision-policy.js';
import { DecisionModelsDisabledError, decisionModelPolicyState } from '@goodvibes-jev/engine/errors';
import { createSystemOnePort, DEFAULT_MODEL, JudgmentError, type JudgmentRetryProgress } from '@goodvibes-jev/judgment';
import { types as nodeTypes } from 'node:util';
import { JudgmentInputError } from '../../gate/judgment-input.js';
import { captureScreeningSource, isMalformedScreeningProposal, proposeScreeningSpans, type ScreeningSource, type ScreeningSpan } from './proposal.js';
import { captureHostedScreeningCredentials, captureLoopbackEndpoint, createScreeningTransport, proxyConfigured } from './transport.js';
import { verifyScreeningSpans } from './verification.js';
import { captureResearchReference, createResearchReferenceReader, WITHHELD_RESEARCH_REFERENCE, type CapturedResearchReference } from './reference.js';
import { SOURCE_SCREENING_LIMITS as LIMITS, type ProtectedSource, type ProtectedSourceOwner, type ProtectedSourceOwnerOptions,
  type HostedProtectedSourceOwnerOptions,
  type SourceScreeningReceipt, type SourceScreeningResult, type ProtectedResearchReference,
  type ResearchReferenceScreeningReceipt, type ResearchReferenceScreeningResult, type ResearchReferenceOperation } from './types.js';

type Handle = ProtectedSource | ProtectedResearchReference;
type Receipt = SourceScreeningReceipt | ResearchReferenceScreeningReceipt;
type Result = { readonly status: 'settled'; readonly receipt: Receipt } | Extract<SourceScreeningResult, { status: 'held' }>;

interface OwnedSource {
  readonly source: ScreeningSource;
  readonly reference?: CapturedResearchReference;
  readonly lifetime: AbortController;
  released: boolean;
  /** The text could not be taken for screening at all (it holds protected input). */
  refused?: 'protected-input';
  pending?: Promise<Result>;
  pendingOperation?: ResearchReferenceOperation | undefined;
  result?: Result;
}
interface OwnedProjection { readonly source: OwnedSource; readonly parts: readonly string[]; }
/** Cheap pending-work bucket, retaining no source text beyond its live owner. */
function pendingSourceBucket(source: OwnedSource): string {
  return JSON.stringify([source.reference !== undefined, source.source.parts.map(part => part.length)]);
}
function samePendingSource(left: OwnedSource, right: OwnedSource): boolean {
  return (left.reference !== undefined) === (right.reference !== undefined)
    && left.source.parts.length === right.source.parts.length
    && left.source.parts.every((part, index) => part === right.source.parts[index]);
}
const held = (reason: Extract<SourceScreeningResult, { status: 'held' }>['reason']): Extract<SourceScreeningResult, { status: 'held' }> => Object.freeze({ status: 'held', reason });
const invalid = (): never => { throw new Error('Protected source owner is unavailable or the handle is not current'); };
const apply = Reflect.apply;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
function reference(value: unknown): value is string { return typeof value === 'string' && /^[\x21-\x7e]{1,128}$/.test(value); }
function dataFields(value: unknown, allowed: readonly string[]): Record<string, PropertyDescriptor> {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.includes(key))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor))) return invalid();
  return descriptors;
}
function hostedOptions(value: ProtectedSourceOwnerOptions): value is HostedProtectedSourceOwnerOptions {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) return invalid();
  const kind = Object.getOwnPropertyDescriptor(value, 'kind');
  if (!kind) return false;
  if (!('value' in kind) || kind.value !== 'hosted') return invalid();
  const options = dataFields(value, ['kind', 'authority', 'credentials', 'timeoutMs', 'onRetry']);
  const authority = dataFields(options.authority?.value, ['kind', 'ownerId', 'revision', 'retention', 'signal', 'assertCurrent']);
  if (authority.kind?.value !== 'hosted' || authority.retention?.value !== 'provider-managed-zero-retention-unverified'
    || !reference(authority.ownerId?.value) || !reference(authority.revision?.value)
    || nodeTypes.isProxy(authority.signal?.value) || !(authority.signal?.value instanceof AbortSignal)
    || typeof authority.assertCurrent?.value !== 'function' || nodeTypes.isProxy(authority.assertCurrent.value)
    || (options.timeoutMs && typeof options.timeoutMs.value !== 'number')
    || (options.onRetry && (typeof options.onRetry.value !== 'function' || nodeTypes.isProxy(options.onRetry.value)))) return invalid();
  captureHostedScreeningCredentials(options.credentials?.value);
  return true;
}
function project(source: ScreeningSource, spans: readonly ScreeningSpan[]): readonly string[] {
  return Object.freeze(source.parts.map((text, part) => {
    let result = '', position = 0;
    for (const span of spans.filter(span => span.part === part)) {
      result += text.slice(position, span.start) + '[redacted]'; position = span.end;
    }
    return result + text.slice(position);
  }));
}

/**
 * Explicit trusted-host composition only. Local and hosted retention grants are
 * distinct. No settings/env route discovery, persistent source, or raw log.
 */
export function createProtectedSourceOwner(options: ProtectedSourceOwnerOptions): ProtectedSourceOwner {
  if (isClassicOperation()) return createClassicProtectedSourceOwner(options.authority);
  const isHosted = hostedOptions(options);
  const { authority } = options;
  const ownerId = authority.ownerId, authorityRevision = authority.revision;
  const parentSignal = authority.signal, assertAuthority = authority.assertCurrent;
  if (!reference(ownerId) || !reference(authorityRevision)
    || authority.retention !== (isHosted ? 'provider-managed-zero-retention-unverified' : 'ephemeral-no-log')
    || typeof assertAuthority !== 'function' || !(parentSignal instanceof AbortSignal)) return invalid();
  const credentials = isHosted ? captureHostedScreeningCredentials(options.credentials) : undefined;
  const credentialLiterals = credentials ? Object.freeze([credentials.abacusApiKey, credentials.typesafeApiKey]) : [];
  const proposal = Object.freeze(isHosted ? { endpoint: 'https://routellm.abacus.ai', model: 'route-llm' }
    : { endpoint: captureLoopbackEndpoint(options.proposal.endpoint), model: options.proposal.model });
  const judgment = Object.freeze(isHosted ? { endpoint: 'https://api.typesafe.ai', model: 'jev-latest' }
    : { endpoint: captureLoopbackEndpoint(options.judgment.endpoint), model: options.judgment.model ?? DEFAULT_MODEL });
  if (!reference(proposal.model) || !reference(judgment.model)) return invalid();
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647
    || (options.onRetry !== undefined && typeof options.onRetry !== 'function')) return invalid();
  const lifetime = new AbortController();
  const signal = AbortSignal.any([parentSignal, lifetime.signal]);
  const sources = new Map<Handle, OwnedSource>();
  const projections = new Map<Receipt, OwnedProjection>();
  const referenceReader = createResearchReferenceReader(credentialLiterals);
  // A live handle whose text could not be settled answers the same for any
  // live capture of the same text, so a retry cannot buy a lucky reading.
  // Callers set an unsettled message aside instead of offering it again, so
  // nothing is pinned after release.
  const unsettled = new Set<OwnedSource>();
  // Only already-owned pending sources, removed when their original work ends.
  // Kind/part lengths avoid full-text comparisons across unrelated requests.
  const screening = new Map<string, Set<OwnedSource>>();
  const wasUnsettled = (source: OwnedSource): boolean => {
    for (const original of unsettled) if (samePendingSource(original, source)) return true;
    return false;
  };
  // New uncertainty about a text also retires every live capture of the same
  // text, so an earlier positive receipt cannot outlive it.
  const markUnsettled = (source: OwnedSource): void => {
    unsettled.add(source);
    for (const other of sources.values()) if (other !== source && !other.released && samePendingSource(other, source)) unsettled.add(other);
  };
  const work = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  // The process environment is one fact: a proxy variable set when the owner
  // is created withholds private screening for its whole life, with no request.
  const proxied = proxyConfigured();
  const active = () => {
    if (signal.aborted) return invalid();
    let result: unknown;
    try { result = assertAuthority(); } catch { return invalid(); }
    if (result !== undefined) {
      // Refuse async authority without exposing an unhandled rejection or
      // inspecting hostile thenable/error properties.
      if (nodeTypes.isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
      return invalid();
    }
    if (signal.aborted) return invalid();
  };
  active();
  // One connection pool for the owner's life: one client per fixed origin, not
  // one per source. Each run gets its own fences and failure flags.
  const transport = proxied ? undefined : createScreeningTransport({ ...(credentials ? { kind: 'hosted', credentials } : {
    endpoints: [`${proposal.endpoint}/v1/chat/completions`, `${judgment.endpoint}/v1/systemone`] }),
    signal, assertCurrent: active, timeoutMs });
  const retry = options.onRetry;
  const onRetry = retry ? (progress: JudgmentRetryProgress) => {
    active();
    // Canonical retry owns any returned observer promise and rechecks authority
    // before the next attempt. Do not discard rejected asynchronous observers.
    return retry(Object.freeze({ ...progress }));
  } : undefined;
  const own = <T>(pending: Promise<T>): Promise<T> => {
    work.add(pending); void pending.then(() => work.delete(pending), () => work.delete(pending)); return pending;
  };
  const current = (source: OwnedSource) => { active(); if (source.released || source.lifetime.signal.aborted) return invalid(); };
  const operationCurrent = (source: OwnedSource, operation?: ResearchReferenceOperation) => {
    current(source);
    assertScreeningOperation(operation);
    current(source);
  };
  const run = async (source: OwnedSource, operation?: ResearchReferenceOperation): Promise<Result> => {
    const requestSignal = AbortSignal.any([signal, source.lifetime.signal, ...(operation?.signal ? [operation.signal] : [])]);
    const policy = decisionModelPolicyState();
    let policySelectedClassic = false;
    const assertCurrent = () => {
      operationCurrent(source, operation);
      const now = decisionModelPolicyState();
      if (now.policy === policy.policy && now.operation === 'classic' && policy.operation === 'decision') {
        policySelectedClassic = true; throw new DecisionModelsDisabledError('private source screening');
      }
      if (now.policy !== policy.policy || now.operation !== policy.operation || now.revision !== policy.revision) return invalid();
    };
    const classicResult = (): Result => {
      operationCurrent(source, operation);
      if (wasUnsettled(source)) return held('unsettled');
      const parts = classicScreeningParts(source.source, source.reference);
      operationCurrent(source, operation);
      const receipt = Object.freeze({ provenance: 'classic' }) as Receipt;
      projections.set(receipt, { source, parts });
      return source.result = Object.freeze({ status: 'settled', receipt });
    };
    let route: ReturnType<NonNullable<typeof transport>['run']> | undefined;
    try {
      assertCurrent();
      if (isClassicOperation()) return classicResult();
      if (!transport) return held('proxy-configured');
      const ownedRoute = route = transport.run({ signal: requestSignal, assertCurrent });
      const assertRoute = () => { assertCurrent(); ownedRoute.assertUsable(); };
      const port = createSystemOnePort({ endpoint: { kind: isHosted ? 'hosted' : 'local', baseURL: judgment.endpoint,
        apiKey: credentials?.typesafeApiKey ?? 'source-screening-local' },
        model: judgment.model, timeoutMs, retry: {}, fetch: ownedRoute.fetch });
      let parts: readonly string[];
      if (source.reference) {
        const result = await referenceReader.read(source.reference, { port, signal: requestSignal, assertCurrent: assertRoute, onRetry });
        if (result.status === 'held') {
          if (result.reason === 'unsettled') markUnsettled(source);
          return result.reason === 'unsettled' ? source.result = held(result.reason) : held(result.reason);
        }
        parts = Object.freeze([result.value]);
      } else {
        const spans = await proposeScreeningSpans(source.source, { ...proposal, fetch: ownedRoute.fetch, signal: requestSignal, assertCurrent });
        const settled = await verifyScreeningSpans(source.source, spans, { port, signal: requestSignal, assertCurrent: assertRoute, onRetry });
        if (!settled) { markUnsettled(source); return source.result = held('unsettled'); }
        parts = project(source.source, spans);
      }
      assertCurrent();
      if (wasUnsettled(source)) return held('unsettled');
      const receipt = Object.freeze({}) as Receipt;
      projections.set(receipt, { source, parts });
      return source.result = Object.freeze({ status: 'settled', receipt });
    } catch (error) {
      if (requestSignal.aborted) return held('cancelled');
      try { operationCurrent(source, operation); decisionModelPolicyState(); } catch { return held('stale'); }
      if (isMalformedScreeningProposal(error)) return held('malformed');
      let protectedInput = false;
      try { protectedInput = error instanceof JudgmentInputError; } catch { /* Do not inspect hostile rejections. */ }
      if (protectedInput) return held('protected-input');
      if (error instanceof JudgmentError && error.kind === 'invalid-response') return held('malformed');
      const unavailable = error instanceof JudgmentError && error.kind === 'unavailable'
        && (error.status !== undefined && (error.status === 408 || error.status === 429 || error.status >= 500)
          || route?.availabilityFailed() === true);
      if (!wasUnsettled(source) && (policySelectedClassic && isClassicOperation() || unavailable && activateClassicFallback(error))) {
        try { return classicResult(); } catch (failure) { return held(failure instanceof JudgmentInputError ? 'protected-input' : 'stale'); }
      }
      return held('route-unavailable');
    }
  };
  const screen = (source: OwnedSource, operation?: ResearchReferenceOperation): Promise<Result> => {
    try { operationCurrent(source, operation); } catch { return Promise.resolve(held(signal.aborted || (operation?.signal && apply(signalAborted, operation.signal, [])) ? 'cancelled' : 'stale')); }
    if (source.refused) return Promise.resolve(held(source.refused));
    if (proxied && !isClassicOperation()) return Promise.resolve(held('proxy-configured'));
    if (source.pending) return operation || source.pendingOperation ? Promise.resolve(held('busy')) : source.pending;
    if (wasUnsettled(source)) return Promise.resolve(held('unsettled'));
    if (source.result) return Promise.resolve(source.result);
    const bucketKey = pendingSourceBucket(source), bucket = screening.get(bucketKey);
    if (bucket) for (const pending of bucket) {
      if (samePendingSource(pending, source)) return Promise.resolve(held('busy'));
    }
    const pendingSources = bucket ?? new Set<OwnedSource>();
    pendingSources.add(source); screening.set(bucketKey, pendingSources);
    const pending = own(Promise.resolve().then(() => withConfiguredDecisionModelPolicy(() => run(source, operation))));
    source.pending = pending;
    source.pendingOperation = operation;
    const finished = () => {
      pendingSources.delete(source);
      if (pendingSources.size === 0 && screening.get(bucketKey) === pendingSources) screening.delete(bucketKey);
      if (source.pending === pending) { delete source.pending; delete source.pendingOperation; }
    };
    void pending.then(finished, finished);
    return pending;
  };
  return {
    capture(parts) {
      active();
      // Text holding protected input is still a handle: screening it answers
      // held('protected-input') with no request, so callers have one path.
      let source: ScreeningSource, refused: 'protected-input' | undefined;
      try { source = captureScreeningSource(parts, credentialLiterals); }
      catch (error) {
        if (!(error instanceof JudgmentInputError)) throw error;
        source = Object.freeze({ revision: 'protected-input', parts: Object.freeze([]) }); refused = 'protected-input';
      }
      active();
      if (sources.size >= LIMITS.sources) return invalid();
      const handle = Object.freeze({}) as ProtectedSource;
      sources.set(handle, { source, lifetime: new AbortController(), released: false, ...(refused ? { refused } : {}) }); return handle;
    },
    captureResearchReference(value) {
      active();
      // Capture the complete actual original before parsing or bounds checks.
      const captured = captureScreeningSource([value], credentialLiterals);
      const reference = captureResearchReference(captured.parts[0]!, credentialLiterals);
      active();
      if (sources.size >= LIMITS.sources) return invalid();
      // Equal text in display-preview mode cannot borrow reference authority.
      const source = Object.freeze({ ...captured, revision: `reference:${captured.revision}` });
      const handle = Object.freeze({}) as ProtectedResearchReference;
      sources.set(handle, { source, reference, lifetime: new AbortController(), released: false }); return handle;
    },
    screen(handle, options) {
      const source = sources.get(handle);
      if (!source || source.reference) return Promise.resolve(held('stale'));
      let operation: ResearchReferenceOperation | undefined;
      try { operation = captureOperation(options); } catch { return Promise.resolve(held('malformed')); }
      return screen(source, operation) as Promise<SourceScreeningResult>;
    },
    screenResearchReference(handle, options) {
      const source = sources.get(handle);
      if (!source?.reference) return Promise.resolve(held('stale'));
      let operation: ResearchReferenceOperation | undefined;
      try { operation = captureOperation(options); } catch { return Promise.resolve(held('malformed')); }
      return screen(source, operation) as Promise<ResearchReferenceScreeningResult>;
    },
    project(receipt) {
      const entry = projections.get(receipt);
      if (!entry || entry.source.reference || wasUnsettled(entry.source)) return invalid();
      current(entry.source); return entry.parts;
    },
    projectResearchReference(receipt) {
      const entry = projections.get(receipt);
      if (!entry?.source.reference || wasUnsettled(entry.source)) return invalid();
      current(entry.source);
      return entry.parts[0] === WITHHELD_RESEARCH_REFERENCE ? Object.freeze({ status: 'omitted' })
        : Object.freeze({ status: 'preserved', url: entry.parts[0]! });
    },
    release(handle) {
      const source = sources.get(handle); if (!source) return Promise.resolve();
      source.released = true; source.lifetime.abort();
      return own(Promise.resolve(source.pending).then(() => {
        // Retirement synchronously removes every future consumer, even when
        // this release was queued first. The raw original is forgotten here.
        unsettled.delete(source);
        sources.delete(handle);
        for (const [receipt, entry] of projections) if (entry.source === source) projections.delete(receipt);
      }));
    },
    close() {
      if (closing) return closing;
      const finish = Promise.withResolvers<void>(); closing = finish.promise;
      lifetime.abort();
      void Promise.allSettled([...work]).then(async () => {
        await transport?.close();
        sources.clear(); projections.clear(); unsettled.clear(); screening.clear(); referenceReader.clear(); finish.resolve();
      });
      return closing;
    },
  };
}
