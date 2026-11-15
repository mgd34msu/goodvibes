import { constantTimeEquals, noticeUnsupportedAttachment, parseJsonRecord, readBearerOrHeaderToken, readTextBodyWithinLimit, verifySha256HmacSignature } from '../helpers.js';
import { resolveSurfaceCredential, surfaceCredentialUnavailable } from '../surface-credential.js';
import { isOrdinaryIngressRefusal, type SurfaceAdapterContext } from '../types.js';
import { logger } from '../../utils/logger.js';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Messages already handled, by phone number and message id. Meta redelivers a whole payload
 * when any message in it was answered with a failure, so a message that was handled must
 * not be handled again. Bounded: it only has to cover Meta's redelivery window.
 */
const HANDLED_MESSAGE_LIMIT = 4_096;
/** Per daemon (its route binding manager), so one running daemon's history is not another's. */
const handledMessagesByOwner = new WeakMap<object, Set<string>>();
function handledMessagesOf(context: SurfaceAdapterContext): Set<string> {
  let handled = handledMessagesByOwner.get(context.routeBindings);
  if (!handled) { handled = new Set(); handledMessagesByOwner.set(context.routeBindings, handled); }
  return handled;
}
function rememberHandled(handled: Set<string>, key: string): void {
  handled.add(key);
  if (handled.size > HANDLED_MESSAGE_LIMIT) handled.delete(handled.values().next().value!);
}

const MEDIA_FIELDS = ['image', 'document', 'video', 'audio', 'voice', 'sticker'] as const;

/** The text of a message: its body, or the caption Meta nests under the media object. */
function readMessageText(message: Record<string, unknown>): string {
  const body = readString(readRecord(message.text)?.body) ?? readString(message.caption);
  if (body) return body;
  for (const field of MEDIA_FIELDS) {
    const caption = readString(readRecord(message[field])?.caption);
    if (caption) return caption;
  }
  return '';
}

function readMediaKind(message: Record<string, unknown>): string | undefined {
  return MEDIA_FIELDS.find(field => readRecord(message[field]) !== null);
}

export async function handleWhatsAppSurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const provider = String(context.configManager.get('surfaces.whatsapp.provider') ?? 'meta-cloud').trim() || 'meta-cloud';
  const verifyCredential = await resolveSurfaceCredential(
    context,
    { kind: 'config', key: 'surfaces.whatsapp.verifyToken' },
    { kind: 'env', name: 'WHATSAPP_VERIFY_TOKEN' },
  );
  if (verifyCredential.state === 'unresolvable') return surfaceCredentialUnavailable('whatsapp', verifyCredential);
  const verifyToken = verifyCredential.state === 'resolved' ? verifyCredential.value : '';
  const signingCredential = await resolveSurfaceCredential(
    context,
    { kind: 'config', key: 'surfaces.whatsapp.signingSecret' },
    { kind: 'registry', service: 'whatsapp', field: 'signingSecret' },
    { kind: 'env', name: 'WHATSAPP_SIGNING_SECRET' },
    { kind: 'env', name: 'WHATSAPP_BRIDGE_TOKEN' },
  );
  if (signingCredential.state === 'unresolvable') return surfaceCredentialUnavailable('whatsapp', signingCredential);
  const signingSecret = signingCredential.state === 'resolved' ? signingCredential.value : '';
  const url = new URL(req.url);
  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode') ?? '';
    const token = url.searchParams.get('hub.verify_token') ?? '';
    const challenge = url.searchParams.get('hub.challenge') ?? '';
    if (mode === 'subscribe' && verifyToken && constantTimeEquals(verifyToken, token)) {
      return new Response(challenge, { status: 200 });
    }
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;
  if (!signingSecret) {
    return Response.json({ error: 'Webhook not configured' }, { status: 503 });
  }
  if (provider === 'meta-cloud') {
    const signature = req.headers.get('x-hub-signature-256') ?? '';
    if (!verifySha256HmacSignature(rawBody, signingSecret, signature)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  } else {
    const providedToken = readBearerOrHeaderToken(req, 'x-goodvibes-whatsapp-token');
    if (!constantTimeEquals(signingSecret, providedToken)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const parsed = parseJsonRecord(rawBody);
  if (parsed instanceof Response) return parsed;
  const payload = readRecord(parsed);
  if (!payload) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  const messages: { value: Record<string, unknown>; message: Record<string, unknown> }[] = [];
  for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
    const changes = readRecord(entry)?.changes;
    for (const change of Array.isArray(changes) ? changes : []) {
      const value = readRecord(readRecord(change)?.value);
      for (const raw of Array.isArray(value?.messages) ? value.messages : []) {
        const message = readRecord(raw);
        if (value && message) messages.push({ value, message });
      }
    }
  }
  if (!messages.length) {
    logger.info('handleWhatsAppSurfaceWebhook: payload ignored', {
      reason: 'no-message-event',
      provider,
    });
    return Response.json({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'no-message-event',
    });
  }
  const responses: Response[] = [];
  for (const { value, message } of messages) {
    // One message failing must not stop the others, and must not be reported as if the payload failed
    // outright: the ones already handled are remembered, so Meta's redelivery only repeats the failed one.
    responses.push(await handleWhatsAppMessage(value, message, context).catch((error: unknown) => {
      logger.warn('handleWhatsAppSurfaceWebhook: message handling failed', { messageId: readString(message.id), error: error instanceof Error ? error.message : String(error) });
      return Response.json({ error: 'Message handling failed' }, { status: 500 });
    }));
  }
  if (responses.length === 1) return responses[0]!;
  const failed = responses.find(response => !response.ok);
  const results = await Promise.all(responses.map(response => response.json()));
  return Response.json({ acknowledged: !failed, results }, { status: failed?.status ?? 200 });
}

async function handleWhatsAppMessage(value: Record<string, unknown>, message: Record<string, unknown>, context: SurfaceAdapterContext): Promise<Response> {
  const messageId = readString(message.id);
  const phoneNumberId = readString(value?.metadata && readRecord(value.metadata)?.phone_number_id);
  const handledKey = messageId ? `${phoneNumberId ?? ''}:${messageId}` : undefined;
  const handled = handledMessagesOf(context);
  if (handledKey && handled.has(handledKey)) {
    return Response.json({ acknowledged: true, queued: false, outcome: 'ignored', reason: 'duplicate-delivery', messageId });
  }
  const response = await processWhatsAppMessage(value, message, context);
  // Only a message that was answered successfully is remembered; a refused or failed one is tried again on redelivery.
  if (handledKey && response.ok) rememberHandled(handled, handledKey);
  return response;
}

async function processWhatsAppMessage(value: Record<string, unknown>, message: Record<string, unknown>, context: SurfaceAdapterContext): Promise<Response> {
  const contact = Array.isArray(value.contacts) ? value.contacts.map(readRecord).find(contact => contact?.wa_id === message.from) ?? readRecord(value.contacts[0]) : null;
  const from = readString(message.from);
  const text = readMessageText(message);
  if (!from) return Response.json({ error: 'Missing sender' }, { status: 400 });

  const policy = await context.authorizeSurfaceIngress({
    surface: 'whatsapp',
    userId: from,
    channelId: from,
    groupId: from,
    conversationKind: 'direct',
    text,
    mentioned: true,
    metadata: {
      messageId: readString(message.id),
      profileName: readString(contact?.profile && readRecord(contact.profile)?.name),
      phoneNumberId: readString(value?.metadata && readRecord(value.metadata)?.phone_number_id),
    },
  });
  if (!policy.allowed) {
    // Meta redelivers a payload it was answered with a failure status, and a refusal will not change on
    // redelivery. Acknowledge it so a blocked sender cannot cause the allowed messages beside it to repeat.
    if (isOrdinaryIngressRefusal(policy.reason)) {
      logger.info('handleWhatsAppSurfaceWebhook: message ignored by channel policy', { reason: policy.reason, messageId: readString(message.id) });
      return Response.json({ acknowledged: true, queued: false, outcome: 'ignored', reason: 'blocked-by-channel-policy', policyReason: policy.reason });
    }
    return Response.json({ error: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
  }

  const binding = await context.routeBindings.upsertBinding({
    kind: 'channel',
    surfaceKind: 'whatsapp',
    surfaceId: readString(value?.metadata && readRecord(value.metadata)?.phone_number_id)
      ?? readString(context.configManager.get('surfaces.whatsapp.phoneNumberId'))
      ?? 'whatsapp',
    externalId: from,
    channelId: from,
    title: readString(contact?.profile && readRecord(contact.profile)?.name) ?? from,
    metadata: {
      messageId: readString(message.id),
      from,
    },
  });
  if (!text) {
    const media = readMediaKind(message);
    // Every WhatsApp conversation this webhook sees is one-to-one.
    const notified = media ? await noticeUnsupportedAttachment(context, binding, media, true) : false;
    logger.info('handleWhatsAppSurfaceWebhook: message acknowledged without queueing', {
      reason: media ? 'unsupported-attachment' : 'no-actionable-text',
      ...(media ? { attachment: media } : {}),
      bindingId: binding.id,
      messageId: readString(message.id),
    });
    return Response.json({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: media ? 'unsupported-attachment' : 'no-actionable-text',
      ...(media ? { attachment: media, notified } : {}),
      bindingId: binding.id,
    });
  }

  const submission = await context.sessionBroker.submitMessage({
    routeId: binding.id,
    ...(readString(message.id) ? { providerMessageId: readString(message.id) } : {}),
    surfaceKind: 'whatsapp',
    surfaceId: binding.surfaceId,
    externalId: binding.externalId,
    threadId: binding.channelId,
    userId: from,
    displayName: binding.title,
    title: binding.title ?? from,
    body: text,
    metadata: {
      messageId: readString(message.id),
    },
  });
  if (submission.mode === 'continued-live' || submission.mode === 'queued-follow-up') {
    return Response.json({ acknowledged: true, continued: true, sessionId: submission.session.id, agentId: submission.activeAgentId ?? null });
  }

  const spawnResult = await context.trySpawnAgent(
    { mode: 'spawn', task: submission.task! },
    'handleWhatsAppSurfaceWebhook',
    submission.session.id,
  );
  if (spawnResult instanceof Response) return spawnResult;
  await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id, submission.input.id);
  context.queueSurfaceReplyFromBinding(submission.routeBinding ?? binding, {
    agentId: spawnResult.id,
    task: text,
    sessionId: submission.session.id,
  });
  return Response.json({ acknowledged: true, queued: true, bindingId: binding.id, sessionId: submission.session.id, agentId: spawnResult.id });
}
