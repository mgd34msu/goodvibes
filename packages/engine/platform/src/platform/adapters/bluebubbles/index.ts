import { constantTimeEquals, parseJsonRecord, readBearerOrHeaderToken, readTextBodyWithinLimit, readRecord, readString, declaredMention, ingressMetadata, noticeUnsupportedAttachment, hasAttachments } from '../helpers.js';
import { duplicateDeliveryResponse, inboundDedupKey, runOncePerMessage } from '../inbound-dedup.js';
import { resolveSurfaceCredential, surfaceCredentialUnavailable } from '../surface-credential.js';
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

  const dedupKey = inboundDedupKey('bluebubbles', conversationId, messageId);
  return runOncePerMessage(dedupKey, duplicateDeliveryResponse, async (committed) => {
    const policy = await context.authorizeSurfaceIngress({
      surface: 'bluebubbles',
      userId: senderId,
      channelId: conversationId,
      groupId: conversationId,
      conversationKind: conversationKindForChatGuid(chatGuid, Boolean(message.isGroup ?? payload.isGroup)),
      text,
      mentioned: declaredMention(payload, conversationKindForChatGuid(chatGuid, Boolean(message.isGroup ?? payload.isGroup)) === 'direct'),
      metadata: payload,
    });
    if (!policy.allowed) {
      return Response.json({ error: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
    }

    const binding = await context.routeBindings.upsertBinding({
      kind: 'channel',
      surfaceKind: 'bluebubbles',
      surfaceId: readString(payload.account)
        ?? readString(context.configManager.get('surfaces.bluebubbles.account'))
        ?? 'bluebubbles',
      externalId: conversationId,
      channelId: conversationId,
      title: senderId ?? conversationId,
      metadata: {
        ...ingressMetadata(payload),
        ...(messageId ? { messageId } : {}),
        ...(chatGuid ? { chatGuid } : {}),
        ...(senderId ? { senderId } : {}),
      },
    });
    if (!text) {
      const attachment = hasAttachments(message.attachments) ? 'attachment' : undefined;
      const notified = attachment ? await noticeUnsupportedAttachment(context, binding, attachment, conversationKindForChatGuid(chatGuid, Boolean(message.isGroup ?? payload.isGroup)) === 'direct') : false;
      return Response.json({
        ok: true,
        acknowledged: true,
        queued: false,
        outcome: 'ignored',
        reason: attachment ? 'unsupported-attachment' : 'no-actionable-text',
        ...(attachment ? { attachment, notified } : {}),
        bindingId: binding.id,
      });
    }

    const controlCommand = await context.parseSurfaceControlCommand(text, { signal: req.signal });
    if (controlCommand) {
      const message = await context.performSurfaceControlCommand(controlCommand, { surface: 'bluebubbles', routeId: binding.id });
      return Response.json({ ok: true, acknowledged: true, message });
    }

    const submission = await context.sessionBroker.submitMessage({
      routeId: binding.id,
      ...(dedupKey ? { providerMessageId: dedupKey } : {}),
      surfaceKind: 'bluebubbles',
      surfaceId: binding.surfaceId,
      externalId: binding.externalId,
      threadId: binding.channelId,
      userId: senderId ?? conversationId,
      displayName: senderId ?? conversationId,
      title: binding.title ?? 'BlueBubbles',
      body: text,
      metadata: binding.metadata,
    });
    if (submission.mode === 'continued-live' || submission.mode === 'queued-follow-up') {
      committed();
      return Response.json({ ok: true, continued: true, sessionId: submission.session.id, agentId: submission.activeAgentId ?? null });
    }

    const spawnResult = await context.trySpawnAgent(
      { mode: 'spawn', task: submission.task! },
      'handleBlueBubblesSurfaceWebhook',
      submission.session.id,
    );
    if (spawnResult instanceof Response) return spawnResult;
    committed();
    await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id, submission.input.id);
    context.queueSurfaceReplyFromBinding(submission.routeBinding ?? binding, {
      agentId: spawnResult.id,
      task: text,
      sessionId: submission.session.id,
    });
    return Response.json({
      ok: true,
      queued: true,
      bindingId: binding.id,
      sessionId: submission.session.id,
      agentId: spawnResult.id,
    });
  });
}
