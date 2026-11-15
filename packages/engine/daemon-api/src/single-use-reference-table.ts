/**
 * The reference table behind the settings precondition lanes: a capture issues
 * a one-use reference, an apply takes it. Both lanes share this so expiry,
 * eviction and the spent-versus-stale answer cannot drift apart.
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
