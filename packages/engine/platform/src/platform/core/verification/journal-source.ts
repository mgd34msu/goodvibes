import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { captureOwnedJson, JudgmentInputError, snapshotJudgmentEvidence } from '../../gate/judgment-input.js';
import { VerificationHeldError } from './types.js';

export type VerificationJournalRecord = { readonly id: string } & (
  { readonly message: Readonly<Record<string, unknown>> } | { readonly contentCommitment: string }
);

// Used only to avoid plaintext persistence of a refused private original, or
// to verify a previously stored commitment on recovery. Never an issued ID,
// ordinary cache key or live currentness check. A commitment is the hex
// SHA-256.
const privateCommitment = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const COMMITMENT = /^[0-9a-f]{64}$/;

/**
 * Why a saved journal original cannot be restored, or undefined when it can.
 * The one reader of the record format: the store refuses a journal with it
 * when the journal is opened, and {@link VerificationJournalSource.restore}
 * relies on it. A commitment in any other spelling than hex comes from an
 * earlier build and is not read.
 */
export function journalRecordProblem(record: unknown): string | undefined {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== 2) return 'invalid journal source record';
  const saved = record as Record<string, unknown>;
  if (typeof saved.id !== 'string' || !saved.id || saved.id.length > 256) return 'invalid journal source identity';
  if ('message' in saved) return saved.message && typeof saved.message === 'object' && !Array.isArray(saved.message) ? undefined : 'invalid journal source record';
  if (typeof saved.contentCommitment !== 'string') return 'invalid journal source record';
  return COMMITMENT.test(saved.contentCommitment) ? undefined
    : 'a saved content commitment is not hex SHA-256 (a journal written by an earlier build, which this build does not read)';
}

/** One complete owned original. Public originals persist exactly; private
 * originals persist only a commitment and bind once during recovery. */
export class VerificationJournalSource {
  #message: Readonly<Record<string, unknown>> | undefined;
  #stored: VerificationJournalRecord | undefined;
  #observed: { readonly message: Readonly<Record<string, unknown>>; readonly matches: boolean } | undefined;
  #migrated = false;
  private constructor(readonly id: string) {
    if (typeof id !== 'string' || !id || id.length > 256) throw new VerificationHeldError('invalid journal source identity');
    snapshotJudgmentEvidence({ id });
  }

  static capture(id: string, message: Record<string, unknown>): VerificationJournalSource {
    const source = new VerificationJournalSource(id);
    source.#message = captureOwnedJson(message) as Readonly<Record<string, unknown>>;
    return source;
  }
  static restore(record: VerificationJournalRecord): VerificationJournalSource {
    const saved = snapshotJudgmentEvidence(record) as VerificationJournalRecord;
    const problem = journalRecordProblem(saved);
    if (problem) throw new VerificationHeldError(problem);
    const source = new VerificationJournalSource(saved.id);
    source.#stored = saved;
    if ('message' in saved) source.#message = saved.message;
    return source;
  }
  get message(): Readonly<Record<string, unknown>> | undefined { return this.#message; }
  takeMigration(): boolean { const migrated = this.#migrated; this.#migrated = false; return migrated; }

  matches(value: Record<string, unknown>): boolean {
    const message = captureOwnedJson(value) as Readonly<Record<string, unknown>>;
    if (this.#message) return isDeepStrictEqual(this.#message, message);
    if (this.#observed && isDeepStrictEqual(this.#observed.message, message)) return this.#observed.matches;
    const saved = this.#stored;
    const matches = !!saved && 'contentCommitment' in saved && privateCommitment(message) === saved.contentCommitment;
    this.#observed = { message, matches };
    if (matches) {
      this.#message = message;
      try {
        this.#stored = Object.freeze({ id: this.id, message: snapshotJudgmentEvidence(message) as Readonly<Record<string, unknown>> });
        this.#migrated = true;
      } catch (error) {
        if (!(error instanceof JudgmentInputError) || error.problem === 'unsupported-input') throw error;
      }
    }
    return matches;
  }

  stored(): VerificationJournalRecord {
    if (this.#stored) return this.#stored;
    if (!this.#message) throw new VerificationHeldError('missing verification journal original');
    try {
      this.#stored = Object.freeze({ id: this.id, message: snapshotJudgmentEvidence(this.#message) as Readonly<Record<string, unknown>> });
    } catch (error) {
      if (!(error instanceof JudgmentInputError) || error.problem === 'unsupported-input') throw error;
      // Lazy once per actual private original, only on an explicit journal save.
      this.#stored = Object.freeze({ id: this.id, contentCommitment: privateCommitment(this.#message) });
    }
    return this.#stored;
  }
}
