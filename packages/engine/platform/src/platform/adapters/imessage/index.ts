import { constantTimeEquals, parseJsonRecord, readBearerOrHeaderToken, readTextBodyWithinLimit, readRecord, readString, declaredMention, ingressMetadata, readIdentifier, noticeUnsupportedAttachment, hasAttachments } from '../helpers.js';
import { duplicateDeliveryResponse, inboundDedupKey, runOncePerMessage } from '../inbound-dedup.js';
import { resolveSurfaceCredential, surfaceCredentialUnavailable } from '../surface-credential.js';
import { runSurfaceMessage, surfaceOutcomeResponse } from '../surface-message.js';
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
  const threadId = readString(payload.threadId);
  return runOncePerMessage(dedupKey, duplicateDeliveryResponse, async (committed) => {
    const outcome = await runSurfaceMessage(context, {
      ingress: {
        surface: 'imessage',
        userId: chatId,
        channelId: chatId,
        groupId: chatId,
        threadId,
        conversationKind: threadId ? 'thread' : 'direct',
        text: message,
        mentioned: declaredMention(payload, !threadId),
        metadata: payload,
      },
      binding: {
        kind: threadId ? 'thread' : 'channel',
        surfaceKind: 'imessage',
        surfaceId: readString(payload.account) ?? readString(context.configManager.get('surfaces.imessage.account')) ?? 'imessage',
        externalId: threadId ?? chatId,
        channelId: chatId,
        threadId,
        title: chatId,
        metadata: ingressMetadata(payload),
      },
      text: message,
      logLabel: 'handleIMessageSurfaceWebhook',
      control: 'notice',
      ...(dedupKey ? { providerMessageId: dedupKey } : {}),
      userId: chatId,
      displayName: chatId,
      title: chatId,
      metadata: ingressMetadata(payload),
      signal: req.signal,
      committed,
    });
    if (outcome.kind === 'no-text') {
      const attachment = hasAttachments(payload.attachments) ? 'attachment' : undefined;
      const notified = attachment ? await noticeUnsupportedAttachment(context, outcome.binding, attachment, !threadId && !readString(payload.groupId)) : false;
      return Response.json({
        acknowledged: true,
        queued: false,
        outcome: 'ignored',
        reason: attachment ? 'unsupported-attachment' : 'no-actionable-text',
        ...(attachment ? { attachment, notified } : {}),
        bindingId: outcome.binding.id,
      });
    }
    return surfaceOutcomeResponse(outcome);
  });
}
