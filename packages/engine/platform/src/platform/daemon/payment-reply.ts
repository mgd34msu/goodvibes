/**
 * Channel-reply resolution of pending purchase windows.
 *
 * A purchase notice goes out over the owner's command channels
 * (`payments.notifyChannels`), and the owner answers it on the same channel.
 * This hangs off the shared ingress hook (`authorizeSurfaceIngress`) beside
 * the work-proposal and permission-ask replies, so every surface adapter gets
 * it without per-adapter wiring.
 *
 * Who may answer is decided in code, before anything is read: the sender must
 * be the channel's owner (`isChannelOwner`, the same test permission answers and
 * control commands use; an allowlisted guest cannot approve spending), and the
 * surface must be a command-authority channel (types.ts). What the reply
 * says is the payment reply inbox's Jev reading (payments/reply-inbox.ts).
 */
import type { ChannelIngressPolicyInput, ChannelPolicyDecision } from '../channels/index.js';
import { channelSenderActor } from '../channels/policy-manager.js';
import { admitEffects } from '../security/effect-authority.js';
import { PaymentReplyWindowError, type PaymentReplyInbox, type PaymentReplyOffer } from '../payments/reply-inbox.js';
import { parseCommandAuthorityChannel } from '../payments/types.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { TelegramSourceAccountReader, TelegramSourceAccountHandle } from '../channels/telegram/source-account.js';
import type { PaymentReplyCorrelation } from '../payments/reply-inbox.js';

/** How long the Telegram identity check may take before the purchase window stops waiting on it. */
const ACCOUNT_VERIFY_TIMEOUT_MS = 15_000;

/**
 * Bound a Telegram lookup by the caller's signal and a deadline. The lookup is a
 * plain network call that cannot be cancelled from here, and the purchase
 * window's teardown waits for this check to settle, so an unreachable Telegram
 * must not hold the window (or daemon shutdown) open.
 */
function settleOrGiveUp<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  const stop = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(ACCOUNT_VERIFY_TIMEOUT_MS)]);
  return new Promise<T>((resolve, reject) => {
    const giveUp = () => reject(new PaymentReplyWindowError('source-unavailable'));
    if (stop.aborted) { giveUp(); return; }
    stop.addEventListener('abort', giveUp, { once: true });
    work.then(
      (value) => { stop.removeEventListener('abort', giveUp); resolve(value); },
      (error: unknown) => { stop.removeEventListener('abort', giveUp); reject(error); },
    );
  });
}

function accountVerifier(reader: TelegramSourceAccountReader | undefined,
  acquire: (() => Promise<TelegramSourceAccountHandle | null>) | undefined, current: () => void, signal?: AbortSignal) {
  const read = reader?.read.bind(reader), assert = reader?.assertCurrent.bind(reader);
  return async () => {
    current();
    if (!read || !assert || !acquire) throw new PaymentReplyWindowError('source-unavailable');
    const handle = await settleOrGiveUp(acquire(), signal); current();
    if (!handle) throw new PaymentReplyWindowError('source-unavailable');
    const account = await settleOrGiveUp(Promise.resolve(read(handle)), signal); current();
    if (!account) throw new PaymentReplyWindowError('source-unavailable');
    const assertCurrent = () => {
      try {
        current(); const observed = assert(handle);
        if (observed.id !== account.id || observed.revision !== account.revision) throw new Error();
      } catch { throw new PaymentReplyWindowError('source-unavailable'); }
    };
    assertCurrent(); return Object.freeze({ accountId: account.id, assertCurrent });
  };
}

/**
 * Offer an inbound message to the purchase windows waiting on its channel.
 * Returns the offer's outcome; `consumed: true` means the message answered a
 * window and must not become a chat turn.
 */
export async function tryResolvePaymentReplyFromChannel(
  input: ChannelIngressPolicyInput,
  decision: ChannelPolicyDecision,
  inbox: PaymentReplyInbox | undefined,
  telegramAccounts?: TelegramSourceAccountReader,
  options: {
    readonly assertCurrent?: (() => void) | undefined;
    readonly signal?: AbortSignal | undefined;
    /** Answers the owner on the channel the message came from. */
    readonly replyToOwner?: ((text: string) => Promise<unknown>) | undefined;
  } = {},
): Promise<PaymentReplyOffer> {
  if (inbox === undefined || inbox.pending === 0 || !input.userId || !input.text) return { consumed: false, reason: 'no-window' };
  if (admitEffects(channelSenderActor(decision, input.surface, input.userId), ['purchase.approve']).kind !== 'allowed') return { consumed: false, reason: 'no-window' };
  const channel = parseCommandAuthorityChannel(input.surface);
  if (channel === null) return { consumed: false, reason: 'no-window' };
  const check = options.assertCurrent?.bind(options), signal = options.signal;
  const current = () => { signal?.throwIfAborted(); check?.(); };
  const conversationId = input.channelId, threadId = input.threadId;
  const messageId = input.metadata?.['messageId'], replyToMessageId = input.metadata?.['replyToMessageId'];
  const sentAtMs = input.metadata?.['messageIsEdit'] === true ? input.metadata['messageEditedAtMs'] : input.metadata?.['messageSentAtMs'];
  const updateId = input.metadata?.['updateId'];
  const correlation: PaymentReplyCorrelation | undefined = conversationId === undefined ? undefined : Object.freeze({
    conversationId, threadId, userId: input.userId, sentAtMs: typeof sentAtMs === 'number' ? sentAtMs : undefined,
    updateId: typeof updateId === 'string' ? updateId : undefined,
    messageId: typeof messageId === 'string' ? messageId : undefined,
    replyToMessageId: typeof replyToMessageId === 'string' ? replyToMessageId : undefined,
    assertCurrent: current,
    ...(channel === 'telegram' ? { verifyAccount: accountVerifier(telegramAccounts, input.acquireTelegramAccount?.bind(input), current, signal) } : {}),
  });
  // With no decision model in use the inbox reads the reply in code (readPaymentReply).
  const offer = await inbox.offer(channel, input.text, correlation);
  if (offer.consumed) {
    logger.info('Purchase window answered from a channel reply', { surface: input.surface, answer: offer.answer });
  } else if (offer.reason === 'several-windows') {
    logger.info('Channel reply not read as a purchase answer: several purchase windows wait on this channel', { surface: input.surface });
    // The message is not consumed, so without a word back the owner sees silence
    // and cannot tell their answer was set aside; every window stays open.
    try {
      const delivery = await options.replyToOwner?.('More than one purchase is waiting; reply to the specific notice so I know which one you mean.');
      if (typeof delivery === 'object' && delivery !== null && 'delivered' in delivery && delivery.delivered === false) {
        logger.warn('The owner was not told which purchase reply is needed', { surface: input.surface, reason: 'reason' in delivery ? String(delivery.reason) : 'unknown' });
      }
    } catch (error) {
      logger.warn('Could not tell the owner which purchase reply is needed', { surface: input.surface, error: summarizeError(error) });
    }
  }
  return offer;
}
