import { randomUUID } from 'node:crypto';
import type { SurfaceAdapterContext } from '../types.js';
import { answerSurfaceControl } from '../surface-message.js';
import type { UpsertRouteBindingInput } from '../../channels/route-manager.js';
import { constantTimeEquals, declaredMention, parseJsonRecord, readString, readTextBodyWithinLimit, ingressAnswerResponse } from '../helpers.js';
import {
  HOME_ASSISTANT_SURFACE,
  resolveHomeAssistantWebhookSecret,
} from '../../channels/builtin/homeassistant.js';
import type { ChannelConversationKind } from '../../channels/index.js';

export async function handleHomeAssistantSurfaceWebhook(
  req: Request,
  context: SurfaceAdapterContext,
): Promise<Response> {
  const enabled = Boolean(context.configManager.get('surfaces.homeassistant.enabled'));
  const secret = await resolveHomeAssistantWebhookSecret(context);
  // Closed until both are set: without a secret anyone who can reach the daemon could post as Home Assistant.
  if (!enabled || !secret) {
    return Response.json({
      error: !enabled
        ? 'Home Assistant ingress is off. Set surfaces.homeassistant.enabled to true to accept its messages.'
        : 'Home Assistant ingress has no webhook secret, so it accepts nothing. Set surfaces.homeassistant.webhookSecret and send it in the x-goodvibes-homeassistant-secret header.',
    }, { status: 503 });
  }

  // The secret travels in a header, so an unauthenticated caller is refused
  // before its body is read.
  if (!isAuthorizedHomeAssistantRequest(req, secret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;

  const contentType = req.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json') || rawBody.trim().startsWith('{')
    ? parseJsonRecord(rawBody)
    : { message: rawBody.trim() };
  if (body instanceof Response) return body;

  const text = readString(body.prompt)
    ?? readString(body.message)
    ?? readString(body.text)
    ?? readString(body.task)
    ?? '';

  const conversationId = readString(body.conversationId ?? body.conversation_id)
    ?? readString(body.threadId ?? body.thread_id)
    ?? readString(body.deviceId ?? body.device_id)
    ?? String(context.configManager.get('surfaces.homeassistant.defaultConversationId') || 'goodvibes');
  const surfaceId = readString(body.surfaceId ?? body.instanceId ?? body.instance_id)
    ?? readString(body.hassInstanceId ?? body.hass_instance_id)
    ?? 'homeassistant';
  const threadId = readString(body.threadId ?? body.thread_id);
  const channelId = readString(body.areaId ?? body.area_id)
    ?? readString(body.entityId ?? body.entity_id)
    ?? conversationId;
  const messageId = readString(body.messageId ?? body.message_id) ?? `ha-${randomUUID()}`;
  const mode = readString(body.mode ?? body.type)?.toLowerCase() ?? 'prompt';
  const conversationKind = conversationKindForHomeAssistant(mode, threadId, channelId);

  const policy = await context.authorizeSurfaceIngress({
    surface: HOME_ASSISTANT_SURFACE,
    userId: readString(body.userId ?? body.user_id),
    channelId,
    groupId: readString(body.areaId ?? body.area_id) ?? channelId,
    threadId,
    workspaceId: readString(body.instanceId ?? body.instance_id),
    conversationKind,
    hasAnyMention: typeof body.hasAnyMention === 'boolean' ? body.hasAnyMention : true,
    text,
    // Every Home Assistant request is addressed to the assistant by construction.
    mentioned: declaredMention(body, true),
    metadata: body,
  });
  if (!policy.allowed) return ingressAnswerResponse(policy);

  // The conversation this request belongs to; the remote chat binds the same one.
  const conversationBinding = (): UpsertRouteBindingInput => ({
    kind: threadId ? 'thread' : 'channel',
    surfaceKind: HOME_ASSISTANT_SURFACE,
    surfaceId,
    externalId: conversationId,
    threadId,
    channelId,
    title: readString(body.title) ?? 'Home Assistant',
    metadata: {
      directoryKind: conversationKind === 'direct' ? 'user' : conversationKind,
      source: 'homeassistant',
      messageId,
      conversationId,
    },
  });

  // A command acts only on what this Home Assistant conversation started.
  const control = await answerSurfaceControl(context, {
    surface: HOME_ASSISTANT_SURFACE,
    text,
    binding: async () => {
      await context.routeBindings.start();
      return context.routeBindings.upsertBinding(conversationBinding());
    },
    userId: readString(body.userId ?? body.user_id),
    channelId,
    answer: 'response',
    signal: req.signal,
  });
  if (control) return Response.json({ acknowledged: true, control: true, message: control.message, bindingId: control.bindingId });

  if (!text.trim()) {
    await context.routeBindings.start();
    const binding = await context.routeBindings.upsertBinding(conversationBinding());
    await context.routeBindings.patchBinding(binding.id, {
      sessionId: null,
      jobId: null,
      runId: null,
    });
    return Response.json({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'no-actionable-text',
      bindingId: binding.id,
    });
  }

  const routing = readRouting(body);
  if (routing?.tools?.length) {
    // The list is not applied to the chat session (every daemon tool stays
    // available to the model), so accepting it would claim a restriction that
    // does not exist.
    return Response.json({
      error: 'The tools list is not supported on the Home Assistant webhook: the conversation keeps every daemon tool and the list would not restrict it. Remove the tools field.',
      field: 'tools',
    }, { status: 400 });
  }
  if (!context.postHomeAssistantChatMessage) {
    return Response.json({ error: 'Home Assistant remote chat is unavailable in this runtime' }, { status: 503 });
  }
  const result = await context.postHomeAssistantChatMessage({
    body: text,
    messageId,
    conversationId,
    surfaceId,
    channelId,
    ...(threadId ? { threadId } : {}),
    ...(readString(body.userId ?? body.user_id) ? { userId: readString(body.userId ?? body.user_id)! } : {}),
    ...(readString(body.displayName ?? body.userName ?? body.user_name) ? { displayName: readString(body.displayName ?? body.userName ?? body.user_name)! } : {}),
    title: readString(body.title) ?? 'Home Assistant',
    ...(routing?.providerId ? { providerId: routing.providerId } : {}),
    ...(routing?.modelId ? { modelId: routing.modelId } : {}),
    context: {
      ...body,
      source: 'homeassistant',
      messageId,
      conversationId,
      deviceId: readString(body.deviceId ?? body.device_id) ?? null,
      entityId: readString(body.entityId ?? body.entity_id) ?? null,
    },
    publishEvent: true,
  });

  return Response.json({
    acknowledged: true,
    queued: false,
    delivered: result.delivered,
    ...(result.routeId ? { bindingId: result.routeId } : {}),
    sessionId: result.sessionId,
    messageId,
    ...(result.assistantMessageId ? { assistantMessageId: result.assistantMessageId } : {}),
    ...(result.error ? { error: result.error } : {}),
    conversationId,
  });
}

function isAuthorizedHomeAssistantRequest(req: Request, secret: string): boolean {
  const candidates = [
    req.headers.get('x-goodvibes-homeassistant-secret'),
    req.headers.get('x-goodvibes-webhook-secret'),
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, ''),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return candidates.some((candidate) => constantTimeEquals(candidate, secret));
}

function conversationKindForHomeAssistant(
  mode: string,
  threadId: string | undefined,
  channelId: string | undefined,
): ChannelConversationKind {
  if (threadId) return 'thread';
  if (mode === 'conversation' || mode === 'chat' || mode === 'prompt') return 'direct';
  return channelId ? 'channel' : 'service';
}

function readRouting(body: Record<string, unknown>): {
  providerId?: string | undefined;
  modelId?: string | undefined;
  tools?: readonly string[] | undefined;
} | undefined {
  const providerId = readString(body.providerId ?? body.provider);
  const modelId = readString(body.modelId ?? body.model);
  const tools = readStringList(body.tools);
  if (!providerId && !modelId && !tools.length) return undefined;
  return {
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(tools.length ? { tools } : {}),
  };
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
    : [];
}
