import type {
  VoiceAudioArtifact,
  VoiceProvider,
  VoiceProviderStatus,
} from '../types.js';
import { fetchWithTimeout, instrumentedFetch } from '../../utils/fetch-with-timeout.js';
import { isRecord } from '../../utils/record-coerce.js';

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

/** Only an https audio URL is fetched on the caller's behalf; see {@link resolveAudioInput}. */
function assertFetchableAudioUri(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Voice audio uri is not a valid URL; send the audio as dataBase64 or an https URL.'); }
  if (url.protocol !== 'https:') {
    throw new Error(`Voice audio uri must be https (got ${url.protocol}); local files and plain-http URLs are not fetched. Send the audio as dataBase64 or an https URL.`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isPrivateHost(host)) {
    throw new Error('Voice audio uri points at a loopback, link-local or private address, which is not fetched. Send the audio as dataBase64 or a public https URL.');
  }
  return url;
}

function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) {
    // IPv6 literal: loopback, unspecified, unique-local, link-local, or an IPv4-mapped address.
    return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:');
  }
  // A name is not resolved here: a public name that resolves to a private address is not caught.
  return false;
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
    const response = await voiceFetch(assertFetchableAudioUri(audio.uri.trim()), {
      ...signalInit(signal),
      // A redirect could lead to the loopback or private address the check above refused.
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Failed to load audio URI: HTTP ${response.status}`);
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
