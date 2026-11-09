import type { TelegramSourceAccountHandle, TelegramWebhookAccountLease } from '../../channels/telegram/source-account.js';
import type { SurfaceAdapterContext } from '../types.js';
import { constantTimeEquals, parseJsonRecord, readTextBodyWithinLimit } from '../helpers.js';
import { resolveSurfaceCredential, surfaceCredentialUnavailable } from '../surface-credential.js';
import { logger } from '../../utils/logger.js';
import { parseTelegramBotCommand, telegramBotCommandReply } from './commands.js';
import type { TelegramReceiveScope } from '../../channels/telegram/receive-progress.js';

/**
 * Capabilities an ingress mode lends to update handling.
 *
 * Both the webhook route and the getUpdates poller process updates through the
 * SAME function below; this is the only thing that differs between them. The
 * poller passes a live Bot API sender; a webhook caller may pass one too, and
 * omits it only where no bot token is resolvable.
 */
export interface TelegramUpdateDeps {
  readonly signal?: AbortSignal | undefined;
  readonly acquireSourceAccount?: (() => Promise<TelegramSourceAccountHandle | null>) | undefined;
  /** Payment-only ingress proof; does not opt HTTP into delegated work intake. */
  readonly acquirePaymentSourceAccount?: (() => Promise<TelegramSourceAccountHandle | null>) | undefined;
  readonly authorizeWebhook?: ((secret: string) => TelegramWebhookAccountLease | null) | undefined;
  readonly sendMessage?: ((input: {
    readonly chatId: string;
    readonly text: string;
    readonly threadId?: string | undefined;
  }) => Promise<void>) | undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

export function readTelegramUpdateMessage(payload: Record<string, unknown>): Record<string, unknown> | null {
  return readRecord(payload.message) ?? readRecord(payload.edited_message) ?? readRecord(payload.channel_post) ?? readRecord(payload.edited_channel_post);
}
/** The same message selection used by processing. Unknown recipient/topic
 * cannot be treated as an irrelevant failure in another conversation. */
export function telegramUpdateReceiveScope(payload: Record<string, unknown>): TelegramReceiveScope | undefined {
  const message = readTelegramUpdateMessage(payload), chat = readRecord(message?.chat), id = chat?.id, thread = message?.message_thread_id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id === 0
    || thread !== undefined && (typeof thread !== 'number' || !Number.isSafeInteger(thread) || thread <= 0)) return undefined;
  return Object.freeze({ conversationId: String(id), ...(thread === undefined ? {} : { threadId: String(thread) }) });
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumberString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return readString(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeBotUsername(value?: string): string {
  return value ? value.replace(/^@/, '').trim() : '';
}

function extractTelegramTask(message: Record<string, unknown>, botUsername?: string): string {
  const text = readString(message.text) ?? readString(message.caption) ?? '';
  if (!text) return '';
  const trimmed = text.trim();
  const botHandle = normalizeBotUsername(botUsername);
  const commandPattern = botHandle
    ? new RegExp(`^/goodvibes(?:@${escapeRegExp(botHandle)})?\\s*`, 'i')
    : /^\/goodvibes\s*/i;
  return trimmed.replace(commandPattern, '').trim();
}

function telegramConversationKind(chatType?: string, threadId?: string): import('../../channels/index.js').ChannelConversationKind {
  if (threadId) return 'thread';
  if (chatType === 'private') return 'direct';
  if (chatType === 'channel') return 'channel';
  return 'group';
}

/**
 * HTTP entry point for webhook mode.
 *
 * Everything here is webhook-SPECIFIC: the shared-secret header check and the
 * request body read. Telegram sends the secret token only on webhook POSTs, so
 * this check must not sit in the shared path, a polled update carries no
 * headers and would be rejected by it.
 */
export async function handleTelegramSurfaceWebhook(
  req: Request,
  context: SurfaceAdapterContext,
  deps: TelegramUpdateDeps = {},
): Promise<Response> {
  const providedSecret = req.headers.get('x-telegram-bot-api-secret-token') ?? '';
  const registration = deps.authorizeWebhook?.(providedSecret) ?? null;
  const registrationCurrent = (): boolean => {
    if (req.signal.aborted) return false;
    try { registration?.assertCurrent(); return true; } catch { return false; }
  };
  if (!registrationCurrent()) return Response.json({ error: 'Webhook registration is unavailable' }, { status: 503 });
  // The registration side (channels/telegram/ingress.ts) hands Telegram the
  // RESOLVED secret, so an unresolved reference here is not a mismatch anyone
  // can debug from the outside: Telegram sends exactly the right value and
  // every update is rejected.
  if (!registration) {
    const credential = await resolveSurfaceCredential(
      context,
      { kind: 'config', key: 'surfaces.telegram.webhookSecret' },
      { kind: 'registry', service: 'telegram', field: 'signingSecret' },
      { kind: 'env', name: 'TELEGRAM_WEBHOOK_SECRET' },
    );
    if (credential.state === 'unresolvable') return surfaceCredentialUnavailable('telegram', credential);
    if (credential.state === 'absent') return Response.json({ error: 'Webhook credential is not configured' }, { status: 503 });
    if (credential.state === 'resolved') {
      if (!constantTimeEquals(credential.value, providedSecret)) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
  }
  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;
  if (!registrationCurrent()) return Response.json({ error: 'Webhook registration is unavailable' }, { status: 503 });
  const body = parseJsonRecord(rawBody);
  if (body instanceof Response) return body;
  const payload = readRecord(body);
  if (!payload) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  // Only the acknowledged original registration lends payment proof. Neither
  // the configured shared secret nor an accidental polling capability does so.
  return processTelegramUpdate(payload, context, {
    sendMessage: deps.sendMessage, signal: req.signal,
    ...(registration ? { acquirePaymentSourceAccount: registration.acquire.bind(registration) } : {}),
  });
}

/**
 * Handle one Telegram Update object, policy, route binding, standard bot
 * commands, control commands, and task dispatch.
 *
 * Shared verbatim by webhook mode and getUpdates polling so the two can never
 * drift into different behaviour for the same message. The Response return
 * shape is what the webhook route replies with; the poller reads it only for
 * logging.
 */
export async function processTelegramUpdate(
  payload: Record<string, unknown>,
  context: SurfaceAdapterContext,
  deps: TelegramUpdateDeps = {},
): Promise<Response> {
  const message = readTelegramUpdateMessage(payload);
  if (!message) {
    logger.info('handleTelegramSurfaceWebhook: update ignored', {
      reason: 'unsupported-update-type',
      updateId: readNumberString(payload.update_id),
    });
    return Response.json({
      ok: true,
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'unsupported-update-type',
      updateId: readNumberString(payload.update_id) ?? null,
    });
  }

  const chat = readRecord(message.chat);
  const from = readRecord(message.from);
  const chatId = readNumberString(chat?.id);
  if (!chatId) {
    logger.info('handleTelegramSurfaceWebhook: update ignored', {
      reason: 'missing-chat-id',
      updateId: readNumberString(payload.update_id),
    });
    return Response.json({
      ok: true,
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'missing-chat-id',
      updateId: readNumberString(payload.update_id) ?? null,
    });
  }
  const threadId = readNumberString(message.message_thread_id);
  const delegated = await context.delegatedTelegram?.selects(chatId, threadId) ?? false;
  const botUsername = readString(context.configManager.get('surfaces.telegram.botUsername'));
  const botHandle = normalizeBotUsername(botUsername);
  const task = delegated ? '' : extractTelegramTask(message, botUsername);
  const text = delegated ? '' : readString(message.text) ?? readString(message.caption) ?? '';
  const mentioned = Boolean(
    (chat?.type === 'private')
    || /^\/goodvibes\b/i.test(text)
    || (botHandle && new RegExp(`@${escapeRegExp(botHandle)}\\b`, 'i').test(text)),
  );
  const paymentSource = deps.acquirePaymentSourceAccount ?? deps.acquireSourceAccount;
  const acquireTelegramAccount = !delegated && context.hasPaymentReplyWindow?.() ? paymentSource?.bind(deps) : undefined;
  const replied = readRecord(message.reply_to_message);
  const policy = await context.authorizeSurfaceIngress({
    surface: 'telegram',
    userId: readNumberString(from?.id),
    channelId: chatId,
    groupId: chatId,
    threadId,
    workspaceId: readString(chat?.username),
    conversationKind: telegramConversationKind(readString(chat?.type), threadId),
    ...(delegated ? {} : { text: task || text }),
    mentioned,
    acquireTelegramAccount,
    metadata: {
      updateId: readNumberString(payload.update_id),
      chatType: readString(chat?.type),
      chatTitle: readString(chat?.title),
      fromUsername: readString(from?.username),
      messageId: readNumberString(message.message_id),
      messageSentAtMs: typeof message.date === 'number' && Number.isSafeInteger(message.date) && message.date > 0 && message.date <= 8.64e12
        ? message.date * 1000 : undefined,
      messageIsEdit: payload.edited_message === message || payload.edited_channel_post === message,
      messageEditedAtMs: typeof message.edit_date === 'number' && Number.isSafeInteger(message.edit_date) && message.edit_date > 0 && message.edit_date <= 8.64e12
        ? message.edit_date * 1000 : undefined,
      replyToMessageId: readNumberString(replied?.message_id),
    },
  });
  if (!policy.allowed) {
    if (policy.reason === 'payment-reply-recorded') return Response.json({ ok: true, acknowledged: true, consumed: true, queued: false, outcome: 'payment-reply', recorded: true });
    const paymentAnswer = /^payment-reply-(approve|deny|acknowledge|object)$/.exec(policy.reason)?.[1];
    if (paymentAnswer) return Response.json({ ok: true, acknowledged: true, consumed: true, queued: false, outcome: 'payment-reply', answer: paymentAnswer });
    return Response.json({ ok: false, error: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
  }

  const binding = await context.routeBindings.upsertBinding({
    kind: threadId ? 'thread' : 'channel',
    surfaceKind: 'telegram',
    surfaceId: botUsername || 'telegram',
    externalId: threadId ?? chatId,
    channelId: chatId,
    threadId,
    title: readString(chat?.title) ?? readString(chat?.username) ?? chatId,
    metadata: {
      chatType: readString(chat?.type),
      fromId: readNumberString(from?.id),
      fromUsername: readString(from?.username),
      updateId: readNumberString(payload.update_id),
    },
  });

  if (delegated) {
    // Keep the original exact and lazy. Neither policy audits nor command/reply
    // matching sees raw selected content; the host owns retention and approval.
    const result = await context.delegatedTelegram!.accept({ binding, chatId, threadId,
      account: await deps.acquireSourceAccount?.() ?? null,
      edited: Boolean(payload.edited_message || payload.edited_channel_post),
      senderId: readNumberString(from?.id), providerMessageId: readNumberString(message.message_id) ?? '',
      readOriginal: () => typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : '',
    });
    return Response.json({ ok: true, acknowledged: true, queued: false, ...result });
  }

  // Standard Telegram bot commands are onboarding, not work. This runs AFTER
  // the route binding above (so the reply has a bound conversation to land in)
  // and BEFORE task dispatch, otherwise `/start`, which every new user sends
  // first, spawns an agent whose task is the literal string "/start".
  const botCommand = parseTelegramBotCommand(text, botUsername);
  if (botCommand) {
    const reply = telegramBotCommandReply(botCommand.command, {
      botUsername,
      isPrivateChat: readString(chat?.type) === 'private',
    });
    let replied = false;
    if (deps.sendMessage) {
      try {
        await deps.sendMessage({ chatId, text: reply, threadId });
        replied = true;
      } catch (error) {
        logger.warn('processTelegramUpdate: onboarding reply failed', {
          command: botCommand.command,
          chatId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logger.info('processTelegramUpdate: standard bot command handled', {
      command: botCommand.command,
      bindingId: binding.id,
      chatId,
      threadId,
      replied,
    });
    return Response.json({
      ok: true,
      acknowledged: true,
      queued: false,
      outcome: 'command',
      command: botCommand.command,
      bindingId: binding.id,
      replied,
      // Webhook mode can answer inline: Telegram accepts a method call as the
      // webhook response body, so a daemon with no outbound sender still
      // replies. The poller ignores these fields and uses sendMessage.
      method: 'sendMessage',
      chat_id: chatId,
      text: reply,
      ...(threadId && /^\d+$/.test(threadId) ? { message_thread_id: Number(threadId) } : {}),
    });
  }

  if (!task) {
    logger.info('handleTelegramSurfaceWebhook: message acknowledged without queueing', {
      reason: 'no-actionable-text',
      bindingId: binding.id,
      chatId,
      threadId,
    });
    return Response.json({
      ok: true,
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'no-actionable-text',
      bindingId: binding.id,
    });
  }

  const controlCommand = await context.parseSurfaceControlCommand(task, deps.signal ? { signal: deps.signal } : {});
  if (controlCommand) {
    const message = await context.performSurfaceControlCommand(controlCommand);
    return Response.json({ ok: true, acknowledged: true, message });
  }

  const submission = await context.sessionBroker.submitMessage({
    routeId: binding.id,
    surfaceKind: 'telegram',
    surfaceId: binding.surfaceId,
    externalId: binding.externalId,
    threadId: binding.threadId ?? binding.channelId,
    userId: readNumberString(from?.id),
    displayName: readString(from?.username) ?? readString(from?.first_name),
    title: binding.title ?? 'Telegram',
    body: task,
    metadata: {
      chatType: readString(chat?.type),
      updateId: readNumberString(payload.update_id),
    },
  });
  if (submission.mode === 'continued-live') {
    return Response.json({ ok: true, continued: true, sessionId: submission.session.id, agentId: submission.activeAgentId ?? null });
  }

  const spawnResult = await context.trySpawnAgent(
    { mode: 'spawn', task: submission.task! },
    'handleTelegramSurfaceWebhook',
    submission.session.id,
  );
  if (spawnResult instanceof Response) return spawnResult;
  await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id);
  context.queueSurfaceReplyFromBinding(submission.routeBinding ?? binding, {
    agentId: spawnResult.id,
    task,
    sessionId: submission.session.id,
  });
  return Response.json({
    ok: true,
    queued: true,
    bindingId: binding.id,
    sessionId: submission.session.id,
    agentId: spawnResult.id,
  });
}
