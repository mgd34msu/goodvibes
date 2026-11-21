import { constantTimeEquals, parseJsonRecord, readBearerOrHeaderToken, readTextBodyWithinLimit, readRecord, readString, surfaceCredentialAbsent } from '../helpers.js';
import { resolveInboundCredential, surfaceCredentialUnavailable } from '../surface-credential.js';
import { runSurfaceMessage, surfaceOutcomeResponse } from '../surface-message.js';
import type { SurfaceAdapterContext } from '../types.js';

/**
 * Only an `m.thread` relation opens a thread. A plain reply (`m.in_reply_to`
 * alone) stays in the room's conversation; the event it answers is kept as
 * `replyToMessageId` so a reply to a notice can still be matched to it.
 */
function readRelation(content: Record<string, unknown> | null): { threadId?: string | undefined; replyToMessageId?: string | undefined } {
  const relatesTo = readRecord(content?.['m.relates_to']);
  const replyToMessageId = readString(readRecord(relatesTo?.['m.in_reply_to'])?.event_id);
  const threadId = readString(relatesTo?.rel_type) === 'm.thread' ? readString(relatesTo?.event_id) : undefined;
  return { ...(threadId ? { threadId } : {}), ...(replyToMessageId ? { replyToMessageId } : {}) };
}
/**
 * Whether the event addresses the bot. The bridge's own `mentioned` flag wins;
 * otherwise the event's `m.mentions` decides when it carries one, and an event
 * without it counts only when its text names the bot's user id (a legacy
 * mention). With no bot user id configured nothing can be matched, so the event
 * is not addressed: a policy that requires a mention must not pass on silence.
 */
function matrixMentioned(payload: Record<string, unknown>, content: Record<string, unknown> | null, botUserId: string | undefined, text: string): boolean {
  if (typeof payload.mentioned === 'boolean') return payload.mentioned;
  if (!botUserId) return false;
  const mentions = readRecord(content?.['m.mentions']);
  if (!mentions) return text.includes(botUserId);
  const userIds = Array.isArray(mentions.user_ids) ? mentions.user_ids : [];
  return mentions.room === true || userIds.includes(botUserId);
}

export async function handleMatrixSurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const credential = await resolveInboundCredential(context, 'matrix');
  if (credential.state === 'unresolvable') return surfaceCredentialUnavailable('matrix', credential);
  if (credential.state === 'absent') return surfaceCredentialAbsent('matrix', credential.setting);
  const providedToken = readBearerOrHeaderToken(req, 'x-goodvibes-matrix-token');
  if (credential.state === 'resolved' && !constantTimeEquals(credential.value, providedToken)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;
  const body = parseJsonRecord(rawBody);
  if (body instanceof Response) return body;
  const payload = readRecord(body);
  if (!payload) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  const event = readRecord(payload.event) ?? payload;
  const content = readRecord(event.content);
  const roomId = readString(event.room_id) ?? readString(payload.roomId);
  const text = readString(content?.body) ?? readString(event.text) ?? readString(payload.text) ?? '';
  if (!roomId) return Response.json({ error: 'Missing room id' }, { status: 400 });
  // An edit (m.replace) re-sends the whole text of a message already acted on, and a reaction (m.annotation)
  // carries a key, not a request. Neither is a new message, so neither binds, spawns or answers.
  const relationType = readString(readRecord(content?.['m.relates_to'])?.rel_type);
  if (relationType === 'm.replace' || relationType === 'm.annotation') {
    return Response.json({ ok: true, acknowledged: true, queued: false, outcome: 'ignored', reason: relationType === 'm.replace' ? 'edited-message' : 'annotation' });
  }
  const { threadId, replyToMessageId } = readRelation(content);
  const sender = readString(event.sender) ?? readString(payload.sender);
  const eventId = readString(event.event_id);
  const msgtype = readString(content?.msgtype);

  const providerMessageId = eventId;
  const surfaceId = readString(context.configManager.get('surfaces.matrix.userId')) ?? 'matrix';
  // A room event does not say whether the room is a direct chat (that is the
  // account's m.direct data); the bridge that delivers it does, as is_direct /
  // isDirect. Without it the room counts as shared. The policy and the binding
  // both read this one test.
  const direct = payload.is_direct === true || payload.isDirect === true;
  const outcome = await runSurfaceMessage(context, {
    ingress: {
      surface: 'matrix',
      userId: sender,
      channelId: roomId,
      groupId: roomId,
      threadId,
      workspaceId: readString(payload.homeserver) ?? readString(context.configManager.get('surfaces.matrix.homeserverUrl')),
      conversationKind: threadId ? 'thread' : direct ? 'direct' : 'channel',
      ...(direct ? { parentConversationKind: 'direct' as const } : {}),
      text,
      mentioned: matrixMentioned(payload, content, readString(context.configManager.get('surfaces.matrix.userId')), text),
      metadata: { ...payload, ...(replyToMessageId ? { replyToMessageId } : {}) },
    },
    binding: {
      kind: threadId ? 'thread' : 'channel',
      surfaceKind: 'matrix',
      surfaceId,
      externalId: threadId ?? roomId,
      channelId: roomId,
      threadId,
      title: roomId,
      metadata: {
        ...(eventId ? { eventId } : {}),
        ...(msgtype ? { msgtype } : {}),
        // Who it is with and whether it is one-to-one: the owner's own conversations (owner-alert.ts isOwnerConversation) are read from these.
        ...(sender ? { userId: sender } : {}),
        conversationKind: threadId ? 'thread' : direct ? 'direct' : 'channel',
        ...(replyToMessageId ? { replyToMessageId } : {}),
      },
    },
    text,
    logLabel: 'handleMatrixSurfaceWebhook',
    control: 'notice',
    ...(providerMessageId ? { providerMessageId } : {}),
    userId: sender,
    displayName: readString(payload.displayName) ?? sender,
    signal: req.signal,
  });
  if (outcome.kind === 'no-text') {
    // Whether a room is one-to-one is not in the event, so the sender is not answered here.
    const attachment = msgtype === 'm.image' || msgtype === 'm.audio' || msgtype === 'm.video' || msgtype === 'm.file' ? msgtype.slice(2) : undefined;
    return Response.json({
      ok: true,
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: attachment ? 'unsupported-attachment' : 'no-actionable-text',
      ...(attachment ? { attachment } : {}),
      bindingId: outcome.binding.id,
    });
  }
  return surfaceOutcomeResponse(outcome, 'caller');
}
