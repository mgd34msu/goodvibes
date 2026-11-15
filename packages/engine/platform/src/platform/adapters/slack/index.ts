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
import { answerSurfaceControl, runSurfaceMessage, submitSurfaceMessage, surfaceOutcomeResponse } from '../surface-message.js';

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

    const control = await answerSurfaceControl(context, {
      surface: 'slack', text: task, binding, userId: event.userId, channelId: event.channelId, answer: 'response', signal: req.signal,
    });
    if (control) {
      return Response.json({
        response_type: 'ephemeral',
        text: control.message,
      });
    }

    let responseUrl: string | undefined = event.responseUrl;
    if (responseUrl && !responseUrl.startsWith('https://hooks.slack.com/')) {
      logger.warn('handleSlackSurfaceWebhook: suspicious responseUrl, ignoring');
      responseUrl = undefined;
    }
    const postToResponseUrl = async (body: Record<string, unknown>, what: string): Promise<void> => {
      if (!responseUrl) return;
      await fetchWithTimeout(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch((error: unknown) => logger.warn(`handleSlackSurfaceWebhook: ${what} could not be posted`, {
        error: summarizeError(error),
      }));
    };
    setImmediate(() => {
      void (async () => {
        const outcome = await submitSurfaceMessage(context, binding, {
          surface: 'slack',
          text: task,
          logLabel: 'handleSlackSurfaceWebhook',
          control: false,
          externalId: event.channelId,
          threadId: event.channelId,
          userId: event.userId,
          displayName: event.userName,
          title: event.channelName || event.command,
          metadata: { command: event.command },
          replyBinding: (replyTo) => responseUrl ? { ...replyTo, metadata: { ...replyTo.metadata, responseUrl } } : replyTo,
        });
        switch (outcome.kind) {
          case 'continued':
            await postToResponseUrl({
              response_type: 'in_channel',
              text: outcome.agentId ? `Continuing session ${outcome.sessionId} via agent ${outcome.agentId}.` : `Queued for session ${outcome.sessionId}; it will run when the agent now starting finishes.`,
            }, 'continuation response');
            return;
          case 'started':
            await postToResponseUrl({
              response_type: 'in_channel',
              blocks: slack.formatAgentResult(
                outcome.agentId,
                task,
                `Session ${outcome.sessionId} active. Agent ${outcome.agentId} will reply in-channel when complete.`,
              ),
            }, 'follow-up');
            return;
          case 'answered':
            // The conversation gate already answered in the channel (a work proposal, or why nothing started).
            return;
          case 'not-started':
            logger.error('handleSlackSurfaceWebhook: the agent was not started', { error: outcome.error });
            context.reportIngressFailure?.('slack', outcome.error);
            await postToResponseUrl({ response_type: 'ephemeral', text: `Nothing was started: ${outcome.error}` }, 'start failure response');
            return;
          case 'control':
            return;
        }
      })().catch((error: unknown) => {
        // The HTTP response is already sent, so a throw here has no caller to
        // reach; it is logged and reported on the surface's ingress alarm.
        const detail = summarizeError(error);
        logger.error('handleSlackSurfaceWebhook: slash-command processing failed after the ack', { error: detail });
        context.reportIngressFailure?.('slack', detail);
      });
    });

    return Response.json({
      response_type: 'in_channel',
      text: `Received: _${task}_`,
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
      const outcome = await runSurfaceMessage(context, {
        ingress: {
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
        },
        binding: {
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
        },
        text: task,
        logLabel: 'handleSlackSurfacePayload',
        // Slack does not show the answer to an event; a command's answer goes to the conversation.
        control: 'notice',
        ...(dedupKey ? { providerMessageId: dedupKey } : {}),
        userId: event.userId,
        displayName: event.userId,
        title: `Slack ${event.eventType}`,
        metadata: {
          eventType: event.eventType,
          eventTs: event.eventTs,
        },
        signal: req.signal,
        committed,
      });
      if (outcome.kind === 'refused') {
        // An attachment-only message is not worth a redelivery: acknowledge it.
        if (!task) return Response.json({ ok: true, acknowledged: true, queued: false, outcome: 'ignored', policyReason: outcome.reason });
        return Response.json({ ok: false, error: `Blocked by channel policy: ${outcome.reason}` }, { status: 403 });
      }
      if (outcome.kind === 'no-text') {
        // A message that is only a file: say so in a one-to-one conversation; in a channel it is chatter.
        const notified = attachment ? await noticeUnsupportedAttachment(context, outcome.binding, attachment, rawEvent?.channel_type === 'im') : false;
        committed();
        return Response.json({
          ok: true,
          acknowledged: true,
          queued: false,
          outcome: 'ignored',
          reason: 'unsupported-attachment',
          attachment,
          notified,
          bindingId: outcome.binding.id,
        });
      }
      return surfaceOutcomeResponse(outcome);
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
