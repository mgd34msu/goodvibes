/**
 * notifier.ts, sending a purchase notice over the daemon's channels and
 * hearing the owner's answer.
 *
 * `createChannelPaymentNotifier` (payments/notice-delivery.ts) wants a router,
 * a target per configured channel, and a `PaymentReplySource`.
 * `payments.notifyChannels` names which `CommandAuthorityChannel`s to notify,
 * and delivery goes out over the daemon's own `ChannelDeliveryRouter`, the
 * same router every other channel send uses.
 *
 * The reply source is the daemon's `PaymentReplyInbox`
 * (payments/reply-inbox.ts), which the shared channel ingress hook feeds with
 * the owner's inbound messages (daemon/payment-reply.ts). A reply is read by
 * Jev against the notice it follows; an answer settles the window before its
 * deadline, and anything else leaves the window to its own silence rule
 * (payments/windows.ts): an approval window's silence denies and a veto
 * window's silence proceeds.
 *
 * `withOwnerInbox` adds the owner inbox as a target that always exists: every
 * notice is posted there too, so both terminal apps and the web UI show it and
 * can answer it, and an in-budget purchase is never bought with nobody told.
 */
import type { ChannelDeliveryRouter, ChannelDeliveryTarget } from '../../channels/index.js';
import { createChannelPaymentNotifier } from '../notice-delivery.js';
import type { PaymentNoticeRouter, PaymentNoticeTarget, PaymentReplySource } from '../notice-delivery.js';
import type { PaymentNotifier, PaymentNoticeWindow } from '../payment-ports.js';
import type { NewOwnerItem, OwnerItem } from '../../control-plane/owner-inbox.js';
import type { ChannelDelivery } from '../windows.js';
import { readNotifyChannels, type PaymentsConfigReader } from '../payments-config.js';
import { parseCommandAuthorityChannel } from '../types.js';
import { logger } from '../../utils/logger.js';

const PAYMENTS_NOTICE_JOB_ID = 'payments-notice';

/**
 * The channel name (`payments.notifyChannels` entry) turned into the router's
 * own addressing shape. This mirrors `parseChannelDeliveryTarget`'s `surface`
 * construction for the plain channel names `readNotifyChannels` produces (no
 * `kind:address` suffix, `CommandAuthorityChannel` carries none).
 */
function surfaceTarget(surfaceKind: string): ChannelDeliveryTarget {
  return { kind: 'surface', surfaceKind: surfaceKind as ChannelDeliveryTarget['surfaceKind'] };
}

/** Adapts the daemon's router to the notifier's narrow, opaque-`request` shape. */
export function daemonNoticeRouter(router: Pick<ChannelDeliveryRouter, 'deliver'> & Partial<Pick<ChannelDeliveryRouter, 'deliverWithReceipt'>>): PaymentNoticeRouter {
  const deliver = router.deliver.bind(router), deliverWithReceipt = router.deliverWithReceipt?.bind(router);
  const requestFor = (request: never): Parameters<ChannelDeliveryRouter['deliver']>[0] => {
    const merged = request as unknown as Record<string, unknown> & { readonly content: string };
    return {
      target: merged['target'] as ChannelDeliveryTarget,
      body: merged.content,
      title: 'Purchase',
      jobId: PAYMENTS_NOTICE_JOB_ID,
      runId: `${PAYMENTS_NOTICE_JOB_ID}-${String(Date.now())}`,
      includeLinks: false,
      binding: merged['binding'] as Parameters<ChannelDeliveryRouter['deliver']>[0]['binding'],
      allowDuplicate: merged['allowDuplicate'] === true,
      assertCurrent: merged['assertCurrent'] as (() => void) | undefined,
      signal: merged['signal'] as AbortSignal | undefined,
    };
  };
  return {
    deliver: request => deliver(requestFor(request)),
    ...(deliverWithReceipt === undefined ? {} : { deliverWithReceipt: (request: never) => deliverWithReceipt(requestFor(request)) }),
  };
}

export function channelBackedPaymentNotifier(
  config: PaymentsConfigReader,
  router: Pick<ChannelDeliveryRouter, 'deliver'> & Partial<Pick<ChannelDeliveryRouter, 'deliverWithReceipt'>>,
  replies: PaymentReplySource,
): PaymentNotifier {
  const targets: PaymentNoticeTarget[] = [];
  for (const name of readNotifyChannels(config)) {
    const channel = parseCommandAuthorityChannel(name);
    // Always notified, through withOwnerInbox; not a channel the router reaches.
    if (channel === 'owner-inbox') continue;
    if (channel === null) {
      logger.warn('payments.notifyChannels names a channel this daemon does not recognise; it will not be notified', { channel: name });
      continue;
    }
    targets.push({
      channel,
      request: { target: surfaceTarget(name) },
      // This router keeps no history. Replies to a Telegram notice are read
      // back after a restart from the payment reply archive instead, which is
      // what RESTART_READABLE_CHANNELS (windows.ts) states; nothing reads this.
      backfillable: false,
    });
  }

  return createChannelPaymentNotifier({
    requireDeliveryReceipt: true,
    router: daemonNoticeRouter(router),
    targets,
    replies,
    onDeliveryFailure: ({ channel, reason }) => {
      logger.warn('A payments notice could not be delivered on a configured channel', { channel, reason });
    },
  });
}

/** The part of the owner inbox (control-plane/owner-inbox.ts) a purchase notice is posted through. */
export interface PaymentOwnerInbox {
  postNow(item: NewOwnerItem): { readonly item: OwnerItem };
  /** The item as stored now; read once when a window closes, so an answer recorded by its deadline is never taken for silence. */
  get(id: string): OwnerItem | undefined;
  waitForAnswer(id: string, signal?: AbortSignal): Promise<OwnerItem>;
  withdraw(id: string, reason: string): unknown;
}

type PaymentWindowKind = 'approval' | 'veto';
type NotifierAnswer = Awaited<ReturnType<PaymentNotifier['awaitAnswer']>>;

/** One word each, so an option can also be typed as the answer. */
const INBOX_OPTIONS: Readonly<Record<PaymentWindowKind, readonly string[]>> = {
  approval: ['approve', 'deny'],
  veto: ['go', 'stop'],
};

const INBOX_TITLES: Readonly<Record<PaymentWindowKind | 'notice', string>> = {
  approval: 'Approve this purchase?',
  veto: 'A purchase goes ahead unless you stop it',
  notice: 'Purchase update',
};

/** A notice the owner reads rather than answers stays listed for a week. */
const INBOX_NOTICE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const INBOX_DETAIL_CHARS = 4000;

/** An owner-inbox answer to a purchase window, as the reply a channel would carry; null when it is neither option. */
export function inboxAnswer(kind: PaymentWindowKind, option: string | undefined): NonNullable<NotifierAnswer>['answer'] | null {
  if (kind === 'approval') return option === 'approve' ? 'approve' : option === 'deny' ? 'deny' : null;
  return option === 'go' ? 'acknowledge' : option === 'stop' ? 'object' : null;
}

/** The key a purchase's window item is posted under; a restart finds the item, and its answer, by it. */
export function purchaseInboxKey(purchaseId: string, kind: PaymentWindowKind | 'notice'): string {
  return `purchase:${purchaseId}:${kind}`;
}

/** The owner-inbox item for one purchase notice or window. */
export function purchaseInboxItem(kind: PaymentWindowKind | 'notice', message: string, expiresAt: number, purchaseId?: string): NewOwnerItem {
  return {
    kind: 'purchase',
    title: INBOX_TITLES[kind],
    detail: message.length > INBOX_DETAIL_CHARS ? `${message.slice(0, INBOX_DETAIL_CHARS - 1)}…` : message,
    options: kind === 'notice' ? ['ok'] : INBOX_OPTIONS[kind],
    expiresAt,
    ...(purchaseId === undefined ? {} : { key: purchaseInboxKey(purchaseId, kind), metadata: { purchaseId } }),
  };
}

/**
 * The notifier with the owner inbox as a target that always exists.
 *
 * A window's notice is posted as a `purchase` item with its options and the
 * window's deadline, recorded as a delivery on `owner-inbox`, and the first
 * answer, from a channel reply or from the inbox, settles the window; the item
 * is withdrawn when the window closes. A notice that needs no answer (a
 * confirmation, a recovery settlement) is posted with one `ok` option. A post
 * that fails is reported as undelivered on `owner-inbox` and never stops the
 * channel sends. The item and its answer live in the home's owner-inbox store,
 * so a restart during the window reads the answer back by the item's key
 * (restored-reply-window.ts) and the window can resume.
 *
 * Cost: one record-log append per notice, one per answer or withdrawal.
 */
export function withOwnerInbox(
  inner: PaymentNotifier,
  inbox: PaymentOwnerInbox,
  /** The configured length of each window, so an item a restart orphans expires with it. */
  windowMinutes?: (kind: PaymentWindowKind) => number,
): PaymentNotifier {
  const expiry = (kind: PaymentWindowKind | 'notice'): number => {
    const minutes = kind === 'notice' ? undefined : windowMinutes?.(kind);
    // A minute past the window, which is armed after the notice is sent.
    return minutes === undefined || !Number.isFinite(minutes) || minutes <= 0
      ? Date.now() + INBOX_NOTICE_LIFETIME_MS
      : Date.now() + (minutes + 1) * 60_000;
  };
  const post = (kind: PaymentWindowKind | 'notice', message: string, purchaseId?: string): OwnerItem | null => {
    try {
      return inbox.postNow(purchaseInboxItem(kind, message, expiry(kind), purchaseId)).item;
    } catch (error) {
      logger.warn('A purchase notice could not be posted to the owner inbox', { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };
  const inboxDelivery = (item: OwnerItem | null): ChannelDelivery => ({ channel: 'owner-inbox', delivered: item !== null, backfillable: false });

  /** The first answer from the channels or the inbox; the inbox item is withdrawn when the window closes. */
  /**
   * The answer the inbox item holds, when the owner recorded one by the
   * window's deadline: an answer written to the store by another process (a
   * terminal app not connected to this daemon) still settles the window.
   */
  const recordedAnswer = (kind: PaymentWindowKind, id: string, deadlineMs: number): NotifierAnswer => {
    let stored: OwnerItem | undefined;
    try { stored = inbox.get(id); } catch { return null; }
    if (stored?.status !== 'answered' || stored.closedAt === undefined || !(stored.closedAt <= deadlineMs)) return null;
    const answer = inboxAnswer(kind, stored.answer?.option ?? stored.answer?.text?.trim().toLowerCase());
    return answer === null ? null : { answer, channel: 'owner-inbox' };
  };

  const firstAnswer = async (
    kind: PaymentWindowKind,
    item: OwnerItem | null,
    channelWait: Promise<NotifierAnswer>,
    signal: AbortSignal | undefined,
    deadlineMs: number,
    /** Retires the channel wait when the inbox answered first. */
    retireChannels?: () => void,
  ): Promise<NotifierAnswer> => {
    if (item === null) return channelWait;
    const fromChannels = channelWait.then((answer) => ({ from: 'channel' as const, answer }));
    // A channel wait retired after the inbox answered rejects; nothing reads it then.
    void fromChannels.catch(() => {});
    const stop = new AbortController();
    const onAbort = (): void => { stop.abort(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const fromInbox = inbox.waitForAnswer(item.id, stop.signal).then((settled): NotifierAnswer | undefined => {
      if (settled.status !== 'answered') return undefined;
      const answer = inboxAnswer(kind, settled.answer?.option ?? settled.answer?.text?.trim().toLowerCase());
      return answer === null ? undefined : { answer, channel: 'owner-inbox' };
    }, () => undefined);
    try {
      const first = await Promise.race([
        fromChannels,
        fromInbox.then((answer) => ({ from: 'inbox' as const, answer })),
      ]);
      // Silence on the channels is read against the item once before it counts: the inbox answer may not have been heard yet.
      if (first.from === 'channel') return first.answer ?? recordedAnswer(kind, item.id, deadlineMs);
      if (first.answer !== undefined) {
        retireChannels?.();
        return first.answer;
      }
      // Closed without an answer (expired with the window, or withdrawn): the channels decide.
      return await channelWait;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      stop.abort();
      try { inbox.withdraw(item.id, 'the purchase window closed'); } catch { /* already closed */ }
    }
  };

  // A window sent through `deliver` (a transport without prepareWindow) is
  // answered through `awaitAnswer`, which names the same notice.
  const posted = new Map<string, OwnerItem | null>();
  const notifier: PaymentNotifier = {
    async deliver(input) {
      const deliveries = await inner.deliver(input);
      input.signal?.throwIfAborted(); input.assertCurrent?.();
      const item = post(input.kind, input.message);
      if (input.kind !== 'notice') posted.set(`${input.kind}\n${input.message}`, item);
      return [...deliveries, inboxDelivery(item)];
    },
    awaitAnswer: (input) => {
      const key = `${input.kind}\n${input.notice}`;
      const item = posted.get(key) ?? null;
      posted.delete(key);
      return firstAnswer(input.kind, item, inner.awaitAnswer(input), input.signal, input.deadlineMs);
    },
  };
  const prepare = inner.prepareWindow?.bind(inner);
  if (prepare) {
    notifier.prepareWindow = (input): PaymentNoticeWindow => {
      const window = prepare(input);
      let item: OwnerItem | null = null;
      const deliveries = window.deliveries.then((report) => {
        input.signal?.throwIfAborted(); input.assertCurrent?.();
        item = post(input.kind, input.notice, input.purchaseId);
        return Object.freeze([...report, Object.freeze(inboxDelivery(item))]);
      });
      return Object.freeze({
        deliveries,
        cancel: () => {
          window.cancel();
          if (item !== null) { try { inbox.withdraw(item.id, 'the purchase window closed'); } catch { /* already closed */ } }
        },
        awaitAnswer: (deadlineMs: number) => firstAnswer(input.kind, item, window.awaitAnswer(deadlineMs), input.signal, deadlineMs, () => window.cancel()),
      });
    };
  }
  return notifier;
}
