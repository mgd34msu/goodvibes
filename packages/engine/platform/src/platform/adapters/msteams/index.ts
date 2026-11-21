import type { ChannelConversationKind } from '../../channels/index.js';
import { constantTimeEquals, readBearerOrHeaderToken, readTextBodyWithinLimit, readRecord, readString, noticeUnsupportedAttachment, hasAttachments } from '../helpers.js';
import { resolveSurfaceCredential, surfaceCredentialUnavailable } from '../surface-credential.js';
import { runSurfaceMessage, surfaceOutcomeResponse } from '../surface-message.js';
import type { SurfaceAdapterContext } from '../types.js';
import { logger } from '../../utils/logger.js';
import { looksLikeJwt, sameServiceUrl, verifyBotFrameworkToken, type BotFrameworkClaims } from './bot-framework-auth.js';

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

/**
 * Who may post an activity. Azure Bot Service signs each one with a Bot
 * Framework token issued for this bot's app id, which is verified here. A
 * relay that cannot carry that token uses a secret of its own
 * (`surfaces.msteams.webhookSecret`). The app password is never accepted as a
 * bearer: it is the bot's delivery credential, not something a caller holds.
 */
async function authenticateTeamsRequest(req: Request, context: SurfaceAdapterContext): Promise<
  | { readonly kind: 'relay' }
  | { readonly kind: 'bot-framework'; readonly claims: BotFrameworkClaims }
  | { readonly kind: 'refused'; readonly response: Response }
> {
  const relaySecret = await resolveSurfaceCredential(
    context,
    { kind: 'config', key: 'surfaces.msteams.webhookSecret' },
    { kind: 'registry', service: 'msteams', field: 'signingSecret' },
    { kind: 'env', name: 'MSTEAMS_WEBHOOK_SECRET' },
  );
  if (relaySecret.state === 'unresolvable') return { kind: 'refused', response: surfaceCredentialUnavailable('msteams', relaySecret) };
  const appId = readString(context.configManager.get('surfaces.msteams.appId')) ?? readString(process.env['MSTEAMS_APP_ID']);
  if (relaySecret.state === 'absent' && !appId) {
    return { kind: 'refused', response: Response.json({ error: 'Webhook not configured: set surfaces.msteams.appId (Azure Bot Service) or surfaces.msteams.webhookSecret (a relay)' }, { status: 503 }) };
  }
  const presented = readBearerOrHeaderToken(req, 'x-goodvibes-msteams-token');
  if (relaySecret.state === 'resolved' && constantTimeEquals(relaySecret.value, presented)) return { kind: 'relay' };
  if (appId && looksLikeJwt(presented)) {
    const verified = await verifyBotFrameworkToken(presented, { appId });
    if (verified.ok) return { kind: 'bot-framework', claims: verified.claims };
    logger.info('handleMSTeamsSurfaceWebhook: Bot Framework token refused', { reason: verified.reason });
  }
  return { kind: 'refused', response: Response.json({ error: 'Unauthorized' }, { status: 401 }) };
}

export async function handleMSTeamsSurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const caller = await authenticateTeamsRequest(req, context);
  if (caller.kind === 'refused') return caller.response;
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
  if (caller.kind === 'bot-framework') {
    // A token is bound to the connector it lets the bot answer and to the
    // channels its key is endorsed for; an activity naming another is refused.
    const activityServiceUrl = readString(activity.serviceUrl);
    const channel = readString(activity.channelId);
    const endorsed = caller.claims.endorsements;
    if (!caller.claims.serviceUrl || !activityServiceUrl || !sameServiceUrl(caller.claims.serviceUrl, activityServiceUrl)
      || (endorsed !== undefined && (!channel || !endorsed.includes(channel)))) {
      logger.info('handleMSTeamsSurfaceWebhook: Bot Framework token does not cover this activity', {
        reason: endorsed !== undefined && (!channel || !endorsed.includes(channel)) ? 'channel-not-endorsed' : 'service-url-mismatch',
      });
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
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
  const providerMessageId = readString(activity.id);
  const conversationKind = teamsConversationKind(conversationType, replyToId);
  // A personal chat is the one-to-one conversation with the bot, a reply in it
  // included: the policy reads a reply there as a thread of a direct message.
  const direct = conversationType === 'personal';
  const outcome = await runSurfaceMessage(context, {
    ingress: {
      surface: 'msteams',
      userId: readString(from?.id),
      channelId,
      groupId: channelEntryId ?? channelId,
      threadId: replyToId,
      workspaceId: teamId ?? tenantId,
      conversationKind,
      ...(direct ? { parentConversationKind: 'direct' as const } : {}),
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
      // The fields a reply needs; the activity itself (message text included) is not kept on the binding.
      metadata: {
        // Who it is with and whether it is one-to-one: the owner's own conversations (owner-alert.ts isOwnerConversation) are read from these.
        ...(readString(from?.id) ? { userId: readString(from?.id) } : {}),
        conversationKind,
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
    ...(providerMessageId ? { providerMessageId } : {}),
    userId: readString(from?.id),
    displayName: readString(from?.name) ?? readString(from?.id),
    signal: req.signal,
  });
  if (outcome.kind === 'no-text') {
    const attachment = hasAttachments(activity.attachments) && (activity.attachments as unknown[]).some((entry) => readString(readRecord(entry)?.contentType) !== 'text/html') ? 'attachment' : undefined;
    const notified = attachment ? await noticeUnsupportedAttachment(context, outcome.binding, attachment, direct) : false;
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
  return surfaceOutcomeResponse(outcome, 'caller');
}
