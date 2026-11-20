import type {
  VoiceAudioArtifact,
  VoiceProvider,
  VoiceProviderStatus,
} from '../types.js';
import { HttpStatusError } from '@goodvibes/engine/errors';
import { fetchWithTimeout, instrumentedFetch } from '../../utils/fetch-with-timeout.js';
import { isRecord } from '../../utils/record-coerce.js';
import { redactDiagnosticText } from '../../utils/redaction.js';
import { parseRetryAfterMs } from '../../providers/rate-limit-headers.js';
import { checkDestination, DestinationRefusedError, egress, type CheckedDestination } from '../../runtime/network/destination.js';

export function trimToUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function readFirstEnv(envVars: readonly string[]): string | null {
  for (const envVar of envVars) {
    const value = process.env[envVar]!;
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function normalizeBaseUrl(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return (trimmed && trimmed.length > 0 ? trimmed : fallback).replace(/\/+$/, '');
}

/** Bound on one cloud voice request, response body included. */
export const VOICE_REQUEST_TIMEOUT_MS = 60_000;

/** Bound on waiting for a streaming synthesis response to start; the audio itself may then run as long as it needs. */
export const VOICE_STREAM_FIRST_BYTE_TIMEOUT_MS = 30_000;

/** `{ signal }` when there is a caller signal, `{}` otherwise (exactOptionalPropertyTypes forbids `signal: undefined`). */
export function signalInit(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal ? { signal } : {};
}

/**
 * A cloud voice request that cannot hang: it ends at the timeout or when the
 * caller's signal aborts, whichever comes first.
 */
export function voiceFetch(
  url: string | URL | Request,
  init: RequestInit = {},
  timeoutMs: number = VOICE_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  return fetchWithTimeout(url, init, timeoutMs, instrumentedFetch);
}

/** Like {@link voiceFetch} but the timeout only covers the wait for the response to start. */
export async function voiceStreamFetch(
  url: string | URL | Request,
  init: RequestInit,
  signal: AbortSignal | undefined,
  firstByteTimeoutMs: number = VOICE_STREAM_FIRST_BYTE_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('Voice stream did not start in time', 'TimeoutError')),
    firstByteTimeoutMs,
  );
  try {
    return await instrumentedFetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    signal?.removeEventListener('abort', abortFromCaller);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** How much of a provider's error body is kept as its stated reason. */
const PROVIDER_REASON_MAX_CHARS = 500;

/** The reason a provider states in its error body: a JSON `message`/`detail`/`error`, else the text itself. */
function providerReason(body: string): string | undefined {
  const text = body.trim();
  if (!text) return undefined;
  let reason: unknown = text;
  try {
    const parsed: unknown = JSON.parse(text);
    const pick = (value: unknown): unknown => {
      if (typeof value === 'string') return value;
      if (!isRecord(value)) return undefined;
      return pick(value['message']) ?? pick(value['detail']) ?? pick(value['error']) ?? pick(value['status']);
    };
    reason = pick(parsed) ?? text;
  } catch { /* A plain-text body is the reason as written. */ }
  const flat = String(reason).replace(/\s+/g, ' ').trim();
  return flat ? redactDiagnosticText(flat.slice(0, PROVIDER_REASON_MAX_CHARS), { anonymize: false }) : undefined;
}

/** What to do about a failed voice request, from its status alone. */
function nextStepFor(provider: string, status: number, retryAfterMs: number | undefined): string {
  if (status === 401) return `Check the ${provider} API key; it was not accepted.`;
  if (status === 402) return `Check the ${provider} plan or balance.`;
  if (status === 403) return `Check that the ${provider} API key is allowed to use this feature.`;
  if (status === 404) return `Check the ${provider} voice or model id.`;
  if (status === 408 || status === 429 || status >= 500) {
    return retryAfterMs !== undefined ? `Retry in ${Math.ceil(retryAfterMs / 1000)} s.` : 'Retry shortly.';
  }
  return 'Check the request: the voice, model, format and text length.';
}

/**
 * The error for a voice provider's non-2xx response: it carries the status,
 * the `Retry-After` wait and the provider's stated reason, so a retry is
 * decided from the status table and the message says what to fix. Reads the
 * body once, on the failure path only.
 */
export async function voiceHttpError(provider: string, operation: string, response: Response): Promise<HttpStatusError> {
  let body = '';
  try { body = await response.text(); } catch { /* The status alone still classifies the failure. */ }
  const reason = providerReason(body);
  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after') ?? undefined, Date.now());
  const next = nextStepFor(provider, response.status, retryAfterMs);
  return new HttpStatusError(`${provider} ${operation} failed: HTTP ${response.status}${reason ? `: ${reason}` : ''}. ${next}`, {
    status: response.status,
    url: response.url || undefined,
    provider,
    operation,
    source: 'provider',
    state: `${provider} ${operation} did not complete`,
    next: [next],
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(reason !== undefined ? { body: reason } : {}),
  });
}

export async function resolveAudioInput(
  audio: VoiceAudioArtifact,
  signal?: AbortSignal,
): Promise<{ buffer: Uint8Array; mimeType: string }> {
  if (typeof audio.dataBase64 === 'string' && audio.dataBase64.trim().length > 0) {
    return {
      buffer: Uint8Array.from(Buffer.from(audio.dataBase64, 'base64')),
      mimeType: audio.mimeType,
    };
  }
  if (typeof audio.uri === 'string' && audio.uri.trim().length > 0) {
    // The destination owner resolves the name and checks every answer: only an
    // https URL whose every address is public is fetched, connected to the
    // address it checked, and a redirect is never followed.
    let destination: CheckedDestination;
    try {
      destination = await checkDestination(audio.uri.trim(), 'voice-audio', signal ? { signal } : {});
    } catch (error) {
      if (error instanceof DestinationRefusedError) throw new Error(`Voice audio uri was not fetched: ${error.message.replace(/^Request blocked: /, '')}. ${error.next} Or send the audio as dataBase64.`);
      throw error;
    }
    const timeout = AbortSignal.timeout(VOICE_REQUEST_TIMEOUT_MS);
    const response = await egress(destination, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Voice audio uri answered with a redirect (HTTP ${response.status}), which is not followed. Send the final https URL or the audio as dataBase64.`);
    }
    if (!response.ok) throw await voiceHttpError('Voice audio uri', 'download', response);
    return {
      buffer: new Uint8Array(await response.arrayBuffer()),
      mimeType: response.headers.get('content-type')?.trim() || audio.mimeType,
    };
  }
  throw new Error('Voice audio input requires dataBase64 or uri.');
}

export function buildStatus(
  id: string,
  label: string,
  capabilities: VoiceProvider['capabilities'],
  configured: boolean,
  detail: string,
  metadata: Record<string, unknown> = {},
): VoiceProviderStatus {
  return {
    id,
    label,
    state: configured ? 'healthy' : 'unconfigured',
    capabilities: [...capabilities],
    configured,
    detail,
    metadata,
  };
}

export function inferMimeFromExtension(ext: string): string {
  switch (ext) {
    case '.wav':
      return 'audio/wav';
    case '.ogg':
      return 'audio/ogg';
    case '.webm':
      return 'audio/webm';
    case '.flac':
      return 'audio/flac';
    case '.aac':
      return 'audio/aac';
    case '.pcm':
      return 'audio/pcm';
    default:
      return 'audio/mpeg';
  }
}

export function inferExtFromOutputFormat(outputFormat: string): string {
  const lower = outputFormat.toLowerCase();
  if (lower.includes('webm')) return '.webm';
  if (lower.includes('ogg')) return '.ogg';
  if (lower.includes('flac')) return '.flac';
  if (lower.includes('aac')) return '.aac';
  if (lower.includes('wav') || lower.includes('riff')) return '.wav';
  if (lower.includes('pcm')) return '.pcm';
  return '.mp3';
}

export function inferFilename(audio: VoiceAudioArtifact, fallbackExt: string): string {
  const metadata = asRecord(audio.metadata);
  const explicit = trimToUndefined(metadata?.['filename']);
  if (explicit) return explicit;
  return `audio${fallbackExt}`;
}

export function mimeTypeForVoiceFormat(format: string): string {
  switch (format) {
    case 'wav':
      return 'audio/wav';
    case 'opus':
      return 'audio/ogg';
    case 'aac':
      return 'audio/aac';
    case 'flac':
      return 'audio/flac';
    case 'pcm':
      return 'audio/pcm';
    default:
      return 'audio/mpeg';
  }
}

export function estimateConfidenceFromAvgLogprob(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const bounded = Math.max(0, Math.min(1, Math.exp(value)));
  return Number.isFinite(bounded) ? bounded : undefined;
}
