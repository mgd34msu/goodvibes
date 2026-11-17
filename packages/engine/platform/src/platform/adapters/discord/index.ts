import { InboundMessageDedup, inboundDedupKey } from '../inbound-dedup.js';
import { logger } from '../../utils/logger.js';
import { DiscordIntegration, DiscordInteractionResponseType, DiscordInteractionType } from '../../integrations/index.js';
import type { SurfaceAdapterContext } from '../types.js';
import { summarizeError } from '../../utils/error-display.js';
import { resolveSurfaceSecret } from '../../channels/builtin/surface-secrets.js';
import { ingressAnswer, readTextBodyWithinLimit } from '../helpers.js';
import { answerSurfaceControl, gateAnswerText, runSurfaceMessage, submitSurfaceMessage, surfaceOutcomeResponse } from '../surface-message.js';

/** Discord message flag: only the user who ran the command sees the reply. */
const EPHEMERAL_MESSAGE_FLAG = 64;

const completedInteractions = new InboundMessageDedup();
const pendingInteractions = new Set<string>();

export async function handleDiscordSurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const publicKey =
    await context.serviceRegistry.resolveSecret('discord', 'publicKey')
    ?? process.env.DISCORD_PUBLIC_KEY;
  if (!publicKey) {
    logger.warn('handleDiscordSurfaceWebhook: DISCORD_PUBLIC_KEY not set, rejecting');
    return Response.json({ error: 'Webhook not configured' }, { status: 503 });
  }

  const signature = req.headers.get('x-signature-ed25519') ?? '';
  const timestamp = req.headers.get('x-signature-timestamp') ?? '';
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp) * 1000) > 5 * 60_000) {
    return new Response('Expired request signature', { status: 401 });
  }
  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;

  const discord = new DiscordIntegration(
    await resolveSurfaceSecret(context, 'discord', 'webhookUrl') ?? undefined,
    await resolveSurfaceSecret(context, 'discord', 'primary') ?? undefined,
  );

  const valid = await discord.verifySignature(rawBody, signature, timestamp, publicKey);
  if (!valid) {
    logger.warn('handleDiscordSurfaceWebhook: invalid Ed25519 signature');
    return new Response('Invalid request signature', { status: 401 });
  }

  let bodyRecord: Record<string, unknown>;
  try {
    bodyRecord = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }

  return handleDiscordInteractionPayload(bodyRecord, context, discord, req);
}

export async function handleDiscordInteractionPayload(
  bodyRecord: Record<string, unknown>,
  context: SurfaceAdapterContext,
  discord = new DiscordIntegration(),
  req: Request = new Request('http://goodvibes.local/webhook/discord', { method: 'POST' }),
): Promise<Response> {
  const id = typeof bodyRecord.id === 'string' ? bodyRecord.id : '';
  const key = inboundDedupKey('discord', String(bodyRecord.application_id ?? ''), id);
  if (bodyRecord.type !== DiscordInteractionType.Ping && !key) return new Response('Missing interaction id', { status: 400 });
  if (key && (pendingInteractions.has(key) || completedInteractions.has(key))) {
    return Response.json({ type: DiscordInteractionResponseType.DeferredChannelMessageWithSource });
  }
  if (key) pendingInteractions.add(key);
  let delivered = false;
  const committed = () => { delivered = true; completedInteractions.claim(key); };
  const failed = () => { if (!delivered) completedInteractions.release(key); pendingInteractions.delete(key); };
  try {
    const response = await dispatchDiscordInteraction(bodyRecord, context, discord, req, committed, failed);
    // Deferred command processing owns the pending claim until it settles.
    if (response.status >= 400) failed();
    else if (bodyRecord.type !== DiscordInteractionType.ApplicationCommand) { committed(); pendingInteractions.delete(key); }
    return response;
  } catch (error) { failed(); throw error; }
}

async function dispatchDiscordInteraction(
  bodyRecord: Record<string, unknown>, context: SurfaceAdapterContext, discord: DiscordIntegration, req: Request,
  committed: () => void, finished: () => void,
): Promise<Response> {
  const interaction = discord.parseInteraction(bodyRecord);
  if (interaction.type === DiscordInteractionType.Ping) {
    return Response.json({ type: DiscordInteractionResponseType.Pong });
  }

  if (interaction.type === DiscordInteractionType.ApplicationCommand) {
    const promptOption = interaction.commandOptions?.find((option) => option.name === 'prompt');
    const task = typeof promptOption?.value === 'string' ? promptOption.value.trim() : '';
    const policy = await context.authorizeSurfaceIngress({
      surface: 'discord',
      userId: interaction.userId,
      channelId: interaction.channelId,
      groupId: interaction.channelId,
      conversationKind: interaction.channelId ? 'channel' : 'service',
      text: task,
      mentioned: true,
      metadata: {
        commandName: interaction.commandName,
      },
    });
    if (!policy.allowed) {
      // Discord shows an interaction reply only when it arrives with 200. A refusal
      // started no work, so the claim on this interaction is given back; a consumed
      // answer keeps it, so a repeat is never read as a second answer.
      if (policy.consumed) committed();
      finished();
      return Response.json({
        type: DiscordInteractionResponseType.ChannelMessageWithSource,
        data: { content: ingressAnswer(policy, 'caller').text, flags: EPHEMERAL_MESSAGE_FLAG },
      });
    }

    const binding = await context.routeBindings.upsertBinding({
      kind: 'channel',
      surfaceKind: 'discord',
      surfaceId: interaction.guildId ?? interaction.applicationId ?? 'discord',
      externalId: interaction.channelId ?? interaction.id,
      channelId: interaction.channelId,
      title: interaction.commandName ?? 'discord',
      metadata: {
        userId: interaction.userId,
        commandName: interaction.commandName,
        applicationId: interaction.applicationId,
        // The interaction token edits this one command's response for 15 minutes.
        // It stays out of the channel's shared, durable binding (and a copy an
        // earlier release stored there is cleared); this command's reply carries
        // it instead.
        interactionToken: undefined,
      },
    });

    const deferredResponse = Response.json({
      type: DiscordInteractionResponseType.DeferredChannelMessageWithSource,
    });
    if (!task) {
      committed(); finished();
      return deferredResponse;
    }

    const control = await answerSurfaceControl(context, {
      surface: 'discord', text: task, binding, userId: interaction.userId, channelId: interaction.channelId, answer: 'response', signal: req.signal,
    });
    if (control) {
      committed(); finished();
      return Response.json({
        type: DiscordInteractionResponseType.ChannelMessageWithSource,
        data: { content: control.message },
      });
    }

    const appId = interaction.applicationId;
    const token = interaction.token;
    const editResponse = async (content: string, embeds?: Parameters<DiscordIntegration['editOriginalResponse']>[3]): Promise<void> => {
      await discord.editOriginalResponse(appId, token, content, embeds).catch((error: unknown) => {
        logger.warn('handleDiscordSurfaceWebhook: the deferred response could not be edited', { error: summarizeError(error) });
      });
    };

    setImmediate(() => {
      void (async () => {
        const outcome = await submitSurfaceMessage(context, binding, {
          surface: 'discord',
          text: task,
          logLabel: 'handleDiscordSurfaceWebhook',
          control: false,
          ...(interaction.id ? { providerMessageId: interaction.id } : {}),
          externalId: interaction.channelId ?? interaction.id,
          threadId: interaction.channelId,
          userId: interaction.userId,
          displayName: interaction.userId,
          title: interaction.commandName ?? 'discord',
          metadata: { applicationId: appId },
          committed,
          replyBinding: (replyTo) => ({ ...replyTo, metadata: { ...replyTo.metadata, interactionToken: token } }),
        });
        switch (outcome.kind) {
          case 'continued':
            await editResponse(outcome.agentId ? `Continuing session ${outcome.sessionId} via agent ${outcome.agentId}.` : `Queued for session ${outcome.sessionId}; it will run when the agent now starting finishes.`);
            return;
          case 'started':
            await editResponse('', [discord.formatAgentResult(
              outcome.agentId,
              task,
              `Session ${outcome.sessionId} active. Result will be posted here when complete.`,
            )]);
            return;
          case 'answered':
            // The gate already answered in the channel; the deferred "thinking" reply says what happened.
            await editResponse(gateAnswerText(outcome.outcome));
            return;
          case 'not-started':
            logger.error('handleDiscordSurfaceWebhook: the agent was not started', { error: outcome.error });
            context.reportIngressFailure?.('discord', outcome.error);
            await editResponse(`Nothing was started: ${outcome.error}`);
            return;
          case 'control':
            return;
        }
      })().catch((error: unknown) => {
        // The slash command was answered with a deferred response before this
        // ran, so a throw has no caller; it is logged, reported on the
        // surface's ingress alarm, and the deferred reply is not left waiting.
        const detail = summarizeError(error);
        logger.error('handleDiscordSurfaceWebhook: slash-command processing failed after the deferred reply', {
          error: detail,
        });
        context.reportIngressFailure?.('discord', detail);
        return editResponse('Nothing was started: the request failed after it was received. Send it again.');
      }).finally(finished);
    });

    return deferredResponse;
  }

  if (interaction.type === DiscordInteractionType.MessageComponent) {
    const data = (interaction.raw.data ?? {}) as Record<string, unknown>;
    const customId = typeof data.custom_id === 'string' ? data.custom_id : '';
    if (customId) {
      const policy = await context.authorizeSurfaceIngress({
        surface: 'discord',
        userId: interaction.userId,
        channelId: interaction.channelId,
        groupId: interaction.channelId,
        conversationKind: interaction.channelId ? 'channel' : 'service',
        text: customId,
        mentioned: true,
        metadata: { interactive: true },
      });
      if (!policy.allowed) {
        return Response.json({
          type: DiscordInteractionResponseType.ChannelMessageWithSource,
          data: { content: ingressAnswer(policy, 'caller').text, flags: EPHEMERAL_MESSAGE_FLAG },
        });
      }
      const message = await context.performInteractiveSurfaceAction(customId, 'discord', req, interaction.userId);
      return Response.json({
        type: DiscordInteractionResponseType.ChannelMessageWithSource,
        data: { content: message },
      });
    }
  }

  return Response.json({ type: DiscordInteractionResponseType.DeferredUpdateMessage });
}

export async function handleDiscordGatewayDispatchPayload(
  dispatch: { readonly t?: string | undefined; readonly d?: Record<string, unknown> | null | undefined },
  context: SurfaceAdapterContext,
  discord = new DiscordIntegration(),
): Promise<Response> {
  if (!dispatch.d) return new Response(null, { status: 204 });
  if (dispatch.t === 'INTERACTION_CREATE') {
    return handleDiscordInteractionPayload(dispatch.d, context, discord);
  }
  if (dispatch.t !== 'MESSAGE_CREATE') {
    return new Response(null, { status: 204 });
  }

  const author = (dispatch.d.author ?? {}) as Record<string, unknown>;
  if (author.bot === true) return new Response(null, { status: 204 });
  const content = typeof dispatch.d.content === 'string' ? dispatch.d.content.trim() : '';
  if (!content) return new Response(null, { status: 204 });
  const channelId = typeof dispatch.d.channel_id === 'string' ? dispatch.d.channel_id : undefined;
  const guildId = typeof dispatch.d.guild_id === 'string' ? dispatch.d.guild_id : undefined;
  const messageId = typeof dispatch.d.id === 'string' ? dispatch.d.id : undefined;
  const userId = typeof author.id === 'string' ? author.id : undefined;
  // Mentioned means this bot is mentioned: a Discord bot user's id is its
  // application id, so a mention counts only when one of the message's
  // structured `mentions` carries the configured application id.
  const applicationId = context.configManager.get('surfaces.discord.applicationId');
  const mentioned = typeof applicationId === 'string' && applicationId.length > 0
    && Array.isArray(dispatch.d.mentions)
    && dispatch.d.mentions.some((mention) => (mention as { readonly id?: unknown } | null)?.id === applicationId);
  const outcome = await runSurfaceMessage(context, {
    ingress: {
      surface: 'discord',
      userId,
      channelId,
      groupId: channelId,
      workspaceId: guildId,
      conversationKind: channelId ? 'channel' : 'service',
      text: content,
      mentioned,
      metadata: {
        gatewayEvent: dispatch.t,
        messageId,
      },
    },
    binding: {
      kind: 'channel',
      surfaceKind: 'discord',
      surfaceId: guildId ?? 'discord',
      externalId: channelId ?? messageId ?? 'discord',
      channelId,
      title: 'Discord message',
      metadata: {
        userId,
        messageId,
        gatewayEvent: dispatch.t,
      },
    },
    text: content,
    logLabel: 'handleDiscordGatewayDispatchPayload',
    // The gateway has no answer channel; a command's answer is posted to the conversation.
    control: 'notice',
    ...(messageId ? { providerMessageId: messageId } : {}),
    threadId: channelId,
    userId,
    displayName: typeof author.username === 'string' ? author.username : userId,
    title: 'Discord message',
    metadata: {
      messageId,
      gatewayEvent: dispatch.t,
    },
  });
  if (outcome.kind === 'no-text') return new Response(null, { status: 204 });
  return surfaceOutcomeResponse(outcome, 'caller');
}
