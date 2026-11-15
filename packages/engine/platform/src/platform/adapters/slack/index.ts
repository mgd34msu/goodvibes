import { jsonErrorResponse } from '@goodvibes-jev/engine/daemon-api';
import { logger } from '../../utils/logger.js';
import { SlackIntegration } from '../../integrations/index.js';
import { slackMentionedUserIds } from '../../integrations/slack.js';
import type { SurfaceAdapterContext } from '../types.js';
import { summarizeError } from '../../utils/error-display.js';
import { fetchWithTimeout } from '../../utils/fetch-with-timeout.js';
import { resolveSecretInput, type SecretRefResolutionOptions } from '../../config/secret-refs.js';
import { hasAttachments, noticeUnsupportedAttachment, policyReplyText, readRecord, readTextBodyWithinLimit } from '../helpers.js';
import { duplicateDeliveryResponse, inboundDedupKey, runOncePerMessage } from '../inbound-dedup.js';

export async function handleSlackSurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const signingSecret =
    await context.serviceRegistry.resolveSecret('slack', 'signingSecret')
    ?? await resolveSlackConfigSecret(context, 'surfaces.slack.signingSecret')
    ?? process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    logger.warn('handleSlackSurfaceWebhook: SLACK_SIGNING_SECRET not set, rejecting');
    return Response.json({ error: 'Webhook not configured' }, { status: 503 });
  }

  const timestamp = req.headers.get('x-slack-request-timestamp') ?? '';
  const signature = req.headers.get('x-slack-signature') ?? '';
  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;

  const slack = new SlackIntegration(
    await context.serviceRegistry.resolveSecret('slack', 'webhookUrl') ?? process.env.SLACK_WEBHOOK_URL,
    await context.serviceRegistry.resolveSecret('slack', 'primary')
      ?? await resolveSlackConfigSecret(context, 'surfaces.slack.botToken')
      ?? process.env.SLACK_BOT_TOKEN,
  );

  if (!slack.verifySignature(rawBody, timestamp, signature, signingSecret)) {
    logger.warn('handleSlackSurfaceWebhook: invalid signature');
    return Response.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let bodyRecord: Record<string, unknown>;
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      bodyRecord = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  } else {
    bodyRecord = Object.fromEntries(new URLSearchParams(rawBody));
  }

  if (bodyRecord.type === 'url_verification') {
    return Response.json({ challenge: bodyRecord.challenge });
  }

  try {
    return await handleSlackSurfacePayload(bodyRecord, context, slack, req);
  } catch (error) {
    // A signed callback is not an owner capability. Keep exact-owner and
    // other domain refusals structured instead of leaking Bun's HTML 500.
    // Structure only: the model-assisted reading of an error message can itself
    // fail or stall, and Slack redelivers an event whose acknowledgement is late.
    return jsonErrorResponse(error);
  }
}

export async function handleSlackSurfacePayload(
  bodyRecord: Record<string, unknown>,
  context: SurfaceAdapterContext,
  slack = new SlackIntegration(),
  req: Request = new Request('http://goodvibes.local/webhook/slack', { method: 'POST' }),
): Promise<Response> {
  const event = slack.parseEvent(bodyRecord);
  if (event.type === 'slash_command') {
    const task = event.text.trim();
    const policy = await context.authorizeSurfaceIngress({
      surface: 'slack',
      userId: event.userId,
      channelId: event.channelId,
      groupId: event.channelId,
      conversationKind: 'channel',
      text: task,
      mentioned: true,
      metadata: {
        command: event.command,
        userName: event.userName,
      },
    });
    if (!policy.allowed) {
      // Slack shows a slash-command reply only when it arrives with 200.
      return Response.json({
        response_type: 'ephemeral',
        text: policyReplyText(policy.reason),
      });
    }

    const binding = await context.routeBindings.upsertBinding({
      kind: 'channel',
      surfaceKind: 'slack',
      surfaceId: event.teamId || 'slack',
      externalId: event.channelId,
      channelId: event.channelId,
      title: event.channelName || event.command,
      metadata: {
        command: event.command,
        userId: event.userId,
        userName: event.userName,
        // The one-shot reply URL belongs to this command alone. It is not kept on
        // the channel's shared binding, and any copy an earlier release stored
        // there is cleared, so later messages never reply to an expired URL.
        responseUrl: undefined,
      },
    });
    if (!task) {
      return Response.json({
        response_type: 'ephemeral',
        text: 'Usage: `/goodvibes <your prompt>`',
      });
    }

    const controlCommand = await context.parseSurfaceControlCommand(task, { signal: req.signal });
    if (controlCommand) {
      const message = await context.performSurfaceControlCommand(controlCommand, { surface: 'slack', routeId: binding.id });
      return Response.json({
        response_type: 'ephemeral',
        text: message,
      });
    }

    let responseUrl: string | undefined = event.responseUrl;
    if (responseUrl && !responseUrl.startsWith('https://hooks.slack.com/')) {
      logger.warn('handleSlackSurfaceWebhook: suspicious responseUrl, ignoring');
      responseUrl = undefined;
    }
    setImmediate(() => {
      void (async () => {
        const submission = await context.sessionBroker.submitMessage({
          routeId: binding.id,
          surfaceKind: 'slack',
          surfaceId: binding.surfaceId,
          externalId: event.channelId,
          threadId: event.channelId,
          userId: event.userId,
          displayName: event.userName,
          title: event.channelName || event.command,
          body: task,
          metadata: {
            command: event.command,
          },
        });
        if (submission.mode === 'continued-live' || submission.mode === 'queued-follow-up') {
          if (responseUrl) {
            await fetchWithTimeout(responseUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                response_type: 'in_channel',
                text: submission.activeAgentId ? `Continuing session ${submission.session.id} via agent ${submission.activeAgentId}.` : `Queued for session ${submission.session.id}; it will run when the agent now starting finishes.`,
              }),
            }).catch((error) => logger.warn('handleSlackSurfaceWebhook: failed to send continuation response', {
              error: summarizeError(error),
            }));
          }
          return;
        }

        const spawnResult = await context.trySpawnAgent(
          { mode: 'spawn', task: submission.task! },
          'handleSlackSurfaceWebhook',
          submission.session.id,
        );
        if (spawnResult instanceof Response) {
          const payload = await spawnResult.json() as { error?: string };
          const message = payload.error ?? 'Agent spawn failed';
          logger.error('handleSlackSurfaceWebhook: spawn failed', { error: message });
          if (responseUrl) {
            await fetchWithTimeout(responseUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                response_type: 'in_channel',
                text: `Agent spawn failed: ${message}`,
              }),
            }).catch((error) => logger.warn('handleSlackSurfaceWebhook: failed to send spawn failure response', {
              error: summarizeError(error),
            }));
          }
          return;
        }

        await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id, submission.input.id);
        const replyBinding = submission.routeBinding ?? binding;
        context.queueSurfaceReplyFromBinding(
          responseUrl ? { ...replyBinding, metadata: { ...replyBinding.metadata, responseUrl } } : replyBinding,
          {
            agentId: spawnResult.id,
            task,
            sessionId: submission.session.id,
          },
        );
        if (responseUrl) {
          await fetchWithTimeout(responseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              response_type: 'in_channel',
              blocks: slack.formatAgentResult(
                spawnResult.id,
                task,
                `Session ${submission.session.id} active. Agent ${spawnResult.id} will reply in-channel when complete.`,
              ),
            }),
          }).catch((error: unknown) => {
            logger.warn('handleSlackSurfaceWebhook: follow-up post failed', {
              error: summarizeError(error),
            });
          });
        }
      })().catch((error: unknown) => {
        // Same shape as Discord's slash command, same absent catch: the HTTP
        // response is already sent, so a throw here was an unhandled rejection
        // with no log line and no way to notice.
        const detail = summarizeError(error);
        logger.error('handleSlackSurfaceWebhook: slash-command processing failed after the ack', { error: detail });
        context.reportIngressFailure?.('slack', detail);
      });
    });

    return Response.json({
      response_type: 'in_channel',
      text: `Running: _${task}_`,
    });
  }

  if (event.type === 'event_callback') {
    if (event.eventType !== 'app_mention' && event.eventType !== 'message') {
      return new Response(null, { status: 200 });
    }
    const task = event.text.trim();
    // Mentioned means this app's bot user is mentioned: Slack sends `app_mention`
    // for that, and a plain `message` counts only when its markup names one of
    // the bot user ids the event's `authorizations` carry, not any user.
    const botUserIds = new Set(event.botUserIds.map((id) => id.toUpperCase()));
    const mentioned = event.eventType === 'app_mention'
      || slackMentionedUserIds(task).some((id) => botUserIds.has(id));
    // Slack sends the bot's own posts back as `message` events; they are never user input.
    const rawEvent = readRecord(bodyRecord.event);
    if (rawEvent?.bot_id || rawEvent?.subtype === 'bot_message' || (event.userId && botUserIds.has(event.userId.toUpperCase()))) {
      return new Response(null, { status: 200 });
    }
    const attachment = hasAttachments(rawEvent?.files) ? 'file' : undefined;
    if (!task && !attachment) return new Response(null, { status: 200 });
    // One mentioning message arrives as both `message` and `app_mention`, and Slack
    // redelivers an event whose acknowledgement took longer than 3 seconds. Channel
    // and message timestamp name the message across all of those deliveries.
    const dedupKey = inboundDedupKey('slack', event.channelId, event.eventTs);
    return runOncePerMessage(dedupKey, duplicateDeliveryResponse, async (committed) => {
      const policy = await context.authorizeSurfaceIngress({
        surface: 'slack',
        userId: event.userId,
        channelId: event.channelId,
        groupId: event.channelId,
        threadId: event.threadTs ?? event.eventTs,
        workspaceId: event.teamId,
        conversationKind: event.threadTs ? 'thread' : 'channel',
        parentConversationKind: 'channel',
        text: task,
        mentioned,
        metadata: {
          eventType: event.eventType,
          eventTs: event.eventTs,
        },
      });
      if (!policy.allowed) {
        // An attachment-only message is not worth a redelivery: acknowledge it.
        if (!task) return Response.json({ ok: true, acknowledged: true, queued: false, outcome: 'ignored', policyReason: policy.reason });
        return Response.json({ ok: false, error: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
      }
      const binding = await context.routeBindings.upsertBinding({
        kind: event.threadTs ? 'thread' : 'channel',
        surfaceKind: 'slack',
        surfaceId: event.teamId || 'slack',
        externalId: event.threadTs ?? event.channelId,
        channelId: event.channelId,
        threadId: event.threadTs,
        title: `Slack ${event.eventType}`,
        metadata: {
          userId: event.userId,
          eventType: event.eventType,
          eventTs: event.eventTs,
          // Clears a one-shot reply URL an earlier release stored on this binding.
          responseUrl: undefined,
        },
      });
      if (!task) {
        // A message that is only a file: say so in a one-to-one conversation; in a channel it is chatter.
        const notified = attachment ? await noticeUnsupportedAttachment(context, binding, attachment, rawEvent?.channel_type === 'im') : false;
        committed();
        return Response.json({
          ok: true,
          acknowledged: true,
          queued: false,
          outcome: 'ignored',
          reason: 'unsupported-attachment',
          attachment,
          notified,
          bindingId: binding.id,
        });
      }
      const submission = await context.sessionBroker.submitMessage({
        routeId: binding.id,
        ...(dedupKey ? { providerMessageId: dedupKey } : {}),
        surfaceKind: 'slack',
        surfaceId: binding.surfaceId,
        externalId: binding.externalId,
        threadId: binding.threadId ?? binding.channelId,
        userId: event.userId,
        displayName: event.userId,
        title: `Slack ${event.eventType}`,
        body: task,
        metadata: {
          eventType: event.eventType,
          eventTs: event.eventTs,
        },
      });
      if (submission.mode === 'continued-live' || submission.mode === 'queued-follow-up') {
        committed();
        return Response.json({
          ok: true,
          continued: true,
          sessionId: submission.session.id,
          agentId: submission.activeAgentId,
        });
      }
      const spawnResult = await context.trySpawnAgent(
        { mode: 'spawn', task: submission.task! },
        'handleSlackSurfacePayload',
        submission.session.id,
      );
      if (spawnResult instanceof Response) return spawnResult;
      committed();
      await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id, submission.input.id);
      context.queueSurfaceReplyFromBinding(submission.routeBinding ?? binding, {
        agentId: spawnResult.id,
        task,
        sessionId: submission.session.id,
      });
      return Response.json({
        ok: true,
        queued: true,
        sessionId: submission.session.id,
        agentId: spawnResult.id,
      });
  
    });
  }

  const actionPayload = event.payload;
  const actionId = Array.isArray(actionPayload.actions)
    ? (() => {
        const first = actionPayload.actions[0]! as Record<string, unknown> | undefined;
        return typeof first?.action_id === 'string' ? first.action_id : '';
      })()
    : '';
  if (actionId) {
    const policy = await context.authorizeSurfaceIngress({
      surface: 'slack',
      userId: typeof (actionPayload.user as Record<string, unknown> | undefined)?.id === 'string'
        ? (actionPayload.user as Record<string, unknown>).id as string
        : undefined,
      channelId: typeof (actionPayload.channel as Record<string, unknown> | undefined)?.id === 'string'
        ? (actionPayload.channel as Record<string, unknown>).id as string
        : undefined,
      groupId: typeof (actionPayload.channel as Record<string, unknown> | undefined)?.id === 'string'
        ? (actionPayload.channel as Record<string, unknown>).id as string
        : undefined,
      conversationKind: 'channel',
      text: actionId,
      mentioned: true,
      metadata: { interactive: true },
    });
    if (!policy.allowed) {
      return Response.json({
        response_type: 'ephemeral',
        text: `Blocked by channel policy: ${policy.reason}`,
      });
    }
    const message = await context.performInteractiveSurfaceAction(actionId, 'slack', req, typeof (actionPayload.user as Record<string, unknown> | undefined)?.id === 'string'
      ? (actionPayload.user as Record<string, unknown>).id as string
      : undefined);
    return Response.json({
      response_type: 'ephemeral',
      text: message,
    });
  }

  return new Response(null, { status: 200 });
}

async function resolveSlackConfigSecret(
  context: SurfaceAdapterContext,
  key: 'surfaces.slack.botToken' | 'surfaces.slack.signingSecret',
): Promise<string | null> {
  return resolveSecretInput(context.configManager.get(key), slackSecretRefOptions(context));
}

function slackSecretRefOptions(context: SurfaceAdapterContext): SecretRefResolutionOptions {
  return {
    resolveLocalSecret: context.secretsManager
      ? (key) => context.secretsManager!.get(key)
      : undefined,
    homeDirectory: context.secretsManager?.getGlobalHome?.() ?? undefined,
  };
}
