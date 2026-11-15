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
/** The mirror row a settled label was scored from: the account and the row's content revision. */
export interface TriageSourceBinding extends TriageReceiptScope { readonly sourceRevision: string }
/**
 * A stored receipt is one of two generations: 4, a settled label, and 3, an
 * attempt that settled nothing (the row is scored again on a later pass). The
 * label is what was decided under `battery`@`batteryVersion`; a receipt of
 * another battery version is history: it lends no label and the row is scored
 * again.
 */
export type TriageBinding = TriageAttribution & { readonly receiptVersion: 4; readonly source?: TriageSourceBinding };
export type TriageEvidence = TriageBinding & {
  readonly status: 'settled';
  readonly spam: YesNoReading;
  readonly urgency: YesNoReading;
  readonly label: TriageLabel;
  readonly score: number;
  readonly tags: readonly string[];
  readonly signals: Readonly<{ spam: number; urgency: number }>;
};
export type TriageFailureReceipt = TriageAttribution & {
  readonly receiptVersion: 3;
  readonly status: 'held' | 'unavailable';
};
export type TriageReceipt = TriageEvidence | TriageFailureReceipt;
/** A reading that is shown and never stored, so it has no receipt generation. */
export type TriagePreview = (Omit<TriageEvidence, 'receiptVersion' | 'source'> | Omit<TriageFailureReceipt, 'receiptVersion'>) & {
  readonly receiptVersion?: never;
};
/** Private receipt comparison domain, never model input or execution authority. */
export interface TriageReceiptScope {
  readonly providerId: string;
  readonly accountScopeId: string;
}
