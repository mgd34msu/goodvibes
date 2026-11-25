/**
 * held-calls-inbox.ts, the calls this terminal program's gate holds for the
 * owner (just-vibes: not run, kept for him), posted to the daemon's one owner
 * inbox as queued actions, where the daemon already posts the calls its own
 * gate holds. Waiting for you, the web UI and a phone then show them in one
 * list and answer them there; an answer approves or sets aside the call in
 * this program's ledger, and an answer given here (`held.approve`,
 * `held.dismiss`) withdraws the item.
 *
 * The answer is heard on the daemon's event stream (`owner-inbox-update`),
 * held open only while a posted call waits; on each event the waiting items
 * are read once. A call held while the daemon is down is posted when the
 * program's daemon connection is back. Items a previous run of this program
 * posted and left open are withdrawn when the daemon is first reached.
 * Nothing waits on a clock.
 */
import { hostname } from 'node:os';
import { HELD_OWNER_ONLY_METADATA, processHeldForOwner, type HeldForOwnerCall } from '@goodvibes/engine/platform/platform/permissions';
import { subscribeDaemonEventFrames } from '@goodvibes/engine/platform/platform/runtime/client';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';

/** How long a held call waits in the inbox: as long as the daemon's own (held-for-owner.ts). */
const HELD_ITEM_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const HELD_PROGRAM = 'heldProgram';
const HELD_HOST = 'heldHost';
const HELD_PID = 'heldPid';

export interface HeldCallsInboxOptions {
  readonly invoke: (method: string, input: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly daemonEndpoint: () => Promise<{ readonly baseUrl: string; readonly token: string | null } | { readonly unavailable: string }>;
  readonly onDaemonBack: (listener: () => void) => () => void;
  readonly program: 'tui' | 'agent';
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function itemsOf(output: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> {
  const items = record(output).items;
  return Array.isArray(items) ? items.map(record) : [];
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === 'EPERM'; }
}

/** Post this program's held calls to the daemon's owner inbox and settle them by the answers there. Returns the stop. */
export function bridgeHeldCallsToDaemonInbox(options: HeldCallsInboxOptions): () => void {
  const ledger = processHeldForOwner();
  const host = hostname();
  /** Held call id → its inbox item id. */
  const posted = new Map<string, string>();
  /** Held calls not posted yet (the daemon did not answer). */
  const waiting = new Map<string, HeldForOwnerCall>();
  let stopped = false;
  let swept = false;
  let stopStream: (() => void) | null = null;

  const follow = (): void => {
    if (stopped || stopStream || posted.size === 0) return;
    let stop: (() => void) | null = null;
    let closed = false;
    stopStream = () => { closed = true; stop?.(); stop = null; };
    void options.daemonEndpoint().then((endpoint) => {
      if (closed || 'unavailable' in endpoint) { if (!closed) stopStream = null; return; }
      stop = subscribeDaemonEventFrames({ baseUrl: endpoint.baseUrl, getAuthToken: () => endpoint.token },
        { domains: ['gate'], events: ['owner-inbox-update'] }, () => { void settleAnswered(); });
    }, () => { if (!closed) stopStream = null; });
  };
  const unfollowWhenIdle = (): void => {
    if (posted.size > 0) return;
    stopStream?.();
    stopStream = null;
  };

  /** Read each posted item once; one no longer open settles its call. */
  const settleAnswered = async (): Promise<void> => {
    for (const [callId, itemId] of [...posted]) {
      let item: Readonly<Record<string, unknown>> | undefined;
      try { item = itemsOf(await options.invoke('inbox.list', { itemId }))[0]; } catch { return; }
      if (posted.get(callId) !== itemId) continue;
      if (item && item.status === 'open') continue;
      posted.delete(callId);
      const answer = record(item?.answer);
      const choice = String(answer.option ?? answer.text ?? '').trim().toLowerCase();
      if (item?.status === 'answered' && choice === 'approve') ledger.approve([callId]); else ledger.dismiss([callId]);
    }
    unfollowWhenIdle();
  };

  const post = async (call: HeldForOwnerCall): Promise<void> => {
    try {
      const output = await options.invoke('inbox.post', {
        kind: 'queued-action',
        // Not the daemon's `held:` prefix: the daemon withdraws its own earlier run's items at its start, never a terminal's.
        key: `terminal-held:${options.program}:${host}:${process.pid}:${call.id}`,
        title: `Held for you: ${call.toolName}`,
        detail: `${call.summary}\n${call.reason}\nApprove to allow this exact call for the session; it runs when the work carries on.`,
        options: ['approve', 'dismiss'],
        expiresAt: Date.now() + HELD_ITEM_LIFETIME_MS,
        metadata: {
          [HELD_PROGRAM]: options.program, [HELD_HOST]: host, [HELD_PID]: process.pid,
          ...(call.ownerOnly !== undefined ? { [HELD_OWNER_ONLY_METADATA]: call.ownerOnly } : {}),
        },
      });
      const itemId = record(record(output).item).id;
      if (typeof itemId !== 'string') throw new Error('the daemon answered inbox.post without an item');
      waiting.delete(call.id);
      // Answered here (/held) while the post was on its way: the item goes at once.
      if (!ledger.list().some((held) => held.id === call.id)) { void withdraw(itemId, 'Answered in the terminal.'); return; }
      posted.set(call.id, itemId);
      follow();
    } catch (error) {
      waiting.set(call.id, call);
      logger.debug('[held calls] posting to the owner inbox failed; posted when the daemon is back', { error: summarizeError(error) });
    }
  };

  const withdraw = async (itemId: string, reason: string): Promise<void> => {
    try { await options.invoke('inbox.withdraw', { itemId, reason }); } catch { /* answered or gone already */ }
  };

  /** Items an earlier run of this program on this machine posted and left open: their calls died with it. */
  const sweep = async (): Promise<void> => {
    if (swept) return;
    let items: ReadonlyArray<Readonly<Record<string, unknown>>>;
    try { items = itemsOf(await options.invoke('inbox.list', { status: 'open', kinds: ['queued-action'] })); } catch { return; }
    swept = true;
    for (const item of items) {
      const metadata = record(item.metadata);
      const pid = metadata[HELD_PID];
      if (metadata[HELD_PROGRAM] !== options.program || metadata[HELD_HOST] !== host || typeof pid !== 'number') continue;
      if (pid === process.pid || alive(pid)) continue;
      if (typeof item.id === 'string') void withdraw(item.id, 'The session that held this call has ended; it was not run.');
    }
  };

  const unsubscribe = ledger.subscribe((event) => {
    if (stopped) return;
    if (event.type === 'held') { void post(event.call); return; }
    waiting.delete(event.id);
    const itemId = posted.get(event.id);
    if (!itemId) return;
    posted.delete(event.id);
    void withdraw(itemId, event.approved ? 'Approved.' : 'Set aside; it was not run.');
    unfollowWhenIdle();
  });
  // The daemon back: post what waited, read what may have been answered meanwhile, and sweep once.
  const stopBack = options.onDaemonBack(() => {
    if (stopped) return;
    void sweep();
    for (const call of [...waiting.values()]) void post(call);
    if (posted.size > 0) { stopStream?.(); stopStream = null; follow(); void settleAnswered(); }
  });
  void sweep();
  for (const call of ledger.list()) void post(call);
  return () => {
    stopped = true;
    unsubscribe();
    stopBack();
    stopStream?.();
    stopStream = null;
  };
}
