import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AutomationRouteBinding } from '../automation/routes.js';
import type { SurfaceAdapterContext } from './types.js';
import { readTextBodyWithinLimit, DEFAULT_MAX_REQUEST_BODY_BYTES } from '../utils/request-body.js';
import { WORK_AUTHORIZED_METADATA_KEY } from '../agents/conversation-continuation.js';
import { SHARED_SESSION_DELEGATED_INPUT_METADATA_KEY } from '../control-plane/session-intents.js';

export const DEFAULT_WEBHOOK_MAX_BYTES = DEFAULT_MAX_REQUEST_BODY_BYTES;

export function constantTimeEquals(expected: string, provided: string): boolean {
  if (!expected || !provided || expected.length !== provided.length) return false;
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  // Equal UTF-16 lengths do not imply equal UTF-8 lengths. Refuse a malformed
  // presentation instead of letting timingSafeEqual throw out of a webhook.
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

export function readBearerOrHeaderToken(req: Request, headerName: string): string {
  return (
    req.headers.get(headerName)
    ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    ?? ''
  ).trim();
}

/** A plain object (never an array), or null. */
export function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A non-blank string, trimmed, or undefined. */
export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * What an interaction surface (a slash command, a button) shows when the channel
 * policy answered instead of starting work. The policy also answers a reply that
 * it consumed (an approval, a payment answer, a work proposal reply), which is
 * not a refusal.
 */
export function policyReplyText(reason: string): string {
  return /^(approval-reply-consumed|payment-reply-|work-proposal-)/.test(reason)
    ? `Your reply was received (${reason}).`
    : `Blocked by channel policy: ${reason}`;
}

/** A provider message id that may arrive as a string or a number, as a string. */
export function readIdentifier(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return readString(value);
}

/**
 * Whether the sender addressed the bot, for the channel policy's `requireMention`.
 * The payload's own `mentioned` boolean wins, then any evidence the provider's
 * native payload gives. A payload with neither does not count as addressed: this
 * provider shows no mention evidence, so a policy that requires one must not be
 * satisfied by silence. A bridge that already filters to mentions says so with
 * `mentioned: true`.
 */
export function declaredMention(payload: Record<string, unknown> | null | undefined, nativeEvidence = false): boolean {
  return typeof payload?.mentioned === 'boolean' ? payload.mentioned : nativeEvidence;
}

/**
 * An inbound body as session-input metadata. The broker reads two control keys
 * from that open record (a live-agent handover decision and the delegated-input
 * quarantine marker); a caller holding only the surface's token must not be able
 * to set either by naming it in a message body.
 */
export function ingressMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  const { [WORK_AUTHORIZED_METADATA_KEY]: _authorized, [SHARED_SESSION_DELEGATED_INPUT_METADATA_KEY]: _quarantined, ...rest } = payload;
  return rest;
}

export function parseJsonRecord(rawBody: string): Record<string, unknown> | Response {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    return readRecord(parsed) ?? {};
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}

export { readTextBodyWithinLimit };

export function verifySha256HmacSignature(
  rawBody: string,
  secret: string,
  signatureHeader: string,
  prefix = 'sha256=',
): boolean {
  if (!secret || !signatureHeader.startsWith(prefix)) return false;
  const digest = signatureHeader.slice(prefix.length);
  if (digest.length !== 64 || !/^[0-9a-f]+$/.test(digest)) return false;
  const expected = `${prefix}${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return constantTimeEquals(expected, signatureHeader);
}

/** Whether a payload's attachment list (an array field every bridge names differently) holds anything. */
export function hasAttachments(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * Tells the sender of a message that held only an attachment that attachments cannot be read.
 * Only in a conversation known to be one-to-one: in a group an unaddressed attachment is ordinary
 * chatter and the bot stays silent. Never throws; returns whether the notice was delivered.
 */
export async function noticeUnsupportedAttachment(
  context: Pick<SurfaceAdapterContext, 'deliverSurfaceNotice'>,
  binding: AutomationRouteBinding,
  attachment: string,
  direct: boolean,
): Promise<boolean> {
  if (!direct || !context.deliverSurfaceNotice) return false;
  try {
    const delivery = await context.deliverSurfaceNotice(binding, `I cannot read ${attachment}s yet. Send the request as text.`);
    return delivery.delivered;
  } catch {
    return false;
  }
}
