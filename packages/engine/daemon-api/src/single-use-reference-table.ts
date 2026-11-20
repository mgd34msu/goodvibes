import { createHash } from 'node:crypto';

/**
 * The reference table behind the settings import's capture-then-apply arm: a
 * capture issues a one-use reference, an apply takes it. A single setting no
 * longer uses it (one `write` carries the revision instead), and an import
 * sent as one `write` does not either.
 */
interface ReferenceEntry {
  readonly lifetime: object;
  readonly expiresAt: number;
}

export interface SingleUseReferenceTable<Entry extends ReferenceEntry> {
  /** Adopt the current serving lifetime (a change drops every reference) and drop expired references. */
  synchronize(current: object | null): void;
  /** Store an entry under a fresh reference, evicting the oldest ones past the cap. */
  issue(entry: Omit<Entry, 'expiresAt'>): { reference: string; expiresAt: number };
  /**
   * Remove the reference whether or not it is usable: a reference is spent by
   * any apply attempt, including one that is later refused. `spent` says the
   * same reference was taken before, so the caller can answer "spent" rather
   * than "stale".
   */
  take(reference: string): { entry: Entry | undefined; spent: boolean };
}

// Five minutes permits ordinary recorded admission reads. Bounded in both time
// and count; capture never starts a timer, and neither arm refreshes a reference.
const LIFETIME_MS = 5 * 60_000;
const MAX_REFERENCES = 256;
/** Recently used references, so a second apply is told it was spent rather than merely stale. */
const MAX_SPENT_REFERENCES = 256;

export function createSingleUseReferenceTable<Entry extends ReferenceEntry>(): SingleUseReferenceTable<Entry> {
  const references = new Map<string, Entry>();
  const spent = new Set<string>();
  let servingLifetime: object | null = null;
  return {
    synchronize(current) {
      if (current !== servingLifetime) { references.clear(); spent.clear(); servingLifetime = current; }
      const now = Date.now();
      for (const [reference, entry] of references) if (entry.expiresAt <= now) references.delete(reference);
    },
    issue(entry) {
      const reference = crypto.randomUUID();
      const expiresAt = Date.now() + LIFETIME_MS;
      while (references.size >= MAX_REFERENCES) references.delete(references.keys().next().value!);
      references.set(reference, { ...entry, expiresAt } as Entry);
      return { reference, expiresAt };
    },
    take(reference) {
      const entry = references.get(reference);
      references.delete(reference);
      const wasSpent = spent.has(reference);
      spent.add(reference);
      while (spent.size > MAX_SPENT_REFERENCES) spent.delete(spent.values().next().value!);
      return { entry, spent: wasSpent };
    },
  };
}

/**
 * The answers to recent settings writes, by the caller and its `requestId`, so
 * a caller whose answer was lost can send the same request again and get the
 * first answer instead of a second write. A repeat that arrives while the first
 * is still running waits for it. Only answers `keep` accepts (a write that
 * happened) stay remembered once settled; a refusal can be retried under the
 * same id. Settled answers are bounded by count (the oldest go first); a write
 * still running is never forgotten. Memory only, so a daemon restart forgets
 * them (a repeat then meets the settings revision check).
 */
export interface RequestReceiptTable<Answer> {
  /**
   * The answer for `requestId` sent by `caller`: the remembered one when that
   * caller sent this id with the same `fingerprint`, otherwise the result of
   * `run`. `mismatch` when the caller used the id for a different request.
   */
  answer(caller: string, requestId: string, fingerprint: string, run: () => Promise<Answer>): Promise<Answer> | 'mismatch';
}

const MAX_REMEMBERED_ANSWERS = 256;

/**
 * A digest of a JSON request (object keys in sorted order), so the table can
 * tell one request from another without holding the values it carried.
 */
export function requestFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical((item as Record<string, unknown>)[key])]));
    }
    return item;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('base64url');
}

export function createRequestReceiptTable<Answer>(keep: (answer: Answer) => boolean): RequestReceiptTable<Answer> {
  const answers = new Map<string, { readonly fingerprint: string; readonly answer: Promise<Answer>; settled: boolean }>();
  /**
   * Only settled answers are evicted, oldest first. A write still running keeps
   * its entry whatever else arrives, so a repeat of it joins it instead of
   * starting a second write; those entries are bounded by the writes in flight.
   */
  const evictSettled = (): void => {
    if (answers.size <= MAX_REMEMBERED_ANSWERS) return;
    for (const [id, entry] of answers) {
      if (answers.size <= MAX_REMEMBERED_ANSWERS) return;
      if (entry.settled) answers.delete(id);
    }
  };
  return {
    answer(caller, requestId, fingerprint, run) {
      // The caller's credential is held only as a digest; two callers never share an answer.
      const id = `${requestFingerprint(caller)}\u0000${requestId}`;
      const known = answers.get(id);
      if (known) return known.fingerprint === fingerprint ? known.answer : 'mismatch';
      const pending = run();
      const entry = { fingerprint, answer: pending, settled: false };
      answers.set(id, entry);
      evictSettled();
      const forget = () => { if (answers.get(id) === entry) answers.delete(id); };
      void pending.then(result => {
        entry.settled = true;
        if (!keep(result)) forget(); else evictSettled();
      }, forget);
      return pending;
    },
  };
}

const servingIds = new WeakMap<object, string>();
/**
 * A stable id for one serving lifetime of the settings owner. The settings
 * revision counts from the start again in a new daemon process, so a revision
 * read in an earlier serving period must not match one counted in this one.
 */
export function servingIdOf(lifetime: object): string {
  let id = servingIds.get(lifetime);
  if (!id) { id = crypto.randomUUID(); servingIds.set(lifetime, id); }
  return id;
}
