/** Durable handoff facts; only the paired owner's private grant authorizes recovery. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types as nodeTypes } from 'node:util';
import { z } from 'zod/v4';
import { captureOwnedJson } from '../../gate/judgment-input.js';
import type { DurableContractKey, DurableContractRequest } from '../../contract/durable-admission.js';
import type { NativeExecutionOriginal, NativeWorkExecutionTransaction } from './native-execution-types.js';
import type { CiWatchSubscription, FixSessionBrief } from '../../ci-watch/types.js';
import { workLedgerExplicitSourceSchema, workLedgerOpaqueExplicitSourceSchema, workLedgerExtractedSourceSchema, type WorkLedgerSource } from './types.js';

const id = z.string().min(1).max(256), hash = z.string().regex(/^[0-9a-f]{64}$/), revision = z.number().int().nonnegative();
const key = z.strictObject({ workId: id, criteriaId: id, criteriaRevision: id, attemptId: id });
const target = z.strictObject({ workId: id, workRevision: revision, criteriaRevision: revision, attemptId: id, attemptRevision: revision });
const owner = { projectId: id, originalKey: key, originalPayloadRevision: hash, principalId: id, authorityRevision: id, authorityScopes: z.array(id).min(1), scopeId: id, scopeRevision: id };
const legacyIssue = z.strictObject({ ...owner, ledgerSourceRevision: hash, policyRevision: hash, seedRevision: hash });
const ledgerSource = z.union([workLedgerExplicitSourceSchema, workLedgerOpaqueExplicitSourceSchema, workLedgerExtractedSourceSchema.omit({ continuation: true })]);
const opaqueAttempt = z.string().regex(/^attempt-ci-[a-p]{8}(?:-[a-p]{4}){3}-[a-p]{12}$/);
const currentIssue = z.strictObject({ ...owner, ledgerSource, policyRevision: z.string().min(1).max(4096), successorAttemptId: opaqueAttempt, successorSourceBinding: hash });
const watchSchema = z.strictObject({ id, repo: id, ref: id.optional(), prNumber: z.number().int().positive().optional(), deliveryChannel: id,
  triggerFixSession: z.boolean(), createdAt: z.number().finite(), updatedAt: z.number().finite(), continuationId: id.optional() });
const schedulingWatchSchema = watchSchema.extend({ lastOverall: z.enum(['passed', 'failed', 'pending', 'unknown']).optional() });
const failureSchema = z.strictObject({ repo: id, ref: z.string().optional(), prNumber: z.number().int().positive().optional(), failingJobs: z.array(z.string()), logs: z.string(),
  jobs: z.array(z.strictObject({ headSha: z.string().optional(), runId: z.string().optional(), jobId: z.string().optional(), name: z.string(), status: z.enum(['queued', 'in_progress', 'completed']), conclusion: z.string().nullable(), continueOnError: z.boolean().optional(), url: z.string().optional() })).optional() });
const common = { id, grant: z.strictObject({ id, binding: hash }), watch: watchSchema.nullable(), state: z.enum(['issued', 'claimed', 'cancelled']), failureRevision: hash.nullable(), successor: target.nullable() };
const records = { 1: z.strictObject({ ...common, version: z.literal(1), issue: legacyIssue }), 2: z.strictObject({ ...common, version: z.literal(2), issue: currentIssue }) };
export type NativeCiContinuationIssue = z.infer<typeof legacyIssue> | z.infer<typeof currentIssue>;
export type NativeCiContinuationRecord = Readonly<z.infer<typeof records[1]> | z.infer<typeof records[2]>>;
const apply = Reflect.apply, get = WeakMap.prototype.get, set = WeakMap.prototype.set, has = WeakSet.prototype.has, add = WeakSet.prototype.add;
const freeze = Object.freeze, clone = structuredClone, parseJson = JSON.parse, isProxy = nodeTypes.isProxy;
const issuedIssues = new WeakMap<object, { digest?: string }>(), issuedWatches = new WeakMap<object, { digest?: string }>();
interface Origin { consumption?: string; legacySuccessor?: string; legacySource?: ReturnType<typeof nativeCiLedgerSourceMetadata> }
const origins = new WeakMap<NativeCiContinuationRecord, Origin>(), jsonRoots = new WeakSet<object>();
const origin = (value: NativeCiContinuationRecord) => apply(get, origins, [value]) as Origin | undefined;
function immutable(value: NativeCiContinuationRecord) { return { version: value.version, id: value.id, issue: value.issue, grant: value.grant }; }
function frozen<T>(value: T): T {
  const pending: unknown[] = [value], seen = new Set<object>();
  while (pending.length) { const node = pending.pop(); if (!node || typeof node !== 'object' || seen.has(node)) continue; seen.add(node); for (const child of Object.values(node)) pending.push(child); freeze(node); }
  return value;
}
/** Historical canonical recipe, retained only by named actual persisted
 * commitment consumers below and v1 compatibility. Never use for local equality. */
function nativeCiDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest('hex'); }
/** No transcript duplication: its complete source commitment and exact original
 * request context bind it; retain only source/extraction metadata here. */
export function nativeCiLedgerSourceMetadata(source: WorkLedgerSource) {
  if (source.version !== 2) return { ...source };
  const { continuation: _continuation, ...metadata } = source; return metadata;
}
export function captureNativeCiIssue(version: 1, value: unknown): z.infer<typeof legacyIssue>;
export function captureNativeCiIssue(version: 2, value: unknown): z.infer<typeof currentIssue>;
export function captureNativeCiIssue(version: 1 | 2, value: unknown): NativeCiContinuationIssue;
export function captureNativeCiIssue(version: 1 | 2, value: unknown): NativeCiContinuationIssue {
  const snapshot = clone(captureOwnedJson(value, isProxy)), issue = frozen((version === 1 ? legacyIssue : currentIssue).parse(snapshot));
  if (new Set(issue.authorityScopes).size !== issue.authorityScopes.length) throw new Error('Invalid native CI owner scopes');
  apply(set, issuedIssues, [issue, {}]); return issue;
}
/** Compared by the independent private PairingTokenManager grant.binding.
 * Cached only on this actual immutable issue, not JSON or a public flag. */
export function nativeCiIssueCommitment(issue: NativeCiContinuationIssue): string {
  const proof = apply(get, issuedIssues, [issue]) as { digest?: string } | undefined;
  if (proof?.digest) return proof.digest;
  const digest = nativeCiDigest(issue); if (proof) proof.digest = digest; return digest;
}
function nativeCiWatchIdentity(watch: CiWatchSubscription) {
  return { id: watch.id, repo: watch.repo, ...(watch.ref ? { ref: watch.ref } : {}), ...(watch.prNumber === undefined ? {} : { prNumber: watch.prNumber }),
    deliveryChannel: watch.deliveryChannel, triggerFixSession: watch.triggerFixSession, createdAt: watch.createdAt, updatedAt: watch.createdAt,
    ...(watch.continuationId ? { continuationId: watch.continuationId } : {}) };
}
export function captureNativeCiWatch(value: unknown): CiWatchSubscription {
  const watch = frozen(watchSchema.parse(clone(captureOwnedJson(value, isProxy)))); apply(set, issuedWatches, [watch, {}]); return watch;
}
/** A caller's scheduling fields are not grant facts. Snapshot data properties
 * before normalizing the issued identity, including before issuance awaits. */
export function captureNativeCiWatchIdentity(value: CiWatchSubscription): CiWatchSubscription {
  const watch = schedulingWatchSchema.parse(clone(captureOwnedJson(value, isProxy)));
  return captureNativeCiWatch(nativeCiWatchIdentity(watch));
}
/** Independent pairing grant watchBinding pins this exact original watch. */
export function nativeCiWatchCommitment(watch: CiWatchSubscription): string {
  const proof = apply(get, issuedWatches, [watch]) as { digest?: string } | undefined;
  if (proof?.digest) return proof.digest;
  const digest = nativeCiDigest(watch); if (proof) proof.digest = digest; return digest;
}
/** Exact incoming CI evidence is detached before any join/owner await. No
 * duplicate raw log body is persisted merely to avoid its saved replay check. */
export function captureNativeCiFailure(brief: FixSessionBrief): FixSessionBrief { return frozen(failureSchema.parse(clone(captureOwnedJson(brief, isProxy)))); }
export function nativeCiFailureCommitment(brief: FixSessionBrief): string { return nativeCiDigest(brief); }
/** The independent private grant consumption compares this small exact
 * continuation/failure/successor commitment. A bare token would lose that
 * binding; the checksum itself is not authentication. */
export function nativeCiConsumption(record: NativeCiContinuationRecord): string {
  if (!record.successor || record.failureRevision === null) throw new Error('Native CI successor is not claimed');
  const proof = origin(record); if (proof?.consumption) return proof.consumption;
  const digest = nativeCiDigest({ continuationId: record.id, failureRevision: record.failureRevision, successor: record.successor });
  if (proof) proof.consumption = digest; return digest;
}
/** Original v1 successor labels remain byte-for-byte compatible. Fresh v2
 * labels are minted once inside its independently committed issue. */
export function nativeCiSuccessorId(record: NativeCiContinuationRecord): string {
  if (record.version === 2) return record.issue.successorAttemptId;
  const proof = origin(record); if (proof?.legacySuccessor) return proof.legacySuccessor;
  const id = `attempt-ci-${nativeCiDigest(record.grant).slice(0, 40)}`;
  if (proof) proof.legacySuccessor = id; return id;
}
export function nativeCiSourceBinding(projectId: string, request: Pick<DurableContractRequest, 'key' | 'binding' | 'input'>): string {
  // requestFor retains the actual ledger work ID in this tuple. Work IDs
  // include the work-* prefix and may be supplied by an embedder's clock;
  // a bare UUID shape is not the current native producer contract.
  if (request.key.criteriaId === 'criteria-v2:' + request.key.workId) {
    if (!/^[0-9a-f]{64}$/.test(request.binding.actionId)) throw new Error('Invalid native source action token'); return request.binding.actionId;
  }
  return nativeCiHistoricalSourceBinding(projectId, request);
}
/** Exact saved pre-correction root-grant recipe. Only an actual unmarked
 * persisted grant candidate may require it for a current native request. */
export function nativeCiHistoricalSourceBinding(projectId: string, request: Pick<DurableContractRequest, 'key' | 'binding' | 'input'>): string {
  const { authorityId, authorityRevision, scopeId, scopeRevision } = request.binding;
  return nativeCiDigest({ projectId, projectRoot: request.input.projectRoot, key: request.key, authorityId, authorityRevision, scopeId, scopeRevision });
}
export function nativeCiLedgerSourceMatches(record: NativeCiContinuationRecord, source: WorkLedgerSource, request: DurableContractRequest): boolean {
  if (!isDeepStrictEqual(source.version === 2 ? source.continuation : undefined, request.input.nativeSource?.continuation)) return false;
  const metadata = nativeCiLedgerSourceMetadata(source);
  if (record.version === 2) return isDeepStrictEqual(record.issue.ledgerSource, metadata);
  const proof = origin(record); if (proof?.legacySource) return isDeepStrictEqual(proof.legacySource, metadata);
  if (nativeCiDigest(source) !== record.issue.ledgerSourceRevision) return false;
  if (proof) proof.legacySource = frozen(clone(metadata)); return true;
}
export function parseNativeCiContinuation(value: unknown, previous?: NativeCiContinuationRecord): NativeCiContinuationRecord {
  if (value && typeof value === 'object' && origin(value as NativeCiContinuationRecord)) {
    if (previous && origin(previous) && !isDeepStrictEqual(immutable(value as NativeCiContinuationRecord), immutable(previous))) throw new Error('Native CI source changed');
    return value as NativeCiContinuationRecord;
  }
  const snapshot = value && typeof value === 'object' && apply(has, jsonRoots, [value]) ? value : clone(captureOwnedJson(value, isProxy));
  const version = snapshot && typeof snapshot === 'object' && 'version' in snapshot ? snapshot.version : undefined;
  if (version !== 1 && version !== 2) throw new Error('Unsupported native CI continuation');
  const parsed = records[version].parse(snapshot);
  const sameSource = previous && origin(previous) && isDeepStrictEqual(immutable(parsed), immutable(previous));
  if (previous && origin(previous) && !sameSource) throw new Error('Native CI source changed');
  const rawIssue = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'issue') : undefined;
  const issued = rawIssue && 'value' in rawIssue ? rawIssue.value as NativeCiContinuationIssue : undefined;
  const issue = sameSource && previous ? previous.issue : issued && apply(get, issuedIssues, [issued]) && isDeepStrictEqual(issued, parsed.issue) ? issued : captureNativeCiIssue(version, parsed.issue);
  const rawWatch = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'watch') : undefined;
  const watchInput = rawWatch && 'value' in rawWatch ? rawWatch.value as CiWatchSubscription | null : null;
  const watch = parsed.watch === null ? null : sameSource && previous?.watch && isDeepStrictEqual(previous.watch, parsed.watch) ? previous.watch
    : watchInput && apply(get, issuedWatches, [watchInput]) && isDeepStrictEqual(watchInput, parsed.watch) ? watchInput : captureNativeCiWatch(parsed.watch);
  const row = { ...parsed, issue, watch } as NativeCiContinuationRecord;
  if (!isDeepStrictEqual(value, row) || row.id !== row.grant.id
    || (row.watch !== null && row.watch.continuationId !== row.id) || (row.state === 'issued' && (row.failureRevision !== null || row.successor !== null))
    || (row.state === 'claimed' && (row.failureRevision === null || row.successor === null))
    || (row.version === 2 && row.successor && row.successor.attemptId !== row.issue.successorAttemptId)) throw new Error('Invalid native CI continuation');
  if (row.grant.binding !== nativeCiIssueCommitment(issue)) throw new Error('Invalid native CI continuation');
  const proof: Origin = {};
  if (sameSource && previous) { const original = origin(previous); if (original?.legacySource) proof.legacySource = original.legacySource;
    if (original?.legacySuccessor) proof.legacySuccessor = original.legacySuccessor;
    if (original?.consumption && previous.failureRevision === row.failureRevision && isDeepStrictEqual(previous.successor, row.successor)) proof.consumption = original.consumption; }
  frozen(row); apply(set, origins, [row, proof]); return row;
}
export function parseNativeCiContinuationJson(json: string, previous?: NativeCiContinuationRecord): NativeCiContinuationRecord {
  const value: unknown = parseJson(json); if (value && typeof value === 'object') apply(add, jsonRoots, [value]); return parseNativeCiContinuation(value, previous);
}
export interface NativeCiContinuationTransaction { readonly record: NativeCiContinuationRecord | null; readonly original: NativeWorkExecutionTransaction; }
export interface NativeCiContinuationOriginal { readonly record?: NativeCiContinuationRecord | undefined; readonly execution?: NativeExecutionOriginal | undefined }
export interface NativeCiContinuationStorage {
  current(id: string, originalKey?: DurableContractKey, original?: NativeCiContinuationOriginal): NativeCiContinuationTransaction;
  transaction<T>(id: string, originalKey: DurableContractKey, decide: (current: NativeCiContinuationTransaction) => { readonly next: NativeCiContinuationRecord | null; readonly value: T }, assertCurrent: () => void, original?: NativeCiContinuationOriginal): Promise<T>;
  claim(id: string, failureRevision: string, assertCurrent: (current: NativeCiContinuationTransaction) => void, original?: NativeCiContinuationOriginal): Promise<NativeCiContinuationRecord>;
}
