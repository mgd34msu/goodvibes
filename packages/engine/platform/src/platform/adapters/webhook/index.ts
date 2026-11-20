import type { GenericWebhookAdapterContext } from '../types.js';
import { validatePublicWebhookUrl } from '../../utils/url-safety.js';
import { constantTimeEquals, readTextBodyWithinLimit, ingressAnswerResponse } from '../helpers.js';
import { resolveSurfaceCredential, surfaceCredentialUnavailable } from '../surface-credential.js';
import { submitSurfaceMessage, surfaceOutcomeResponse } from '../surface-message.js';

function parseJsonRecord(rawBody: string): Record<string, unknown> | Response {
  try {
    return JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}

/** Binding fields a caller may describe itself with; anything else it sends is not copied onto the shared binding. */
const BINDING_PROFILE_FIELDS = ['userId', 'displayName', 'workspaceId', 'groupId', 'conversationKind'] as const;

/** Keys under `goodvibes.` are the platform's own markers (such as work authorization); a caller never supplies them. */
function withoutReservedMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !key.startsWith('goodvibes.')));
}

export async function handleGenericWebhookSurface(req: Request, context: GenericWebhookAdapterContext): Promise<Response> {
  const credential = await resolveSurfaceCredential(context, { kind: 'config', key: 'surfaces.webhook.secret' });
  if (credential.state === 'unresolvable') return surfaceCredentialUnavailable('webhook', credential);
  const configuredSecret = credential.state === 'resolved' ? credential.value : '';
  const enabled = Boolean(context.configManager.get('surfaces.webhook.enabled'));
  if (!enabled || !configuredSecret) {
    return Response.json({ error: 'Webhook ingress is not configured' }, { status: 503 });
  }
  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;
  const providedSignature = req.headers.get('x-goodvibes-signature') ?? '';
  const providedSecret = req.headers.get('x-goodvibes-webhook-secret')
    ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    ?? '';
  const secretValid = constantTimeEquals(configuredSecret, providedSecret);
  // The native producer emits exactly sha256= plus 64 lowercase hex digits.
  // A valid bearer needs no HMAC; an impossible signature cannot authenticate.
  const signatureValid = !secretValid && providedSignature.length === 71 && /^sha256=[0-9a-f]{64}$/.test(providedSignature)
    && constantTimeEquals(context.signWebhookPayload(rawBody, configuredSecret), providedSignature);
  if (!secretValid && !signatureValid) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  if ((req.headers.get('content-type') ?? '').includes('application/json')) {
    const parsed = parseJsonRecord(rawBody);
    if (parsed instanceof Response) return parsed;
    body = parsed;
  } else if (rawBody.trim().length > 0) {
    body = { message: rawBody.trim() };
  }

  const url = new URL(req.url);
  const surfaceId = typeof body.surfaceId === 'string' && body.surfaceId.trim().length > 0
    ? body.surfaceId.trim()
    : 'webhook';
  const threadId = typeof body.threadId === 'string' ? body.threadId : undefined;
  const channelId = typeof body.channelId === 'string' ? body.channelId : undefined;
  const externalId = typeof body.externalId === 'string' && body.externalId.trim().length > 0
    ? body.externalId.trim()
    : url.searchParams.get('externalId')
      ?? threadId
      ?? channelId
      ?? surfaceId;
  if (body.callbackUrl !== undefined && typeof body.callbackUrl !== 'string') {
    return Response.json({ error: 'callbackUrl must be a string URL' }, { status: 400 });
  }
  let callbackUrl = typeof body.callbackUrl === 'string' ? body.callbackUrl : undefined;
  if (callbackUrl) {
    const validation = validatePublicWebhookUrl(callbackUrl);
    if (!validation.ok) {
      return Response.json({ error: validation.error }, { status: 400 });
    }
    callbackUrl = validation.url;
  }
  const correlationId = typeof body.correlationId === 'string'
    ? body.correlationId
    : req.headers.get('x-goodvibes-correlation-id') ?? undefined;
  const task = typeof body.task === 'string'
    ? body.task.trim()
    : typeof body.message === 'string'
      ? body.message.trim()
      : typeof body.text === 'string'
        ? body.text.trim()
        : '';
  const policy = await context.authorizeSurfaceIngress({
    surface: 'webhook',
    userId: typeof body.userId === 'string' ? body.userId : undefined,
    channelId,
    groupId: typeof body.groupId === 'string' ? body.groupId : channelId,
    threadId,
    workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : undefined,
    conversationKind: typeof body.conversationKind === 'string'
      ? body.conversationKind as import('../../channels/index.js').ChannelConversationKind
      : threadId
        ? 'thread'
        : channelId
          ? 'channel'
          : 'service',
    hasAnyMention: typeof body.hasAnyMention === 'boolean' ? body.hasAnyMention : undefined,
    text: task,
    mentioned: typeof body.mentioned === 'boolean' ? body.mentioned : true,
    controlCommand: typeof body.controlCommand === 'string' ? body.controlCommand : undefined,
    metadata: body,
  });
  if (!policy.allowed) return ingressAnswerResponse(policy, 'caller');
  // A caller may continue a conversation that came through this webhook, not step into one from another surface.
  const requestedSessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
  if (requestedSessionId) {
    const existing = context.sessionBroker.getSession(requestedSessionId);
    if (existing && !existing.surfaceKinds.includes('webhook')) {
      return Response.json({ error: 'sessionId belongs to a conversation that did not come through this webhook. Omit sessionId to start a new conversation.' }, { status: 403 });
    }
  }

  const binding = await context.routeBindings.upsertBinding({
    kind: threadId ? 'thread' : channelId ? 'channel' : 'message',
    surfaceKind: 'webhook',
    surfaceId,
    externalId,
    threadId,
    channelId,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    title: typeof body.title === 'string' ? body.title : externalId,
    metadata: {
      ...Object.fromEntries(BINDING_PROFILE_FIELDS.filter((field) => typeof body[field] === 'string').map((field) => [field, body[field]])),
      // The binding is shared by every call on this route, and its metadata is merged over what an earlier call left.
      // Written explicitly (undefined when this call has none) so a callback never outlives the request that supplied it.
      callbackUrl,
      correlationId,
      callbackSignature: typeof body.callbackSignature === 'string' ? body.callbackSignature : undefined,
    },
  });

  if (!task) {
    return Response.json({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'no-actionable-text',
      bindingId: binding.id,
    });
  }

  const callbackSignature = typeof body.callbackSignature === 'string'
    ? body.callbackSignature as 'shared-secret' | 'hmac-sha256'
    : undefined;
  const callbackFields = { callbackUrl: callbackUrl ?? null, correlationId: correlationId ?? null };
  let callbackDelivery: Record<string, unknown> = { status: 'skipped', reason: callbackUrl ? 'webhook-delivery-disabled' : 'no-callback-url' };
  const outcome = await submitSurfaceMessage(context, binding, {
    surface: 'webhook',
    text: task,
    logLabel: 'handleGenericWebhookSurface',
    // The caller reads the answer to its own request.
    control: 'response',
    sessionId: requestedSessionId,
    externalId,
    threadId,
    userId: typeof body.userId === 'string' ? body.userId : undefined,
    displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
    channelId,
    title: typeof body.title === 'string' ? body.title : externalId,
    metadata: { ...withoutReservedMetadata(body.metadata), ...(correlationId ? { correlationId } : {}) },
    // The caller's id for this message: a retry with the same correlationId (a lost answer, a
    // timeout) finds the message already accepted and starts nothing a second time.
    ...(correlationId ? { providerMessageId: correlationId } : {}),
    signal: req.signal,
    queueReply: ({ agentId, sessionId }) => {
      if (!callbackUrl || !context.surfaceDeliveryEnabled('webhook')) return;
      context.queueWebhookReply({
        agentId,
        task,
        sessionId,
        routeId: binding.id,
        callbackUrl,
        callbackCorrelationId: correlationId,
        callbackSignature,
      });
      callbackDelivery = { status: 'queued' };
    },
  });
  switch (outcome.kind) {
    case 'continued':
      return surfaceOutcomeResponse(outcome, 'caller', { queued: true, ...callbackFields });
    case 'started':
      return surfaceOutcomeResponse(outcome, 'caller', { ...callbackFields, callbackDelivery });
    default:
      return surfaceOutcomeResponse(outcome, 'caller');
  }
}
