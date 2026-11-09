/** Existing persisted static-reading shapes; no runtime interpretation. */
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
  readonly sourceHash: string;
  readonly firstLine: number;
  readonly lastLine: number;
  readonly source: string;
  readonly anchors: readonly SourceAnchor[];
}
export interface StaticSourceReadings {
  readonly format: 1;
  readonly readingPlanVersion?: 1 | 2 | 3;
  readonly decisionSourceHash: string;
  readonly readings: Readonly<Record<string, unknown>>;
  /** Original source manifests prove which policy a retained wire capture used. */
  readonly captureSources?: Readonly<Record<string, unknown>>;
  readonly captureBatterySources?: Readonly<Record<string, unknown>>;
}

export interface StaticCallEvidence {
  readonly id: string;
  readonly at: string;
  readonly battery: string;
  readonly version: number;
  readonly site: string;
  readonly stateHash: string;
  readonly questionsHash: string;
  readonly requestedModel: string;
  readonly observedModel: string;
  readonly requestId: string | null;
  readonly answers: unknown;
  /** Legacy evidence inherits its containing receipt's original capture hash. */
  readonly captureDecisionSourceHash?: string;
}
export interface StaticSourceReceipt {
  readonly readingPlanVersion?: 1 | 2 | 3;
  readonly inputHash: string;
  readonly sourceHash: string;
  readonly decisionSourceHash: string;
  readonly presence: StaticCallEvidence;
  readonly selection: StaticCallEvidence | null;
  readonly parts: readonly StaticSourceReceipt[];
  /** Revalidation does not change the original capture hash or wire evidence. */
  readonly validatedDecisionSourceHash?: string;
  /** Current composition applied to unchanged original plan-2 question answers. */
  readonly validatedReadingPlanVersion?: 3;
  readonly previousCaptures?: readonly unknown[];
}

export interface StaticSourceProgress {
  readonly previous: StaticSourceReadings;
  readonly original?: StaticSourceReadings;
  readonly decisionSourceHash?: string;
  readonly onReceipt: (input: StaticSourceInput, receipt: StaticSourceReceipt) => void;
}

export type StaticInputStanding = { readonly kind: 'clear' }
  | { readonly kind: 'violation'; readonly anchor: SourceAnchor }
  | { readonly kind: 'held'; readonly reason: string };

/** Structural capture before any persisted source identity is needed. */
export type StaticSourceWindow = Omit<StaticSourceInput, 'sourceHash'>;
export interface StaticPolicyObservation {
  readonly manifest: ReadonlyArray<readonly [string, string]>;
  readonly hash: string;
  readonly batterySources: ReadonlyMap<string, string>;
  assertCurrent(): void;
}
