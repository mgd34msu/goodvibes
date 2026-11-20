import { randomUUID } from 'node:crypto';
import { parseJevDecision } from '@goodvibes-jev/judgment/decisions';
import { createOperatorApiClient } from '@goodvibes-jev/engine/operator-client';
import { GoodVibesError } from '@goodvibes-jev/engine/errors';
import { array, boolean, discriminatedUnion, enum as enumSchema, literal, object, record, strictObject, string, unknown } from 'zod/v4';
import { validateLegacyWorkLedgerManifest, type LegacyMigrationPreparation } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger';
import { LegacyImportJournal, type LegacyImportBinding, type LegacyImportEntry, type LegacyImportCommand, type LegacyImportJournalOptions, legacyImportResultSchema } from './legacy-work-ledger-import-journal.js';

export interface LegacyImportHost { readonly baseUrl: string; readonly token: string; readonly workspace: string; readonly selectionIdentity?: string }
export interface LegacyImportOperatorClient { currentAuth(signal?: AbortSignal): Promise<unknown>; invoke(method: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>; dispose(): void }
export interface LegacyImportOperatorOptions {
  readonly resolve: () => LegacyImportHost | { readonly reason: string };
  readonly projectId: string; readonly journalPath: string;
  readonly journalOptions?: LegacyImportJournalOptions;
  readonly createClient?: (host: LegacyImportHost) => LegacyImportOperatorClient;
}
const authSchema = object({ authenticated: boolean(), admin: boolean(), principalId: string().min(1).nullable(), principalKind: enumSchema(['bot', 'service', 'token', 'user']).nullable(), scopes: array(string()) });
const pageSchema = object({ items: array(object({ id: string().min(1), connectorId: string(), metadata: record(string(), unknown()) })).max(1000), hasMore: boolean(), nextCursor: string().nullable().optional() });
// The kind decides the shape first, so a host's refusal is reported as the host said it, not as a broken manifest.
const preparationSchema = discriminatedUnion('kind', [
  strictObject({ kind: literal('prepared'), manifest: unknown().transform(validateLegacyWorkLedgerManifest) }),
  strictObject({ kind: literal('blocked'), code: enumSchema(['cancelled', 'pending-local-changes', 'invalid-source', 'limit', 'identity-conflict', 'target-conflict', 'stale-preparation']), reason: string() }),
]);
function clientFor(host: LegacyImportHost): LegacyImportOperatorClient {
  const client = createOperatorApiClient({ baseUrl: host.baseUrl, authToken: host.token, fetchImpl: (input, init) => fetch(input, { ...init, redirect: 'error' }) });
  return { currentAuth: signal => client.control.auth.current({}, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) }),
    invoke: (method, input, signal) => client.invoke(method, input, { signal }), dispose: () => client.dispose() };
}
/** Reads grant no mutation; every dispatch goes through the selected host's own admission. */
export interface LegacyImportOperatorSession {
  readonly binding: LegacyImportBinding;
  prepare(): Promise<LegacyMigrationPreparation>;
  status(): Promise<LegacyImportEntry | null>;
  submit(): Promise<LegacyImportEntry>;
  /** The saved import is the one for this workspace and project; a request id, when given, must name it. */
  reconsider(requestId?: string): Promise<LegacyImportEntry>;
  recover(requestId?: string): Promise<LegacyImportEntry>;
  cancel(requestId?: string): Promise<LegacyImportEntry>;
  restart(requestId?: string): Promise<LegacyImportEntry>;
  dispose(): void;
}
/**
 * One authentication per command: the host checks scope on every call, and a
 * 401 or 403 later means the credential or principal changed. The one saved
 * request id is what makes a retry safe: the host applies a request id once.
 */
export async function openLegacyImportOperator(options: LegacyImportOperatorOptions): Promise<LegacyImportOperatorSession> {
  const projectId = options.projectId, journalPath = options.journalPath;
  const selected = options.resolve(); if ('reason' in selected) throw new Error(selected.reason);
  const host = { ...selected };
  if (!host.token.trim()) throw new Error('An existing authenticated host credential is required');
  const client = options.createClient ? options.createClient(host) : clientFor(host);
  const lifetime = new AbortController();
  let closed = false; let store: LegacyImportJournal | undefined;
  const journal = (): LegacyImportJournal => {
    if (closed) throw new Error('This import session is closed');
    return store ??= new LegacyImportJournal(journalPath, undefined, options.journalOptions);
  };
  const plain = (error: unknown): Error => {
    const message = (error instanceof Error ? error.message : String(error)).split(host.token).join('[redacted]');
    if (error instanceof GoodVibesError && error.kind === 'auth')
      return new Error(`The host at ${host.baseUrl} no longer accepts this terminal's credential (${message}). Pair again with /devices pair host, then run the command again; a saved import keeps its request id.`);
    return new Error(message);
  };
  const safe = async <T>(operation: () => Promise<T> | T): Promise<T> => {
    try { return await operation(); } catch (error) { throw plain(error); }
  };
  const authenticated = async (): Promise<{ binding: LegacyImportBinding; canWrite: boolean }> => {
    try {
      const auth = authSchema.parse(await client.currentAuth(lifetime.signal));
      if (!auth.authenticated || !auth.admin || !auth.principalId || !auth.principalKind || !['read:work-ledger', 'read:knowledge'].every(scope => auth.scopes.includes('*') || auth.scopes.includes(scope)))
        throw new Error('This credential needs admin with read:work-ledger and read:knowledge on the host; pair with an admin credential');
      return {
        canWrite: auth.scopes.some(scope => scope === '*' || scope === 'write:work-ledger-import'),
        binding: { endpoint: host.baseUrl, workspaceId: host.workspace, projectId, principalId: auth.principalId, principalKind: auth.principalKind },
      };
    } catch (error) { client.dispose(); throw plain(error); }
  };
  const { binding, canWrite } = await authenticated();
  const requireWrite = () => { if (!canWrite) throw new Error('This credential lacks write:work-ledger-import on the host; pair with a credential that has it'); };
  const status = () => journal().read(binding);
  const readSaved = (): LegacyImportEntry | null => {
    // Look without writing first: a read, or a preparation the host then blocks, must not create a
    // journal or raise the writer format floor. A journal that cannot be opened read-only (a write an
    // earlier process left half done) is recovered through the update path.
    try { return journal().read(binding); } catch { return journal().readForUpdate(binding); }
  };
  const savedEntry = (requestId?: string): LegacyImportEntry => named(readSaved(), requestId);
  const named = (entry: LegacyImportEntry | null, requestId: string | undefined): LegacyImportEntry => {
    if (!entry) throw new Error(`No saved legacy import for project ${projectId}; run /work-import submit ${projectId}`);
    if (requestId !== undefined && entry.command.requestId !== requestId) throw new Error(`Request ${requestId} is not the saved import for project ${projectId} (that is ${entry.command.requestId}); run /work-import status ${projectId}`);
    return entry;
  };
  const prepareSources = async (): Promise<LegacyMigrationPreparation> => {
    const sourceIds: string[] = []; const seen = new Set<string>(); const cursors = new Set<string>(); let cursor: string | undefined;
    do {
      const page = pageSchema.parse(await client.invoke('knowledge.sources.list', { limit: 100, includeAllSpaces: true, ...(cursor ? { cursor } : {}) }, lifetime.signal));
      if ((page.hasMore && (!page.nextCursor || !page.items.length)) || (!page.hasMore && page.nextCursor != null)) throw new Error('Incomplete source discovery: inconsistent cursor');
      for (const source of page.items) {
        if (seen.has(source.id)) throw new Error('Source discovery repeated an identity'); seen.add(source.id);
        if (source.connectorId === 'goodvibes-project-planning' && source.metadata.projectPlanning === true && source.metadata.projectId === projectId) sourceIds.push(source.id);
      }
      if (seen.size >= 5000 || sourceIds.length > 500) throw new Error('Source discovery limit prevents proving completeness');
      cursor = page.hasMore ? page.nextCursor! : undefined;
      if (cursor) { if (cursors.has(cursor)) throw new Error('Source cursor repeated'); cursors.add(cursor); }
    } while (cursor);
    // The host adds the project's work-plan tasks (rows of their own, not listed as knowledge sources), so an empty list is still a request.
    const prepared = preparationSchema.parse(await client.invoke('workLedger.prepareLegacyImport', { projectId, sourceIds: sourceIds.sort() }, lifetime.signal));
    if (prepared.kind === 'blocked') return prepared;
    const manifest = prepared.manifest;
    const captured = manifest.sources.filter(item => item.source.metadata === null || typeof item.source.metadata !== 'object' || Array.isArray(item.source.metadata)
      || item.source.metadata['planningArtifactKind'] !== 'work-plan-task').map(item => String(item.source.id)).sort();
    if (manifest.projectId !== projectId || JSON.stringify(captured) !== JSON.stringify(sourceIds)) throw new Error('Prepared source selection changed');
    return { kind: 'prepared', manifest };
  };
  const dispatch = async (entry: LegacyImportEntry): Promise<LegacyImportEntry> => {
    // Saved as sent BEFORE transmission, so a lost answer is resent with the same id instead of a new one.
    const dispatched = journal().dispatch(binding, entry.command, entry);
    const raw = await client.invoke('workLedger.importLegacy', entry.command, lifetime.signal);
    if (raw && typeof raw === 'object' && 'kind' in raw && raw.kind === 'decision') {
      const semantic = strictObject({ kind: literal('decision'), decision: unknown().transform(parseJevDecision) }).parse(raw);
      if (semantic.decision.outcome === 'act') throw new Error('Host returned an uncommitted act decision');
      return journal().recordDecision(binding, entry.command, semantic.decision, entry.state === 'pending' ? dispatched.attempts : undefined);
    }
    return journal().record(binding, entry.command, legacyImportResultSchema.parse(raw), entry.state === 'pending' ? dispatched.attempts : undefined);
  };
  const create = async (replace?: { requestId?: string | undefined }): Promise<LegacyImportEntry> => {
    requireWrite();
    const prior = readSaved();
    if (prior && !replace) return prior;
    if (replace) {
      const saved = named(prior, replace.requestId);
      if (!['rejected', 'cancelled'].includes(saved.state)) throw new Error(`Only a rejected or cancelled import can be restarted; this one is ${saved.state}. Run /work-import status ${projectId} for its next step`);
    }
    const prepared = await prepareSources();
    if (prepared.kind === 'blocked') throw new Error(`The host blocked the preparation: ${prepared.code}: ${prepared.reason}. Resolve that on the host, then run /work-import preview ${projectId}`);
    const command: LegacyImportCommand = { type: 'import_legacy', requestId: randomUUID(), expectedRevision: prepared.manifest.expectedLedgerRevision, manifest: prepared.manifest };
    const reserved = journal().reserve(binding, () => command, replace ? prior!.command.requestId : undefined);
    if (reserved.command.requestId !== command.requestId) return reserved;
    return dispatch(reserved);
  };
  const resume = async (requestId: string | undefined, state: 'pending' | 'unknown'): Promise<LegacyImportEntry> => {
    requireWrite();
    const entry = savedEntry(requestId);
    if (entry.state !== state) throw new Error(`The saved import is ${entry.state}, not ${state}; run /work-import status ${projectId} for the next step`);
    return dispatch(entry);
  };
  return {
    get binding() { return { ...binding }; },
    status: () => safe(status),
    prepare: () => safe(async () => {
      if (status()) throw new Error(`A saved import exists for project ${projectId}; run /work-import status ${projectId} for its next step instead of preparing another`);
      return prepareSources();
    }),
    submit: () => safe(() => create()),
    restart: requestId => safe(() => create({ requestId })),
    reconsider: requestId => safe(() => resume(requestId, 'pending')),
    recover: requestId => safe(() => resume(requestId, 'unknown')),
    cancel: requestId => safe(() => { const entry = savedEntry(requestId); return journal().cancel(binding, entry.command)!; }),
    dispose() { if (!closed) { closed = true; lifetime.abort(); client.dispose(); store?.close(); } },
  };
}
