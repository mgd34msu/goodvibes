import { randomUUID } from 'node:crypto';
import { constantTimeEquals, declaredMention, ingressMetadata, parseJsonRecord, readBearerOrHeaderToken, readTextBodyWithinLimit, ingressAnswerResponse } from '../helpers.js';
import { resolveSurfaceCredential, surfaceCredentialUnavailable } from '../surface-credential.js';
import type { SurfaceAdapterContext } from '../types.js';
import { inboundDedupKey, ntfyInboundDedup } from '../inbound-dedup.js';
import { answerSurfaceControl, submitSurfaceMessage, surfaceOutcomeResponse } from '../surface-message.js';
import type { UpsertRouteBindingInput } from '../../channels/route-manager.js';
import {
  isGoodVibesNtfyDeliveryEcho,
  resolveGoodVibesNtfyTopics,
} from '../../integrations/ntfy.js';

const inFlight = new Set<string>();

export async function handleNtfySurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const enabled = Boolean(context.configManager.get('surfaces.ntfy.enabled'));
  const credential = await resolveSurfaceCredential(
    context,
    { kind: 'config', key: 'surfaces.ntfy.token' },
    { kind: 'registry', service: 'ntfy', field: 'primary' },
    { kind: 'env', name: 'NTFY_ACCESS_TOKEN' },
  );
  if (credential.state === 'unresolvable') return surfaceCredentialUnavailable('ntfy', credential);
  const configuredToken = credential.state === 'resolved' ? credential.value : '';
  if (!enabled || !configuredToken) {
    return Response.json({ error: 'ntfy webhook ingress is not configured' }, { status: 503 });
  }
  const providedToken = req.headers.get('x-ntfy-token')
    ?? readBearerOrHeaderToken(req, 'x-goodvibes-ntfy-token');
  if (!constantTimeEquals(configuredToken, providedToken)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;
  let body: Record<string, unknown> = {};
  if ((req.headers.get('content-type') ?? '').includes('application/json')) {
    const parsed = parseJsonRecord(rawBody);
    if (parsed instanceof Response) return parsed;
    body = parsed;
  } else if (rawBody.trim().length > 0) {
    body = { message: rawBody.trim() };
  }

  return handleNtfySurfacePayload(body, context, new URL(req.url));
}

export async function handleNtfySurfacePayload(
  body: Record<string, unknown>,
  context: SurfaceAdapterContext,
  url?: URL,
): Promise<Response> {
  if (isGoodVibesNtfyDeliveryEcho(body)) {
    return Response.json({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'goodvibes-self-echo',
      ignored: 'goodvibes-self-echo',
    });
  }
  const topic = typeof body.topic === 'string'
    ? body.topic
    : url?.searchParams.get('topic') ?? '';
  const message = typeof body.message === 'string'
    ? body.message
    : typeof body.text === 'string'
      ? body.text
      : '';
  if (!topic) {
    return Response.json({ error: 'Missing ntfy topic' }, { status: 400 });
  }
  // One ntfy message can arrive twice: once on the long-lived JSON
  // subscription and once on the HTTP webhook route (and again after a
  // subscription reconnect resumes from an inclusive `since`). Both land here,
  // so this is the single place that can tell the copies apart. Without it the
  // pipeline ran twice and two agents worked the same message.
  const messageId = typeof body.id === 'string' ? body.id : undefined;
  const dedupKey = inboundDedupKey('ntfy', topic, messageId);
  if (dedupKey && (inFlight.has(dedupKey) || !ntfyInboundDedup.claim(dedupKey))) {
    return Response.json({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'duplicate-delivery',
      ignored: 'duplicate-delivery',
      topic,
    });
  }

  if (dedupKey) inFlight.add(dedupKey);
  let delivered = false;
  const committed = () => { delivered = true; };
  try {
    const topics = resolveConfiguredNtfyTopics(context);
    const response = topic === topics.chatTopic
      ? await handleNtfyChatPayload(body, context, topic, message, committed)
      : topic === topics.remoteTopic
        ? await handleNtfyRemoteChatPayload(body, context, topic, message)
        : topic === topics.agentTopic
          ? await handleNtfyAgentPayload(body, context, topic, message, committed)
          : Response.json({ acknowledged: true, queued: false, outcome: 'ignored', reason: 'unknown-ntfy-topic', ignored: 'unknown-ntfy-topic', topic });
    if (response.ok) delivered = true;
    return response;
  } finally {
    if (!delivered) ntfyInboundDedup.release(dedupKey);
    if (dedupKey) inFlight.delete(dedupKey);
  }
}

function resolveConfiguredNtfyTopics(context: SurfaceAdapterContext) {
  // A shipped topic name on the public server is not routed: anyone can post to it.
  return resolveGoodVibesNtfyTopics({
    chatTopic: readConfigString(context, 'surfaces.ntfy.chatTopic'),
    agentTopic: readConfigString(context, 'surfaces.ntfy.agentTopic'),
    remoteTopic: readConfigString(context, 'surfaces.ntfy.remoteTopic'),
    baseUrl: readConfigString(context, 'surfaces.ntfy.baseUrl'),
  });
}

function readConfigString(context: SurfaceAdapterContext, key: string): string {
  const value = context.configManager.get(key);
  return typeof value === 'string' ? value : '';
}

async function authorizeNtfyPayload(
  body: Record<string, unknown>,
  context: SurfaceAdapterContext,
  topic: string,
  message: string,
): Promise<Response | null> {
  const policy = await context.authorizeSurfaceIngress({
    surface: 'ntfy',
    channelId: topic,
    groupId: topic,
    conversationKind: 'channel',
    text: message,
    // A message published to the bot's topic is addressed to it by construction.
    mentioned: declaredMention(body, true),
    metadata: body,
  });
  if (!policy.allowed) return ingressAnswerResponse(policy, 'caller');
  return null;
}

/** The route binding of an ntfy topic: the conversation a control command from it acts for. */
function ntfyTopicBinding(body: Record<string, unknown>, topic: string): UpsertRouteBindingInput {
  return {
    kind: 'channel',
    surfaceKind: 'ntfy',
    surfaceId: 'ntfy',
    externalId: topic,
    channelId: topic,
    title: typeof body.title === 'string' ? body.title : topic,
    metadata: {},
  };
}

/**
 * `status`, `cancel` or `retry <id>` sent to a chat topic. The topic's binding
 * is written only when the text is a command, so ordinary chat costs no write.
 */
async function answerNtfyControl(
  body: Record<string, unknown>,
  context: SurfaceAdapterContext,
  topic: string,
  message: string,
): Promise<Response | null> {
  const control = await answerSurfaceControl(context, {
    surface: 'ntfy',
    text: message,
    binding: () => context.routeBindings.upsertBinding(ntfyTopicBinding(body, topic)),
    channelId: topic,
    answer: 'notice',
  });
  return control ? surfaceOutcomeResponse({ kind: 'control', ...control }, 'caller', { topic }) : null;
}

async function handleNtfyChatPayload(
  body: Record<string, unknown>,
  context: SurfaceAdapterContext,
  topic: string,
  message: string,
  committed: () => void,
): Promise<Response> {
  const denied = await authorizeNtfyPayload(body, context, topic, message);
  if (denied) return denied;
  if (!message) {
    return Response.json({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'no-actionable-text',
      topic,
    });
  }
  const control = await answerNtfyControl(body, context, topic, message);
  if (control) return control;
  if (!context.publishConversationFollowup) {
    return Response.json({ error: 'ntfy chat routing is unavailable in this runtime' }, { status: 503 });
  }
  const session = await findPreferredTuiSession(context);
  if (!session) {
    return Response.json({ error: 'No active terminal TUI session is available for ntfy chat' }, { status: 409 });
  }
  const messageId = randomUUID();
  const timestamp = Date.now();
  await context.sessionBroker.appendCompanionMessage(session.id, {
    messageId,
    body: message,
    source: 'ntfy-chat',
    timestamp,
  });
  committed();
  context.queueNtfyChatReply?.({
    sessionId: session.id,
    topic,
    body: message,
    title: typeof body.title === 'string' ? body.title : 'GoodVibes chat',
    messageId,
  });
  context.publishConversationFollowup(session.id, {
    messageId,
    body: message,
    source: 'ntfy-chat',
    timestamp,
    metadata: { surface: 'ntfy', topic, ntfyMessageId: messageId },
  });
  return Response.json({
    acknowledged: true,
    queued: false,
    routedTo: 'tui-chat',
    sessionId: session.id,
    messageId,
    topic,
  }, { status: 202 });
}

async function handleNtfyRemoteChatPayload(
  body: Record<string, unknown>,
  context: SurfaceAdapterContext,
  topic: string,
  message: string,
): Promise<Response> {
  const denied = await authorizeNtfyPayload(body, context, topic, message);
  if (denied) return denied;
  if (!message) {
    return Response.json({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'no-actionable-text',
      topic,
    });
  }
  const control = await answerNtfyControl(body, context, topic, message);
  if (control) return control;
  if (!context.postNtfyRemoteChatMessage) {
    return Response.json({ error: 'ntfy remote chat is unavailable in this runtime' }, { status: 503 });
  }
  const result = await context.postNtfyRemoteChatMessage({
    topic,
    body: message,
    title: typeof body.title === 'string' ? body.title : 'GoodVibes ntfy',
    ...(typeof body.id === 'string' && body.id ? { messageId: body.id } : {}),
  });
  return Response.json({
    acknowledged: true,
    queued: false,
    routedTo: 'ntfy-remote-chat',
    ...result,
    topic,
  }, { status: result.error ? 502 : 202 });
}

async function handleNtfyAgentPayload(
  body: Record<string, unknown>,
  context: SurfaceAdapterContext,
  topic: string,
  message: string,
  committed: () => void,
): Promise<Response> {
  const denied = await authorizeNtfyPayload(body, context, topic, message);
  if (denied) return denied;
  const preferredTuiSession = await findPreferredTuiSession(context);

  const binding = await context.routeBindings.upsertBinding(ntfyTopicBinding(body, topic));

  if (!message) {
    return Response.json({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'no-actionable-text',
      bindingId: binding.id,
      topic,
    });
  }

  const outcome = await submitSurfaceMessage(context, binding, {
    surface: 'ntfy',
    text: message,
    logLabel: 'handleNtfySurfaceWebhook',
    control: 'notice',
    ...(preferredTuiSession ? { sessionId: preferredTuiSession.id } : {}),
    ...(typeof body.id === 'string' && body.id ? { providerMessageId: body.id } : {}),
    externalId: topic,
    threadId: topic,
    channelId: topic,
    title: typeof body.title === 'string' ? body.title : topic,
    metadata: ingressMetadata(body),
    trackContract: true,
    committed,
  });
  return surfaceOutcomeResponse(outcome, 'caller', { topic });
}

async function findPreferredTuiSession(context: SurfaceAdapterContext) {
  const direct = await context.sessionBroker.findPreferredSession({ surfaceKind: 'tui' });
  if (direct) return direct;
  return context.sessionBroker
    .listSessions(500)
    .find((candidate) => candidate.status !== 'closed' && candidate.metadata?.source === 'tui')
    ?? null;
}
