import { isDeepStrictEqual } from 'node:util';
import { opaqueUuid, drainOwned } from '@goodvibes-jev/judgment/decisions';
import { knowledgeSchemaColumns, executionAttemptColumns } from './store-schema-validation-data.js';
import { createNativeCiContinuationStorage } from './store-native-ci-continuation.js';
import { nativeSettlementDigest, nativeWorkSettlementSchema, nativeSettlementStorageKey, captureNativeSettlementPublication, nativeSettlementPublicationCommitment, type NativeWorkSettlementReceipt, type NativeWorkSettlementPublication } from '../workflow/work-ledger/native-settlement-types.js';
import type { SQLiteStore, SqlDatabase } from '../state/sqlite-store.js';
import { durableKeyIdentity, durableKeyHash, durablePayloadRevision, sameDurableRequest, type DurableContractKey, type DurableContractRequest, type DurableContractReceipt } from '../contract/durable-admission.js';
import { readWorkLedgerState, createEmptyWorkLedgerState, reduceWorkLedgerSettlement } from '../workflow/work-ledger/service.js';
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
  for (const row of db.exec('SELECT project_id, key_hash, format_version, state_json FROM native_work_execution_settlements')[0]?.values ?? []) {
    const receipt = nativeWorkSettlementSchema.parse(JSON.parse(String(row[3])));
    if (row[0] !== receipt.projectId || row[1] !== nativeSettlementStorageKey(receipt) || row[2] !== receipt.version) throw new NativeWorkExecutionError('invalid');
    const current = read(db, receipt.projectId, { attemptId: receipt.target.attemptId }, nativeExecutionOriginalFor(validationOriginal, receipt.projectId, receipt.target.attemptId));
    if (!current.settlement || !isDeepStrictEqual(current.settlement, receipt)) throw new NativeWorkExecutionError('invalid');
  }
}
/** Validate every existing authority row before admitting the additive schema. */
export function migrateNativeWorkSettlementTable(db: Pick<SqlDatabase, 'exec' | 'run'>): void {
  for (const row of db.exec('SELECT project_id,format_version,revision,state_json FROM work_ledgers')[0]?.values ?? []) {
    const ledger = readWorkLedgerState(JSON.parse(String(row[3])), String(row[0]));
    if (row[1] !== ledger.version || row[2] !== ledger.revision) throw new NativeWorkExecutionError('invalid');
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
function read(db: SqlReader, projectId: string, key: Lookup, original?: NativeExecutionOriginal, candidate?: SettlementSource): NativeWorkExecutionTransaction {
  const ledgerRow = db.exec('SELECT format_version, revision, state_json FROM work_ledgers WHERE project_id = ?', [projectId])[0]?.values[0];
  const ledger = ledgerRow ? readWorkLedgerState(JSON.parse(String(ledgerRow[2])), projectId) : createEmptyWorkLedgerState(projectId);
  if (ledgerRow && (ledgerRow[0] !== ledger.version || ledgerRow[1] !== ledger.revision)) throw new NativeWorkExecutionError('invalid');
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
      || settlement.targetAfterReport.workRevision !== record.target.workRevision + 1 || settlement.targetAfterReport.attemptRevision !== record.target.attemptRevision + 1
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
      if (!/^native-report-v2:[a-p]{8}(?:-[a-p]{4}){3}-[a-p]{12}$/.test(report.requestId) || !/^native-evidence-v2:[a-p]{8}(?:-[a-p]{4}){3}-[a-p]{12}$/.test(evidence.requestId) || current.evidenceId !== evidence.requestId
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
    || work.revision !== target.workRevision || work.criteriaRevision !== target.criteriaRevision || attempt.revision !== target.attemptRevision
    || attempt.state !== 'active' || work.reportedState === 'cancelled' || work.reportedState === 'complete'
    || work.title !== intent.request.input.ask || work.goal !== intent.request.input.nativeSource?.goal
    || JSON.stringify(work.criteria) !== JSON.stringify(intent.request.input.nativeSource.criteria)
    || (work.source !== null && (work.source.sourceId !== intent.request.input.nativeSource.sourceId
      || work.source.sourceRevision !== intent.request.input.nativeSource.sourceRevision
      || work.source.sessionId !== intent.request.input.sessionId))) throw new NativeWorkExecutionError('stale');
}
function validateIntentTransition(current: NativeWorkExecutionTransaction, next: NativeWorkExecutionIntent): void {
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
  function transaction<T>(key: Lookup, decide: (current: NativeWorkExecutionTransaction) => NativeWorkExecutionMutation<T>, afterDurable?: (value: T, current: () => NativeWorkExecutionTransaction) => void, original?: NativeExecutionOriginal): Promise<T> {
    if (closed) return Promise.reject(new NativeWorkExecutionError('closed'));
    const lookup = { ...key };
    if (!lookup.attemptId || typeof lookup.attemptId !== 'string') return Promise.reject(new NativeWorkExecutionError('invalid'));
    let publishedOriginal = original;
    const work = sqlite.transactPersisted(db => {
      const current = read(db, projectId, lookup, original);
      // Parsed execution/intent sources are deeply immutable native originals.
      // Preserve their validation provenance while detaching mutable ledger and
      // historical settlement data from the transaction comparison baseline.
      const result = decide({ ...current, ledger: structuredClone(current.ledger), ...(current.settlement ? { settlement: structuredClone(current.settlement) } : {}) });
      if (result && typeof (result as unknown as { then?: unknown }).then === 'function') {
        if (result instanceof Promise) void result.catch(() => {});
        throw new NativeWorkExecutionError('invalid');
      }
      if (!result || !('next' in result)) throw new NativeWorkExecutionError('invalid');
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
      if (next && current.record && (!sameFacts(current.record, next) || (current.record.state === 'cancelled' && next.state !== 'cancelled'))) throw new NativeWorkExecutionError('conflict');
      if (next && !current.record && (!nextIntent || nextIntent.state !== 'associated' || current.intent?.state !== 'admitting')) throw new NativeWorkExecutionError(current.intent?.state === 'associated' ? 'recovery-required' : 'conflict');
      if (resultingIntent && resultingRecord && (!sameFacts(resultingIntent, resultingRecord) || !['associated', 'cancelled'].includes(resultingIntent.state)
        || (resultingIntent.state === 'cancelled' && resultingRecord.state !== 'cancelled'))) throw new NativeWorkExecutionError('conflict');
      if (nextIntent?.state === 'associated' && !resultingRecord) throw new NativeWorkExecutionError('recovery-required');
      publishedOriginal = next ?? nextIntent ?? current.record ?? current.intent ?? original;
      if (nextIntent?.version === 2 || next?.version === 2) {
        const declared: unknown = beforeV2Write?.();
        if (declared !== undefined) { drainOwned(declared); throw new NativeWorkExecutionError('invalid'); }
      }
      if (nextIntent) db.run('INSERT INTO native_work_execution_intents(project_id,attempt_id,format_version,state_json) VALUES (?,?,?,?) ON CONFLICT(project_id,attempt_id) DO UPDATE SET format_version=excluded.format_version,state_json=excluded.state_json', [projectId, nextIntent.target.attemptId, nextIntent.version, JSON.stringify(nextIntent)]);
      if (next) db.run('INSERT INTO native_work_executions(project_id,key_hash,format_version,state_json,attempt_id) VALUES (?,?,?,?,?) ON CONFLICT(project_id,key_hash) DO UPDATE SET format_version=excluded.format_version,state_json=excluded.state_json', [projectId, nativeExecutionStorageKey(next), next.version, JSON.stringify(next), next.target.attemptId]);
      return { changed: next !== null || nextIntent !== null, value: result.value };
    }, refresh, afterDurable ? (value, db) => afterDurable(value, () => read(db, projectId, lookup, publishedOriginal)) : undefined).then(result => {
      if (result.kind !== 'completed') throw new NativeWorkExecutionError('unavailable'); return result.value;
    });
    pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
  }
  return {
    continuations: createNativeCiContinuationStorage(sqlite, projectId, refresh, (db, key, original) => read(db, projectId, key, original), beforeCiV2Write),
    current(key, original) { if (closed) throw new NativeWorkExecutionError('closed'); return withValidationOriginal(original, () => sqlite.readPersisted(db => read(db, projectId, key, original))); },
    currentByAttempt(attemptId, original) { if (closed) throw new NativeWorkExecutionError('closed'); if (!attemptId || typeof attemptId !== 'string') throw new NativeWorkExecutionError('invalid'); return withValidationOriginal(original, () => sqlite.readPersisted(db => read(db, projectId, { attemptId }, original))); },
    transaction,
    transactionByAttempt(attemptId, decide, afterDurable, original) { return transaction({ attemptId }, decide, afterDurable, original); },
    settle(key, decide, assertCurrent, original) {
      if (closed) return Promise.reject(new NativeWorkExecutionError('closed'));
      const lookup = { ...key }; durableKeyIdentity(lookup);
      let actualSource: NativeWorkExecutionRecord | undefined, candidate: SettlementSource | undefined;
      const operation = sqlite.transactPersisted(db => {
        const current = read(db, projectId, lookup, original); actualSource = current.record ?? undefined;
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
        const reportRequestId = publication.version === 2 ? `native-report-v2:${opaqueUuid()}` : `native-report:${oldKey}`;
        const evidenceRequestId = publication.version === 2 ? `native-evidence-v2:${opaqueUuid()}` : `native-evidence:${oldKey}`;
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
          const declared: unknown = beforeSettlementV2Write?.(); if (declared !== undefined) { drainOwned(declared); throw new NativeWorkExecutionError('invalid'); }
        }
        // Last owner/cancellation/artifact observation follows every reducer,
        // clock and format callback. Candidate comparison below is not adoption
        // of durable source: only the actual afterDurable image may retain it.
        assertCurrent();
        db.run('INSERT INTO work_ledgers(project_id,format_version,revision,state_json) VALUES (?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET format_version=excluded.format_version,revision=excluded.revision,state_json=excluded.state_json', [projectId, reduced.state.version, reduced.state.revision, JSON.stringify(reduced.state)]);
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
    close() { closed = true; return closing ??= Promise.allSettled([...pending]).then(() => {}); },
  };
}
