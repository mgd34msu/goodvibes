/**
 * memory-author.ts, who wrote a memory record (memory-store.ts `MemoryRecord.author`), kept apart from the store so a
 * reader (the recall contract, a program's prompt, a place's list) needs nothing of the store's to tell it.
 */
import { noteExposure } from '../security/conversation-exposure.js';

/**
 * Who wrote a memory record: `owner` (their own press or typed words), `owner-model` (their model in their own turn) or
 * `other` (a device, a member, an outside agent, a script or command line with no person, a turn on someone else's
 * input), with who that was in words. `acceptedAt`: when the owner reviewed or changed in person a record someone else
 * wrote; from then on it is the owner's reviewed words.
 * A record with no author was written before authors were kept (3.5.0, or earlier in this version): the owner's.
 *
 * As released, what steers the model (memory, a persona, a note, a routine, a skill) is decided when it is written, by
 * its row under the mode in force for that caller (permissions/manager.ts); once written it is given to turns as any
 * record. Who wrote it is kept on the record and, for someone else's, marks a conversation it enters as having read text
 * from outside (`noteOthersWritingRead`), a fact for the one decision. Nothing waits for the owner's review.
 */
export interface MemoryAuthor {
  readonly kind: 'owner' | 'owner-model' | 'other';
  readonly who?: string | undefined;
  readonly acceptedAt?: number | undefined;
  /**
   * For someone else's record: the principal that wrote it, as the daemon authenticated it (never a body's). A caller below
   * an admin changes only a record it made (control-plane/caller-reach.ts `OWN_RECORD_CHANGES`, daemon/record-owners.ts).
   */
  readonly madeBy?: string | undefined;
}

/**
 * An author as a store kept it (a JSON object). Absent or null: none (the owner's, a record from before authors were
 * kept). Anything else that is not an author is someone else's: an unreadable author never makes a record the owner's.
 */
export function readRecordAuthor(value: unknown): MemoryAuthor | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'object' && !Array.isArray(value) ? value as { kind?: unknown; who?: unknown; acceptedAt?: unknown; madeBy?: unknown } : {};
  if (parsed.kind === 'owner' || parsed.kind === 'owner-model' || parsed.kind === 'other') {
    return {
      kind: parsed.kind,
      ...(typeof parsed.who === 'string' && parsed.who ? { who: parsed.who } : {}),
      ...(typeof parsed.acceptedAt === 'number' && Number.isFinite(parsed.acceptedAt) ? { acceptedAt: parsed.acceptedAt } : {}),
      ...(parsed.kind === 'other' && typeof parsed.madeBy === 'string' && parsed.madeBy ? { madeBy: parsed.madeBy } : {}),
    };
  }
  return { kind: 'other', who: 'an author that could not be read' };
}

/**
 * A record's author after a change by `by`: someone else's change makes it someone else's words; the owner's own
 * change of such a record makes it the owner's reviewed words; their model's change, or a change nobody named, keeps it.
 */
export function authorAfterChange(existing: MemoryAuthor | undefined, by: MemoryAuthor | undefined, now: number): MemoryAuthor | undefined {
  if (by === undefined || by.kind === 'owner-model') return existing;
  if (by.kind === 'other') return { kind: 'other', ...(by.who !== undefined ? { who: by.who } : {}), ...(by.madeBy !== undefined ? { madeBy: by.madeBy } : {}) };
  return acceptedAuthor(existing, now);
}

/** The author once the owner reviewed the record in person (their review, their own change): someone else's is marked so. */
export function acceptedAuthor(existing: MemoryAuthor | undefined, now: number): MemoryAuthor | undefined {
  return existing?.kind === 'other' && existing.acceptedAt === undefined ? { ...existing, acceptedAt: now } : existing;
}

/**
 * Who wrote a record that is someone else's words the owner has not reviewed in person (a device's, a member's, the
 * outside agent's, a script's, a turn's on someone else's input), in words; undefined for the owner's own, their model's
 * and one they reviewed.
 */
export function othersWritingBy(author: MemoryAuthor | undefined): string | undefined {
  if (author?.kind !== 'other' || author.acceptedAt !== undefined) return undefined;
  return author.who ?? 'someone other than the owner';
}

/**
 * A record someone else wrote is put into a turn's prompt now (memory, knowledge, a note, a persona, a routine, a
 * skill): the conversation in scope has read text from outside from this moment, the same mark a fetched page sets
 * (security/conversation-exposure.ts), so the one permission decision is told so and an exposed turn's rules apply
 * (no administrative authority on its own calls; what runs later, sends, spends or loosens is decided with that fact).
 * Nothing for the owner's own words. Returns who wrote it, for the prompt line to name.
 */
export function noteOthersWritingRead(kind: string, id: string, author: MemoryAuthor | undefined): string | undefined {
  const who = othersWritingBy(author);
  if (who !== undefined) noteExposure('memory', `${kind} ${id} written by ${who}`);
  return who;
}

/** A new record's author from who wrote it (`kind` and `who` only; a review in person is the owner's later act). */
export function newRecordAuthor(by: { readonly kind: MemoryAuthor['kind']; readonly who?: string | undefined; readonly madeBy?: string | undefined } | undefined): MemoryAuthor | undefined {
  if (by === undefined) return undefined;
  return { kind: by.kind, ...(by.who !== undefined ? { who: by.who } : {}), ...(by.kind === 'other' && by.madeBy !== undefined ? { madeBy: by.madeBy } : {}) };
}
