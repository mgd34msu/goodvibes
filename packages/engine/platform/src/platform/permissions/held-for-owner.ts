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
  /** The owner-only kind it was held as (gate/classify.ts), when it is one. */
  readonly ownerOnly?: string | undefined;
  /** The folder of the project the call was made in, when the gate knew it: approving it settles the call there only. */
  readonly project?: string | undefined;
  /** The session the call was made in, when the gate knew it. */
  readonly sessionId?: string | undefined;
}

/** Inbox item metadata naming the owner-only kind a held call was held as; its card opens on No for the kinds that do (ask-presentation.ts). */
export const HELD_OWNER_ONLY_METADATA = 'ownerOnly';

/**
 * Inbox item metadata marking a queued action as a send the Agent's content check refused (a mail or a calendar
 * invitation), held for the owner to send as shown or drop (terminal-shell places/held-sends-inbox.ts).
 */
export const HELD_SEND_METADATA = 'heldSend';

interface HeldEntry extends HeldForOwnerCall {
  /** Identifies the exact call (tool, arguments, session); a repeat is held once. */
  readonly key: string;
  readonly approve: () => void;
}

export const HELD_FOR_OWNER_CAPACITY = 64;

/** What happened to a held call: held now, or answered (approved or set aside). */
export type HeldForOwnerEvent =
  | { readonly type: 'held'; readonly call: HeldForOwnerCall }
  | { readonly type: 'settled'; readonly id: string; readonly approved: boolean };

export class HeldForOwnerLedger {
  private readonly entries = new Map<string, HeldEntry>();
  private readonly listeners = new Set<(event: HeldForOwnerEvent) => void>();
  private sequence = 0;

  /** Told of every new held call and every answer; returns the unsubscribe. */
  subscribe(listener: (event: HeldForOwnerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(event: HeldForOwnerEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* One listener cannot stop the gate or another listener. */ }
    }
  }

  /** Hold one call; the same exact call held again keeps its first id. */
  hold(call: { readonly key: string; readonly toolName: string; readonly summary: string; readonly reason: string; readonly ownerOnly?: string | undefined;
    readonly project?: string | undefined; readonly sessionId?: string | undefined },
    approve: () => void): HeldForOwnerCall {
    for (const entry of this.entries.values()) if (entry.key === call.key) return view(entry);
    const entry: HeldEntry = { ...call, id: `h${(++this.sequence).toString()}`, heldAt: Date.now(), approve };
    this.entries.set(entry.id, entry);
    if (this.entries.size > HELD_FOR_OWNER_CAPACITY) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) { this.entries.delete(oldest.value); this.emit({ type: 'settled', id: oldest.value, approved: false }); }
    }
    const held = view(entry);
    this.emit({ type: 'held', call: held });
    return held;
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
      this.emit({ type: 'settled', id, approved: true });
    }
    return chosen;
  }

  /** Set held calls aside without running them. Returns the ids removed. */
  dismiss(ids: readonly string[] | 'all'): readonly string[] {
    const chosen = this.pick(ids);
    for (const id of chosen) { this.entries.delete(id); this.emit({ type: 'settled', id, approved: false }); }
    return chosen;
  }

  private pick(ids: readonly string[] | 'all'): readonly string[] {
    return ids === 'all' ? [...this.entries.keys()] : [...new Set(ids)].filter((id) => this.entries.has(id));
  }
}

function view(entry: HeldEntry): HeldForOwnerCall {
  return { id: entry.id, toolName: entry.toolName, summary: entry.summary, reason: entry.reason, heldAt: entry.heldAt, ...(entry.ownerOnly !== undefined ? { ownerOnly: entry.ownerOnly } : {}),
    ...(entry.project !== undefined ? { project: entry.project } : {}), ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}) };
}

const processLedger = new HeldForOwnerLedger();

/** This process's held calls: the gate writes them, `/held` reads and answers them. */
export function processHeldForOwner(): HeldForOwnerLedger {
  return processLedger;
}

/** The part of the owner inbox held calls are posted to (control-plane/owner-inbox.ts). */
export interface HeldForOwnerInbox {
  postNow(item: { readonly kind: 'queued-action'; readonly title: string; readonly detail?: string | undefined;
    readonly options?: readonly string[] | undefined; readonly key?: string | undefined; readonly expiresAt?: number | undefined;
    readonly metadata?: Readonly<Record<string, string | number | boolean>> | undefined;
  }): { readonly item: { readonly id: string } };
  listNow(filter: { readonly status: 'open'; readonly kinds: readonly ['queued-action']; readonly limit: number }): readonly { readonly id: string; readonly key?: string | undefined }[];
  waitForAnswer(id: string, signal?: AbortSignal): Promise<{ readonly status: string; readonly answer?: { readonly option?: string | undefined; readonly text?: string | undefined } | undefined }>;
  withdraw(id: string, reason: string): unknown;
}

const HELD_ITEM_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const HELD_KEY_PREFIX = 'held:';

/**
 * Post every call the gate holds to the owner inbox as a `queued-action` with
 * `approve` and `dismiss`, so the owner sees it in `/questions` and the web UI
 * and answers it from any surface; his answer approves or sets aside the held
 * call, and an answer here or through `/held` closes the other. Held calls live
 * in this process, so items a previous process posted are withdrawn at start.
 *
 * Cost: one inbox write per held call and one per answer; nothing per request.
 */
export function bridgeHeldForOwnerToInbox(ledger: HeldForOwnerLedger, inbox: HeldForOwnerInbox): () => void {
  const boot = `${HELD_KEY_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}:`;
  const lifetime = new AbortController();
  const items = new Map<string, string>();
  try {
    for (const stale of inbox.listNow({ status: 'open', kinds: ['queued-action'], limit: 200 })) {
      if (stale.key?.startsWith(HELD_KEY_PREFIX)) inbox.withdraw(stale.id, 'The session that held this call has ended; it was not run.');
    }
  } catch { /* An unreadable inbox leaves old items to expire. */ }
  const unsubscribe = ledger.subscribe((event) => {
    if (event.type === 'settled') {
      const itemId = items.get(event.id);
      items.delete(event.id);
      if (itemId) { try { inbox.withdraw(itemId, event.approved ? 'Approved.' : 'Set aside; it was not run.'); } catch { /* already answered */ } }
      return;
    }
    const call = event.call;
    let itemId: string;
    try {
      itemId = inbox.postNow({ kind: 'queued-action', key: `${boot}${call.id}`, title: `Held for you: ${call.toolName}`,
        // The project it was made in, by its name: an approval settles the call there, never in another project.
        detail: `${call.summary}\n${call.reason}\n${call.project ? `In: ${call.project.split(/[\\/]/).filter(Boolean).pop() ?? call.project} (${call.project})\n` : ''}Approve to allow this exact call for the session; it runs when the work carries on.`,
        options: ['approve', 'dismiss'], expiresAt: Date.now() + HELD_ITEM_LIFETIME_MS,
        ...(call.ownerOnly !== undefined ? { metadata: { [HELD_OWNER_ONLY_METADATA]: call.ownerOnly } } : {}) }).item.id;
    } catch { return; }
    items.set(call.id, itemId);
    inbox.waitForAnswer(itemId, lifetime.signal).then((settled) => {
      if (items.get(call.id) !== itemId) return;
      items.delete(call.id);
      if (settled.status !== 'answered') return;
      const choice = (settled.answer?.option ?? settled.answer?.text ?? '').trim().toLowerCase();
      if (choice === 'approve') ledger.approve([call.id]); else ledger.dismiss([call.id]);
    }, () => { /* stopped with this process */ });
  });
  return () => { unsubscribe(); lifetime.abort(); };
}
