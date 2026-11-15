import { constantTimeEquals, parseJsonRecord, readBearerOrHeaderToken, readTextBodyWithinLimit, readRecord, readString, declaredMention, ingressMetadata, readIdentifier, noticeUnsupportedAttachment, hasAttachments } from '../helpers.js';
import { runSurfaceMessage, surfaceOutcomeResponse } from '../surface-message.js';
import { duplicateDeliveryResponse, inboundDedupKey, runOncePerMessage } from '../inbound-dedup.js';
import { resolveSurfaceCredential, surfaceCredentialUnavailable } from '../surface-credential.js';
import type { SurfaceAdapterContext } from '../types.js';

/** The data message a bridge forwards, at the top level or inside a signal-cli style envelope. */
function readDataMessage(payload: Record<string, unknown>): Record<string, unknown> | null {
  return readRecord(payload.dataMessage) ?? readRecord(readRecord(payload.envelope)?.dataMessage);
}

/** The group a message was written in, or undefined for a one-to-one message. */
function readGroupId(payload: Record<string, unknown>): string | undefined {
  const dataMessage = readDataMessage(payload);
  return readString(payload.groupId) ?? readString(dataMessage?.groupId) ?? readString(readRecord(dataMessage?.groupInfo)?.groupId);
}

/**
 * Who wrote the message. `source` names the sender; `recipient` is the
 * account the bridge delivered to, so it is only a fallback for a bridge that
 * sends nothing else.
 */
function readSender(payload: Record<string, unknown>): string | undefined {
  const envelope = readRecord(payload.envelope);
  return readString(payload.source) ?? readString(payload.sourceNumber) ?? readString(payload.sourceUuid)
    ?? readString(envelope?.source) ?? readString(envelope?.sourceNumber) ?? readString(envelope?.sourceUuid)
    ?? readString(payload.recipient) ?? readString(payload.phoneNumber);
}

/**
 * Native evidence that a Signal message names the bot: a `mentions` entry (the
 * bridge's own list, on the payload or its dataMessage) carrying the configured
 * account's number or uuid. A 1:1 chat (no group, no thread) is always addressed to
 * the bot, as on Telegram and Google Chat. Without a configured account a group
 * message cannot be matched.
 */
function signalMentionsAccount(payload: Record<string, unknown>, message: string, account: string | undefined, groupId: string | undefined): boolean {
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
  const sender = readSender(payload);
  const groupId = readGroupId(payload);
  const threadId = readString(payload.threadId);
  const message = readString(payload.message) ?? readString(payload.text) ?? readString(readDataMessage(payload)?.message) ?? '';
  if (!sender) return Response.json({ error: 'Missing recipient/source' }, { status: 400 });
  // One conversation value for policy, binding and reply: the group when the
  // message was written in one, otherwise the sender.
  const conversationId = groupId ?? sender;

  const dedupKey = inboundDedupKey('signal', conversationId, readIdentifier(payload.messageId ?? payload.id ?? payload.timestamp));
  return runOncePerMessage(dedupKey, duplicateDeliveryResponse, async (committed) => {
    const outcome = await runSurfaceMessage(context, {
      ingress: {
        surface: 'signal',
        userId: sender,
        channelId: conversationId,
        groupId: conversationId,
        threadId,
        conversationKind: threadId ? 'thread' : groupId ? 'group' : 'direct',
        ...(threadId ? { parentConversationKind: groupId ? 'group' as const : 'direct' as const } : {}),
        text: message,
        mentioned: declaredMention(payload, signalMentionsAccount(payload, message, readString(context.configManager.get('surfaces.signal.account')), groupId)),
        metadata: payload,
      },
      binding: {
        kind: threadId ? 'thread' : 'channel',
        surfaceKind: 'signal',
        surfaceId: readString(payload.account) ?? readString(context.configManager.get('surfaces.signal.account')) ?? 'signal',
        externalId: threadId ?? conversationId,
        channelId: conversationId,
        threadId,
        title: conversationId,
        metadata: { ...(groupId ? { groupId } : {}), senderId: sender },
      },
      text: message,
      logLabel: 'handleSignalSurfaceWebhook',
      control: 'notice',
      ...(dedupKey ? { providerMessageId: dedupKey } : {}),
      userId: sender,
      displayName: sender,
      title: conversationId,
      metadata: ingressMetadata(payload),
      signal: req.signal,
      committed,
    });
    if (outcome.kind === 'no-text') {
      const attachment = hasAttachments(payload.attachments) || hasAttachments(readDataMessage(payload)?.attachments) ? 'attachment' : undefined;
      const notified = attachment ? await noticeUnsupportedAttachment(context, outcome.binding, attachment, !threadId && !groupId) : false;
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
