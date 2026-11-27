/**
 * purchase-notices-follow.ts: an inbox item that needs no answer (a purchase notice, a report) is a notice, not a
 * question.
 *
 * The daemon's payments host posts every purchase notice to the owner inbox (payments/host/notifier.ts): a window to
 * answer carries its options (approve / deny, go / stop), and a notice that only tells (it goes ahead now, it was
 * approved, a recovery settled) carries the one option `ok`. The windows are Waiting for you's (its Purchases tab);
 * the notices are this program's notices: each is put in the notification history once (System, Notices, and the
 * status bar's unread count), and Waiting for you neither lists nor counts it (places/waiting-place.ts).
 *
 * Read when the program connects, again when its daemon connection is back, and on each owner-inbox change the
 * daemon announces; nothing waits on a clock.
 */
import { subscribeDaemonEventFrames } from '@goodvibes/engine/platform/platform/runtime/client';

/** A notice the inbox holds that only tells: a purchase item whose one option is OK. */
export function isPurchaseNotice(item: Readonly<Record<string, unknown>>): boolean {
  return item.kind === 'purchase' && Array.isArray(item.options) && item.options.length > 0 && item.options.every((option) => option === 'ok');
}

/**
 * Any inbox item that needs no answer: a purchase notice, or a report (something a part of GoodVibes left the owner
 * to read, such as the machine group's "This machine joined the group"). Each is this program's notice, never a
 * question in Waiting for you.
 */
export function isInboxNotice(item: Readonly<Record<string, unknown>>): boolean {
  return isPurchaseNotice(item) || item.kind === 'report';
}

export interface PurchaseNoticesFollowOptions {
  /** The daemon's address and credential for its event stream, or why there is none. */
  readonly daemonEndpoint: () => Promise<{ readonly baseUrl: string; readonly token: string | null } | { readonly unavailable: string }>;
  /** Told each time this program's daemon connection comes back; returns the stop. */
  readonly onDaemonBack: (listener: () => void) => () => void;
  /** A daemon method, called as this program. */
  readonly invoke: (method: string, input: Readonly<Record<string, unknown>>) => Promise<unknown>;
  /** Keeps one notice in this program's notification history. */
  readonly record: (notice: { readonly key: string; readonly title: string; readonly body: string; readonly timestamp: number; readonly domain: string }) => void;
}

const plain = (value: unknown): string => (typeof value === 'string' ? value.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]+/g, ' ').trim() : '');

/** Follow the daemon's purchase notices for this program; returns the stop. */
export function followPurchaseNotices(options: PurchaseNoticesFollowOptions): () => void {
  let stopped = false;
  let stopStream: (() => void) | null = null;
  const kept = new Set<string>();
  const read = (): void => {
    void options.invoke('inbox.list', { status: 'open' }).then((answer) => {
      if (stopped) return;
      const items = answer !== null && typeof answer === 'object' && Array.isArray((answer as { items?: unknown }).items)
        ? (answer as { items: unknown[] }).items : [];
      for (const raw of items) {
        if (raw === null || typeof raw !== 'object') continue;
        const item = raw as Record<string, unknown>;
        const id = plain(item.id);
        if (!id || kept.has(id) || !isInboxNotice(item)) continue;
        kept.add(id);
        const presentation = item.presentation !== null && typeof item.presentation === 'object' ? item.presentation as Record<string, unknown> : {};
        const purchase = item.kind === 'purchase';
        options.record({
          key: `${purchase ? 'purchase-notice' : 'inbox-notice'}:${id}`,
          // Listed by what it is about: a purchase under payments, anything else the daemon left to read under daemon.
          domain: purchase ? 'payments' : 'daemon',
          title: plain(presentation.title) || plain(item.title) || (purchase ? 'Purchase update' : 'Notice'),
          body: typeof item.detail === 'string' ? item.detail.split('\n').map(plain).join('\n').trim() : '',
          timestamp: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
        });
        // A notice needs no answer, and this program never answers one by itself: an answer in the owner inbox is the
        // owner's own act (put to them when no press of theirs makes it). It stays in the inbox until it expires; Waiting
        // for you neither lists nor counts it, and its notification key keeps it in Notices once.
      }
    }, () => { /* Not read now: read again at the next inbox change or when the daemon is back. */ });
  };
  const open = (): void => {
    stopStream?.();
    stopStream = null;
    void options.daemonEndpoint().then((endpoint) => {
      if (stopped || 'unavailable' in endpoint) return;
      stopStream = subscribeDaemonEventFrames(
        { baseUrl: endpoint.baseUrl, getAuthToken: () => endpoint.token },
        { domains: ['gate'], events: ['owner-inbox-update'] },
        () => { read(); },
      );
      read();
    }, () => { /* No daemon yet: opened when this program's daemon connection is back. */ });
  };
  open();
  const stopBack = options.onDaemonBack(() => { if (!stopped) open(); });
  return () => {
    stopped = true;
    stopBack();
    stopStream?.();
    stopStream = null;
  };
}
