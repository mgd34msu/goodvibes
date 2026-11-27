/**
 * memory-author.ts, who wrote a memory record (memory-store.ts `MemoryRecord.author`), kept apart from the store so a
 * reader (the recall contract, a program's prompt, a place's list) needs nothing of the store's to tell it.
 */

/**
 * Who wrote a memory record: `owner` (his own press or typed words), `owner-model` (his model in his own turn) or
 * `other` (a device, a member, an outside agent, a script or command line with no person, a turn on someone else's
 * input), with who that was in words. `acceptedAt`: when the owner accepted a record someone else wrote, in Memory and
 * knowledge (accept, or change it himself); from then on it is given to turns as any record, with no special weight.
 * A record with no author was written before authors were kept (3.5.0, or earlier in this version): the owner's.
 */
export interface MemoryAuthor {
  readonly kind: 'owner' | 'owner-model' | 'other';
  readonly who?: string | undefined;
  readonly acceptedAt?: number | undefined;
}

/**
 * Whether a record waits for the owner's review because someone else wrote it and he has not accepted it. The one
 * eligibility rule of authorship, read by every record that steers a turn: memory (memory-recall-contract.ts), and the
 * Agent's personas, routines, skills and notes (each keeps `author` the same way).
 */
export function memoryAwaitsOwner(record: { readonly author?: MemoryAuthor | undefined }): boolean {
  return record.author?.kind === 'other' && record.author.acceptedAt === undefined;
}

/**
 * An author as a store kept it (a JSON object). Absent or null: none (the owner's, a record from before authors were
 * kept). Anything else that is not an author is someone else's, waiting: an unreadable author never makes a record his.
 */
export function readRecordAuthor(value: unknown): MemoryAuthor | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'object' && !Array.isArray(value) ? value as { kind?: unknown; who?: unknown; acceptedAt?: unknown } : {};
  if (parsed.kind === 'owner' || parsed.kind === 'owner-model' || parsed.kind === 'other') {
    return {
      kind: parsed.kind,
      ...(typeof parsed.who === 'string' && parsed.who ? { who: parsed.who } : {}),
      ...(typeof parsed.acceptedAt === 'number' && Number.isFinite(parsed.acceptedAt) ? { acceptedAt: parsed.acceptedAt } : {}),
    };
  }
  return { kind: 'other', who: 'an author that could not be read' };
}

/**
 * A record's author after a change by `by`: someone else's change makes it someone else's words, waiting for the
 * owner; the owner's own change of such a record accepts it; his model's change, or a change nobody named, keeps it.
 */
export function authorAfterChange(existing: MemoryAuthor | undefined, by: MemoryAuthor | undefined, now: number): MemoryAuthor | undefined {
  if (by === undefined || by.kind === 'owner-model') return existing;
  if (by.kind === 'other') return { kind: 'other', ...(by.who !== undefined ? { who: by.who } : {}) };
  return acceptedAuthor(existing, now);
}

/** The author once the owner accepted the record (his review, his own change): someone else's is marked accepted. */
export function acceptedAuthor(existing: MemoryAuthor | undefined, now: number): MemoryAuthor | undefined {
  return existing?.kind === 'other' && existing.acceptedAt === undefined ? { ...existing, acceptedAt: now } : existing;
}

/** A new record's author from who wrote it (`kind` and `who` only; acceptance is the owner's later act). */
export function newRecordAuthor(by: { readonly kind: MemoryAuthor['kind']; readonly who?: string | undefined } | undefined): MemoryAuthor | undefined {
  if (by === undefined) return undefined;
  return { kind: by.kind, ...(by.who !== undefined ? { who: by.who } : {}) };
}
