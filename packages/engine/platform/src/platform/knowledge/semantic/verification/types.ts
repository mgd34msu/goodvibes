import type { KnowledgeExtractionRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../../types.js';

/** The concrete content to persist. IDs are provenance, not evidence of truth. */
export interface GeneratedFactSupportClaim {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly value?: unknown;
  readonly evidence?: unknown;
  readonly labels?: readonly string[] | undefined;
  readonly aliases?: readonly string[] | undefined;
  readonly subject?: string | undefined;
  readonly targetHints?: readonly (string | Readonly<Record<string, unknown>>)[] | undefined;
}
export interface GeneratedFactSupportInput {
  readonly spaceId: string;
  readonly claim: GeneratedFactSupportClaim;
  readonly source: KnowledgeSourceRecord;
  /** Actual extraction used for generation, never a generated quote or summary substitute. */
  readonly extraction: KnowledgeExtractionRecord | null | undefined;
  readonly subjects: readonly KnowledgeNodeRecord[];
}
export interface GeneratedFactSupportOptions {
  readonly signal?: AbortSignal | undefined;
  /** Bounds may tighten, never expand, the hard limits below. */
  readonly maxRequests?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly concurrency?: number | undefined;
  readonly timeoutMs?: number | undefined;
}
export interface GeneratedFactSupportReceipt {
  /** Fresh receipts are v2. Omitted only on earlier saved descriptive metadata. */
  readonly version?: 2;
  /** Opaque local label, not evidence or a provider/decision-log ID. Saved earlier labels remain readable. */
  readonly receiptId: string;
  readonly decisionId?: string | undefined;
  readonly battery: string;
  readonly batteryVersion: number;
  readonly spaceId: string;
  readonly claimId: string;
  /** Earlier saved receipt compatibility only; fresh receipts do not compute this field. */
  readonly claimHash?: string;
  readonly field: string;
  /** Earlier saved receipt compatibility only; fresh receipts do not compute this field. */
  readonly fieldHash?: string;
  /** Earlier saved receipt compatibility only; fresh receipts do not compute this field. */
  readonly stateHash?: string;
  readonly sourceId: string;
  /** Earlier saved receipt compatibility only; fresh receipts do not compute this field. */
  readonly sourceHash?: string;
  readonly extractionId: string;
  /** Earlier saved receipt compatibility only; fresh receipts do not compute this field. */
  readonly extractionHash?: string;
  /** Native writers emit canonical ISO; numeric receipts remain readable for historical data. */
  readonly extractionUpdatedAt: string | number;
  readonly subjectId?: string | undefined;
  readonly subjectHash?: string | undefined;
  /** Names the actual extraction. Original native source owners and complete
   * receipt equality provide binding; a descriptive checksum grants nothing. */
  readonly evidenceReference: { readonly extractionId: string; readonly evidenceHash?: string };
  readonly verdict: 'yes';
  readonly outcome: 'act';
  readonly probability: number;
}
export interface GeneratedFactSupportPlan {
  readonly claim: GeneratedFactSupportClaim;
  readonly claimId: string;
  readonly sourceId: string;
  readonly extractionId: string;
  readonly receipts: readonly GeneratedFactSupportReceipt[];
}
export type GeneratedFactSupportHoldReason = 'unsettled' | 'no-support' | 'unavailable' | 'malformed' | 'stale' | 'aborted' | 'budget' | 'missing-evidence' | 'foreign-space';
/** Value-free failure: no affected pass may fall back or persist partial plans. */
export class KnowledgeGeneratedFactSupportHeldError extends Error {
  override readonly name = 'KnowledgeGeneratedFactSupportHeldError';
  constructor(readonly reason: GeneratedFactSupportHoldReason = 'unsettled') {
    super(`Generated fact support held (${reason}); no affected claim or attachment is authorized for persistence.`);
  }
}
export const GENERATED_FACT_SUPPORT_LIMITS = Object.freeze({ inputs: Number.POSITIVE_INFINITY, requests: Number.POSITIVE_INFINITY, bytes: Number.POSITIVE_INFINITY, concurrency: 4, timeoutMs: 2_147_483_647 });
