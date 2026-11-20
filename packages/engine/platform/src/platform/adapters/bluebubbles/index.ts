import { constantTimeEquals, parseJsonRecord, readBearerOrHeaderToken, readTextBodyWithinLimit, readRecord, readString, declaredMention, noticeUnsupportedAttachment, hasAttachments } from '../helpers.js';
import { resolveSurfaceCredential, surfaceCredentialUnavailable } from '../surface-credential.js';
import { runSurfaceMessage, surfaceOutcomeResponse } from '../surface-message.js';
import type { SurfaceAdapterContext } from '../types.js';

function conversationKindForChatGuid(chatGuid?: string, isGroup?: boolean): import('../../channels/index.js').ChannelConversationKind {
  if (isGroup) return 'group';
  if (chatGuid?.includes(';+;')) return 'group';
  return 'direct';
}

export async function handleBlueBubblesSurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const credential = await resolveSurfaceCredential(
    context,
    { kind: 'config', key: 'surfaces.bluebubbles.password' },
    { kind: 'registry', service: 'bluebubbles', field: 'password' },
    { kind: 'env', name: 'BLUEBUBBLES_PASSWORD' },
  );
  if (credential.state === 'unresolvable') return surfaceCredentialUnavailable('bluebubbles', credential);
  if (credential.state === 'absent') return Response.json({ error: 'Webhook credential is not configured' }, { status: 503 });
  const url = new URL(req.url);
  // Header FIRST, query parameter second.
  //
  // BlueBubbles' own webhook configuration can only append `?password=`, so the
  // query parameter has to keep working or every existing install breaks. But a
  // credential in a URL is copied into places nobody chose to put it, access
  // logs, proxy logs, a Referer header, so a caller that can send the header
  // should never have its query parameter read instead.
  const providedPassword = readBearerOrHeaderToken(req, 'x-goodvibes-bluebubbles-token')
    || url.searchParams.get('password')
    || '';
  if (credential.state === 'resolved' && !constantTimeEquals(credential.value, providedPassword)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;
  const body = parseJsonRecord(rawBody);
  if (body instanceof Response) return body;
  const payload = readRecord(body);
  if (!payload) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  const message = readRecord(payload.message) ?? payload;
  const text = readString(message.text) ?? readString(message.message) ?? '';
  const chatGuid = readString(message.chatGuid) ?? readString(message.chat_guid) ?? readString(payload.chatGuid);
  const senderId = readString(message.senderId)
    ?? readString(message.sender)
    ?? readString(message.handle)
    ?? readString(payload.senderId);
  const messageId = readString(message.guid) ?? readString(message.messageId) ?? readString(payload.guid);
  const isFromMe = Boolean(message.isFromMe ?? message.fromMe ?? payload.isFromMe ?? payload.fromMe);
  if (isFromMe) {
    return Response.json({
      ok: true,
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      ignored: true,
      reason: 'from-me',
    });
  }
  const conversationId = chatGuid ?? senderId;
  if (!conversationId) return Response.json({ error: 'Missing BlueBubbles chat identifier' }, { status: 400 });

  const providerMessageId = messageId;
  const conversationKind = conversationKindForChatGuid(chatGuid, Boolean(message.isGroup ?? payload.isGroup));
  const outcome = await runSurfaceMessage(context, {
    ingress: {
      surface: 'bluebubbles',
      userId: senderId,
      channelId: conversationId,
      groupId: conversationId,
      conversationKind,
      text,
      mentioned: declaredMention(payload, conversationKind === 'direct'),
      metadata: payload,
    },
    binding: {
      kind: 'channel',
      surfaceKind: 'bluebubbles',
      surfaceId: readString(payload.account)
        ?? readString(context.configManager.get('surfaces.bluebubbles.account'))
        ?? 'bluebubbles',
      externalId: conversationId,
      channelId: conversationId,
      title: senderId ?? conversationId,
      metadata: {
        ...(messageId ? { messageId } : {}),
        ...(chatGuid ? { chatGuid } : {}),
        ...(senderId ? { senderId } : {}),
        // Who it is with and whether it is one-to-one: the owner's own conversations (owner-alert.ts isOwnerConversation) are read from these.
        conversationKind,
      },
    },
    text,
    logLabel: 'handleBlueBubblesSurfaceWebhook',
    control: 'notice',
    ...(providerMessageId ? { providerMessageId } : {}),
    userId: senderId ?? conversationId,
    displayName: senderId ?? conversationId,
    signal: req.signal,
  });
  if (outcome.kind === 'no-text') {
    const attachment = hasAttachments(message.attachments) ? 'attachment' : undefined;
    const notified = attachment ? await noticeUnsupportedAttachment(context, outcome.binding, attachment, conversationKind === 'direct') : false;
    return Response.json({
      ok: true,
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: attachment ? 'unsupported-attachment' : 'no-actionable-text',
      ...(attachment ? { attachment, notified } : {}),
      bindingId: outcome.binding.id,
    });
  }
  return surfaceOutcomeResponse(outcome, 'caller');
}
