import { constantTimeEquals, parseJsonRecord, readBearerOrHeaderToken, readTextBodyWithinLimit, readRecord, readString, declaredMention, ingressMetadata, readIdentifier, noticeUnsupportedAttachment, hasAttachments } from '../helpers.js';
import { duplicateDeliveryResponse, inboundDedupKey, runOncePerMessage } from '../inbound-dedup.js';
import { resolveSurfaceCredential, surfaceCredentialUnavailable } from '../surface-credential.js';
import type { SurfaceAdapterContext } from '../types.js';

/**
 * Native evidence that a Signal message names the bot: a `mentions` entry (the
 * bridge's own list, on the payload or its dataMessage) carrying the configured
 * account's number or uuid. A 1:1 chat (no group, no thread) is always addressed to
 * the bot, as on Telegram and Google Chat. Without a configured account a group
 * message cannot be matched.
 */
function signalMentionsAccount(payload: Record<string, unknown>, message: string, account: string | undefined): boolean {
  const dataMessage = readRecord(payload.dataMessage) ?? readRecord(readRecord(payload.envelope)?.dataMessage);
  const groupId = readString(payload.groupId) ?? readString(dataMessage?.groupId) ?? readString(readRecord(dataMessage?.groupInfo)?.groupId);
  if (!groupId && !readString(payload.threadId)) return true;
  if (!account) return false;
  const lists = [payload.mentions, readRecord(payload.dataMessage)?.mentions, readRecord(readRecord(payload.envelope)?.dataMessage)?.mentions];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const record = readRecord(entry);
      if (readString(record?.number) === account || readString(record?.uuid) === account || readString(record?.recipient) === account) return true;
    }
  }
  return message.includes(account);
}

export async function handleSignalSurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const credential = await resolveSurfaceCredential(
    context,
    { kind: 'config', key: 'surfaces.signal.token' },
    { kind: 'registry', service: 'signal', field: 'primary' },
    { kind: 'env', name: 'SIGNAL_BRIDGE_TOKEN' },
  );
  if (credential.state === 'unresolvable') return surfaceCredentialUnavailable('signal', credential);
  if (credential.state === 'absent') return Response.json({ error: 'Webhook credential is not configured' }, { status: 503 });
  if (credential.state === 'resolved') {
    const providedToken = readBearerOrHeaderToken(req, 'x-goodvibes-signal-token');
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
  const recipient = readString(payload.recipient) ?? readString(payload.source) ?? readString(payload.phoneNumber);
  const message = readString(payload.message) ?? readString(payload.text) ?? '';
  if (!recipient) return Response.json({ error: 'Missing recipient/source' }, { status: 400 });

  const dedupKey = inboundDedupKey('signal', recipient, readIdentifier(payload.messageId ?? payload.id ?? payload.timestamp));
  return runOncePerMessage(dedupKey, duplicateDeliveryResponse, async (committed) => {
    const policy = await context.authorizeSurfaceIngress({
      surface: 'signal',
      userId: recipient,
      channelId: recipient,
      groupId: recipient,
      threadId: readString(payload.threadId),
      conversationKind: readString(payload.threadId) ? 'thread' : 'direct',
      text: message,
      mentioned: declaredMention(payload, signalMentionsAccount(payload, message, readString(context.configManager.get('surfaces.signal.account')))),
      metadata: payload,
    });
    if (!policy.allowed) {
      return Response.json({ error: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
    }

    const binding = await context.routeBindings.upsertBinding({
      kind: readString(payload.threadId) ? 'thread' : 'channel',
      surfaceKind: 'signal',
      surfaceId: readString(payload.account) ?? readString(context.configManager.get('surfaces.signal.account')) ?? 'signal',
      externalId: readString(payload.threadId) ?? recipient,
      channelId: recipient,
      threadId: readString(payload.threadId),
      title: recipient,
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
      surfaceKind: 'signal',
      surfaceId: binding.surfaceId,
      externalId: binding.externalId,
      threadId: binding.threadId ?? binding.channelId,
      userId: recipient,
      displayName: recipient,
      title: recipient,
      body: message,
      metadata: ingressMetadata(payload),
    });
    if (submission.mode === 'continued-live' || submission.mode === 'queued-follow-up') {
      committed();
      return Response.json({ acknowledged: true, continued: true, sessionId: submission.session.id, agentId: submission.activeAgentId ?? null });
    }

    const spawnResult = await context.trySpawnAgent(
      { mode: 'spawn', task: submission.task! },
      'handleSignalSurfaceWebhook',
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
