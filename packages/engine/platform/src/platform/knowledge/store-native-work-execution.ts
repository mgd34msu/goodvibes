import { isDeepStrictEqual } from 'node:util';
import { assertSynchronousJudgmentGuard, drainOwned } from '@goodvibes/judgment/decisions';
import { knowledgeSchemaColumns, executionAttemptColumns } from './store-schema-validation-data.js';
import { NativeExecutionMoveRefused, executionIntentMoveText, executionRecordMoveText } from './store-native-refusal.js';
import { createNativeCiContinuationStorage } from './store-native-ci-continuation.js';
import { nativeSettlementDigest, nativeWorkSettlementSchema, nativeSettlementStorageKey, captureNativeSettlementPublication, nativeSettlementPublicationCommitment, type NativeWorkSettlementReceipt, type NativeWorkSettlementPublication } from '../workflow/work-ledger/native-settlement-types.js';
import type { SQLiteStore, SqlDatabase } from '../state/sqlite-store.js';
import { readKnowledgeWorkLedgerImage, writeKnowledgeWorkLedger } from './store-work-ledger.js';
import { durableKeyIdentity, durableKeyHash, durablePayloadRevision, sameDurableRequest, type DurableContractKey, type DurableContractRequest, type DurableContractReceipt } from '../contract/durable-admission.js';
import { readWorkLedgerState, createEmptyWorkLedgerState, reduceWorkLedgerFailure, reduceWorkLedgerSettlement, reduceWorkLedgerStatus, reduceWorkLedgerStopped,nativeStatusReports, nativeTargetMatches, nativeBoundRevisions, NATIVE_STATUS_REQUEST_PREFIX } from '../workflow/work-ledger/service.js';
import type { WorkLedgerState } from '../workflow/work-ledger/types.js';
import { isNativeWorkSession } from '../workflow/work-ledger/native-work-session.js';
import { NativeWorkExecutionError, nativeExecutionOriginalFor, parseNativeWorkExecutionRecord, parseNativeWorkExecutionIntent, parseNativeWorkExecutionRecordJson, parseNativeWorkExecutionIntentJson, nativeExecutionStorageKey, type NativeExecutionOriginal, type NativeWorkExecutionIntent, type NativeWorkExecutionRecord, type NativeWorkExecutionMutation, type NativeWorkExecutionStorage, type NativeWorkExecutionTransaction } from '../workflow/work-ledger/native-execution-types.js';

type Lookup = DurableContractKey | { readonly attemptId: string };
type SqlReader = Pick<SqlDatabase, 'exec'>;
const settlementApply = Reflect.apply, settlementGet = WeakMap.prototype.get, settlementSet = WeakMap.prototype.set, freezeSettlement = Object.freeze;
interface SettlementSource { readonly receipt: NativeWorkSettlementReceipt; readonly publication: NativeWorkSettlementPublication; readonly runnerReceipt: DurableContractReceipt }
// Exact publication data is retained only by the actual immutable native
// request owner. Independent saved adoption validates its commitment once;
// copied public JSON cannot acquire this source lifetime.
const settlementSources = new WeakMap<DurableContractRequest, SettlementSource>();
// Full-schema validation executes inside this exact synchronous storage read.
// Retain only its existing immutable native original, never prompt/body copies.
// Nested reads restore the prior context even when validation throws.
let validationOriginal: NativeExecutionOriginal | undefined;
function withValidationOriginal<T>(original: NativeExecutionOriginal | undefined, read: () => T): T {
  const previous = validationOriginal;
  validationOriginal = original;
  try { return read(); } finally { validationOriginal = previous; }
}

const historicalSettlementKeys = new WeakMap<DurableContractRequest, string>();
function oldSettlementKey(record: NativeWorkExecutionRecord): string {
  if (record.version === 1) return nativeExecutionStorageKey(record);
  const held = settlementApply(settlementGet, historicalSettlementKeys, [record.request]) as string | undefined;
  if (held) return held;
  const key = durableKeyHash(record.request.key); settlementApply(settlementSet, historicalSettlementKeys, [record.request, key]); return key;
}
function historicalReceiptMatches(record: NativeWorkExecutionRecord, digest: string, candidate?: SettlementSource): boolean {
  const expected = (settlementApply(settlementGet, settlementSources, [record.request]) as SettlementSource | undefined) ?? candidate;
  if (expected) return expected.receipt.version === 1 && expected.receipt.receiptDigest === digest && isDeepStrictEqual(expected.runnerReceipt, record.receipt);
  return nativeSettlementDigest(record.receipt) === digest;
}
function retainSettlement(record: NativeWorkExecutionRecord, receipt: NativeWorkSettlementReceipt, publication: NativeWorkSettlementPublication, candidate?: SettlementSource): NativeWorkSettlementReceipt {
  const original = settlementApply(settlementGet, settlementSources, [record.request]) as SettlementSource | undefined;
  const expected = original ?? candidate;
  if (expected) {
    if (!isDeepStrictEqual(expected.receipt, receipt) || !isDeepStrictEqual(expected.publication, publication) || !isDeepStrictEqual(expected.runnerReceipt, record.receipt)) throw new NativeWorkExecutionError('invalid');
    return expected.receipt;
  }
  if (nativeSettlementPublicationCommitment(publication) !== receipt.publicationDigest) throw new NativeWorkExecutionError('invalid');
  const pending: unknown[] = [receipt, publication];
  while (pending.length) { const value = pending.pop(); if (!value || typeof value !== 'object') continue; for (const child of Object.values(value)) pending.push(child); freezeSettlement(value); }
  settlementApply(settlementSet, settlementSources, [record.request, { receipt, publication, runnerReceipt: record.receipt! }]); return receipt;
}
export function createNativeWorkExecutionTable(db: Pick<SqlDatabase, 'run'>): void {
  db.run('CREATE TABLE IF NOT EXISTS native_work_executions (project_id TEXT NOT NULL, key_hash TEXT NOT NULL, format_version INTEGER NOT NULL, state_json TEXT NOT NULL, attempt_id TEXT NOT NULL, PRIMARY KEY(project_id, key_hash), UNIQUE(project_id, attempt_id))');
}
export function createNativeWorkExecutionIntentTable(db: Pick<SqlDatabase, 'run'>): void {
  db.run('CREATE TABLE IF NOT EXISTS native_work_execution_intents (project_id TEXT NOT NULL, attempt_id TEXT NOT NULL, format_version INTEGER NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(project_id, attempt_id))');
}
/** DB settlement migration composes after the intake schema. Existing execution/intent formats are unchanged. */
export function createNativeWorkSettlementTable(db: Pick<SqlDatabase, 'run'>): void {
  db.run('CREATE TABLE IF NOT EXISTS native_work_execution_settlements (project_id TEXT NOT NULL, key_hash TEXT NOT NULL, format_version INTEGER NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(project_id, key_hash))');
  createNativeWorkSettlementTargetIndex(db);
}
/** Index the actual historical target lookup; fresh/no-settlement reads must
 * not scan all completed project settlements merely to avoid a key digest. */
export function createNativeWorkSettlementTargetIndex(db: Pick<SqlDatabase, 'run'>): void {
  db.run("CREATE INDEX IF NOT EXISTS native_work_settlement_targets ON native_work_execution_settlements(project_id,format_version,json_extract(state_json, '$.target.attemptId'))");
}
export function validateNativeWorkSettlementTable(db: SqlReader): void {
  validateColumns(db, 'native_work_execution_settlements', knowledgeSchemaColumns.settlement);
  // One validation pass reads one database image, so each project's ledger is parsed and
  // replayed once rather than once per settlement. Each settlement still indexes the full
  // history by its own sequences.
  const ledgers = new Map<string, WorkLedgerState>();
  for (const row of db.exec('SELECT project_id, key_hash, format_version, state_json FROM native_work_execution_settlements')[0]?.values ?? []) {
    const receipt = nativeWorkSettlementSchema.parse(JSON.parse(String(row[3])));
    if (row[0] !== receipt.projectId || row[1] !== nativeSettlementStorageKey(receipt) || row[2] !== receipt.version) throw new NativeWorkExecutionError('invalid');
    const current = read(db, receipt.projectId, { attemptId: receipt.target.attemptId }, nativeExecutionOriginalFor(validationOriginal, receipt.projectId, receipt.target.attemptId), undefined, ledgers);
    if (!current.settlement || !isDeepStrictEqual(current.settlement, receipt)) throw new NativeWorkExecutionError('invalid');
  }
}
/** Validate every existing authority row before admitting the additive schema. */
export function migrateNativeWorkSettlementTable(db: Pick<SqlDatabase, 'exec' | 'run'>): void {
  for (const row of db.exec('SELECT project_id,format_version,revision,state_json FROM work_ledgers')[0]?.values ?? []) {
    const ledger = readWorkLedgerState(readKnowledgeWorkLedgerImage(db, String(row[0]), row[1], row[3]), String(row[0]));
    if (row[2] !== ledger.revision) throw new NativeWorkExecutionError('invalid');
  }
  validateNativeWorkExecutionTable(db); validateNativeWorkExecutionIntentTable(db);
  createNativeWorkSettlementTable(db); validateNativeWorkSettlementTable(db);
  for (const row of db.exec('SELECT project_id,attempt_id FROM native_work_executions')[0]?.values ?? []) read(db, String(row[0]), { attemptId: String(row[1]) });
}
function validateColumns(db: SqlReader, table: string, expected: readonly (readonly (string | number)[])[]): void {
  const rows = db.exec(`PRAGMA table_info(${table})`)[0]?.values;
  if (!rows || rows.length !== expected.length || expected.some(([name, type, required, primary]) => {
    const row = rows.find(value => value[1] === name); return !row || row[2] !== type || row[3] !== required || row[5] !== primary;
  })) throw new NativeWorkExecutionError('invalid');
}
export function validateNativeWorkExecutionTable(db: SqlReader): void {
  validateColumns(db, 'native_work_executions', knowledgeSchemaColumns.execution);
  // A same-shaped table without attempt uniqueness is not an execution authority.
  const indexes = db.exec('PRAGMA index_list(native_work_executions)')[0]?.values ?? [];
  if (!indexes.some(index => index[2] === 1 && index[4] === 0
    && JSON.stringify(db.exec(`PRAGMA index_info('${String(index[1]).replaceAll("'", "''")}')`)[0]?.values.map(row => row[2])) === JSON.stringify(executionAttemptColumns))) throw new NativeWorkExecutionError('invalid');
}
export function validateNativeWorkExecutionIntentTable(db: SqlReader): void {
  validateColumns(db, 'native_work_execution_intents', knowledgeSchemaColumns.intent);
  for (const row of db.exec('SELECT project_id, attempt_id, format_version, state_json FROM native_work_execution_intents')[0]?.values ?? []) {
    const intent = parseNativeWorkExecutionIntentJson(String(row[3]), nativeExecutionOriginalFor(validationOriginal, String(row[0]), String(row[1])));
    if (row[0] !== intent.projectId || row[1] !== intent.target.attemptId || row[2] !== intent.version) throw new NativeWorkExecutionError('invalid');
  }
}
function readRecord(db: SqlReader, projectId: string, key: Lookup, original?: NativeExecutionOriginal): NativeWorkExecutionRecord | null {
  // attempt_id already has a real unique constraint. Querying it avoids
  // hashing the public key merely to discover the original saved format.
  const rows = db.exec('SELECT format_version, state_json, attempt_id, key_hash FROM native_work_executions WHERE project_id = ? AND attempt_id = ?', [projectId, key.attemptId])[0]?.values ?? [];
  if (rows.length > 1) throw new NativeWorkExecutionError('invalid');
  const row = rows[0], record = row ? parseNativeWorkExecutionRecordJson(String(row[1]), original) : null;
  if (record && (row?.[0] !== record.version || row?.[2] !== record.target.attemptId || record.target.attemptId !== key.attemptId || record.projectId !== projectId
    || nativeExecutionStorageKey(record) !== row?.[3] || ('workId' in key && durableKeyIdentity(record.request.key) !== durableKeyIdentity(key)))) throw new NativeWorkExecutionError('invalid');
  return record;
}
const sameScopes = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((scope, index) => scope === [...b].sort()[index]);
function sameFacts(a: NativeWorkExecutionIntent | NativeWorkExecutionRecord, b: NativeWorkExecutionIntent | NativeWorkExecutionRecord): boolean {
  return a.version === b.version && isDeepStrictEqual(a.owner, b.owner) && a.projectId === b.projectId && sameDurableRequest(a.request, b.request)
    && Object.keys(a.target).every(key => a.target[key as keyof typeof a.target] === b.target[key as keyof typeof b.target]) && sameScopes(a.authorityScopes, b.authorityScopes);
}
/**
 * The last ledger image each project's reads validated, kept deeply frozen,
 * per database: the key is the database handle (one per open store, so two
 * copies of a knowledge database never share an entry), then the project,
 * and an entry is reused only for the same format, revision and row text. A
 * format 3 ledger keeps its events in another table, so the row text alone
 * does not tell two physical histories apart; the database does. Different
 * bytes (another writer, a restored file) are validated in full.
 */
const validatedLedgers = new WeakMap<object, Map<string, { readonly format: unknown; readonly image: string; readonly ledger: WorkLedgerState }>>();
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
}
function validatedLedger(db: SqlReader, projectId: string, format: unknown, image: string): WorkLedgerState {
  let projects = validatedLedgers.get(db);
  if (projects === undefined) validatedLedgers.set(db, projects = new Map());
  const known = projects.get(projectId);
  // A format 3 row names its revision and its events are only appended, so in
  // one database the same format and row text is the same ledger.
  if (known && known.format === format && known.image === image) return known.ledger;
  const ledger = deepFreeze(readWorkLedgerState(readKnowledgeWorkLedgerImage(db, projectId, format, image), projectId));
  projects.set(projectId, { format, image, ledger });
  return ledger;
}
/**
 * One storage's last validated ledger, keyed by the ledger's own format and
 * revision columns. Every ledger write moves the revision (or, for a format
 * upgrade, the format), so equal columns mean the same ledger: a read then
 * selects two integers instead of the ledger's bytes.
 */
interface LedgerRevisionCache { entry?: { readonly version: unknown; readonly revision: unknown; readonly ledger: WorkLedgerState } }
function readLedger(db: SqlReader, projectId: string, cache?: LedgerRevisionCache): WorkLedgerState {
  const head = db.exec('SELECT format_version, revision FROM work_ledgers WHERE project_id = ?', [projectId])[0]?.values[0];
  if (!head) return createEmptyWorkLedgerState(projectId);
  const kept = cache?.entry;
  if (kept && kept.version === head[0] && kept.revision === head[1]) return kept.ledger;
  const image = db.exec('SELECT state_json FROM work_ledgers WHERE project_id = ?', [projectId])[0]?.values[0]?.[0];
  if (image === undefined) throw new NativeWorkExecutionError('invalid');
  const ledger = validatedLedger(db, projectId, head[0], String(image));
  if (head[1] !== ledger.revision) throw new NativeWorkExecutionError('invalid');
  if (cache) cache.entry = { version: head[0], revision: head[1], ledger };
  return ledger;
}
function read(db: SqlReader, projectId: string, key: Lookup, original?: NativeExecutionOriginal, candidate?: SettlementSource, ledgers?: Map<string, WorkLedgerState>, cache?: LedgerRevisionCache): NativeWorkExecutionTransaction {
  let ledger = ledgers?.get(projectId);
  if (!ledger) {
    ledger = readLedger(db, projectId, cache);
    ledgers?.set(projectId, ledger);
  }
  const record = readRecord(db, projectId, key, original);
  const rows = db.exec('SELECT format_version, state_json FROM native_work_execution_intents WHERE project_id = ? AND attempt_id = ?', [projectId, key.attemptId])[0]?.values ?? [];
  if (rows.length > 1) throw new NativeWorkExecutionError('invalid');
  const row = rows[0];
  const intent = row ? parseNativeWorkExecutionIntentJson(String(row[1]), record ?? original) : null;
  if (intent && (row?.[0] !== intent.version || intent.projectId !== projectId || intent.target.attemptId !== key.attemptId)) throw new NativeWorkExecutionError('invalid');
  if (intent && record && (!sameFacts(intent, record) || !['associated', 'cancelled'].includes(intent.state) || (intent.state === 'cancelled' && record.state !== 'cancelled'))) throw new NativeWorkExecutionError('invalid');
  // An associated intent with a missing execution is preserved for explicit host recovery.
  let settlementRow = record ? db.exec('SELECT format_version,state_json,key_hash FROM native_work_execution_settlements WHERE project_id = ? AND key_hash = ?', [projectId, `v2:${durableKeyIdentity(record.request.key)}`])[0]?.values[0] : undefined;
  // Query actual old target metadata before considering its historical index
  // recipe. Fresh projects/attempts need no digest to search absent old state.
  // JSON lookup already belongs to the actual KnowledgeStore SQLite protocol.
  if (!settlementRow && record) {
    const old = db.exec("SELECT format_version,state_json,key_hash FROM native_work_execution_settlements WHERE project_id = ? AND format_version = 1 AND json_extract(state_json, '$.target.attemptId') = ?", [projectId, record.target.attemptId])[0]?.values ?? [];
    if (old.length > 1) throw new NativeWorkExecutionError('invalid');
    settlementRow = old[0];
  }
  let settlement = settlementRow ? nativeWorkSettlementSchema.parse(JSON.parse(String(settlementRow[1]))) : null;
  if (!settlement && record && settlementApply(settlementGet, settlementSources, [record.request])) throw new NativeWorkExecutionError('invalid');
  if (settlement) {
    if (!record?.receipt || settlementRow?.[0] !== settlement.version || settlementRow?.[2] !== nativeSettlementStorageKey(settlement) || settlement.projectId !== projectId
      || settlement.payloadRevision !== durablePayloadRevision(record.request) || !isDeepStrictEqual(settlement.target, record.target)
      || settlement.contractId !== record.receipt.contractId || settlement.evidenceSequence !== settlement.reportSequence + 1) throw new NativeWorkExecutionError('invalid');
    if (settlement.version === 1 ? settlement.keyHash !== oldSettlementKey(record) || !historicalReceiptMatches(record, settlement.receiptDigest, candidate)
      : !isDeepStrictEqual(settlement.receipt, record.receipt)) throw new NativeWorkExecutionError('invalid');
    const report = ledger.history[settlement.reportSequence - 1], evidence = ledger.history[settlement.evidenceSequence - 1];
    const reportedAttempt = report?.type === 'report' ? report.attempts.find(attempt => attempt.id === record.target.attemptId) : undefined;
    if (!report || report.type !== 'report' || report.requestId !== settlement.reportRequestId || report.workId !== record.target.workId || report.attemptId !== record.target.attemptId
      || !reportedAttempt || reportedAttempt.workId !== record.target.workId || typeof reportedAttempt.report !== 'string'
      || reportedAttempt.state !== 'complete' || report.work.id !== record.target.workId || report.work.currentAttemptId !== record.target.attemptId || report.work.reportedState !== 'complete'
      || !evidence || evidence.type !== 'record_evidence' || evidence.requestId !== settlement.evidenceRequestId || evidence.attemptId !== record.target.attemptId || evidence.evidence?.id !== settlement.evidenceId
      || !isDeepStrictEqual(evidence.evidence.target, settlement.targetAfterReport)
      || !isDeepStrictEqual({ outcome: evidence.evidence.outcome, reason: evidence.evidence.reason, references: evidence.evidence.references, source: evidence.evidence.source, criteriaResults: evidence.evidence.criteriaResults }, settlement.attestation)
      // The host's status reports before the settlement (waiting for the owner, going on) moved both revisions too.
      || settlement.targetAfterReport.workRevision !== record.target.workRevision + 1 + nativeStatusReports(ledger.history, record.target.workId, record.target.attemptId, settlement.reportSequence - 1)
      || settlement.targetAfterReport.attemptRevision !== record.target.attemptRevision + 1 + nativeStatusReports(ledger.history,record.target.workId, record.target.attemptId, settlement.reportSequence - 1)
      || settlement.targetAfterReport.criteriaRevision !== record.target.criteriaRevision || settlement.targetAfterReport.workId !== record.target.workId || settlement.targetAfterReport.attemptId !== record.target.attemptId
      || report.actorId !== evidence.actorId || evidence.evidence.actorId !== report.actorId || reportedAttempt.ownerId !== report.actorId
      || settlement.attestation.source !== 'host_check' || settlement.attestation.criteriaResults.length !== record.request.input.nativeSource!.criteria.length
      || settlement.attestation.criteriaResults.some((item, index) => item.criterionIndex !== index)
      || report.work.goal !== record.request.input.nativeSource!.goal || !isDeepStrictEqual(report.work.criteria, record.request.input.nativeSource!.criteria)
      || report.work.revision !== settlement.targetAfterReport.workRevision || report.work.criteriaRevision !== settlement.targetAfterReport.criteriaRevision || reportedAttempt.revision !== settlement.targetAfterReport.attemptRevision) throw new NativeWorkExecutionError('invalid');
    if (settlement.version === 1) {
      const legacy = settlement;
      if (report.requestId !== `native-report:${legacy.keyHash}` || evidence.requestId !== `native-evidence:${legacy.keyHash}` || legacy.evidenceId !== `native-evidence-${legacy.keyHash}`
        || !legacy.attestation.references.some(item => item.ref === `execution:${legacy.contractId}` && item.digest === legacy.contractDigest)
        || !legacy.attestation.references.some(item => item.ref === `receipt:${legacy.contractId}` && item.digest === legacy.receiptDigest)
        ) throw new NativeWorkExecutionError('invalid');
      settlement = retainSettlement(record, legacy, { report: reportedAttempt.report, attestation: legacy.attestation, receiptDigest: legacy.receiptDigest, contractDigest: legacy.contractDigest, actorId: report.actorId }, candidate);
    } else {
      const current = settlement;
      if (!/^native-report-v2:[0-9a-p]{8}(?:-[0-9a-p]{4}){3}-[0-9a-p]{12}$/.test(report.requestId) || !/^native-evidence-v2:[0-9a-p]{8}(?:-[0-9a-p]{4}){3}-[0-9a-p]{12}$/.test(evidence.requestId) || current.evidenceId !== evidence.requestId
        || !current.attestation.references.some(item => item.ref === `execution:${current.contractId}`)
        || !current.attestation.references.some(item => item.ref === `receipt:${current.contractId}`)
        || (record.owner && record.owner.principalId !== report.actorId)) throw new NativeWorkExecutionError('invalid');
      settlement = retainSettlement(record, current, { version: 2, report: reportedAttempt.report, attestation: current.attestation, receipt: current.receipt, actorId: report.actorId }, candidate);
    }
  }
  return { ledger, record, intent, settlement };
}
function assertCurrentTarget(current: NativeWorkExecutionTransaction, intent: NativeWorkExecutionIntent): void {
  const target = intent.target;
  const work = current.ledger.works.find(item => item.id === target.workId);
  const attempt = current.ledger.attempts.find(item => item.id === target.attemptId);
  if (!work || !attempt || attempt.workId !== work.id || work.currentAttemptId !== attempt.id
    || !nativeTargetMatches(current.ledger.history,target, work, attempt)
    || attempt.state !== 'active' || work.reportedState === 'cancelled' || work.reportedState === 'complete'
    || work.title !== intent.request.input.ask || work.goal !== intent.request.input.nativeSource?.goal
    || JSON.stringify(work.criteria) !== JSON.stringify(intent.request.input.nativeSource.criteria)
    || (work.source !== null && (work.source.sourceId !== intent.request.input.nativeSource.sourceId
      || work.source.sourceRevision !== intent.request.input.nativeSource.sourceRevision
      // The work's own session (`<asking session>:<work id>`), or the asking session itself for a request kept before;
      // never another work's or another asking session's (workflow/work-ledger/native-work-session.ts).
      || !isNativeWorkSession(intent.request.input.sessionId, work.source.sessionId, work.id)))) throw new NativeWorkExecutionError('stale');
}
function validateIntentTransition(current: NativeWorkExecutionTransaction, next: NativeWorkExecutionIntent): void {
  try { checkIntentTransition(current, next); }
  catch (error) {
    if (error instanceof NativeWorkExecutionError && error.code === 'conflict' && error.constructor === NativeWorkExecutionError) {
      throw new NativeExecutionMoveRefused('conflict', executionIntentMoveText(current.intent?.state ?? null, next.state, !!current.intent && !sameFacts(current.intent, next)));
    }
    throw error;
  }
}
function checkIntentTransition(current: NativeWorkExecutionTransaction, next: NativeWorkExecutionIntent): void {
  const previous = current.intent;
  if (!previous) {
    if (next.generation !== 1 || !['admitting', 'cancelled'].includes(next.state) || current.record) throw new NativeWorkExecutionError('conflict');
    assertCurrentTarget(current, next);
    return;
  }
  if (!sameFacts(previous, next)) throw new NativeWorkExecutionError('conflict');
  if (previous.state === 'cancelled' && (next.state !== 'cancelled' || next.generation !== previous.generation)) throw new NativeWorkExecutionError('prevented-before-admission');
  if (next.generation !== previous.generation) {
    if (next.generation !== previous.generation + 1 || next.state !== 'admitting' || !['admitting', 'refused'].includes(previous.state)) throw new NativeWorkExecutionError('conflict');
    assertCurrentTarget(current, next);
  } else if ((previous.state === 'associated' && !['associated', 'cancelled'].includes(next.state))
    || (previous.state === 'refused' && !['refused', 'cancelled'].includes(next.state))) throw new NativeWorkExecutionError('conflict');
}
/** One owner and one existing KnowledgeStore database; no observer launches work. */
export function createNativeWorkExecutionStorage(sqlite: SQLiteStore, projectId: string, refresh: () => void, beforeV2Write?: () => void, beforeCiV2Write?: () => void, beforeSettlementV2Write?: () => void): NativeWorkExecutionStorage {
  createEmptyWorkLedgerState(projectId);
  let closed = false; const pending = new Set<Promise<unknown>>(); let closing: Promise<void> | undefined;
  // Filled only by reads of committed state, never by a read after a write in an open transaction.
  const ledgerCache: LedgerRevisionCache = {};
  function transaction<T>(key: Lookup, decide: (current: NativeWorkExecutionTransaction) => NativeWorkExecutionMutation<T>, afterDurable?: (value: T, current: () => NativeWorkExecutionTransaction) => void, original?: NativeExecutionOriginal): Promise<T> {
    if (closed) return Promise.reject(new NativeWorkExecutionError('closed'));
    const lookup = { ...key };
    if (!lookup.attemptId || typeof lookup.attemptId !== 'string') return Promise.reject(new NativeWorkExecutionError('invalid'));
    let publishedOriginal = original;
    const work = sqlite.transactPersisted(db => {
      const current = read(db, projectId, lookup, original, undefined, undefined, ledgerCache);
      // Parsed execution/intent sources are deeply immutable native originals.
      // Preserve their validation provenance while detaching mutable ledger and
      // historical settlement data from the transaction comparison baseline.
      const result = decide({ ...current, ledger: structuredClone(current.ledger), ...(current.settlement ? { settlement: structuredClone(current.settlement) } : {}) });
      if (result && typeof (result as unknown as { then?: unknown }).then === 'function') {
        if (result instanceof Promise) void result.catch(() => {});
        throw new NativeWorkExecutionError('invalid');
      }
      if (!result || !('next' in result)) throw new NativeWorkExecutionError('invalid');
      if (result.removeIntent === true) {
        // Only an admission that admitted nothing is removed: no record, and the intent still admitting.
        if (result.next !== null || result.nextIntent != null) throw new NativeWorkExecutionError('invalid');
        if (current.record || current.intent?.state !== 'admitting') throw new NativeWorkExecutionError('conflict');
        db.run('DELETE FROM native_work_execution_intents WHERE project_id=? AND attempt_id=?', [projectId, current.intent.target.attemptId]);
        publishedOriginal = original;
        return { changed: true, value: result.value };
      }
      const next = result.next === null ? null : parseNativeWorkExecutionRecord(result.next, current.record ?? current.intent ?? original);
      const nextIntent = result.nextIntent == null ? null : parseNativeWorkExecutionIntent(result.nextIntent, current.intent ?? current.record ?? original);
      for (const item of [next, nextIntent]) {
        if (item && (item.projectId !== projectId || item.target.attemptId !== lookup.attemptId || ('workId' in lookup && durableKeyIdentity(item.request.key) !== durableKeyIdentity(lookup)))) throw new NativeWorkExecutionError('invalid');
      }
      const bound = current.record;
      if (next && bound && durableKeyIdentity(bound.request.key) !== durableKeyIdentity(next.request.key)) throw new NativeWorkExecutionError('conflict');
      if (nextIntent && bound && !current.intent) throw new NativeWorkExecutionError('conflict');
      if (nextIntent) validateIntentTransition(current, nextIntent);
      if (nextIntent?.state === 'associated' && current.intent?.state === 'admitting') assertCurrentTarget(current, nextIntent);
      const resultingIntent = nextIntent ?? current.intent;
      const resultingRecord = next ?? current.record;
      // A claimed launch is never re-armed: `prepared` is launchable, so moving back could launch twice.
      if (next && current.record && (!sameFacts(current.record, next) || (current.record.state === 'cancelled' && next.state !== 'cancelled')
        || (current.record.state === 'launch-claimed' && next.state === 'prepared'))) throw new NativeExecutionMoveRefused('conflict', executionRecordMoveText(current.record.state, next.state, !sameFacts(current.record, next)));
      if (next && !current.record && (!nextIntent || nextIntent.state !== 'associated' || current.intent?.state !== 'admitting')) throw new NativeWorkExecutionError(current.intent?.state === 'associated' ? 'recovery-required' : 'conflict');
      if (resultingIntent && resultingRecord && (!sameFacts(resultingIntent, resultingRecord) || !['associated', 'cancelled'].includes(resultingIntent.state)
        || (resultingIntent.state === 'cancelled' && resultingRecord.state !== 'cancelled'))) throw new NativeWorkExecutionError('conflict');
      if (nextIntent?.state === 'associated' && !resultingRecord) throw new NativeWorkExecutionError('recovery-required');
      publishedOriginal = next ?? nextIntent ?? current.record ?? current.intent ?? original;
      if (nextIntent?.version === 2 || next?.version === 2) {
        assertSynchronousJudgmentGuard(beforeV2Write, () => new NativeWorkExecutionError('invalid'));
      }
      if (nextIntent) db.run('INSERT INTO native_work_execution_intents(project_id,attempt_id,format_version,state_json) VALUES (?,?,?,?) ON CONFLICT(project_id,attempt_id) DO UPDATE SET format_version=excluded.format_version,state_json=excluded.state_json', [projectId, nextIntent.target.attemptId, nextIntent.version, JSON.stringify(nextIntent)]);
      if (next) db.run('INSERT INTO native_work_executions(project_id,key_hash,format_version,state_json,attempt_id) VALUES (?,?,?,?,?) ON CONFLICT(project_id,key_hash) DO UPDATE SET format_version=excluded.format_version,state_json=excluded.state_json', [projectId, nativeExecutionStorageKey(next), next.version, JSON.stringify(next), next.target.attemptId]);
      return { changed: next !== null || nextIntent !== null, value: result.value };
    }, refresh, afterDurable ? (value, db) => afterDurable(value, () => read(db, projectId, lookup, publishedOriginal, undefined, undefined, ledgerCache)) : undefined).then(result => {
      if (result.kind !== 'completed') throw new NativeWorkExecutionError('unavailable'); return result.value;
    });
    pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
  }
  return {
    continuations: createNativeCiContinuationStorage(sqlite, projectId, refresh, (db, key, original) => read(db, projectId, key, original), beforeCiV2Write),
    revision: () => sqlite.contentRevision(),
    current(key, original) { if (closed) throw new NativeWorkExecutionError('closed'); return withValidationOriginal(original, () => sqlite.readPersisted(db => read(db, projectId, key, original, undefined, undefined, ledgerCache))); },
    currentByAttempt(attemptId, original) { if (closed) throw new NativeWorkExecutionError('closed'); if (!attemptId || typeof attemptId !== 'string') throw new NativeWorkExecutionError('invalid'); return withValidationOriginal(original, () => sqlite.readPersisted(db => read(db, projectId, { attemptId }, original, undefined, undefined, ledgerCache))); },
    transaction,
    transactionByAttempt(attemptId, decide, afterDurable, original) { return transaction({ attemptId }, decide, afterDurable, original); },
    settle(key, decide, assertCurrent, original) {
      if (closed) return Promise.reject(new NativeWorkExecutionError('closed'));
      const lookup = { ...key }; durableKeyIdentity(lookup);
      let actualSource: NativeWorkExecutionRecord | undefined, candidate: SettlementSource | undefined;
      const operation = sqlite.transactPersisted(db => {
        const current = read(db, projectId, lookup, original, undefined, undefined, ledgerCache); actualSource = current.record ?? undefined;
        const proposed = decide({ ...current, ledger: structuredClone(current.ledger) });
        if (proposed && typeof (proposed as unknown as { then?: unknown }).then === 'function') { drainOwned(proposed); throw new NativeWorkExecutionError('invalid'); }
        const publication = proposed === null ? null : captureNativeSettlementPublication(proposed);
        if (current.settlement) {
          if (publication !== null && nativeSettlementPublicationCommitment(publication) !== current.settlement.publicationDigest) throw new NativeWorkExecutionError('conflict');
          return { changed: false, value: current.settlement };
        }
        const record = current.record;
        if (!publication || !record?.receipt || record.state !== 'launch-claimed' || (current.intent !== null && current.intent.state !== 'associated')) throw new NativeWorkExecutionError('stale');
        if (publication.version === 2 ? !isDeepStrictEqual(publication.receipt, record.receipt)
          : publication.receiptDigest !== nativeSettlementDigest(record.receipt)) throw new NativeWorkExecutionError('conflict');
        assertCurrent();
        const oldKey = publication.version === 2 ? undefined : oldSettlementKey(record);
        const reportRequestId = publication.version === 2 ? `native-report-v2:${crypto.randomUUID()}` : `native-report:${oldKey}`;
        const evidenceRequestId = publication.version === 2 ? `native-evidence-v2:${crypto.randomUUID()}` : `native-evidence:${oldKey}`;
        const evidenceId = publication.version === 2 ? evidenceRequestId : `native-evidence-${oldKey}`;
        const at = Math.max(Date.now(), current.ledger.history.at(-1)?.at ?? 0);
        const reduced = reduceWorkLedgerSettlement(current.ledger, { target: record.target, report: publication.report, attestation: publication.attestation,
          actorId: publication.actorId, reportRequestId, evidenceRequestId }, { now: () => at, newId: () => evidenceId });
        const receipt = nativeWorkSettlementSchema.parse({ ...(publication.version === 2 ? { version: 2, receipt: publication.receipt } : { version: 1, keyHash: oldKey, receiptDigest: publication.receiptDigest, contractDigest: publication.contractDigest }),
          projectId, payloadRevision: durablePayloadRevision(record.request), target: record.target, contractId: record.receipt.contractId,
          publicationDigest: nativeSettlementPublicationCommitment(publication), reportRequestId, evidenceRequestId,
          reportSequence: reduced.report.sequence, evidenceSequence: reduced.evidence.sequence,
          evidenceId: reduced.evidence.evidence!.id, targetAfterReport: reduced.evidence.evidence!.target, attestation: publication.attestation });
        candidate = { receipt, publication, runnerReceipt: record.receipt };
        if (receipt.version === 2) {
          assertSynchronousJudgmentGuard(beforeSettlementV2Write, () => new NativeWorkExecutionError('invalid'));
        }
        // Last owner/cancellation/artifact observation follows every reducer,
        // clock and format callback. Candidate comparison below is not adoption
        // of durable source: only the actual afterDurable image may retain it.
        assertCurrent();
        writeKnowledgeWorkLedger(db, reduced.state);
        db.run('INSERT INTO native_work_execution_settlements(project_id,key_hash,format_version,state_json) VALUES (?,?,?,?)', [projectId, nativeSettlementStorageKey(receipt), receipt.version, JSON.stringify(receipt)]);
        read(db, projectId, lookup, record, candidate);
        assertCurrent();
        return { changed: true, value: receipt };
      }, refresh, (receipt, db) => {
        const confirmed = read(db, projectId, lookup, actualSource ?? original, candidate);
        if (!confirmed.record || !confirmed.settlement || !isDeepStrictEqual(confirmed.settlement, receipt)) throw new NativeWorkExecutionError('invalid');
        if (candidate) {
          const pending: unknown[] = [candidate.receipt, candidate.publication];
          while (pending.length) { const value = pending.pop(); if (!value || typeof value !== 'object') continue; for (const child of Object.values(value)) pending.push(child); freezeSettlement(value); }
          settlementApply(settlementSet, settlementSources, [confirmed.record.request, candidate]);
        }
      }).then(result => { if (result.kind !== 'completed') throw new NativeWorkExecutionError('unavailable'); return result.value; });
      pending.add(operation); void operation.then(() => pending.delete(operation), () => pending.delete(operation)); return operation;
    },
    reportFailed(key, reason, original) {
      if (closed) return Promise.reject(new NativeWorkExecutionError('closed'));
      const lookup = { ...key }; durableKeyIdentity(lookup);
      const operation = sqlite.transactPersisted(db => {
        const current = read(db, projectId, lookup, original, undefined, undefined, ledgerCache);
        const record = current.record;
        // Only a launched run with no settlement, at its own target, while its work still reads in progress.
        if (!record?.receipt || current.settlement) return { changed: false, value: false };
        const work = current.ledger.works.find(item => item.id === record.target.workId);
        const attempt = current.ledger.attempts.find(item => item.id === record.target.attemptId);
        // A run waiting for the owner already says "blocked" with its wait; its failure replaces that.
        if (!work || !attempt || work.currentAttemptId !== attempt.id || (work.reportedState === 'blocked' && attempt.blocker === reason) || work.reportedState === 'complete' || work.reportedState === 'cancelled'
          || !nativeTargetMatches(current.ledger.history,record.target, work, attempt)) return { changed: false, value: false };
        const at = Math.max(Date.now(), current.ledger.history.at(-1)?.at ?? 0);
        const reduced = reduceWorkLedgerFailure(current.ledger, { target: record.target, actorId: attempt.ownerId, reason: reason.slice(0, 2000),
          requestId: `native-failed:${durableKeyIdentity(record.request.key)}` }, { now: () => at, newId: () => crypto.randomUUID() });
        writeKnowledgeWorkLedger(db, reduced.state);
        return { changed: true, value: true };
      }, refresh).then(result => { if (result.kind !== 'completed') throw new NativeWorkExecutionError('unavailable'); return result.value; });
      pending.add(operation); void operation.then(() => pending.delete(operation), () => pending.delete(operation)); return operation;
    },
    reportStopped(key, reason, original) {
      if (closed) return Promise.reject(new NativeWorkExecutionError('closed'));
      const lookup = { ...key }; durableKeyIdentity(lookup);
      const operation = sqlite.transactPersisted(db => {
        const current = read(db, projectId, lookup, original, undefined, undefined, ledgerCache);
        if (current.settlement) return { changed: false, value: false };
        const at = Math.max(Date.now(), current.ledger.history.at(-1)?.at ?? 0);
        const reduced = reduceWorkLedgerStopped(current.ledger, { workId: key.workId, attemptId: key.attemptId, reason: (reason || 'Stopped by the owner.').slice(0, 2000),
          requestId: `${NATIVE_STATUS_REQUEST_PREFIX}stop:${crypto.randomUUID()}` }, { now: () => at, newId: () => crypto.randomUUID() });
        if (!reduced.changed) return { changed: false, value: false };
        writeKnowledgeWorkLedger(db, reduced.state);
        return { changed: true, value: true };
      }, refresh).then(result => { if (result.kind !== 'completed') throw new NativeWorkExecutionError('unavailable'); return result.value; });
      pending.add(operation); void operation.then(() => pending.delete(operation), () => pending.delete(operation)); return operation;
    },
    reportBeforeRun(workId, attemptId, status, words) {
      if (closed) return Promise.reject(new NativeWorkExecutionError('closed'));
      const operation = sqlite.transactPersisted(db => {
        const current = read(db, projectId, { attemptId }, undefined, undefined, undefined, ledgerCache);
        // Only before any run of this attempt exists: once one does, the run says where it stands.
        if (current.record || current.intent) return { changed: false, value: false };
        const work = current.ledger.works.find(item => item.id === workId);
        const attempt = current.ledger.attempts.find(item => item.id === attemptId);
        if (!work || !attempt || work.currentAttemptId !== attempt.id || attempt.state !== 'active' || work.reportedState === 'complete' || work.reportedState === 'cancelled') return { changed: false, value: false };
        const bound = nativeBoundRevisions(current.ledger.history, work, attempt);
        const at = Math.max(Date.now(), current.ledger.history.at(-1)?.at ?? 0);
        const reduced = reduceWorkLedgerStatus(current.ledger, { target: { workId, workRevision: bound.workRevision, criteriaRevision: work.criteriaRevision, attemptId, attemptRevision: bound.attemptRevision },
          actorId: attempt.ownerId, state: status, words: words.slice(0, 2000), requestId: `${NATIVE_STATUS_REQUEST_PREFIX}${crypto.randomUUID()}` }, { now: () => at, newId: () => crypto.randomUUID() });
        if (!reduced.changed) return { changed: false, value: false };
        writeKnowledgeWorkLedger(db, reduced.state);
        return { changed: true, value: true };
      }, refresh).then(result => { if (result.kind !== 'completed') throw new NativeWorkExecutionError('unavailable'); return result.value; });
      pending.add(operation); void operation.then(() => pending.delete(operation), () => pending.delete(operation)); return operation;
    },
    reportStatus(key, status, words, original) {
      if (closed) return Promise.reject(new NativeWorkExecutionError('closed'));
      const lookup = { ...key }; durableKeyIdentity(lookup);
      const operation = sqlite.transactPersisted(db => {
        const current = read(db, projectId, lookup, original, undefined, undefined, ledgerCache);
        const record = current.record;
        // Only a launched run with no settlement, at its own target, while its work reads in progress or blocked.
        if (!record?.receipt || current.settlement || record.state === 'cancelled') return { changed: false, value: false };
        const work = current.ledger.works.find(item => item.id === record.target.workId);
        const attempt = current.ledger.attempts.find(item => item.id === record.target.attemptId);
        if (!work || !attempt || work.currentAttemptId !== attempt.id || attempt.state !== 'active' || work.reportedState === 'complete' || work.reportedState === 'cancelled'
          || !nativeTargetMatches(current.ledger.history,record.target, work, attempt)) return { changed: false, value: false };
        const at = Math.max(Date.now(), current.ledger.history.at(-1)?.at ?? 0);
        const reduced = reduceWorkLedgerStatus(current.ledger, { target: record.target, actorId: attempt.ownerId, state: status, words: words.slice(0, 2000),
          requestId: `${NATIVE_STATUS_REQUEST_PREFIX}${crypto.randomUUID()}` }, { now: () => at, newId: () => crypto.randomUUID() });
        // It says exactly this already: said.
        if (!reduced.changed) return { changed: false, value: true };
        writeKnowledgeWorkLedger(db, reduced.state);
        return { changed: true, value: true };
      }, refresh).then(result => { if (result.kind !== 'completed') throw new NativeWorkExecutionError('unavailable'); return result.value; });
      pending.add(operation); void operation.then(() => pending.delete(operation), () => pending.delete(operation)); return operation;
    },
    close() { closed = true; return closing ??= Promise.allSettled([...pending]).then(() => {}); },
  };
}
