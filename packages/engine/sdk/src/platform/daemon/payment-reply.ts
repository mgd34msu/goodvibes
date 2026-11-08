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
 * be on the channel policy's owner allowlist, as for permission asks, and the
 * surface must be a command-authority channel (types.ts). What the reply
 * says is the payment reply inbox's Jev reading (payments/reply-inbox.ts).
 */
import type { ChannelIngressPolicyInput, ChannelPolicyDecision } from '../channels/index.js';
import { PaymentReplyWindowError, type PaymentReplyInbox, type PaymentReplyOffer } from '../payments/reply-inbox.js';
import { parseCommandAuthorityChannel } from '../payments/types.js';
import { logger } from '../utils/logger.js';
import { isClassicOperation } from '../runtime/decision-policy.js';
import type { TelegramSourceAccountReader, TelegramSourceAccountHandle } from '../channels/telegram/source-account.js';
import type { PaymentReplyCorrelation } from '../payments/reply-inbox.js';

function accountVerifier(reader: TelegramSourceAccountReader | undefined,
  acquire: (() => Promise<TelegramSourceAccountHandle | null>) | undefined, current: () => void) {
  const read = reader?.read.bind(reader), assert = reader?.assertCurrent.bind(reader);
  return async () => {
    current();
    if (!read || !assert || !acquire) throw new PaymentReplyWindowError('source-unavailable');
    const handle = await acquire(); current();
    if (!handle) throw new PaymentReplyWindowError('source-unavailable');
    const account = await read(handle); current();
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
  options: { readonly assertCurrent?: (() => void) | undefined; readonly signal?: AbortSignal | undefined } = {},
): Promise<PaymentReplyOffer> {
  if (isClassicOperation()) return { consumed: false, reason: 'decision-model-required' };
  if (inbox === undefined || inbox.pending === 0 || !input.userId || !input.text) return { consumed: false, reason: 'no-window' };
  const owners = decision.matchedGroupPolicy?.allowlistUserIds ?? decision.policy.allowlistUserIds;
  if (owners.length === 0 || !owners.includes(input.userId)) return { consumed: false, reason: 'no-window' };
  const channel = parseCommandAuthorityChannel(input.surface);
  if (channel === null) return { consumed: false, reason: 'no-window' };
  const check = options.assertCurrent?.bind(options), signal = options.signal;
  const current = () => { signal?.throwIfAborted(); check?.(); };
  const conversationId = input.channelId, threadId = input.threadId;
  const messageId = input.metadata?.['messageId'], replyToMessageId = input.metadata?.['replyToMessageId'];
  const correlation: PaymentReplyCorrelation | undefined = conversationId === undefined ? undefined : Object.freeze({
    conversationId, threadId, messageId: typeof messageId === 'string' ? messageId : undefined,
    replyToMessageId: typeof replyToMessageId === 'string' ? replyToMessageId : undefined,
    assertCurrent: current,
    ...(channel === 'telegram' ? { verifyAccount: accountVerifier(telegramAccounts, input.acquireTelegramAccount?.bind(input), current) } : {}),
  });
  const offer = await inbox.offer(channel, input.text, correlation);
  if (offer.consumed) {
    logger.info('Purchase window answered from a channel reply', { surface: input.surface, answer: offer.answer });
  } else if (offer.reason === 'several-windows') {
    logger.info('Channel reply not read as a purchase answer: several purchase windows wait on this channel', { surface: input.surface });
  }
  return offer;
}
