import type { DecisionContext, EntryType, JsonValue, JudgmentLineage } from '../port/types.ts';
import type { JudgmentErrorKind } from '../port/errors.ts';
import type { FixtureCheck } from '../batteries/decision.ts';

/** A decision log entry's id. */
export type DecisionId = string & { readonly __decisionId: true };
/** An ISO 8601 timestamp. */
export type IsoTime = string & { readonly __isoTime: true };
/** SHA-256 of a state's canonical JSON, in hex. */
export type StateHash = string & { readonly __stateHash: true };

export const isoTime = (date: Date): IsoTime => date.toISOString() as IsoTime;

/** Token counts for one answered call. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** What every entry records about the call it describes. */
export interface CallRecord {
  readonly id: DecisionId;
  /** When the call was made. */
  readonly at: IsoTime;
  readonly context: DecisionContext;
  readonly requestedModel: string;
  /** Optional answered-call commitment requested for an independent saved
   * proof. The state itself is not stored; audit-only and failed calls omit it. */
  readonly stateHash?: StateHash;
  readonly questions: JsonValue;
  readonly latencyMs: number;
  readonly requestId: string | undefined;
  readonly lineage?: JudgmentLineage;
}

/** Where a decision's ground truth came from. */
export type TruthSource =
  /** A calibration fixture's labelled expectation. */
  | 'fixture'
  /** The owner said what the right answer was, confirming or correcting the decision. */
  | 'owner'
  /** What happened afterwards showed whether the decision was right. */
  | 'outcome';

/**
 * What the right answer turned out to be for a decision, checked against what
 * the decision concluded: one check per aspect, with the reading's signal and
 * band outcome, so accuracy can be read against confidence from the log.
 */
export interface DecisionTruth {
  readonly source: TruthSource;
  readonly checks: readonly FixtureCheck[];
}

/** Something recorded about a call after it answered: what the decision concluded, what code did with it, or what was right. */
export type DecisionNote =
  | { readonly kind: 'readings'; readonly readings: JsonValue }
  | { readonly kind: 'action'; readonly action: string }
  | { readonly kind: 'truth'; readonly truth: DecisionTruth };

function latestNote(notes: readonly DecisionNote[], kind: DecisionNote['kind']): DecisionNote | undefined {
  for (let index = notes.length - 1; index >= 0; index--) {
    const note = notes[index];
    if (note?.kind === kind) return note;
  }
  return undefined;
}

/** A call the endpoint answered. */
export interface AnsweredEntry extends CallRecord {
  readonly status: 'answered';
  /** The versioned model that answered. */
  readonly model: string;
  /** Raw answers as the endpoint returned them. */
  readonly answers: JsonValue;
  readonly usage: TokenUsage;
  /** Notes attached after the call, in the order they were recorded. */
  readonly notes: readonly DecisionNote[];
}

/** The latest recorded conclusion; the entry's notes retain earlier readings. */
export function readingsOf(entry: DecisionEntry): JsonValue | undefined {
  if (entry.status !== 'answered') return undefined;
  const note = latestNote(entry.notes, 'readings');
  return note?.kind === 'readings' ? note.readings : undefined;
}

/** The latest recorded action; the entry's notes retain earlier actions. */
export function actionOf(entry: DecisionEntry): string | undefined {
  if (entry.status !== 'answered') return undefined;
  const note = latestNote(entry.notes, 'action');
  return note?.kind === 'action' ? note.action : undefined;
}

/** The latest recorded ground truth; the entry's notes retain earlier truth. */
export function truthOf(entry: DecisionEntry): DecisionTruth | undefined {
  if (entry.status !== 'answered') return undefined;
  const note = latestNote(entry.notes, 'truth');
  return note?.kind === 'truth' ? note.truth : undefined;
}

/** A call that failed; nothing was read from it. */
export interface FailedEntry extends CallRecord {
  readonly status: 'failed';
  readonly error: { readonly kind: JudgmentErrorKind; readonly message: string };
}

export type DecisionEntry = AnsweredEntry | FailedEntry;

/** What a caller supplies to record an entry; the log assigns the id. */
export type NewDecisionEntry = Omit<AnsweredEntry, 'id' | 'notes'> | Omit<FailedEntry, 'id'>;

export interface DecisionQuery {
  readonly battery?: string;
  readonly site?: string;
  /** Inclusive lower bound on `at`. */
  readonly since?: string;
  /** Exclusive upper bound on `at`. */
  readonly until?: string;
  /** Entries where at least one reading has this outcome. */
  readonly outcome?: 'act' | 'confirm' | 'escalate';
  readonly status?: DecisionEntry['status'];
  /** Newest first; default 1000. */
  readonly limit?: number;
}

/** Payload-free counter projection for bounded local volume monitoring.
 * It contains no questions, answers, error text, attempt details or notes. */
export interface DecisionVolumeEntry {
  readonly id: DecisionId;
  readonly context: Pick<DecisionContext, 'battery' | 'site'>;
  readonly volume: {
    readonly logicalRequestId?: string;
    readonly targetAttempts: number;
    readonly wireAttempts: number;
    readonly unknownDispatchAttempts: number;
    readonly callsWithoutAttemptEvidence: 0 | 1;
  };
}

/**
 * Durable record of every reading. The engine state layer hosts an
 * implementation; this package ships the SQLite one.
 */
export interface DecisionLog {
  /** Appends an entry and returns its id. Throws when the write fails. */
  record(entry: NewDecisionEntry): DecisionId;
  /** Appends a note to an answered entry without replacing earlier notes. Throws when there is no answered entry with that id or the write fails. */
  attach(id: string, note: DecisionNote): void;
  get(id: string): DecisionEntry | undefined;
  query(query?: DecisionQuery): readonly DecisionEntry[];
  /** Optional on older/custom logs. Same filters, ordering and limit as query,
   * returning only IDs without materializing entry or note payloads. */
  queryIds?(query?: DecisionQuery): readonly DecisionId[];
  /** Optional on older/custom logs. Native SQLite reads only bounded counters. */
  queryVolume?(query?: DecisionQuery): readonly DecisionVolumeEntry[];
}

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  Object.prototype.toString.call(value) === '[object Object]';

const sortKeys = (value: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

/** Canonical JSON: object keys sorted, so equal states hash equally. */
export function canonicalJson(value: EntryType | JsonValue | undefined): string {
  if (value === undefined) return 'null';
  return JSON.stringify(value, (_key, inner: unknown) => (isPlainObject(inner) ? sortKeys(inner) : inner));
}

export function hashState(state: EntryType): StateHash {
  return Bun.CryptoHasher.hash('sha256', canonicalJson(state), 'hex') as StateHash;
}
