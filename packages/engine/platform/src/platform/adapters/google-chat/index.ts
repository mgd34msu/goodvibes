import type { SurfaceAdapterContext } from '../types.js';
import { constantTimeEquals, parseJsonRecord, readTextBodyWithinLimit, readRecord, readString, policyReplyText, noticeUnsupportedAttachment, hasAttachments } from '../helpers.js';
import { duplicateDeliveryResponse, inboundDedupKey, runOncePerMessage, surfaceInboundDedup } from '../inbound-dedup.js';
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

  const dedupKey = inboundDedupKey('google-chat', spaceName, readString(message?.name));
  return runOncePerMessage(dedupKey, duplicateDeliveryResponse, async (committed) => {
    const policy = await context.authorizeSurfaceIngress({
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
    });
    if (!policy.allowed) {
      // Google posts the 200 body as the reply; a 403 would only show "app not responding".
      // A 200 would count as delivered, so release the claim: a retry after the policy changes must run.
      surfaceInboundDedup.release(dedupKey);
      return Response.json({ text: policyReplyText(policy.reason) });
    }

    const binding = await context.routeBindings.upsertBinding({
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
      },
    });

    if (!text) {
      const attachment = hasAttachments(message?.attachment) ? 'attachment' : undefined;
      const notified = attachment ? await noticeUnsupportedAttachment(context, binding, attachment, space?.type === 'DM' || space?.spaceType === 'DIRECT_MESSAGE') : false;
      logger.info('handleGoogleChatSurfaceWebhook: message acknowledged without queueing', {
        reason: attachment ? 'unsupported-attachment' : 'no-actionable-text',
        bindingId: binding.id,
        eventType,
      });
      return Response.json({
        text: 'Acknowledged.',
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
      const message = await context.performSurfaceControlCommand(controlCommand, { surface: 'google-chat', routeId: binding.id });
      return Response.json({ text: message });
    }

    const submission = await context.sessionBroker.submitMessage({
      routeId: binding.id,
      ...(dedupKey ? { providerMessageId: dedupKey } : {}),
      surfaceKind: 'google-chat',
      surfaceId: binding.surfaceId,
      externalId: binding.externalId,
      threadId: binding.threadId ?? binding.channelId,
      userId: readString(user?.name),
      displayName: readString(user?.displayName),
      title: binding.title ?? 'Google Chat',
      body: text,
      metadata: {
        eventType,
        spaceName,
      },
    });
    if (submission.mode === 'continued-live' || submission.mode === 'queued-follow-up') {
      committed();
      return Response.json({ text: `Continuing session ${submission.session.id}.` });
    }

    const spawnResult = await context.trySpawnAgent(
      { mode: 'spawn', task: submission.task! },
      'handleGoogleChatSurfaceWebhook',
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
    return Response.json({ text: `Running ${spawnResult.id}` });
  });
}
