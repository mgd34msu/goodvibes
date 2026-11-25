/**
 * held-sends-inbox.ts, the sends the Agent's content check refused (a mail, a
 * calendar invitation: agent-turn/outward-approvals.ts), posted to the
 * daemon's one owner inbox as held actions, beside the calls a gate held.
 * Waiting for you (its Sends tab) in every program, the web UI and a phone
 * then show each one exactly as it would go out, and the answer there sends
 * it or drops it: "Send it as shown" runs the very send that was refused,
 * with the bytes shown, from this Agent (which holds the mail and calendar
 * connection); "Drop it" drops it. A send stays approvable five minutes: its
 * item expires with it, by the inbox's own expiry, and the expired send is
 * dropped here too.
 *
 * Who may answer is the inbox's rule: the owner's own act, an agent is
 * refused. A send approved or dropped in this Agent another way withdraws its
 * item. The answer is heard on the daemon's event stream
 * (`owner-inbox-update`), held open only while a posted send waits. A send
 * refused while the daemon is down is posted when the Agent's daemon
 * connection is back. Nothing waits on a clock.
 */
import { hostname } from 'node:os';
import { HELD_SEND_METADATA } from '@goodvibes/engine/platform/platform/permissions';
import { subscribeDaemonEventFrames } from '@goodvibes/engine/platform/platform/runtime/client';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import {
  getOutwardApprovalStore, listRefusedOutwardActions, onRefusedOutwardActionsChange, takeRefusedOutwardAction, type PendingOutwardAction,
} from '../agent-turn/outward-approvals.js';

/** As long as a refused send stays approvable (outward-approvals.ts). */
const SEND_LIFETIME_MS = 5 * 60 * 1000;
const HELD_PROGRAM = 'heldProgram';
const HELD_HOST = 'heldHost';
const HELD_PID = 'heldPid';
const DETAIL_CHARS = 3_900;

export interface HeldSendsInboxOptions {
  readonly invoke: (method: string, input: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly daemonEndpoint: () => Promise<{ readonly baseUrl: string; readonly token: string | null } | { readonly unavailable: string }>;
  readonly onDaemonBack: (listener: () => void) => () => void;
  /** Says what became of a send the owner approved, in the Agent's conversation and to its model's next request. */
  readonly told?: ((line: string) => void) | undefined;
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

/** Exactly what would go out, one field a line ("to: ...", "subject: ..."), as the owner is shown it. */
export function heldSendDetail(entry: Pick<PendingOutwardAction, 'content'>): string {
  const lines: string[] = [];
  for (const [field, value] of Object.entries(entry.content)) {
    if (value === undefined || value === '') continue;
    const [first = '', ...rest] = value.split('\n');
    lines.push(`${field}: ${first}`, ...rest.map((line) => `  ${line}`));
  }
  const detail = lines.join('\n');
  return detail.length > DETAIL_CHARS ? `${detail.slice(0, DETAIL_CHARS - 1)}…` : detail;
}

/** Post the Agent's refused sends to the daemon's owner inbox and send or drop each by the answer there. Returns the stop. */
export function bridgeHeldSendsToDaemonInbox(options: HeldSendsInboxOptions): () => void {
  const host = hostname();
  /** Send number → its inbox item and the moment of the refusal it shows. */
  const posted = new Map<number, { readonly itemId: string; readonly at: number }>();
  /** Sends not posted yet (the daemon did not answer). */
  const waiting = new Map<number, PendingOutwardAction>();
  /** Sends this bridge is settling itself (an answer from the inbox): their leaving the list withdraws nothing. */
  const settling = new Set<number>();
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

  const withdraw = async (itemId: string, reason: string): Promise<void> => {
    try { await options.invoke('inbox.withdraw', { itemId, reason }); } catch { /* answered or gone already */ }
  };

  /** The owner said send: the very send that was refused goes out, with the content he was shown. */
  const send = async (entry: PendingOutwardAction): Promise<void> => {
    if (!entry.perform) {
      // No way to perform it from here: a one-use approval for the exact content, spent by the next identical call.
      const approval = getOutwardApprovalStore().grant({ action: entry.action, surface: 'owner-direct', content: entry.content });
      options.told?.(approval === null
        ? `The owner approved "${entry.description}", but the approval could not be recorded; nothing was sent.`
        : `The owner approved "${entry.description}" exactly as shown: it is good once for that content and ends in five minutes.`);
      return;
    }
    try {
      const outcome = await entry.perform();
      options.told?.(`The owner approved "${entry.description}" in Waiting for you. ${outcome.ok ? 'Sent' : 'It did not go through'}: ${outcome.text} Do not send it again.`);
    } catch (error) {
      options.told?.(`The owner approved "${entry.description}" in Waiting for you, but it did not go through: ${summarizeError(error)} Do not send it again.`);
    }
  };

  /** Read each posted item once; one no longer open sends or drops its send. */
  const settleAnswered = async (): Promise<void> => {
    for (const [sendId, post] of [...posted]) {
      let item: Readonly<Record<string, unknown>> | undefined;
      try { item = itemsOf(await options.invoke('inbox.list', { itemId: post.itemId }))[0]; } catch { return; }
      if (posted.get(sendId)?.itemId !== post.itemId) continue;
      if (item && item.status === 'open') continue;
      posted.delete(sendId);
      const answer = record(item?.answer);
      const choice = String(answer.option ?? answer.text ?? '').trim().toLowerCase();
      settling.add(sendId);
      const entry = takeRefusedOutwardAction(sendId);
      settling.delete(sendId);
      if (entry && item?.status === 'answered' && choice === 'approve') await send(entry);
    }
    unfollowWhenIdle();
  };

  const post = async (entry: PendingOutwardAction): Promise<void> => {
    try {
      const output = await options.invoke('inbox.post', {
        kind: 'queued-action',
        key: `terminal-held-send:agent:${host}:${process.pid}:${entry.id}:${entry.at}`,
        title: `Refused send: ${entry.description}`,
        detail: heldSendDetail(entry),
        options: ['approve', 'drop'],
        askedBy: 'the Agent\'s content check',
        expiresAt: entry.at + SEND_LIFETIME_MS,
        metadata: { [HELD_SEND_METADATA]: true, [HELD_PROGRAM]: 'agent', [HELD_HOST]: host, [HELD_PID]: process.pid },
      });
      const itemId = record(record(output).item).id;
      if (typeof itemId !== 'string') throw new Error('the daemon answered inbox.post without an item');
      waiting.delete(entry.id);
      // Taken here another way while the post was on its way: the item goes at once.
      if (!listRefusedOutwardActions().some((held) => held.id === entry.id && held.at === entry.at)) { void withdraw(itemId, 'Answered in the Agent.'); return; }
      posted.set(entry.id, { itemId, at: entry.at });
      follow();
    } catch (error) {
      waiting.set(entry.id, entry);
      logger.debug('[held sends] posting to the owner inbox failed; posted when the daemon is back', { error: summarizeError(error) });
    }
  };

  /** Items an earlier run of the Agent on this machine posted and left open: their sends died with it. */
  const sweep = async (): Promise<void> => {
    if (swept) return;
    let items: ReadonlyArray<Readonly<Record<string, unknown>>>;
    try { items = itemsOf(await options.invoke('inbox.list', { status: 'open', kinds: ['queued-action'] })); } catch { return; }
    swept = true;
    for (const item of items) {
      const metadata = record(item.metadata);
      const pid = metadata[HELD_PID];
      if (metadata[HELD_SEND_METADATA] !== true || metadata[HELD_HOST] !== host || typeof pid !== 'number') continue;
      if (pid === process.pid || alive(pid)) continue;
      if (typeof item.id === 'string') void withdraw(item.id, 'The Agent that held this send has ended; nothing was sent.');
    }
  };

  /** The list changed here: post what is new (or refused again), withdraw what left it another way. */
  const reconcile = (): void => {
    if (stopped) return;
    const now = listRefusedOutwardActions();
    for (const entry of now) {
      const known = posted.get(entry.id);
      if (known && known.at === entry.at) continue;
      if (known) { posted.delete(entry.id); void withdraw(known.itemId, 'Refused again; shown anew.'); }
      if (waiting.get(entry.id)?.at === entry.at) continue;
      waiting.set(entry.id, entry);
      void post(entry);
    }
    for (const [sendId, known] of [...posted]) {
      if (now.some((entry) => entry.id === sendId) || settling.has(sendId)) continue;
      posted.delete(sendId);
      void withdraw(known.itemId, 'Answered in the Agent.');
    }
    for (const sendId of [...waiting.keys()]) if (!now.some((entry) => entry.id === sendId)) waiting.delete(sendId);
    unfollowWhenIdle();
  };

  const unsubscribe = onRefusedOutwardActionsChange(reconcile);
  // The daemon back: post what waited, read what may have been answered meanwhile, and sweep once.
  const stopBack = options.onDaemonBack(() => {
    if (stopped) return;
    void sweep();
    for (const entry of [...waiting.values()]) void post(entry);
    if (posted.size > 0) { stopStream?.(); stopStream = null; follow(); void settleAnswered(); }
  });
  void sweep();
  reconcile();
  return () => {
    stopped = true;
    unsubscribe();
    stopBack();
    stopStream?.();
    stopStream = null;
  };
}
