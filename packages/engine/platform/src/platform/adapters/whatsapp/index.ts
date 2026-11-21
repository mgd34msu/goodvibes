import { constantTimeEquals, noticeUnsupportedAttachment, parseJsonRecord, readBearerOrHeaderToken, readTextBodyWithinLimit, verifySha256HmacSignature, surfaceCredentialAbsent } from '../helpers.js';
import { resolveInboundCredential, resolveSurfaceCredential, surfaceCredentialUnavailable } from '../surface-credential.js';
import type { SurfaceAdapterContext } from '../types.js';
import { logger } from '../../utils/logger.js';
import { runSurfaceMessage, surfaceOutcomeResponse } from '../surface-message.js';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
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
  const signingCredential = await resolveInboundCredential(context, 'whatsapp');
  if (signingCredential.state === 'unresolvable') return surfaceCredentialUnavailable('whatsapp', signingCredential);
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
  if (signingCredential.state === 'absent') return surfaceCredentialAbsent('whatsapp', signingCredential.setting);
  const signingSecret = signingCredential.value;
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
    // outright. Meta redelivers the whole payload then; the shared per-message claim (runSurfaceMessage)
    // answers the ones already handled as duplicates, so only the failed one runs again.
    responses.push(await processWhatsAppMessage(value, message, context).catch((error: unknown) => {
      logger.warn('handleWhatsAppSurfaceWebhook: message handling failed', { messageId: readString(message.id), error: error instanceof Error ? error.message : String(error) });
      return Response.json({ error: 'Message handling failed' }, { status: 500 });
    }));
  }
  if (responses.length === 1) return responses[0]!;
  const failed = responses.find(response => !response.ok);
  const results = await Promise.all(responses.map(response => response.json()));
  return Response.json({ acknowledged: !failed, results }, { status: failed?.status ?? 200 });
}

async function processWhatsAppMessage(value: Record<string, unknown>, message: Record<string, unknown>, context: SurfaceAdapterContext): Promise<Response> {
  const contact = Array.isArray(value.contacts) ? value.contacts.map(readRecord).find(contact => contact?.wa_id === message.from) ?? readRecord(value.contacts[0]) : null;
  const from = readString(message.from);
  const text = readMessageText(message);
  if (!from) return Response.json({ error: 'Missing sender' }, { status: 400 });

  const messageId = readString(message.id);
  const phoneNumberId = readString(value?.metadata && readRecord(value.metadata)?.phone_number_id);
  const profileName = readString(contact?.profile && readRecord(contact.profile)?.name);
  const outcome = await runSurfaceMessage(context, {
    ingress: {
      surface: 'whatsapp',
      userId: from,
      channelId: from,
      groupId: from,
      conversationKind: 'direct',
      text,
      mentioned: true,
      metadata: { messageId, profileName, phoneNumberId },
    },
    binding: {
      kind: 'channel',
      surfaceKind: 'whatsapp',
      surfaceId: phoneNumberId ?? readString(context.configManager.get('surfaces.whatsapp.phoneNumberId')) ?? 'whatsapp',
      externalId: from,
      channelId: from,
      title: profileName ?? from,
      metadata: { messageId, from },
    },
    text,
    logLabel: 'handleWhatsAppSurfaceWebhook',
    control: 'notice',
    ...(messageId ? { providerMessageId: messageId } : {}),
    userId: from,
    displayName: profileName ?? from,
    metadata: { messageId },
  });
  if (outcome.kind === 'refused') {
    // Meta redelivers a payload answered with a failure status; the shared answer acknowledges a consumed
    // answer and a final refusal, so a blocked sender cannot make the allowed messages beside it repeat.
    if (!outcome.decision.consumed) logger.info('handleWhatsAppSurfaceWebhook: message not admitted by channel policy', { reason: outcome.reason, messageId });
    return surfaceOutcomeResponse(outcome, 'redelivering');
  }
  if (outcome.kind === 'no-text') {
    const media = readMediaKind(message);
    // Every WhatsApp conversation this webhook sees is one-to-one.
    const notified = media ? await noticeUnsupportedAttachment(context, outcome.binding, media, true) : false;
    logger.info('handleWhatsAppSurfaceWebhook: message acknowledged without queueing', {
      reason: media ? 'unsupported-attachment' : 'no-actionable-text',
      ...(media ? { attachment: media } : {}),
      bindingId: outcome.binding.id,
      messageId,
    });
    return Response.json({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: media ? 'unsupported-attachment' : 'no-actionable-text',
      ...(media ? { attachment: media, notified } : {}),
      bindingId: outcome.binding.id,
    });
  }
  return surfaceOutcomeResponse(outcome, 'redelivering');
}
