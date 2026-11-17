import { knowledgeSchemaColumns, conversationRequestColumns } from './store-schema-validation-data.js';
/** Durable conversation capture in the same coordinated image as its native ledger publication. */
import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
import { isDeepStrictEqual } from 'node:util';
import type { SQLiteStore, SqlDatabase } from '../state/sqlite-store.js';
import { createEmptyWorkLedgerState, readWorkLedgerState } from '../workflow/work-ledger/service.js';
import type { WorkLedgerState, WorkLedgerSubmission } from '../workflow/work-ledger/types.js';
import {
  NativeConversationStorageError, parseNativeConversationCapture, isValidatedNativeConversationCapture, nativeConversationProposalRevision, nativeConversationDecisionBinding,
  type NativeConversationCapture, type NativeConversationKey, type NativeConversationMutation, type NativeConversationStorage,
} from '../workflow/work-ledger/native-intake-types.js';
import { createKnowledgeWorkLedgerStorage, readKnowledgeWorkLedger, readKnowledgeWorkLedgerImage } from './store-work-ledger.js';
import { NativeConversationMoveRefused, intakeMoveText } from './store-native-refusal.js';

type SqlReader = Pick<SqlDatabase, 'exec'>;
const TRANSCRIPT_TABLE = 'CREATE TABLE IF NOT EXISTS native_conversation_transcripts (project_id TEXT NOT NULL, session_id TEXT NOT NULL, revision TEXT NOT NULL, messages_json TEXT NOT NULL, PRIMARY KEY(project_id, session_id, revision))';
export function createNativeConversationCaptureTable(db: Pick<SqlDatabase, 'run'>): void {
  db.run('CREATE TABLE IF NOT EXISTS native_conversation_captures (project_id TEXT NOT NULL, principal_id TEXT NOT NULL, input_id TEXT NOT NULL, request_id TEXT NOT NULL, format_version INTEGER NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(project_id, principal_id, input_id), UNIQUE(project_id, principal_id, request_id))');
  db.run(TRANSCRIPT_TABLE);
}

/**
 * The session transcript an input continues is stored once, by its session and
 * revision, when the input is captured; the input's row names it and every later
 * write of the row (route, proposal, decisions, association) leaves it alone.
 * A row written by an earlier build carries its transcript inline and is read as is.
 *
 * Each message of a session is captured with the whole conversation so far, and
 * the capture's source revision is a hash over all of it, so every revision must
 * stay readable in full. A revision that extends the session's previous stored
 * one is stored as only the messages it adds (`{ base, depth, append }`); a full
 * copy is kept every {@link TRANSCRIPT_FULL_COPY_EVERY} revisions so a read
 * follows at most that many rows. Storage grows with the conversation instead
 * of with its square; a stored plain array is a full copy.
 */
const TRANSCRIPT_FULL_COPY_EVERY = 16;
interface TranscriptDelta { readonly base: string; readonly depth: number; readonly append: readonly unknown[] }
function readTranscriptRow(db: SqlReader, projectId: string, sessionId: string, revision: string): unknown[] | TranscriptDelta {
  const row = db.exec('SELECT messages_json FROM native_conversation_transcripts WHERE project_id = ? AND session_id = ? AND revision = ?', [projectId, sessionId, revision])[0]?.values[0];
  if (typeof row?.[0] !== 'string') throw new NativeConversationStorageError('invalid');
  const stored = JSON.parse(row[0]) as unknown;
  if (Array.isArray(stored)) return stored as unknown[];
  const delta = stored as Partial<TranscriptDelta> | null;
  if (!delta || typeof delta.base !== 'string' || typeof delta.depth !== 'number' || !Number.isInteger(delta.depth)
    || delta.depth < 1 || delta.depth >= TRANSCRIPT_FULL_COPY_EVERY || !Array.isArray(delta.append)) throw new NativeConversationStorageError('invalid');
  return delta as TranscriptDelta;
}
function readTranscript(db: SqlReader, projectId: string, sessionId: string, revision: string): unknown[] {
  const parts: (readonly unknown[])[] = [];
  let current = revision;
  for (let hops = 0; hops < TRANSCRIPT_FULL_COPY_EVERY; hops += 1) {
    const stored = readTranscriptRow(db, projectId, sessionId, current);
    if (Array.isArray(stored)) return [...stored, ...parts.reverse().flat()];
    parts.push(stored.append);
    current = stored.base;
  }
  throw new NativeConversationStorageError('invalid');
}
function encodeTranscript(db: SqlReader, projectId: string, sessionId: string, revision: string,
  messages: readonly { readonly role: string; readonly content: string }[]): string {
  const previous = db.exec('SELECT revision FROM native_conversation_transcripts WHERE project_id = ? AND session_id = ? AND revision <> ? ORDER BY rowid DESC LIMIT 1', [projectId, sessionId, revision])[0]?.values[0];
  if (typeof previous?.[0] === 'string') {
    try {
      const stored = readTranscriptRow(db, projectId, sessionId, previous[0]);
      const depth = (Array.isArray(stored) ? 0 : stored.depth) + 1;
      if (depth < TRANSCRIPT_FULL_COPY_EVERY) {
        const base = readTranscript(db, projectId, sessionId, previous[0]) as Array<{ readonly role?: unknown; readonly content?: unknown }>;
        if (base.length <= messages.length && base.every((message, index) => message.role === messages[index]!.role && message.content === messages[index]!.content)) {
          return JSON.stringify({ base: previous[0], depth, append: messages.slice(base.length) });
        }
      }
    } catch { /* An unreadable earlier revision is not a base: this one is stored whole. */ }
  }
  return JSON.stringify(messages);
}
function transcriptOf(db: SqlReader, projectId: string, stored: unknown): unknown {
  const continuation = (stored as { continuation?: unknown } | null)?.continuation;
  if (!continuation || typeof continuation !== 'object' || Object.hasOwn(continuation, 'messages')) return stored;
  const { sessionId, revision } = continuation as { sessionId?: unknown; revision?: unknown };
  return { ...(stored as object), continuation: { ...continuation, messages: readTranscript(db, projectId, String(sessionId), String(revision)) } };
}
function storedRow(db: Pick<SqlDatabase, 'exec' | 'run'>, projectId: string, current: NativeConversationCapture | null, next: NativeConversationCapture): string {
  if (!next.continuation) return JSON.stringify(next);
  const { messages, ...reference } = next.continuation;
  // The continuation is part of the captured source and never changes after capture.
  // The transcript table is created with the schema on every open of the store.
  if (!current) {
    const exists = (db.exec('SELECT 1 FROM native_conversation_transcripts WHERE project_id = ? AND session_id = ? AND revision = ?', [projectId, reference.sessionId, reference.revision])[0]?.values.length ?? 0) > 0;
    if (!exists) db.run('INSERT INTO native_conversation_transcripts(project_id, session_id, revision, messages_json) VALUES (?, ?, ?, ?)',
      [projectId, reference.sessionId, reference.revision, encodeTranscript(db, projectId, reference.sessionId, reference.revision, messages)]);
  } else if ((db.exec('SELECT 1 FROM native_conversation_transcripts WHERE project_id = ? AND session_id = ? AND revision = ?', [projectId, reference.sessionId, reference.revision])[0]?.values.length ?? 0) === 0) {
    // A row from an earlier build held its transcript inline: keep it inline.
    return JSON.stringify(next);
  }
  return JSON.stringify({ ...next, continuation: reference });
}
export function validateNativeConversationCaptureTable(db: SqlReader): void {
  const expected = knowledgeSchemaColumns.conversation;
  const rows = db.exec('PRAGMA table_info(native_conversation_captures)')[0]?.values;
  if (!rows || rows.length !== expected.length || expected.some(([name, type, required, primary]) => {
    const row = rows.find(value => value[1] === name); return !row || row[2] !== type || row[3] !== required || row[5] !== primary;
  })) throw new NativeConversationStorageError('invalid');
  const indexes = db.exec('PRAGMA index_list(native_conversation_captures)')[0]?.values ?? [];
  if (!indexes.some(index => index[2] === 1 && index[4] === 0
    && isDeepStrictEqual(db.exec(`PRAGMA index_info('${String(index[1]).replaceAll("'", "''")}')`)[0]?.values.map(row => row[2]), conversationRequestColumns))) throw new NativeConversationStorageError('invalid');
  // One pass reads one image: parse each project's ledger once, not once per capture.
  const ledgers = new Map<string, WorkLedgerState>();
  for (const row of db.exec('SELECT project_id, principal_id, input_id, request_id, format_version, state_json FROM native_conversation_captures')[0]?.values ?? []) {
    const capture = parseRow(db, row); validateAssociation(db, capture, ledgers);
  }
  for (const row of db.exec('SELECT project_id, format_version, state_json FROM work_ledgers')[0]?.values ?? []) {
    const raw = readKnowledgeWorkLedgerImage(db, String(row[0]), row[1], row[2]) as Partial<WorkLedgerState>;
    if (!Array.isArray(raw.history) || !raw.history.some(event => event?.type === 'submit_native' && event.work?.source?.version === 2)) continue;
    const ledger = readWorkLedgerState(raw, String(row[0]));
    for (const event of ledger.history) {
      if (event.type !== 'submit_native' || event.work.source?.version !== 2) continue;
      const capture = read(db, ledger.projectId, { principalId: event.actorId, inputId: event.work.source.inputId }, undefined, ledgers);
      if (!capture?.association || capture.association.ledgerRevision !== event.sequence) throw new NativeConversationStorageError('invalid');
    }
  }
}
/** Validate all schema-5 authorities before adding the new table and schema epoch. */
export function migrateNativeConversationCaptureTable(db: Pick<SqlDatabase, 'exec' | 'run'>): void {
  for (const row of db.exec('SELECT project_id, format_version, revision, state_json FROM work_ledgers')[0]?.values ?? []) {
    if (typeof row[0] !== 'string' || (row[1] !== 2 && row[1] !== 3) || typeof row[3] !== 'string') throw new NativeConversationStorageError('invalid');
    const ledger = readWorkLedgerState(readKnowledgeWorkLedgerImage(db, row[0], row[1], row[3]), row[0]);
    if (ledger.revision !== row[2] || ledger.works.some(work => work.source?.version === 2)) throw new NativeConversationStorageError('invalid');
  }
  if ((db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='native_conversation_captures'")[0]?.values.length ?? 0) > 0
    && (db.exec('SELECT input_id FROM native_conversation_captures LIMIT 1')[0]?.values.length ?? 0) > 0) throw new NativeConversationStorageError('invalid');
  createNativeConversationCaptureTable(db);
  validateNativeConversationCaptureTable(db);
}
function parseRow(db: SqlReader, row: readonly unknown[], original?: NativeConversationCapture): NativeConversationCapture {
  try {
    if (typeof row[4] === 'number' && row[4] > 2) throw new NativeConversationStorageError('future-version');
    if ((row[4] !== 1 && row[4] !== 2) || typeof row[5] !== 'string') throw new Error();
    const value = parseNativeConversationCapture(transcriptOf(db, String(row[0]), JSON.parse(row[5])), original);
    if (value.version !== row[4]) throw new Error();
    if (row[0] !== value.projectId || row[1] !== value.principalId || row[2] !== value.inputId || row[3] !== value.requestId) throw new Error();
    return value;
  } catch (error) { if (error instanceof NativeConversationStorageError && error.code === 'future-version') throw error; throw new NativeConversationStorageError('invalid'); }
}
function keySnapshot(key: NativeConversationKey): NativeConversationKey {
  if (!key || typeof key.principalId !== 'string' || !key.principalId || key.principalId.length > 200
    || typeof key.inputId !== 'string' || !key.inputId || key.inputId.length > 200) throw new NativeConversationStorageError('invalid');
  return { principalId: key.principalId, inputId: key.inputId };
}
function read(db: SqlReader, projectId: string, key: NativeConversationKey, original?: NativeConversationCapture, ledgers?: Map<string, WorkLedgerState>): NativeConversationCapture | null {
  const row = db.exec('SELECT project_id, principal_id, input_id, request_id, format_version, state_json FROM native_conversation_captures WHERE project_id = ? AND principal_id = ? AND input_id = ?', [projectId, key.principalId, key.inputId])[0]?.values[0];
  if (!row) return null;
  const capture = parseRow(db, row, original); validateAssociation(db, capture, ledgers); return capture;
}
function assertPublication(capture: NativeConversationCapture, event: WorkLedgerSubmission): void {
  const source = event.work.source, final = capture.decisions.at(-1);
  if (capture.route !== 'contract' || capture.unsupportedSources.length > 0 || event.actorId !== capture.principalId || event.requestId !== capture.requestId || source.version !== 2
    || source.sourceId !== capture.sourceId || source.sourceRevision !== capture.sourceRevision || source.inputId !== capture.inputId || source.sessionId !== capture.sessionId
    || !isDeepStrictEqual(source.continuation, capture.continuation)
    || event.work.goal !== capture.text || !capture.proposal || !final || final.decision.outcome !== 'act'
    || !isDeepStrictEqual(final.decision.binding, nativeConversationDecisionBinding(capture, 'publish-work'))
    || source.extraction.admissionDecisionId !== final.decision.decisionId
    || !isDeepStrictEqual(source.extraction.judgmentDecisionIds, final.decision.judgmentDecisionIds)
    || !isDeepStrictEqual(source.extraction.spans, capture.proposal.spans)
    || source.extraction.proposalRevision !== nativeConversationProposalRevision(capture.proposal)
    || !isDeepStrictEqual(event.work.criteria, capture.proposal.spans.map(span => capture.text.slice(span.start, span.end)))
    || !event.attemptId || event.attempts.length !== 1 || event.attempts[0]?.id !== event.attemptId
    || event.attempts[0]?.ownerId !== capture.principalId || event.attempts[0]?.state !== 'active') throw new NativeConversationStorageError('invalid');
}
function validateAssociation(db: SqlReader, capture: NativeConversationCapture, ledgers?: Map<string, WorkLedgerState>): void {
  if (!capture.association) return;
  let ledger = ledgers?.get(capture.projectId);
  if (!ledger) { ledger = readKnowledgeWorkLedger(db, capture.projectId); ledgers?.set(capture.projectId, ledger); }
  const event = ledger.history[capture.association.ledgerRevision - 1];
  if (!event || event.type !== 'submit_native' || event.work.source?.version !== 2 || !event.attemptId
    || event.workId !== capture.association.workId || event.attemptId !== capture.association.attemptId
    || event.sequence !== capture.association.ledgerRevision) throw new NativeConversationStorageError('invalid');
  assertPublication(capture, event as WorkLedgerSubmission);
}
function immutable(capture: NativeConversationCapture): unknown {
  const { generation: _generation, state: _state, stage: _stage, route: _route, reason: _reason,
    proposalsSpent: _spent, proposal: _proposal, decisions: _decisions, association: _association, classic: _classic, settled: _settled, ...facts } = capture;
  return facts;
}
function validateTransition(current: NativeConversationCapture | null, next: NativeConversationCapture, publication = false): void {
  try { checkTransition(current, next, publication); }
  catch (error) {
    if (error instanceof NativeConversationStorageError && error.code === 'conflict' && error.constructor === NativeConversationStorageError) {
      throw new NativeConversationMoveRefused('conflict', intakeMoveText(current?.state ?? null, next.state));
    }
    throw error;
  }
}
function checkTransition(current: NativeConversationCapture | null, next: NativeConversationCapture, publication = false): void {
  if (!current) {
    if (next.classic || next.generation !== 1 || !['captured', 'cancelled'].includes(next.state) || next.proposalsSpent !== 0 || next.proposal || next.decisions.length || next.association) throw new NativeConversationStorageError('conflict');
    return;
  }
  if (!isDeepStrictEqual(immutable(current), immutable(next))) throw new NativeConversationStorageError('conflict');
  // Admission is host-owned terminal metadata, never part of the captured
  // source. It may be added once to this processing generation, then retained
  // exactly through lookup, restart and cancellation.
  if (!isDeepStrictEqual(current.classic, next.classic)
    && (current.classic || !next.classic || current.state !== 'processing' || next.state !== 'turn'
      || current.generation !== next.generation)) throw new NativeConversationStorageError('conflict');
  if (current.state === 'cancelled' && !isDeepStrictEqual(current, next)) throw new NativeConversationStorageError('cancelled');
  if (['blocked', 'refused'].includes(current.state) && next.state !== 'cancelled' && !isDeepStrictEqual(current, next)) throw new NativeConversationStorageError('conflict');
  if (current.state !== 'cancelled' && next.state === 'cancelled' && (next.generation !== current.generation + 1
    || !isDeepStrictEqual({ ...current, generation: next.generation, state: 'cancelled', stage: null }, next))) throw new NativeConversationStorageError('conflict');
  // The one move out of a finished-looking state: a dispatched turn is marked settled, same generation, nothing else changed.
  const settlesTurn = current.state === 'turn' && !current.settled && next.settled === true && isDeepStrictEqual({ ...current, settled: true }, next);
  if ((current.state === 'associated' || current.state === 'turn') && !isDeepStrictEqual(current, next) && !settlesTurn) throw new NativeConversationStorageError('conflict');
  if (next.generation !== current.generation && (next.generation !== current.generation + 1
    || (next.state !== 'cancelled' && (next.state !== 'processing' || !['captured', 'processing'].includes(current.state))))) throw new NativeConversationStorageError('conflict');
  if (next.state === 'captured' && current.state !== 'captured') throw new NativeConversationStorageError('conflict');
  if (['blocked', 'refused'].includes(current.state) && ![current.state, 'cancelled'].includes(next.state)) throw new NativeConversationStorageError('conflict');
  if (current.state === 'captured' && !['captured', 'processing', 'cancelled'].includes(next.state)) throw new NativeConversationStorageError('conflict');
  if (current.state !== 'processing' && next.state === 'processing' && next.generation === current.generation) throw new NativeConversationStorageError('conflict');
  if (next.proposalsSpent < current.proposalsSpent || next.proposalsSpent > current.proposalsSpent + 1
    || next.decisions.length < current.decisions.length || next.decisions.length > current.decisions.length + 1
    || !isDeepStrictEqual(next.decisions.slice(0, current.decisions.length), current.decisions)) throw new NativeConversationStorageError('conflict');
  if (!isDeepStrictEqual(current.association, next.association) && !(publication && !current.association && next.state === 'associated')) throw new NativeConversationStorageError('conflict');
  if (next.state === 'associated' && current.state !== 'associated' && (!publication || current.state !== 'processing')) throw new NativeConversationStorageError('conflict');
}
function write(db: Pick<SqlDatabase, 'exec' | 'run'>, projectId: string, key: NativeConversationKey, current: NativeConversationCapture | null, next: NativeConversationCapture, publication = false, beforeWrite?: () => void, beforeSettledWrite?: () => void): void {
  if (next.projectId !== projectId || next.principalId !== key.principalId || next.inputId !== key.inputId) throw new NativeConversationStorageError('invalid');
  validateTransition(current, next, publication);
  const duplicate = db.exec('SELECT input_id FROM native_conversation_captures WHERE project_id = ? AND principal_id = ? AND request_id = ?', [projectId, key.principalId, next.requestId])[0]?.values[0];
  if (duplicate && duplicate[0] !== key.inputId) throw new NativeConversationStorageError('conflict');
  if (next.version === 2) {
    assertSynchronousJudgmentGuard(beforeWrite, () => new NativeConversationStorageError('invalid'));
  }
  if (next.settled === true) {
    assertSynchronousJudgmentGuard(beforeSettledWrite, () => new NativeConversationStorageError('invalid'));
  }
  db.run('INSERT INTO native_conversation_captures(project_id, principal_id, input_id, request_id, format_version, state_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, principal_id, input_id) DO UPDATE SET format_version=excluded.format_version, state_json=excluded.state_json', [projectId, key.principalId, key.inputId, next.requestId, next.version, storedRow(db, projectId, current, next)]);
}
function synchronous(value: unknown): void {
  if (value && typeof (value as { then?: unknown }).then === 'function') {
    if (value instanceof Promise) void value.catch(() => {});
    throw new NativeConversationStorageError('invalid');
  }
}
/** `beforeWrite` declares the capture format; `beforeSettledWrite` declares the extra reader requirement of a settled capture. */
export function createNativeConversationStorage(sqlite: SQLiteStore, projectId: string, refresh: () => void, beforeWrite?: () => void, beforeSettledWrite?: () => void): NativeConversationStorage {
  createEmptyWorkLedgerState(projectId);
  let closed = false, closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const publishers = new Set<ReturnType<typeof createKnowledgeWorkLedgerStorage>>();
  function assertOpen() { if (closed) throw new NativeConversationStorageError('closed'); }
  function track<T>(work: Promise<T>): Promise<T> { pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return work; }
  return {
    current(key) { assertOpen(); const original = isValidatedNativeConversationCapture(key) ? key : undefined, lookup = keySnapshot(key); return sqlite.readPersisted(db => read(db, projectId, lookup, original)); },
    transaction<T>(key: NativeConversationKey, decide: (current: NativeConversationCapture | null) => NativeConversationMutation<T>): Promise<T> {
      assertOpen(); const original = isValidatedNativeConversationCapture(key) ? key : undefined, lookup = keySnapshot(key);
      return track(sqlite.transactPersisted(db => {
        const current = read(db, projectId, lookup, original), result = decide(current); synchronous(result);
        if (!result || !Object.hasOwn(result, 'next')) throw new NativeConversationStorageError('invalid');
        const next = result.next === null ? null : parseNativeConversationCapture(result.next, current ?? original);
        if (next) write(db, projectId, lookup, current, next, false, beforeWrite, beforeSettledWrite);
        return { changed: next !== null && !isDeepStrictEqual(next, current), value: result.value };
      }, refresh).then(result => { if (result.kind !== 'completed') throw new NativeConversationStorageError('unavailable'); return result.value; }));
    },
    publicationStorage(key, assertCurrent, finish) {
      assertOpen(); const original = isValidatedNativeConversationCapture(key) ? key : undefined, lookup = keySnapshot(key);
      const publisher = createKnowledgeWorkLedgerStorage(sqlite, projectId, refresh, {
        beforeDecision(db) {
          const current = read(db, projectId, lookup, original);
          if (!current) throw new NativeConversationStorageError('not-found');
          if (current.state === 'cancelled') throw new NativeConversationStorageError('cancelled');
          assertSynchronousJudgmentGuard(() => assertCurrent(current), () => new NativeConversationStorageError('invalid'));
        },
        beforeCommit(db, currentLedger: WorkLedgerState, nextLedger: WorkLedgerState) {
          const current = read(db, projectId, lookup, original);
          if (!current || current.state !== 'processing') throw new NativeConversationStorageError('conflict');
          if (nextLedger.revision !== currentLedger.revision + 1 || nextLedger.history.length !== currentLedger.history.length + 1) throw new NativeConversationStorageError('invalid');
          const event = nextLedger.history.at(-1);
          if (event?.type !== 'submit_native' || !event.attemptId || event.work.source?.version !== 2) throw new NativeConversationStorageError('invalid');
          // The full ordinary reducer replay is already validated by the ledger adapter.
          const nextValue = finish(current, structuredClone(event) as WorkLedgerSubmission); synchronous(nextValue);
          const next = parseNativeConversationCapture(nextValue, current);
          // The publishing decision itself may be appended here, written with the association it allowed.
          const decisionsKept = isDeepStrictEqual(next.decisions, current.decisions)
            || (next.decisions.length === current.decisions.length + 1 && isDeepStrictEqual(next.decisions.slice(0, -1), current.decisions));
          if (next.state !== 'associated' || next.generation !== current.generation
            || next.proposalsSpent !== current.proposalsSpent || !isDeepStrictEqual(next.proposal, current.proposal) || !decisionsKept
            || !isDeepStrictEqual(next.association, { workId: event.workId, attemptId: event.attemptId, ledgerRevision: event.sequence })) throw new NativeConversationStorageError('invalid');
          assertPublication(next, event as WorkLedgerSubmission);
          assertSynchronousJudgmentGuard(() => assertCurrent(current), () => new NativeConversationStorageError('invalid'));
          write(db, projectId, lookup, current, next, true, beforeWrite, beforeSettledWrite);
        },
      });
      publishers.add(publisher);
      return { read: () => { assertOpen(); return publisher.read(); }, transaction: decide => { assertOpen(); return publisher.transaction(decide); },
        subscribe: (listener, onUnavailable) => { assertOpen(); return publisher.subscribe(listener, onUnavailable); }, close: () => publisher.close().then(() => { publishers.delete(publisher); }) };
    },
    close() { closed = true; return closing ??= Promise.allSettled([...pending, ...[...publishers].map(publisher => publisher.close())]).then(() => {}); },
  };
}
