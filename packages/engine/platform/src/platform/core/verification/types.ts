import type { CallOptions, JudgmentPort } from '@goodvibes-jev/judgment';
import type { CompletionFinding } from '../response-completion-findings.js';

/**
 * Where a source came from, as the producer knows it. `reference` is display
 * text for the model; code reads these fields and never parses the label.
 */
export type VerificationLane =
  | 'request' | 'criteria' | 'turn-entry-request'
  | 'transcript' | 'initial-transcript' | 'archive'
  | 'delegated-assignment' | 'delegated-evidence'
  | 'contract' | 'contract-acceptance' | 'contract-answer'
  | 'answer';
export interface VerificationOrigin {
  readonly lane?: VerificationLane;
  /** Which pre-compaction history, for the `archive` lane. */
  readonly archiveIndex?: number;
  /** The message's position in its lane's message list. */
  readonly messageIndex?: number;
  /** The delegated worker, for the `delegated-*` lanes. */
  readonly workerId?: string;
  /** The host-completed contract, for the `contract*` lanes. */
  readonly contractId?: string;
}
export interface VerificationSource extends VerificationOrigin {
  readonly id: string;
  readonly kind: 'instruction' | 'observation' | 'answer';
  readonly reference: string;
  readonly text: string;
  readonly messageRole?: 'user' | 'assistant' | 'tool' | 'system';
  readonly completeMessage?: boolean;
  readonly execution?: Readonly<Record<string, unknown>>;
  /** Native call identities on every interval of an assistant tool request. */
  readonly toolCallIds?: readonly string[];
  /** Local original-record links; carried by the source owner, not model text. */
  readonly originalIds?: readonly string[];
  /** Native read projection provenance; independent of the opaque record ID. */
  readonly readKind?: 'receipt' | 'ledger' | 'citation';
}
export type VerificationSourceInput = Omit<VerificationSource, 'id'>;
export type VerificationSourceOwner = (source: VerificationSourceInput) => VerificationSource;
export interface VerificationFact {
  readonly text: string;
  readonly sources: readonly string[];
}
export interface VerificationSummary {
  readonly facts: readonly VerificationFact[];
  readonly concerns: readonly VerificationFact[];
}
export interface VerificationRequirement {
  readonly id: string;
  readonly text: string;
  readonly sources: readonly string[];
}
export interface VerificationReceipt {
  readonly id: string;
  readonly summary: VerificationSummary;
  readonly children: readonly string[];
  readonly sourceIds: readonly string[];
  readonly representation?: 'jev-qualified' | 'exact-original' | 'source-index';
}
export interface VerificationWriterRequest {
  readonly operation: 'requirements' | 'evidence' | 'merge' | 'findings';
  readonly context: unknown;
  readonly repair?: unknown;
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent: () => void;
}
export type VerificationWriter = (request: VerificationWriterRequest) => Promise<string>;
export interface VerificationAccess extends CallOptions {
  readonly port: JudgmentPort;
  readonly identity: object;
  readonly assertCurrent: () => void;
}
export class VerificationHeldError extends Error {
  constructor(readonly stage: string, options?: ErrorOptions) { super(`Source-backed verification is held at ${stage}.`, options); }
}
/** Semantic uncertainty needs a specific evidence repair, not outage retries. */
export class VerificationUnsettledError extends Error {
  constructor(readonly stage: string, readonly findings: readonly CompletionFinding[]) {
    super(`Source-backed verification is held at ${stage}.`);
  }
}
export class VerificationSubdivisionError extends Error {
  constructor() { super('The evidence reduction needs a smaller source frame.'); }
}
