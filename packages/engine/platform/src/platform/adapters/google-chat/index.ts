import type { SurfaceAdapterContext } from '../types.js';
import { runSurfaceMessage, surfaceOutcomeResponse } from '../surface-message.js';
import { constantTimeEquals, parseJsonRecord, readTextBodyWithinLimit, readRecord, readString, ingressAnswer, noticeUnsupportedAttachment, hasAttachments } from '../helpers.js';
import { resolveSurfaceCredential, surfaceCredentialUnavailable } from '../surface-credential.js';
import { logger } from '../../utils/logger.js';
/**
 * Whether the message addresses the bot: the bridge's own `mentioned` flag, else
 * a direct message, else an `annotations` list that holds a mention of a bot.
 * A message with no annotation data counts as addressed.
 */
function googleChatMentioned(
  payload: Record<string, unknown>,
  message: Record<string, unknown> | null,
  space: Record<string, unknown> | null,
): boolean {
  if (typeof payload.mentioned === 'boolean') return payload.mentioned;
  if (readString(space?.type)?.toUpperCase() === 'DM' || space?.singleUserBotDm === true) return true;
  const annotations = message?.annotations;
  if (!Array.isArray(annotations)) return true;
  return annotations.some((annotation) => {
    const entry = readRecord(annotation);
    const user = readRecord(readRecord(entry?.userMention)?.user);
    return readString(entry?.type) === 'USER_MENTION' && readString(user?.type) === 'BOT';
  });
}

export async function handleGoogleChatSurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const credential = await resolveSurfaceCredential(
    context,
    { kind: 'config', key: 'surfaces.googleChat.verificationToken' },
    { kind: 'registry', service: 'google-chat', field: 'signingSecret' },
    { kind: 'env', name: 'GOOGLE_CHAT_VERIFICATION_TOKEN' },
  );
  if (credential.state === 'unresolvable') return surfaceCredentialUnavailable('google-chat', credential);
  if (credential.state === 'absent') return Response.json({ error: 'Webhook credential is not configured' }, { status: 503 });
  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;
  const body = parseJsonRecord(rawBody);
  if (body instanceof Response) return body;
  const payload = readRecord(body);
  if (!payload) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  const providedToken = readString(payload.token) ?? req.headers.get('x-goog-chat-token') ?? '';
  if (credential.state === 'resolved' && !constantTimeEquals(credential.value, providedToken)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const eventType = readString(payload.type) ?? 'MESSAGE';
  if (eventType !== 'MESSAGE' && eventType !== 'ADDED_TO_SPACE') {
    logger.info('handleGoogleChatSurfaceWebhook: event ignored', {
      reason: 'unsupported-event-type',
      eventType,
    });
    return Response.json({
      text: 'Ignored.',
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'unsupported-event-type',
      eventType,
    });
  }

  const message = readRecord(payload.message);
  const space = readRecord(payload.space);
  const user = readRecord(payload.user) ?? readRecord(message?.sender);
  const thread = readRecord(message?.thread);
  const text = readString(message?.argumentText) ?? readString(message?.text) ?? '';
  const spaceName = readString(space?.name);
  if (!spaceName) return Response.json({ text: 'missing space' }, { status: 400 });
  const threadName = readString(thread?.name);

  const providerMessageId = readString(message?.name);
  const outcome = await runSurfaceMessage(context, {
    ingress: {
      surface: 'google-chat',
      userId: readString(user?.name),
      channelId: spaceName,
      groupId: spaceName,
      threadId: threadName,
      workspaceId: readString(payload.hostApp),
      conversationKind: threadName ? 'thread' : 'channel',
      text,
      mentioned: googleChatMentioned(payload, message, space),
      metadata: {
        eventType,
        spaceDisplayName: readString(space?.displayName),
        userDisplayName: readString(user?.displayName),
      },
    },
    binding: {
      kind: threadName ? 'thread' : 'channel',
      surfaceKind: 'google-chat',
      surfaceId: readString(context.configManager.get('surfaces.googleChat.appId')) ?? 'google-chat',
      externalId: threadName ?? spaceName,
      channelId: spaceName,
      threadId: threadName,
      title: readString(space?.displayName) ?? spaceName,
      metadata: {
        eventType,
        userName: readString(user?.name),
        // Who it is with and whether it is one-to-one: the owner's own conversations (owner-alert.ts isOwnerConversation) are read from these.
        // Google marks a one-to-one space with the app as DM (space.type, or spaceType DIRECT_MESSAGE with singleUserBotDm).
        ...(readString(user?.name) ? { userId: readString(user?.name) } : {}),
        conversationKind: threadName ? 'thread' : googleChatDirect(space) ? 'direct' : 'channel',
      },
    },
    text,
    logLabel: 'handleGoogleChatSurfaceWebhook',
    // Google posts the 200 body of a synchronous answer as the reply.
    control: 'response',
    ...(providerMessageId ? { providerMessageId } : {}),
    userId: readString(user?.name),
    displayName: readString(user?.displayName),
    metadata: { eventType, spaceName },
    signal: req.signal,
  });
  switch (outcome.kind) {
    case 'refused':
      // Google posts the 200 body as the reply; a 403 would only show "app not responding".
      // The pipeline lets a redelivery of a refusal run again (the policy may have changed) and keeps a consumed answer claimed.
      return Response.json({ text: ingressAnswer(outcome.decision, 'caller').text });
    case 'no-text': {
      const attachment = hasAttachments(message?.attachment) ? 'attachment' : undefined;
      const notified = attachment ? await noticeUnsupportedAttachment(context, outcome.binding, attachment, space?.type === 'DM' || space?.spaceType === 'DIRECT_MESSAGE') : false;
      logger.info('handleGoogleChatSurfaceWebhook: message acknowledged without queueing', {
        reason: attachment ? 'unsupported-attachment' : 'no-actionable-text',
        bindingId: outcome.binding.id,
        eventType,
      });
      return Response.json({
        text: 'Acknowledged.',
        acknowledged: true,
        queued: false,
        outcome: 'ignored',
        reason: attachment ? 'unsupported-attachment' : 'no-actionable-text',
        ...(attachment ? { attachment, notified } : {}),
        bindingId: outcome.binding.id,
      });
    }
    case 'control': return Response.json({ text: outcome.message });
    case 'continued': return Response.json({ text: `Continuing session ${outcome.sessionId}.` });
    case 'started': return Response.json({ text: `Running ${outcome.agentId}` });
    // The gate's own notice already went to the space.
    case 'answered':
    case 'not-started': return outcome.response;
    // A redelivered event: no text, so Google posts nothing a second time.
    case 'duplicate': return surfaceOutcomeResponse(outcome, 'caller');
  }
}

/** Whether a Google Chat space is the one-to-one conversation between one person and the app. */
function googleChatDirect(space: Record<string, unknown> | null | undefined): boolean {
  if (!space) return false;
  return space.type === 'DM' || space.singleUserBotDm === true || (space.spaceType === 'DIRECT_MESSAGE' && space.singleUserBotDm !== false);
}
