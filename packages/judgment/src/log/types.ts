import type { DecisionContext, EntryType, JsonValue, JudgmentLineage } from '../port/types.ts';
import type { JudgmentErrorKind, JudgmentFailureReason } from '../port/errors.ts';
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
  /** The evaluator rules every question of the call shared, stated once for the call (a battery's context). */
  readonly sharedContext?: string;
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
  readonly error: { readonly kind: JudgmentErrorKind; readonly message: string; readonly reason?: JudgmentFailureReason };
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

/** Payload-free outcome of one call: whether it was answered and by which model. */
export interface DecisionSummary {
  readonly id: DecisionId;
  readonly status: DecisionEntry['status'];
  readonly requestedModel: string;
  /** The versioned model that answered; absent on a failed call. */
  readonly model?: string;
}

/**
 * Durable record of every reading. The engine state layer hosts an
 * implementation; this package ships the SQLite one.
 */
export interface DecisionLog {
  /** Appends an entry and returns its id. Throws when the write fails. */
  record(entry: NewDecisionEntry): DecisionId;
  /** Optional on older/custom logs. Appends an answered entry and its notes in one write; throws and keeps nothing when it fails. */
  recordWithNotes?(entry: NewDecisionEntry, notes: readonly DecisionNote[]): DecisionId;
  /** Appends a note to an answered entry without replacing earlier notes. Throws when there is no answered entry with that id or the write fails. */
  attach(id: string, note: DecisionNote): void;
  /**
   * Optional on older/custom logs. Queues a note for a batched, unsynced write
   * shortly after; never throws, and calls `onUnrecorded` for a note that was
   * not written. Reads through the same log see queued notes.
   */
  attachLater?(id: string, note: DecisionNote, onUnrecorded: () => void): void;
  get(id: string): DecisionEntry | undefined;
  query(query?: DecisionQuery): readonly DecisionEntry[];
  /** Optional on older/custom logs. Same filters, ordering and limit as query,
   * returning only IDs without materializing entry or note payloads. */
  queryIds?(query?: DecisionQuery): readonly DecisionId[];
  /** Optional on older/custom logs. Native SQLite reads only bounded counters. */
  queryVolume?(query?: DecisionQuery): readonly DecisionVolumeEntry[];
  /** Optional on older/custom logs. Status and models of the given ids in one
   * read, without questions, answers or notes; an unknown id is left out. */
  summaries?(ids: readonly string[]): readonly DecisionSummary[];
  /**
   * Optional on older/custom logs. Deletes up to `rule.batch` entries, with
   * their notes, that the retention rule no longer keeps, oldest first, and
   * returns how many went. Call again until it returns less than the batch.
   */
  prune?(rule: DecisionRetention): number;
}

/**
 * How long the decision log keeps an entry: until it is older than `before`
 * or falls outside the newest `maxEntries`, whichever comes first. An entry
 * carrying a truth note is always kept, because calibration and accuracy
 * reports read accuracy against confidence from those.
 */
export interface DecisionRetention {
  /** Entries recorded before this time go. */
  readonly before: string;
  /** Entries beyond the newest this many go. */
  readonly maxEntries: number;
  /** Most entries one call deletes. */
  readonly batch: number;
}

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  Object.prototype.toString.call(value) === '[object Object]';

// The collator is pinned so the order, and so the stored state hash, does not
// follow the process locale. en-US is what keys were ordered by when hashes were
// first stored. Keys it ties (canonically equivalent spellings) fall back to
// code units so insertion order never decides.
const keyCollator = new Intl.Collator('en-US');
const compareKeys = (a: string, b: string): number => keyCollator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

const sortKeys = (value: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareKeys(a, b)));

/** Canonical JSON: object keys sorted, so equal states hash equally. */
export function canonicalJson(value: EntryType | JsonValue | undefined): string {
  if (value === undefined) return 'null';
  return JSON.stringify(value, (_key, inner: unknown) => (isPlainObject(inner) ? sortKeys(inner) : inner));
}

export function hashState(state: EntryType): StateHash {
  return Bun.CryptoHasher.hash('sha256', canonicalJson(state), 'hex') as StateHash;
}
