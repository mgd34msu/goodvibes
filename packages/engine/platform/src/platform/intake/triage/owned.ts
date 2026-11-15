/**
 * One account's inbox with triage: its mirror, its poller and, when the account
 * has a triage grant, a scoring pass that runs after each poll that stored new
 * rows. Labels are stored beside their rows in the mirror and shown by every
 * inbox read; a label shows only while the row's content is what was scored.
 */
import { join } from 'node:path';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { HandlerError } from '../../control-plane/host-handlers.js';
import { acquireCrossProcessLock } from '../../state/durable-file-io.js';
import { isClassicOperation } from '../../runtime/decision-policy.js';
import { aggregateInbox, normalizeInboxQuery, type InboxListInput } from '../aggregator.js';
import { createOwnedInboxSource, registerCompositeInboxSurface, type InboxSurfaceContext,
  type OwnedInboxSource, type RegisterInboxSurfaceOptions } from '../registration.js';
import { previewInboxTriage, triageMirrorRows } from './pipeline.js';
import type { TriagePreview, TriageReceipt } from './types.js';
import { acquireOwnedTriageIdentity } from '../providers/account-identity.js';

/**
 * The account's grant to send its screened previews to a model for triage. The
 * daemon builds it from the account's privacy-screening route
 * (screening-route.ts), so triage goes where screening already goes, under the
 * same retention promise, and stops when screening is revoked.
 */
export interface InboxTriageAuthority {
  /** Absent when the grant is built for whichever account it is handed to (one grant per account). */
  readonly accountScopeId?: string;
  readonly providerId: string;
  readonly destinationId: string;
  readonly retention: 'ephemeral-no-log' | 'provider-managed-zero-retention-unverified';
  readonly port: JudgmentPort;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
export interface OwnedTriagedInboxOptions extends Omit<RegisterInboxSurfaceOptions, 'storeFileName' | 'onCommitted' | 'acquireReadLease'> {
  /** Preserve a native account mirror already protected by its host owner lock. */
  readonly storeFileName?: string;
  /** Earlier installs kept triage receipts in a file of their own; that file is no longer read. */
  readonly triageStoreFileName?: string;
  /** Native installation declaration before publishing default opaque selectors. */
  readonly beforeIdentityWrite?: (() => void) | undefined;
  /** Native data declaration before the first triage receipt is stored in the mirror. */
  readonly beforeReceiptWrite?: ((receiptVersion?: 3 | 4) => void) | undefined;
  readonly providerId: string;
  readonly accountScopeId: string;
  readonly acquireReadLease: NonNullable<RegisterInboxSurfaceOptions['acquireReadLease']>;
  readonly authority?: InboxTriageAuthority;
  /** Rows scored per model request (one request per batch). */
  readonly batchSize?: number;
}
export interface OwnedInboxTriageResult {
  readonly receipts: readonly (TriageReceipt | TriagePreview)[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}
export interface OwnedTriagedInboxSource extends OwnedInboxSource {
  /** Score a selected page now, at most 100 rows; `dryRun` returns the reading without storing it. */
  runInboxTriage(query?: InboxListInput, operation?: { readonly signal?: AbortSignal; readonly dryRun?: boolean }): Promise<OwnedInboxTriageResult>;
}
function unavailable(): HandlerError {
  return new HandlerError('Inbox triage is not enabled for this account: it has no privacy-screening model route to ask, or that route was revoked',
    'INBOX_TRIAGE_AUTHORITY_UNAVAILABLE', 503);
}

const DEFAULT_BATCH = 50;
/** Batches one trigger may score before it waits for the next poll. */
const MAX_BATCHES_PER_PASS = 4;

/** Own one independent account, its mirror, triage and storage lock. */
export function createOwnedTriagedInboxSource(
  ctx: Omit<InboxSurfaceContext, 'catalog'>, options: OwnedTriagedInboxOptions,
): Promise<OwnedTriagedInboxSource> { return createTriagedSource(ctx, options); }

async function createTriagedSource(
  ctx: Omit<InboxSurfaceContext, 'catalog'>, options: OwnedTriagedInboxOptions,
  enclosingClosing?: () => Promise<void> | undefined,
): Promise<OwnedTriagedInboxSource> {
  ctx = Object.freeze({ ...ctx });
  options = Object.freeze({ ...options, adapters: new Map(options.adapters) });
  const { providerId, accountScopeId } = options;
  const receiptScope = Object.freeze({ providerId, accountScopeId });
  if (options.storeFileName !== undefined && (typeof options.storeFileName !== 'string' || options.storeFileName.length > 200
    || options.storeFileName.includes('/') || options.storeFileName.includes('\\') || options.storeFileName.startsWith('.')
    || !options.storeFileName.endsWith('.sqlite'))) {
    throw new TypeError('Triaged inbox mirror requires a local SQLite filename');
  }
  if (!providerId || providerId.includes(':') || !accountScopeId || accountScopeId.length > 500
    || options.adapters.size !== 1 || !options.adapters.has(providerId) || typeof options.acquireReadLease !== 'function') {
    throw new TypeError('Triaged inbox requires one explicitly scoped account and read lease');
  }
  const authority = options.authority;
  const bound = authority !== undefined && (authority.accountScopeId === undefined || authority.accountScopeId === accountScopeId)
    && authority.providerId === providerId && authority.destinationId.length > 0;
  const batchSize = Math.max(1, Math.min(100, Math.floor(options.batchSize ?? DEFAULT_BATCH)));
  const gatePolling = options.gatePolling;
  const owner = new AbortController();
  let closed = false, closing: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  const defaults = options.storeFileName ? undefined
    : await acquireOwnedTriageIdentity({ workingDirectory: ctx.workingDirectory, assertCurrent: () => {
      if (closed || owner.signal.aborted) throw unavailable();
    }, beforeWrite: options.beforeIdentityWrite }, providerId, accountScopeId);
  const mirrorFileName = options.storeFileName ?? defaults!.mirrorFileName;
  // Native roots already own their mirror lock; a default mirror takes its own.
  const releases: Array<() => void> = [];
  const releaseLock = () => {
    const failures: unknown[] = [];
    for (const release of releases.splice(0).reverse()) try { release(); } catch (error) { failures.push(error); }
    if (failures.length) throw new Error('Triaged inbox storage ownership did not retire', { cause: failures[0] });
  };
  // Mirrors named by the earlier owned-inbox scheme are also guarded by the
  // mutex the offline retention janitor looks for (inactive-retention.ts).
  const legacyOwned = /^inbox-owned-([0-9a-f]{64})\.sqlite$/.exec(mirrorFileName);
  const lockNames = [...(options.storeFileName === undefined ? [`${mirrorFileName}.owner.lock`] : []),
    ...(legacyOwned ? [`inbox-triage-${legacyOwned[1]!}.sqlite.owner.lock`] : [])];
  try {
    for (const name of lockNames) releases.push(await acquireCrossProcessLock(join(ctx.workingDirectory, '.goodvibes', 'tui', 'operator', name),
      { strictOwnership: true, totalTimeoutMs: 100 }));
  } catch (error) { releaseLock(); throw error; }
  /** Usable grant right now, or undefined: triage is skipped, never an error for a read. */
  const grant = (): InboxTriageAuthority | undefined => {
    // Decision models off (Classic) means no model request, triage included.
    if (closed || owner.signal.aborted || !bound || authority.signal.aborted || isClassicOperation()) return undefined;
    try { authority.assertCurrent(); return authority; } catch { return undefined; }
  };
  const report = (message: string): void => { try { ctx.logger.warn(message); } catch { /* fixed diagnostic only */ } };
  let declared = false;
  const declare = (): void => { if (!declared) { options.beforeReceiptWrite?.(4); declared = true; } };
  // One scoring pass at a time; a poll that lands during a pass asks for one more.
  let passing: Promise<void> | undefined;
  let again = false;
  let source!: OwnedInboxSource;
  const pass = async (): Promise<void> => {
    for (let batch = 0; batch < MAX_BATCHES_PER_PASS; batch += 1) {
      const live = grant();
      const mirror = source.mirror;
      if (!live || !mirror) return;
      const candidates = mirror.untriagedItems(providerId, batchSize).map(({ item, revision }) => ({ id: item.id, provider: item.provider,
        kind: item.kind, subject: item.subjectPreview, snippet: item.bodyPreview, unread: item.unread, revision }));
      if (candidates.length === 0) return;
      declare();
      const signal = AbortSignal.any([owner.signal, live.signal]);
      const { receipts, stored } = await triageMirrorRows(mirror, providerId, live.port, { candidates, signal });
      // Unanswered (model down, held readings): stop here and wait for the next poll.
      if (stored === 0 || receipts.every(receipt => receipt.status !== 'settled')) return;
    }
  };
  const schedule = (): void => {
    if (!grant()) return;
    if (passing) { again = true; return; }
    const run = (async () => {
      do {
        again = false;
        try { await pass(); } catch { report('Inbox triage pass failed; the next poll tries again'); }
      } while (again && !closed);
    })();
    passing = run;
    active.add(run);
    void run.finally(() => { active.delete(run); if (passing === run) passing = undefined; });
  };
  try {
    source = createOwnedInboxSource(ctx, { ...options, adapters: new Map(options.adapters), storeFileName: mirrorFileName, triageScope: receiptScope,
      onCommitted: () => schedule(),
      ...(gatePolling ? { gatePolling: (provider: string, control: Parameters<NonNullable<RegisterInboxSurfaceOptions['gatePolling']>>[1]) => {
        const retire = gatePolling(provider, control);
        if (typeof retire !== 'function') return;
        return () => {
          const result = retire();
          if (result !== undefined && (result === closing || result === enclosingClosing?.())) {
            throw new Error('Inbox gate cleanup cannot await its own triage close');
          }
          return result;
        };
      } } : {}),
    });
  } catch (error) { releaseLock(); throw error; }
  // Rows stored before triage was granted, or before a restart, are scored once the mirror is open.
  void source.ready.then(() => schedule(), () => {});
  const score: OwnedTriagedInboxSource['runInboxTriage'] = async (query = {}, operation = {}) => {
    if (closed) throw unavailable();
    const selected = normalizeInboxQuery(query);
    if (selected.limit > 100) throw new HandlerError('Inbox triage scores at most 100 rows at a time; pass limit 100 or less', 'INVALID_ARGUMENT', 400);
    if (selected.providers?.some(provider => provider !== providerId)) throw unavailable();
    const live = grant();
    if (!live) throw unavailable();
    const signal = AbortSignal.any([owner.signal, live.signal, ...(operation.signal ? [operation.signal] : [])]);
    const read = await source.acquireRead(true);
    try {
      const page = aggregateInbox(read.sources, { ...selected, providers: [providerId] });
      const mirror = source.mirror!;
      let receipts: readonly (TriageReceipt | TriagePreview)[];
      if (operation.dryRun) {
        receipts = await previewInboxTriage(page.items, live.port, signal);
      } else {
        const revisions = mirror.triageRevisions(page.items.map(item => item.id));
        declare();
        receipts = (await triageMirrorRows(mirror, providerId, live.port, { signal,
          candidates: page.items.filter(item => revisions.has(item.id)).map(item => ({ id: item.id, provider: item.provider, kind: item.kind,
            subject: item.subject ?? '', snippet: item.bodyPreview, unread: item.unread, revision: revisions.get(item.id)! })) })).receipts;
      }
      return { receipts, total: page.total, hasMore: page.hasMore, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    } finally { read.release(); }
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void closing.catch(() => {});
    owner.abort();
    const retiring = source.close();
    void (async () => {
      const outcomes = await Promise.allSettled([retiring, ...active]);
      // A source that did not retire may still hold its mirror open, so its lock stays held.
      if (outcomes[0]?.status === 'rejected') throw new Error('Triaged inbox source did not retire');
      releaseLock();
    })().then(resolve, reject);
    return closing;
  };
  return { ...source, runInboxTriage: score, close, unregister() { void close(); } };
}

/** Owned source plus the canonical `channels.inbox.list` binding over it. */
export async function registerTriagedInbox(ctx: InboxSurfaceContext, options: OwnedTriagedInboxOptions): Promise<OwnedTriagedInboxSource> {
  ctx = Object.freeze({ ...ctx });
  let closing: Promise<void> | undefined;
  const source = await createTriagedSource(ctx, options, () => closing);
  let binding: ReturnType<typeof registerCompositeInboxSurface>;
  try { binding = registerCompositeInboxSurface(ctx, [source]); }
  catch (error) { await source.close(); throw error; }
  const close = (): Promise<void> => {
    if (closing) return closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void closing.catch(() => {});
    void Promise.allSettled([binding.close(), source.close()]).then(results => {
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) reject(new AggregateError(failures.map(result => result.reason), 'Triaged inbox did not retire'));
      else resolve();
    });
    return closing;
  };
  return { ...source, ready: Promise.all([source.ready, binding.ready]).then(() => {}), close, unregister() { void close(); } };
}
