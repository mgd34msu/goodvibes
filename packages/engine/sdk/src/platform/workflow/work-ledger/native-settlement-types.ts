/** Saved settlement data is evidence of one publication, never execution authority. */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { canonicalJson, type EntryType } from '@goodvibes-jev/judgment';
import { literal, number, strictObject, string, union, type z } from 'zod/v4';
import { captureOwnedJson } from '../../gate/judgment-input.js';
import type { DurableContractReceipt } from '../../contract/durable-admission.js';
import { NativeWorkExecutionError } from './native-execution-types.js';
import { evidenceTargetSchema, ledgerEvidenceSchema } from './types.js';

/** Exact historical v1 recipe; fresh descriptive references do not use it. */
export const nativeSettlementDigest = (value: unknown): string => createHash('sha256').update(canonicalJson(value as EntryType)).digest('hex');
export const nativeWorkAttestationSchema = ledgerEvidenceSchema.pick({ outcome: true, reason: true, references: true, source: true, criteriaResults: true });
export type NativeWorkAttestation = z.infer<typeof nativeWorkAttestationSchema>;
const digest = string().regex(/^[0-9a-f]{64}$/), id = string().min(1).max(200), ref = string().min(1).max(256);
const revision = number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const key = strictObject({ workId: ref, criteriaId: ref, criteriaRevision: ref, attemptId: ref });
const binding = strictObject({ sourceId: ref, inputRevision: ref, actionId: ref, actionRevision: ref, authorityId: ref, authorityRevision: ref, scopeId: ref, scopeRevision: ref });
const receiptFields = { key, binding, contractId: string().regex(/^ctr-[0-9a-f]{8}$/), ownerAgentId: string().min(1), payloadRevision: digest };
const execution = union([strictObject({ isolation: literal('shared') }), strictObject({ isolation: literal('worktree'), branch: string().regex(/^contract\/[0-9a-f]{8}$/), worktreePath: string().min(1), baseBranch: string().min(1) })]);
const runnerReceipt = union([strictObject({ ...receiptFields, schemaVersion: literal(1) }), strictObject({ ...receiptFields, schemaVersion: literal(2), execution })]);
const common = { projectId: id, payloadRevision: digest, target: evidenceTargetSchema, contractId: id, publicationDigest: digest,
  reportRequestId: id, evidenceRequestId: id, reportSequence: revision, evidenceSequence: revision,
  evidenceId: id, targetAfterReport: evidenceTargetSchema, attestation: nativeWorkAttestationSchema };
const historical = strictObject({ ...common, version: literal(1), keyHash: digest, receiptDigest: digest, contractDigest: digest });
const current = strictObject({ ...common, version: literal(2), receipt: runnerReceipt });
export const nativeWorkSettlementSchema = union([historical, current]);
export type NativeWorkSettlementReceipt = z.infer<typeof nativeWorkSettlementSchema>;
interface PublicationBase { readonly report: string; readonly attestation: NativeWorkAttestation; readonly actorId: string }
export interface HistoricalNativeWorkSettlementPublication extends PublicationBase { readonly version?: undefined; readonly receiptDigest: string; readonly contractDigest: string }
export interface CurrentNativeWorkSettlementPublication extends PublicationBase { readonly version: 2; readonly receipt: DurableContractReceipt }
export type NativeWorkSettlementPublication = HistoricalNativeWorkSettlementPublication | CurrentNativeWorkSettlementPublication;
const publicationBase = { report: string().trim().min(1).max(20_000), attestation: nativeWorkAttestationSchema, actorId: id };
const publicationSchema = union([strictObject({ ...publicationBase, receiptDigest: digest, contractDigest: digest }), strictObject({ ...publicationBase, version: literal(2), receipt: runnerReceipt })]);
const apply = Reflect.apply, get = WeakMap.prototype.get, set = WeakMap.prototype.set, freeze = Object.freeze;
const clone = structuredClone, isProxy = nodeTypes.isProxy;
const publications = new WeakMap<object, { digest?: string }>();
/** Snapshot a real proposed publication before callbacks/persistence. Only its
 * actual immutable result may reuse the independently saved commitment. */
export function captureNativeSettlementPublication(value: NativeWorkSettlementPublication): NativeWorkSettlementPublication {
  try {
    const snapshot = clone(captureOwnedJson(value, isProxy));
    const publication = publicationSchema.parse(snapshot), pending: unknown[] = [publication];
    while (pending.length) { const item = pending.pop(); if (!item || typeof item !== 'object') continue; for (const child of Object.values(item)) pending.push(child); freeze(item); }
    apply(set, publications, [publication, {}]); return publication;
  } catch { throw new NativeWorkExecutionError('invalid'); }
}
/** Independently persisted adjacent ledger events are compared to this saved
 * original report/attestation/actor/runner-receipt commitment. It avoids another
 * raw report copy in the settlement row. It is integrity, not authentication
 * against an attacker rewriting both images, and not a general local hash. */
export function nativeSettlementPublicationCommitment(value: NativeWorkSettlementPublication): string {
  const proof = apply(get, publications, [value]) as { digest?: string } | undefined;
  if (proof?.digest) return proof.digest;
  const commitment = nativeSettlementDigest(value); if (proof) proof.digest = commitment; return commitment;
}
/** Exact structural index for fresh rows. Old digest indices are read only by
 * their explicit v1 compatibility branch in the actual store. */
export function nativeSettlementStorageKey(receipt: NativeWorkSettlementReceipt): string {
  return receipt.version === 1 ? receipt.keyHash : `v2:${JSON.stringify([receipt.receipt.key.workId, receipt.receipt.key.criteriaId, receipt.receipt.key.criteriaRevision, receipt.receipt.key.attemptId])}`;
}
