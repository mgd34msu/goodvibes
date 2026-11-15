import type { ChannelConversationKind } from '../../channels/index.js';
import { constantTimeEquals, readBearerOrHeaderToken, readTextBodyWithinLimit, readRecord, readString, ingressMetadata, noticeUnsupportedAttachment, hasAttachments } from '../helpers.js';
import { duplicateDeliveryResponse, inboundDedupKey, runOncePerMessage } from '../inbound-dedup.js';
import { resolveSurfaceCredential, surfaceCredentialUnavailable } from '../surface-credential.js';
import { runSurfaceMessage, surfaceOutcomeResponse } from '../surface-message.js';
import type { SurfaceAdapterContext } from '../types.js';
import { logger } from '../../utils/logger.js';

function stripTeamsMarkup(text: string): string {
  return text
    .replace(/<at>.*?<\/at>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamsConversationKind(conversationType?: string, threadId?: string): ChannelConversationKind {
  if (threadId) return 'thread';
  if (conversationType === 'personal') return 'direct';
  if (conversationType === 'channel') return 'channel';
  return 'group';
}

function normalizeConversationId(raw?: string): string | undefined {
  if (!raw) return undefined;
  return raw.replace(/;messageid=[^;]+$/i, '');
}
/**
 * Whether the activity @mentions the bot. Teams lists a mention as an entity and
 * puts `<at>name</at>` in the text; the markup is stripped from the text before
 * the policy sees it, so the entities are the evidence, and a user typing the
 * bot's name does not count. A personal chat always addresses the bot.
 */
function teamsMentioned(
  activity: Record<string, unknown>,
  conversationType: string | undefined,
  configuredBotIds: ReadonlyArray<string | undefined>,
): boolean {
  if (conversationType === 'personal') return true;
  const botIds = new Set(configuredBotIds.filter((id): id is string => !!id));
  const recipientId = readString(readRecord(activity.recipient)?.id);
  if (recipientId) botIds.add(recipientId);
  const entities = Array.isArray(activity.entities) ? activity.entities : [];
  return entities.some((entity) => {
    const record = readRecord(entity);
    const mentionedId = readString(readRecord(record?.mentioned)?.id);
    return readString(record?.type)?.toLowerCase() === 'mention' && mentionedId !== undefined && botIds.has(mentionedId);
  });
}

export async function handleMSTeamsSurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const credential = await resolveSurfaceCredential(
    context,
    // A secret of its own for inbound calls comes first, so the account's
    // delivery credential is not the shared secret a caller must hold. The
    // delivery credential stays as the fallback for a surface that has not set one.
    { kind: 'config', key: 'surfaces.msteams.webhookSecret' },
    { kind: 'registry', service: 'msteams', field: 'signingSecret' },
    { kind: 'env', name: 'MSTEAMS_WEBHOOK_SECRET' },
    { kind: 'config', key: 'surfaces.msteams.appPassword' },
    { kind: 'registry', service: 'msteams', field: 'password' },
    { kind: 'env', name: 'MSTEAMS_APP_PASSWORD' },
  );
  if (credential.state === 'unresolvable') return surfaceCredentialUnavailable('msteams', credential);
  if (credential.state === 'absent') {
    return Response.json({ error: 'Webhook not configured' }, { status: 503 });
  }
  const configuredSecret = credential.value;
  const providedToken = readBearerOrHeaderToken(req, 'x-goodvibes-msteams-token');
  if (!constantTimeEquals(configuredSecret, providedToken)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;
  let body: unknown = null;
  if (rawBody.trim().length > 0) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }
  const activity = readRecord(body);
  if (!activity) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  const activityType = readString(activity.type)?.toLowerCase();
  if (activityType && activityType !== 'message' && activityType !== 'invoke') {
    logger.info('handleMSTeamsSurfaceWebhook: activity ignored', {
      reason: 'unsupported-activity-type',
      activityType,
    });
    return Response.json({
      ok: true,
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'unsupported-activity-type',
      activityType,
    });
  }

  const conversation = readRecord(activity.conversation);
  const from = readRecord(activity.from);
  const value = readRecord(activity.value);
  const channelData = readRecord(activity.channelData);
  const conversationId = normalizeConversationId(readString(conversation?.id));
  if (!conversationId) return Response.json({ error: 'Missing conversation id' }, { status: 400 });
  const replyToId = readString(activity.replyToId);
  const serviceUrl = readString(activity.serviceUrl)
    ?? (String(context.configManager.get('surfaces.msteams.serviceUrl') ?? '').trim() || undefined);
  const text = stripTeamsMarkup(
    readString(activity.text)
    ?? readString(value?.text)
    ?? readString(value?.command)
    ?? '',
  );
  const conversationType = readString(conversation?.conversationType) ?? readString(channelData?.conversationType);
  const channelId = readString(conversation?.id) ?? conversationId;
  const team = readRecord(channelData?.team);
  const channel = readRecord(channelData?.channel);
  const tenant = readRecord(channelData?.tenant);
  const teamId = readString(team?.['id']);
  const channelEntryId = readString(channel?.['id']);
  const tenantId = readString(tenant?.['id']);
  const dedupKey = inboundDedupKey('msteams', conversationId, readString(activity.id));
  const conversationKind = teamsConversationKind(conversationType, replyToId);
  return runOncePerMessage(dedupKey, duplicateDeliveryResponse, async (committed) => {
    const outcome = await runSurfaceMessage(context, {
      ingress: {
        surface: 'msteams',
        userId: readString(from?.id),
        channelId,
        groupId: channelEntryId ?? channelId,
        threadId: replyToId,
        workspaceId: teamId ?? tenantId,
        conversationKind,
        text,
        mentioned: teamsMentioned(activity, conversationType, [
          readString(context.configManager.get('surfaces.msteams.botId')),
          readString(context.configManager.get('surfaces.msteams.appId')),
        ]),
        metadata: {
          activityId: readString(activity.id),
          conversationId,
          conversationType,
          replyToId,
          serviceUrl,
          teamId,
          channelId: channelEntryId,
          tenantId,
        },
      },
      binding: {
        kind: replyToId ? 'thread' : 'channel',
        surfaceKind: 'msteams',
        surfaceId: readString(context.configManager.get('surfaces.msteams.botId'))
          ?? readString(context.configManager.get('surfaces.msteams.appId'))
          ?? 'msteams',
        externalId: replyToId ?? conversationId,
        channelId: channelId,
        threadId: replyToId,
        title: readString(conversation?.name) ?? readString(channel?.id) ?? conversationId,
        metadata: {
          ...ingressMetadata(activity),
          conversationId,
          serviceUrl,
          conversationType,
          replyToId,
          teamId,
          channelId: channelEntryId,
        },
      },
      text,
      logLabel: 'handleMSTeamsSurfaceWebhook',
      // The Bot Framework does not show the webhook answer; replies go through the connector.
      control: 'notice',
      ...(dedupKey ? { providerMessageId: dedupKey } : {}),
      userId: readString(from?.id),
      displayName: readString(from?.name) ?? readString(from?.id),
      signal: req.signal,
      committed,
    });
    if (outcome.kind === 'no-text') {
      const attachment = hasAttachments(activity.attachments) && (activity.attachments as unknown[]).some((entry) => readString(readRecord(entry)?.contentType) !== 'text/html') ? 'attachment' : undefined;
      const notified = attachment ? await noticeUnsupportedAttachment(context, outcome.binding, attachment, conversationKind === 'direct') : false;
      logger.info('handleMSTeamsSurfaceWebhook: activity acknowledged without queueing', {
        reason: attachment ? 'unsupported-attachment' : 'no-actionable-text',
        bindingId: outcome.binding.id,
        activityId: readString(activity.id),
      });
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
    return surfaceOutcomeResponse(outcome);
  });
}
