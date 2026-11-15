import { constantTimeEquals, parseJsonRecord, readBearerOrHeaderToken, readTextBodyWithinLimit, readRecord, readString, declaredMention, ingressMetadata, readIdentifier, noticeUnsupportedAttachment, hasAttachments } from '../helpers.js';
import { duplicateDeliveryResponse, inboundDedupKey, runOncePerMessage } from '../inbound-dedup.js';
import { resolveSurfaceCredential, surfaceCredentialUnavailable } from '../surface-credential.js';
import type { SurfaceAdapterContext } from '../types.js';

export async function handleIMessageSurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const credential = await resolveSurfaceCredential(
    context,
    { kind: 'config', key: 'surfaces.imessage.token' },
    { kind: 'registry', service: 'imessage', field: 'primary' },
    { kind: 'env', name: 'IMESSAGE_BRIDGE_TOKEN' },
  );
  if (credential.state === 'unresolvable') return surfaceCredentialUnavailable('imessage', credential);
  if (credential.state === 'absent') return Response.json({ error: 'Webhook credential is not configured' }, { status: 503 });
  if (credential.state === 'resolved') {
    const providedToken = readBearerOrHeaderToken(req, 'x-goodvibes-imessage-token');
    if (!constantTimeEquals(credential.value, providedToken)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;
  const body = parseJsonRecord(rawBody);
  if (body instanceof Response) return body;
  const payload = readRecord(body);
  if (!payload) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  const chatId = readString(payload.chatId) ?? readString(payload.conversationId) ?? readString(payload.source);
  const message = readString(payload.message) ?? readString(payload.text) ?? '';
  if (!chatId) return Response.json({ error: 'Missing chatId' }, { status: 400 });

  const dedupKey = inboundDedupKey('imessage', chatId, readIdentifier(payload.guid ?? payload.messageId ?? payload.id));
  return runOncePerMessage(dedupKey, duplicateDeliveryResponse, async (committed) => {
    const policy = await context.authorizeSurfaceIngress({
      surface: 'imessage',
      userId: chatId,
      channelId: chatId,
      groupId: chatId,
      threadId: readString(payload.threadId),
      conversationKind: readString(payload.threadId) ? 'thread' : 'direct',
      text: message,
      mentioned: declaredMention(payload, !readString(payload.threadId)),
      metadata: payload,
    });
    if (!policy.allowed) {
      return Response.json({ error: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
    }

    const binding = await context.routeBindings.upsertBinding({
      kind: readString(payload.threadId) ? 'thread' : 'channel',
      surfaceKind: 'imessage',
      surfaceId: readString(payload.account) ?? readString(context.configManager.get('surfaces.imessage.account')) ?? 'imessage',
      externalId: readString(payload.threadId) ?? chatId,
      channelId: chatId,
      threadId: readString(payload.threadId),
      title: chatId,
      metadata: ingressMetadata(payload),
    });
    if (!message) {
      const attachment = hasAttachments(payload.attachments) ? 'attachment' : undefined;
      const notified = attachment ? await noticeUnsupportedAttachment(context, binding, attachment, !readString(payload.threadId) && !readString(payload.groupId)) : false;
      return Response.json({
        acknowledged: true,
        queued: false,
        outcome: 'ignored',
        reason: attachment ? 'unsupported-attachment' : 'no-actionable-text',
        ...(attachment ? { attachment, notified } : {}),
        bindingId: binding.id,
      });
    }

    const submission = await context.sessionBroker.submitMessage({
      routeId: binding.id,
      ...(dedupKey ? { providerMessageId: dedupKey } : {}),
      surfaceKind: 'imessage',
      surfaceId: binding.surfaceId,
      externalId: binding.externalId,
      threadId: binding.threadId ?? binding.channelId,
      userId: chatId,
      displayName: chatId,
      title: chatId,
      body: message,
      metadata: ingressMetadata(payload),
    });
    if (submission.mode === 'continued-live' || submission.mode === 'queued-follow-up') {
      committed();
      return Response.json({ acknowledged: true, continued: true, sessionId: submission.session.id, agentId: submission.activeAgentId ?? null });
    }

    const spawnResult = await context.trySpawnAgent(
      { mode: 'spawn', task: submission.task! },
      'handleIMessageSurfaceWebhook',
      submission.session.id,
    );
    if (spawnResult instanceof Response) return spawnResult;
    committed();
    await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id, submission.input.id);
    context.queueSurfaceReplyFromBinding(submission.routeBinding ?? binding, {
      agentId: spawnResult.id,
      task: message,
      sessionId: submission.session.id,
    });
    return Response.json({ acknowledged: true, queued: true, bindingId: binding.id, sessionId: submission.session.id, agentId: spawnResult.id });
  });
}
