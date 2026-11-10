import type { EntryType, Questions } from '@goodvibes-jev/judgment';

/** Exact transmitted source windows; no whole-file certificate or digest. */
export type StaticRule = 'internal-identifier' | 'deferred-work';
export interface SourceAnchor {
  readonly id: string;
  readonly line: number;
  readonly col: number;
  readonly text: string;
}
export interface StaticSourceInput {
  readonly kind: StaticRule;
  readonly path: string;
  readonly firstLine: number;
  readonly lastLine: number;
  readonly source: string;
  readonly anchors: readonly SourceAnchor[];
}
export interface StaticSourceReadings {
  readonly format: 2;
  readonly readingPlanVersion?: 1 | 2 | 3;
  readonly readings: Readonly<Record<string, unknown>>;
}
export interface StaticCallEvidence {
  readonly id: string;
  readonly at: string;
  readonly battery: string;
  readonly version: number;
  readonly site: string;
  readonly state: EntryType;
  readonly questions: Questions;
  readonly requestedModel: string;
  readonly observedModel: string;
  readonly requestId: string | null;
  readonly answers: unknown;
}
/** Tool-owned answered raw-wire observations, not the default decision logger. */
export interface StaticCallCapture {
  get(id: string): StaticCallEvidence | undefined;
}
export interface StaticSourceReceipt {
  readonly readingPlanVersion?: 1 | 2 | 3;
  readonly input: StaticSourceInput;
  readonly presence: StaticCallEvidence;
  readonly selection: StaticCallEvidence | null;
  readonly parts: readonly StaticSourceReceipt[];
  readonly previousCaptures?: readonly unknown[];
}
export interface StaticSourceProgress {
  readonly previous: StaticSourceReadings;
  readonly original?: StaticSourceReadings;
  readonly onReceipt: (input: StaticSourceInput, receipt: StaticSourceReceipt) => void;
}
export type StaticInputStanding = { readonly kind: 'clear' }
  | { readonly kind: 'violation'; readonly anchor: SourceAnchor }
  | { readonly kind: 'held'; readonly reason: string };
export type StaticSourceWindow = StaticSourceInput;
export interface StaticPolicyObservation {
  readonly manifest: ReadonlyArray<readonly [string, string]>;
  assertCurrent(): void;
}
