import type { YesNoReading } from '@goodvibes-jev/judgment';

/** Provider-neutral semantic input; the complete supplied object is inspected before projection. */
export interface TriageInput {
  readonly id: string;
  readonly surface: string;
  readonly subject?: string;
  readonly snippet?: string;
  readonly conversationKind?: 'direct' | 'group' | 'channel' | 'thread' | 'service';
  readonly unread?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
export type TriageLabel = 'spam' | 'priority' | 'normal';
export interface TriageAttribution {
  readonly id: string;
  readonly battery: string;
  readonly batteryVersion: number;
  /** Requested model or alias; absent if no validated answer is available. */
  readonly model?: string;
  /** The actual configured target that answered, which may be a fallback. */
  readonly targetModel?: string;
  /** Resolved response model, present when the request was answered. */
  readonly actualModel?: string;
}
/** Ordinary mutation-issued native mirror generation and account comparison domain. */
export interface TriageSourceBinding extends TriageReceiptScope { readonly sourceRevision: string }
export type TriageBinding = TriageAttribution & (
  | { readonly receiptVersion: 4; readonly source?: TriageSourceBinding; readonly inputHash?: never }
  | { readonly receiptVersion?: 2; readonly inputHash: string; readonly source?: never }
);
export type TriageEvidence = TriageBinding & {
  readonly status: 'settled';
  readonly spam: YesNoReading;
  readonly urgency: YesNoReading;
  readonly label: TriageLabel;
  readonly score: number;
  readonly tags: readonly string[];
  readonly signals: Readonly<{ spam: number; urgency: number }>;
};
/** Failed attempts withdraw a previous label, but have no input-matching
 * consumer. Fresh v3 failures carry no decorative message commitment. Actual
 * saved v1/v2 failures retain their original binding for read compatibility. */
export type TriageFailureReceipt = TriageAttribution & {
  readonly inputHash?: never;
  readonly receiptVersion: 3;
  readonly status: 'held' | 'unavailable';
};
export type TriageReceipt = TriageEvidence | TriageFailureReceipt | (Extract<TriageBinding, { readonly inputHash: string }> & {
  readonly status: 'held' | 'unavailable';
});
/** Nonpersisted explicit preview. No input commitment or persisted receipt
 * version is issued merely to display a model conclusion. */
export type TriagePreview = (Omit<TriageEvidence, 'inputHash' | 'receiptVersion' | 'source'>
  | Omit<TriageFailureReceipt, 'inputHash' | 'receiptVersion'>) & {
  readonly inputHash?: never;
  readonly receiptVersion?: never;
};
/** Private receipt comparison domain, never model input or execution authority. */
export interface TriageReceiptScope {
  readonly providerId: string;
  readonly accountScopeId: string;
}
