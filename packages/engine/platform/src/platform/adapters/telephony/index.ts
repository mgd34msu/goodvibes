import { createHash, createHmac } from 'node:crypto';
import { constantTimeEquals, parseJsonRecord, readBearerOrHeaderToken, readTextBodyWithinLimit } from '../helpers.js';
import { resolveSurfaceCredential, surfaceCredentialUnavailable } from '../surface-credential.js';
import type { SurfaceAdapterContext } from '../types.js';
import { logger } from '../../utils/logger.js';
import { runSurfaceMessage, surfaceOutcomeResponse } from '../surface-message.js';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseTelephonyBody(req: Request, rawBody: string): Record<string, unknown> | Response {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return parseJsonRecord(rawBody);
  }
  const params = new URLSearchParams(rawBody);
  const parsed: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) parsed[key] = value;
  return parsed;
}

function signatureCandidateUrls(req: Request, context: SurfaceAdapterContext): readonly string[] {
  const requestUrl = new URL(req.url);
  const candidates = [requestUrl.toString()];
  const publicBaseUrl =
    readString(context.configManager.get('web.publicBaseUrl'))
    ?? readString(context.configManager.get('controlPlane.publicBaseUrl'));
  if (publicBaseUrl) {
    candidates.push(new URL(`${requestUrl.pathname}${requestUrl.search}`, publicBaseUrl.endsWith('/') ? publicBaseUrl : `${publicBaseUrl}/`).toString());
  }
  return [...new Set(candidates)];
}

function twilioSignatureBaseString(url: string, rawBody: string, req: Request, bodyDigest: () => string): string | null {
  const parsedUrl = new URL(url);
  const bodyHash = parsedUrl.searchParams.get('bodySHA256');
  if (bodyHash) {
    if (bodyHash.length !== 64 || !/^[a-f0-9]{64}$/i.test(bodyHash)) return null;
    const expectedHash = bodyDigest();
    if (!constantTimeEquals(expectedHash, bodyHash.toLowerCase())) return null;
    return url;
  }
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return null;
  const params = [...new URLSearchParams(rawBody).entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  return `${url}${params.map(([key, value]) => `${key}${value}`).join('')}`;
}

function verifyTwilioSignature(
  req: Request,
  rawBody: string,
  context: SurfaceAdapterContext,
  authToken: string,
  signature: string,
): boolean {
  // HMAC-SHA1 is exactly 20 bytes in Twilio's canonical base64 encoding.
  // The final sextet has two zero padding bits; impossible signatures cannot
  // consume either body SHA256 or URL authentication work.
  if (!authToken || signature.length !== 28 || !/^[A-Za-z0-9+/]{26}[AEIMQUYcgkosw048]=$/.test(signature)) return false;
  // Twilio's JSON webhook protocol requires the bodySHA256 query commitment in
  // the signed URL. Hash this request body once even when its internal and
  // configured public URLs both need signature verification. Form requests
  // without bodySHA256 do not hash. This verifies the external protocol.
  let digest: string | undefined;
  const bodyDigest = () => digest ??= createHash('sha256').update(rawBody).digest('hex');
  for (const url of signatureCandidateUrls(req, context)) {
    const baseString = twilioSignatureBaseString(url, rawBody, req, bodyDigest);
    if (!baseString) continue;
    const expected = createHmac('sha1', authToken).update(baseString).digest('base64');
    if (constantTimeEquals(expected, signature)) return true;
  }
  return false;
}

export async function handleTelephonySurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const sharedCredential = await resolveSurfaceCredential(
    context,
    { kind: 'config', key: 'surfaces.telephony.webhookSecret' },
    { kind: 'registry', service: 'telephony', field: 'signingSecret' },
    { kind: 'config', key: 'surfaces.telephony.token' },
    { kind: 'registry', service: 'telephony', field: 'primary' },
    { kind: 'env', name: 'TELEPHONY_WEBHOOK_SECRET' },
    { kind: 'env', name: 'TWILIO_WEBHOOK_SECRET' },
    { kind: 'env', name: 'TELEPHONY_BRIDGE_TOKEN' },
  );
  if (sharedCredential.state === 'unresolvable') return surfaceCredentialUnavailable('telephony', sharedCredential);
  const configuredSecret = sharedCredential.state === 'resolved' ? sharedCredential.value : '';
  const twilioCredential = await resolveSurfaceCredential(
    context,
    { kind: 'registry', service: 'telephony', field: 'authToken' },
    { kind: 'config', key: 'surfaces.telephony.authToken' },
    { kind: 'env', name: 'TWILIO_AUTH_TOKEN' },
  );
  if (twilioCredential.state === 'unresolvable') return surfaceCredentialUnavailable('telephony', twilioCredential);
  const twilioAuthToken = twilioCredential.state === 'resolved' ? twilioCredential.value : '';
  if (!configuredSecret && !twilioAuthToken) {
    return Response.json({ error: 'Telephony webhook is not configured' }, { status: 503 });
  }

  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;
  const providedToken = readBearerOrHeaderToken(req, 'x-goodvibes-telephony-token');
  const providedTwilioSignature = readString(req.headers.get('x-twilio-signature')) ?? '';
  const sharedSecretAllowed = configuredSecret ? constantTimeEquals(configuredSecret, providedToken) : false;
  const twilioSignatureAllowed = !sharedSecretAllowed
    && verifyTwilioSignature(req, rawBody, context, twilioAuthToken, providedTwilioSignature);
  if (!sharedSecretAllowed && !twilioSignatureAllowed) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = parseTelephonyBody(req, rawBody);
  if (parsed instanceof Response) return parsed;
  const payload = readRecord(parsed);
  if (!payload) return Response.json({ error: 'Invalid request body' }, { status: 400 });

  const from = readString(payload.from) ?? readString(payload.From) ?? readString(payload.caller) ?? readString(payload.Caller) ?? readString(payload.source);
  const to = readString(payload.to) ?? readString(payload.To) ?? readString(context.configManager.get('surfaces.telephony.fromNumber')) ?? 'telephony';
  const text =
    readString(payload.text)
    ?? readString(payload.message)
    ?? readString(payload.Body)
    ?? readString(payload.body)
    ?? readString(payload.SpeechResult)
    ?? readString(payload.transcription)
    ?? '';
  if (!from) return Response.json({ error: 'Missing telephony sender' }, { status: 400 });

  const deliveryId = readString(payload.messageId) ?? readString(payload.MessageSid) ?? readString(payload.SmsSid);
  // A voice call sends one webhook per spoken turn, all with the same CallSid and
  // no message id, so the call id is not a per-message key and must not dedupe turns.
  const messageId = deliveryId ?? readString(payload.CallSid);
  const outcome = await runSurfaceMessage(context, {
    ingress: {
      surface: 'telephony',
      userId: from,
      channelId: from,
      groupId: from,
      conversationKind: 'direct',
      text,
      mentioned: true,
      metadata: { ...payload, messageId, to },
    },
    binding: {
      kind: 'channel',
      surfaceKind: 'telephony',
      surfaceId: to,
      externalId: from,
      channelId: from,
      title: from,
      metadata: { messageId, to },
    },
    text,
    logLabel: 'handleTelephonySurfaceWebhook',
    // Neither Twilio nor a bridge reads the answer to this webhook as a reply.
    control: 'notice',
    ...(deliveryId ? { providerMessageId: deliveryId } : {}),
    userId: from,
    displayName: from,
    title: from,
    metadata: { messageId, to },
    signal: req.signal,
  });
  if (outcome.kind === 'refused') {
    if (!outcome.decision.consumed) logger.info('handleTelephonySurfaceWebhook: message not admitted by channel policy', { reason: outcome.reason });
    return surfaceOutcomeResponse(outcome, 'redelivering');
  }
  if (outcome.kind === 'no-text') {
    return Response.json({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'no-actionable-text',
      bindingId: outcome.binding.id,
    });
  }
  return surfaceOutcomeResponse(outcome, 'redelivering');
}
