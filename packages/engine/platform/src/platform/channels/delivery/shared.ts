import { assertDeliveryCurrent, runDeliveryPublication, type DeliveryLifetime } from '../../utils/delivery-lifetime.js';
import { ArtifactStore, type ArtifactAttachment, type ArtifactReference } from '../../artifacts/index.js';
import { ConfigManager } from '../../config/manager.js';
import type { ConfigKey } from '../../config/schema-types.js';
import { ServiceRegistry, type ServiceSecretField } from '../../config/service-registry.js';
import type { SecretsManager } from '../../config/secrets.js';
import { resolveSecretInput } from '../../config/secret-refs.js';
import { channelCredentials } from '../credential-holder.js';
import type {
  ChannelDeliveryRequest,
  ChannelDeliveryResult,
  ChannelDeliveryRouteBinding,
  ChannelDeliverySurfaceKind,
  ChannelDeliveryTarget,
} from './types.js';
import { instrumentedFetch } from '../../utils/fetch-with-timeout.js';
import { resolveReachableBaseUrl } from '../../utils/reachable-base-url.js';
import { validatePublicWebhookUrl } from '../../utils/url-safety.js';
import { HttpStatusError } from '@goodvibes-jev/engine/errors';
import { createHash } from 'node:crypto';

/** The lifetime is checked only after payload preparation, without an intervening await. */
export function deliveryFetch(
  lifetime: DeliveryLifetime,
  url: string | URL | Request,
  init?: RequestInit,
  diagnosticMode: 'default' | 'opaque-url' = 'default',
): Promise<Response> {
  assertDeliveryCurrent(lifetime);
  return runDeliveryPublication(lifetime, () => instrumentedFetch(url, {
    ...init,
    ...(lifetime.signal ? { signal: init?.signal ? AbortSignal.any([init.signal, lifetime.signal]) : lifetime.signal } : {}),
  }, diagnosticMode));
}

export function resolveChannelDeliverySurfaceKind(
  target: ChannelDeliveryTarget,
): ChannelDeliverySurfaceKind | undefined {
  return target.surfaceKind ?? (target.kind === 'webhook' ? 'webhook' : undefined);
}

/**
 * What a bound route fills in a target that left it out: the route's surface,
 * its reply address and its title. The one rule for this, used by the router
 * and by scheduled delivery.
 */
export function routeBindingTargetFields(binding: ChannelDeliveryRouteBinding): {
  readonly surfaceKind: ChannelDeliverySurfaceKind;
  readonly address: string;
  readonly label: string | undefined;
} {
  return {
    surfaceKind: binding.surfaceKind,
    address: typeof binding.metadata.responseUrl === 'string' ? binding.metadata.responseUrl
      : typeof binding.metadata.callbackUrl === 'string' ? binding.metadata.callbackUrl
        : binding.channelId ?? binding.externalId,
    label: binding.title,
  };
}

/** A target that names a route, read with its binding (routeBindingTargetFields). */
export function resolveRouteBindingTarget(target: ChannelDeliveryTarget, binding: ChannelDeliveryRouteBinding): ChannelDeliveryTarget {
  const fields = routeBindingTargetFields(binding);
  const label = target.label ?? fields.label;
  return {
    ...target,
    surfaceKind: target.surfaceKind ?? fields.surfaceKind,
    address: target.address ?? fields.address,
    ...(label !== undefined ? { label } : {}),
  };
}

export function titleFromBody(body: string): string {
  const firstLine = body.split('\n').find((line) => line.trim().length > 0) ?? 'goodvibes automation';
  return firstLine.slice(0, 80);
}

/** `truncated` says the text sent was shortened to fit the surface; it is absent when everything went out. */
export function success(
  responseId?: string,
  options: { readonly truncated?: boolean | undefined; readonly omittedChars?: number | undefined } = {},
): ChannelDeliveryResult {
  return {
    ...(responseId === undefined ? {} : { responseId }),
    ...(options.truncated ? { truncated: true, ...(options.omittedChars ? { omittedChars: options.omittedChars } : {}) } : {}),
  };
}

/**
 * The most text one message carries on each surface whose strategy cuts a body
 * to fit (`fitForSurface`). The router splits a longer body into following
 * messages of at most this size, so the recipient gets all of it. Telephony is
 * absent on purpose: a following SMS or call is not what a sender asked for.
 */
export const SURFACE_TEXT_LIMITS = {
  telegram: 4_096,
  whatsapp: 4_096,
  'google-chat': 4_000,
  msteams: 4_000,
  mattermost: 12_000,
  matrix: 8_000,
  signal: 8_000,
  imessage: 8_000,
  bluebubbles: 8_000,
} as const satisfies Partial<Record<ChannelDeliverySurfaceKind, number>>;

/**
 * Split a body into parts of at most `limit` characters, each cut at a paragraph,
 * line or word boundary where one falls in the second half of the part. The
 * last of `maxParts` parts carries whatever remains, which the surface then
 * cuts and reports as shortened.
 */
export function splitForSurface(body: string, limit: number, maxParts: number): string[] {
  let rest = body.replace(/\r\n/g, '\n').trim();
  const parts: string[] = [];
  while (rest.length > limit && parts.length < maxParts - 1) {
    const window = rest.slice(0, limit);
    const floor = Math.floor(limit / 2);
    const boundary = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' ')].find((index) => index >= floor);
    const cut = boundary ?? limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

export function buildArtifactContentPath(artifactId: string): string {
  return `/api/artifacts/${encodeURIComponent(artifactId)}/content`;
}

export function buildArtifactContentUrl(configManager: ConfigManager, artifactId: string): string | undefined {
  // The URL is posted INTO a chat message, so it is read off this host.
  const baseUrl = resolveReachableBaseUrl(configManager, 'off-host');
  if (!baseUrl) return undefined;
  return new URL(buildArtifactContentPath(artifactId), `${baseUrl}/`).toString();
}

export async function resolveAttachments(
  request: ChannelDeliveryRequest,
  artifactStore: ArtifactStore,
  configManager: ConfigManager,
  inlineLimitBytes?: number,
): Promise<ArtifactAttachment[]> {
  const references = request.attachments ?? [];
  const attachments: ArtifactAttachment[] = [];
  for (const reference of references) {
    attachments.push(await artifactStore.toAttachment(reference, {
      contentUrl: buildArtifactContentUrl(configManager, reference.artifactId),
      ...(typeof inlineLimitBytes === 'number' ? { includeBase64IfSmallerThan: inlineLimitBytes } : {}),
    }));
  }
  return attachments;
}

function attachmentSummaryBlock(attachments: readonly ArtifactAttachment[]): string {
  const lines = attachments.map((attachment) => {
    const name = attachment.filename ?? attachment.label ?? attachment.artifactId;
    const detail = `${name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`;
    // Only a link the reader can open is worth printing. The daemon-relative
    // path means nothing in a chat, so without a reachable base URL the line
    // says where the file is instead.
    return attachment.contentUrl
      ? `- ${detail}: ${attachment.contentUrl}`
      : `- ${detail}: not uploaded to this channel, the file is on the GoodVibes host`;
  });
  return `Attachments:\n${lines.join('\n')}`;
}

export function appendAttachmentSummary(body: string, attachments: readonly ArtifactAttachment[]): string {
  if (attachments.length === 0) return body;
  return `${body.trimEnd()}\n\n${attachmentSummaryBlock(attachments)}`;
}

export function trimForSurface(body: string, maxChars: number): string {
  const normalized = body.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

/**
 * The text to send to a surface with a length limit. When it does not fit, the
 * body is cut, the cut says how much was left out, and the attachment lines
 * survive: they are the part of the message that cannot be recovered from the
 * body. `truncated` and `omittedChars` let the caller report a shortened
 * delivery as such. The router sends a long body as several parts first
 * (`splitForSurface`), so this cut is reached only past the part limit.
 */
export function fitForSurface(
  body: string,
  attachments: readonly ArtifactAttachment[],
  maxChars: number,
): { readonly text: string; readonly truncated: boolean; readonly omittedChars: number } {
  const full = trimForSurface(appendAttachmentSummary(body, attachments), Number.MAX_SAFE_INTEGER);
  if (full.length <= maxChars) return { text: full, truncated: false, omittedChars: 0 };
  const normalizedBody = body.replace(/\r\n/g, '\n').trim();
  const summary = attachments.length > 0 ? `\n\n${attachmentSummaryBlock(attachments)}` : '';
  const marker = (omitted: number): string => `\n[Message shortened: ${omitted} characters were not sent]`;
  const reserved = summary.length + marker(normalizedBody.length).length;
  if (reserved >= maxChars) return { text: trimForSurface(full, maxChars), truncated: true, omittedChars: Math.max(0, full.length - maxChars) };
  const room = maxChars - reserved;
  const kept = normalizedBody.slice(0, room).trimEnd();
  const omittedChars = normalizedBody.length - kept.length;
  return { text: `${kept}${marker(omittedChars)}${summary}`, truncated: true, omittedChars };
}

/**
 * The bridge URL a delivery posts to, and sends its bearer token to. It comes
 * from configuration. A target address that is an https URL is honoured only
 * when it is on the configured bridge's origin, because the address can be
 * built from a conversation id that an inbound request supplied.
 */
export function resolveBridgeUrl(options: {
  readonly label: string;
  readonly address: string | undefined;
  readonly configured: ReadonlyArray<string | undefined>;
}): string | undefined {
  const configured = firstNonEmpty(...options.configured);
  const address = options.address?.trim();
  if (!address?.startsWith('https://')) return configured;
  if (configured && sameOrigin(address, configured)) return address;
  throw new Error(
    `${options.label} target address ${describeOrigin(address)} is not the configured ${options.label} bridge`
    + `${configured ? ` (${describeOrigin(configured)})` : ''}; set the bridge URL in the surface settings instead of passing it in the target`,
  );
}

/**
 * An explicit webhook URL on a target must be an https URL on a public host.
 * Chat webhooks carry the agent's output to whoever owns the host, so a value
 * that is not a usable public webhook is refused rather than posted to.
 */
export function assertPublicWebhookAddress(label: string, address: string): string {
  const validation = validatePublicWebhookUrl(address);
  if (!validation.ok) {
    throw new Error(`${label} requires an explicit HTTPS webhook target on a public host (${validation.error}); configure the webhook in the surface settings or pass a channel id`);
  }
  return address;
}

function sameOrigin(left: string, right: string): boolean {
  try { return new URL(left).origin === new URL(right).origin; } catch { return false; }
}

function describeOrigin(value: string): string {
  try { return new URL(value).origin; } catch { return 'that URL'; }
}

export function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Resolve only the selected credential; a broken configured reference cannot
 * switch accounts. References go through the process's credential holder, so a
 * send starts no password-manager command once the credential is held.
 */
export async function resolveDeliveryCredential(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
  options: {
    readonly serviceName: string;
    readonly serviceField: ServiceSecretField;
    readonly configKey: ConfigKey;
    readonly serviceDefault?: (() => string | undefined) | undefined;
    readonly environmentValue: string | undefined;
  },
): Promise<string | undefined> {
  const registered = firstNonEmpty(await channelCredentials.resolve(`service:${options.serviceName}:${options.serviceField}`,
    serviceRegistry.get?.(options.serviceName), () => serviceRegistry.resolveSecret(options.serviceName, options.serviceField), secretsManager));
  if (registered) return registered;
  const serviceDefault = firstNonEmpty(options.serviceDefault?.());
  if (serviceDefault) return serviceDefault;
  const configured = configManager.get(options.configKey);
  if (configured !== undefined && configured !== null
    && (typeof configured !== 'string' || configured.trim().length > 0)) {
    const resolved = firstNonEmpty(await channelCredentials.resolve(`config:${options.configKey}`, configured, () => resolveSecretInput(configured, {
      diagnosticMode: 'structural',
      resolveLocalSecret: (key) => secretsManager.get(key),
      homeDirectory: secretsManager.getGlobalHome?.() ?? undefined,
      configKey: options.configKey,
    }), secretsManager));
    if (!resolved) throw new Error(`Could not resolve channel delivery credential for ${options.configKey}`);
    return resolved;
  }
  return firstNonEmpty(options.environmentValue);
}

/** `credential` fingerprints the password the token was issued for, so a rotated or removed password is not served from the old token. */
const msTeamsTokenCache = new Map<string, { readonly token: string; readonly expiresAt: number; readonly credential: string }>();

export async function resolveMSTeamsAccessToken(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
  lifetime: DeliveryLifetime = {},
): Promise<string> {
  const appId = firstNonEmpty(
    String(configManager.get('surfaces.msteams.appId') ?? ''),
    process.env.MSTEAMS_APP_ID,
  );
  const appPassword = await resolveDeliveryCredential(configManager, serviceRegistry, secretsManager, {
    serviceName: 'msteams',
    serviceField: 'password',
    configKey: 'surfaces.msteams.appPassword',
    environmentValue: process.env.MSTEAMS_APP_PASSWORD,
  });
  const tenantId = firstNonEmpty(
    String(configManager.get('surfaces.msteams.tenantId') ?? ''),
    process.env.MSTEAMS_TENANT_ID,
    'botframework.com',
  )!;
  if (!appId) throw new Error('Missing Microsoft Teams app id');
  if (!appPassword) throw new Error('Missing Microsoft Teams app password');
  const cacheKey = `${tenantId}:${appId}`;
  const credential = createHash('sha256').update(appPassword).digest('hex');
  const cached = msTeamsTokenCache.get(cacheKey);
  if (cached && cached.credential === credential && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: appId,
    client_secret: appPassword,
    scope: 'https://api.botframework.com/.default',
  });
  const response = await deliveryFetch({ signal: lifetime.signal, assertCurrent: lifetime.assertCurrent }, `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const payload = await requireOkResponse('Microsoft Teams token request failed', response);
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  const token = typeof record?.access_token === 'string' ? record.access_token.trim() : '';
  const expiresIn = typeof record?.expires_in === 'number'
    ? record.expires_in
    : typeof record?.expires_in === 'string'
      ? Number(record.expires_in)
      : 300;
  if (!token) throw new Error('Microsoft Teams token request did not return an access token');
  msTeamsTokenCache.set(cacheKey, {
    token,
    credential,
    expiresAt: Date.now() + Math.max(60, Number.isFinite(expiresIn) ? expiresIn : 300) * 1_000,
  });
  return token;
}

export function extractResponseId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const direct = record.id;
  if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim();
  if (typeof direct === 'number' && Number.isFinite(direct)) return String(direct);
  const name = record.name;
  if (typeof name === 'string' && name.trim().length > 0) return name.trim();
  const messageId = record.message_id;
  if (typeof messageId === 'number' && Number.isFinite(messageId)) return String(messageId);
  if (typeof messageId === 'string' && messageId.trim().length > 0) return messageId.trim();
  const result = record.result;
  if (result && typeof result === 'object') return extractResponseId(result);
  return undefined;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  try {
    const text = await response.text();
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

export async function requireOkResponse(label: string, response: Response): Promise<unknown> {
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    const detail = typeof payload === 'string'
      ? payload
      : payload && typeof payload === 'object'
        ? JSON.stringify(payload)
        : '';
    throw new HttpStatusError(`${label} HTTP ${response.status}${detail ? `: ${detail}` : ''}`, { status: response.status });
  }
  return payload;
}

export async function postBridgePayload(
  bridgeUrl: string,
  payload: Record<string, unknown>,
  options: {
    readonly label: string;
    readonly token?: string | undefined;
    readonly lifetime?: DeliveryLifetime | undefined;
  },
): Promise<string | undefined> {
  const response = await deliveryFetch(options.lifetime ?? {}, bridgeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      'X-GoodVibes-Channel': String(payload.surface ?? 'bridge'),
    },
    body: JSON.stringify(payload),
  });
  const result = await requireOkResponse(options.label, response);
  return extractResponseId(result) ?? bridgeUrl;
}

/**
 * The same logical send always carries the same id, so a retry after an
 * ambiguous failure is recognised by the provider instead of sent twice. The
 * content is part of the id because one run can legitimately send several
 * different messages to the same chat.
 */
export function stableSendId(runId: string, destination: string, text: string): string {
  const digest = createHash('sha256').update(runId).update('\0').update(destination).update('\0').update(text).digest('hex');
  return `gv-${digest.slice(0, 32)}`;
}
