/**
 * Calls permissions.mode just-vibes held for the owner instead of asking him
 * in the middle of the work: not run, listed at the end of the run, and
 * approved or set aside by him afterwards (`/held` in both terminal apps).
 *
 * An approval is his answer "allow for this session" for that exact call, as
 * if he had been asked when it was made: the gate that held it records it
 * (PermissionManager), so the same call runs when it is made again.
 *
 * One ledger per process, like the process's permission gate. Bounded: the
 * oldest held call is dropped past HELD_FOR_OWNER_CAPACITY.
 */

/** A call just-vibes held for the owner. */
export interface HeldForOwnerCall {
  /** Short id the owner approves it by (`/held approve h3`). */
  readonly id: string;
  readonly toolName: string;
  /** What the call would do, as the gate summarized it. */
  readonly summary: string;
  readonly reason: string;
  readonly heldAt: number;
}

interface HeldEntry extends HeldForOwnerCall {
  /** Identifies the exact call (tool, arguments, session); a repeat is held once. */
  readonly key: string;
  readonly approve: () => void;
}

export const HELD_FOR_OWNER_CAPACITY = 64;

export class HeldForOwnerLedger {
  private readonly entries = new Map<string, HeldEntry>();
  private sequence = 0;

  /** Hold one call; the same exact call held again keeps its first id. */
  hold(call: { readonly key: string; readonly toolName: string; readonly summary: string; readonly reason: string },
    approve: () => void): HeldForOwnerCall {
    for (const entry of this.entries.values()) if (entry.key === call.key) return view(entry);
    const entry: HeldEntry = { ...call, id: `h${(++this.sequence).toString()}`, heldAt: Date.now(), approve };
    this.entries.set(entry.id, entry);
    if (this.entries.size > HELD_FOR_OWNER_CAPACITY) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    return view(entry);
  }

  /** Held calls, oldest first. */
  list(): readonly HeldForOwnerCall[] {
    return [...this.entries.values()].map(view);
  }

  /** Approve held calls by id (or all): each becomes the owner's session answer for that call. Returns the ids approved. */
  approve(ids: readonly string[] | 'all'): readonly string[] {
    const chosen = this.pick(ids);
    for (const id of chosen) {
      const entry = this.entries.get(id)!;
      this.entries.delete(id);
      entry.approve();
    }
    return chosen;
  }

  /** Set held calls aside without running them. Returns the ids removed. */
  dismiss(ids: readonly string[] | 'all'): readonly string[] {
    const chosen = this.pick(ids);
    for (const id of chosen) this.entries.delete(id);
    return chosen;
  }

  private pick(ids: readonly string[] | 'all'): readonly string[] {
    return ids === 'all' ? [...this.entries.keys()] : [...new Set(ids)].filter((id) => this.entries.has(id));
  }
}

function view(entry: HeldEntry): HeldForOwnerCall {
  return { id: entry.id, toolName: entry.toolName, summary: entry.summary, reason: entry.reason, heldAt: entry.heldAt };
}

const processLedger = new HeldForOwnerLedger();

/** This process's held calls: the gate writes them, `/held` reads and answers them. */
export function processHeldForOwner(): HeldForOwnerLedger {
  return processLedger;
}
