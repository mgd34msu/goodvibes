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
// SHA-256; earlier builds saved its digits as the letters g to p, so a saved
// commitment is read in either spelling.
const privateCommitment = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const COMMITMENT = /^[0-9a-p]{64}$/;
const savedCommitment = (commitment: string): string => commitment.replace(/[g-p]/g, letter => String(letter.charCodeAt(0) - 103));

/** Conversion of an actually stored earlier commitment, never a new key. */
export function matchesStoredVerificationCommitment(value: unknown, commitment: string): boolean {
  return COMMITMENT.test(commitment) && privateCommitment(captureOwnedJson(value)) === savedCommitment(commitment);
}
export function storedVerificationCommitmentMatcher(value: unknown): (commitment: string) => boolean {
  const captured = captureOwnedJson(value);
  let actual: string | undefined;
  return expected => COMMITMENT.test(expected) && (actual ??= privateCommitment(captured)) === savedCommitment(expected);
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
    if (!saved || typeof saved !== 'object' || Array.isArray(saved) || Object.keys(saved).length !== 2
      || ('message' in saved ? !saved.message || typeof saved.message !== 'object' || Array.isArray(saved.message)
        : !('contentCommitment' in saved) || typeof saved.contentCommitment !== 'string' || !COMMITMENT.test(saved.contentCommitment)))
      throw new VerificationHeldError('invalid journal source record');
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
    const matches = !!saved && 'contentCommitment' in saved && privateCommitment(message) === savedCommitment(saved.contentCommitment);
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
