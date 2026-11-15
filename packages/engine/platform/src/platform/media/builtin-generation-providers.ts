import type {
  MediaArtifact,
  MediaGenerationRequest,
  MediaGenerationResult,
  MediaProvider,
  MediaProviderStatus,
} from './provider-registry.js';
import { instrumentedFetch } from '../utils/fetch-with-timeout.js';
import { logger } from '../utils/logger.js';
import { assertDeliveryCurrent, type DeliveryLifetime } from '../utils/delivery-lifetime.js';
import { isRecord } from '../utils/record-coerce.js';

function readFirstEnv(envVars: readonly string[]): string | null {
  for (const envVar of envVars) {
    const value = process.env[envVar]!;
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function buildStatus(
  id: string,
  label: string,
  configured: boolean,
  detail: string,
): MediaProviderStatus {
  return {
    id,
    label,
    state: configured ? 'healthy' : 'unconfigured',
    capabilities: ['generate'],
    configured,
    detail,
    // Status reads local configuration only; the provider is not contacted.
    metadata: { verified: false },
  };
}

/** A job the provider itself reported as failed or cancelled: nothing is left running. */
class ProviderTaskEnded extends Error {}

/**
 * Runs everything that follows a successful submission. The job is paid for and
 * keeps running remotely, so any failure names the provider and task id (the
 * only handle for finding or cancelling it) on the thrown error, and an abort
 * cancels the remote job when the provider has a cancel call.
 */
async function afterSubmission<T>(
  provider: string,
  taskId: string,
  lifetime: DeliveryLifetime,
  cancel: (() => Promise<unknown>) | undefined,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    let note: string | undefined;
    if (!(error instanceof ProviderTaskEnded)) {
      note = `${provider} task ${taskId} was submitted and may still be running`;
      if (lifetime.signal?.aborted && cancel) {
        try { await cancel(); note = `${provider} task ${taskId} was cancelled because the request was aborted`; }
        catch { note = `${provider} task ${taskId} may still be running; cancelling it failed`; }
      }
    }
    const providerTask = { providerId: provider, taskId };
    if (error instanceof Error) {
      if (note) {
        try { error.message = `${error.message} (${note})`; }
        catch {
          // An abort's message is read-only: carry it, and its name, on a new error that wraps it.
          const wrapped = new Error(`${error.message} (${note})`, { cause: error });
          wrapped.name = error.name;
          throw Object.assign(wrapped, { providerTask });
        }
      }
      Object.defineProperty(error, 'providerTask', { value: providerTask, configurable: true });
    }
    throw error;
  }
}

/** Best-effort remote cancel with its own deadline: the caller's signal is already aborted when this runs. */
async function cancelRemoteTask(url: string, method: 'DELETE' | 'POST' | 'PUT', headers: Record<string, string>): Promise<void> {
  const response = await instrumentedFetch(url, { method, headers, signal: AbortSignal.timeout(15_000) });
  try { await response.body?.cancel(); } catch { /* the status is all that is read */ }
  if (!response.ok) throw new Error(`cancel failed (${response.status})`);
}

/** The registrable domain, so regional hosts of one vendor are accepted and other hosts are not. */
function registrableDomain(hostname: string): string {
  return hostname.split('.').slice(-2).join('.');
}

/**
 * options.baseUrl receives the provider's API key, so it must stay on the
 * vendor's own domain over https.
 */
function vendorBaseUrl(options: Record<string, unknown>, defaultBaseUrl: string, vendor: string): string {
  const requested = trimString(options['baseUrl']);
  if (!requested) return defaultBaseUrl;
  let parsed: URL;
  try { parsed = new URL(requested); } catch { throw new Error(`${vendor} options.baseUrl is not a valid URL.`); }
  if (parsed.protocol !== 'https:' || registrableDomain(parsed.hostname) !== registrableDomain(new URL(defaultBaseUrl).hostname)) {
    throw new Error(`${vendor} options.baseUrl must be an https URL on ${registrableDomain(new URL(defaultBaseUrl).hostname)}; the provider key is only sent there.`);
  }
  return requested;
}

const COMFY_CLOUD_HOST = 'cloud.comfy.org';

/**
 * The API key goes to this host, so a per-request options.baseUrl may only name
 * the configured server (COMFY_BASE_URL, else the local default) or Comfy Cloud over https.
 */
function comfyBaseUrl(options: Record<string, unknown>): string {
  const configured = trimString(process.env['COMFY_BASE_URL']) ?? 'http://127.0.0.1:8188';
  let allowed: URL;
  try { allowed = new URL(configured); } catch { throw new Error('COMFY_BASE_URL is not a valid URL.'); }
  const requested = trimString(options['baseUrl']);
  if (!requested) return configured;
  let parsed: URL;
  try { parsed = new URL(requested); } catch { throw new Error('Comfy options.baseUrl is not a valid URL.'); }
  if (parsed.origin === allowed.origin || (parsed.protocol === 'https:' && parsed.hostname === COMFY_CLOUD_HOST)) return requested;
  throw new Error(`Comfy options.baseUrl must be the configured server (${allowed.origin}) or https://${COMFY_CLOUD_HOST}; the Comfy key is only sent there.`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function trimString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toDataUrl(artifact: MediaArtifact): string | undefined {
  if (artifact.uri?.trim()) return artifact.uri.trim();
  if (artifact.dataBase64?.trim()) {
    return `data:${artifact.mimeType || 'application/octet-stream'};base64,${artifact.dataBase64.trim()}`;
  }
  return undefined;
}

interface RemoteArtifactRetrieval extends Record<string, unknown> {
  readonly source: 'media-generation-provider';
  readonly sourceProviderId: string;
  readonly sourceUrl: string;
  readonly sourceUri: string;
  readonly sourceQuality: 'provider-output-url';
  readonly inlined: boolean;
  readonly retrievalMethod: 'GET' | 'remote-reference';
  readonly headProbe: {
    readonly attempted: true;
    readonly ok: boolean;
    readonly status?: number | undefined;
    readonly contentLength?: number | undefined;
    readonly contentType?: string | undefined;
    readonly error?: string | undefined;
  };
  readonly transportRecovery?: {
    readonly from: 'HEAD';
    readonly to: 'GET';
    readonly reason: string;
  } | undefined;
}

function buildRemoteArtifactMetadata(
  providerId: string,
  url: string,
  input: {
    readonly inlined: boolean;
    readonly retrievalMethod: 'GET' | 'remote-reference';
    readonly headOk: boolean;
    readonly headStatus?: number | undefined;
    readonly headContentLength?: number | undefined;
    readonly headContentType?: string | undefined;
    readonly headError?: string | undefined;
  },
): RemoteArtifactRetrieval {
  return {
    source: 'media-generation-provider',
    sourceProviderId: providerId,
    sourceUrl: url,
    sourceUri: url,
    sourceQuality: 'provider-output-url',
    inlined: input.inlined,
    retrievalMethod: input.retrievalMethod,
    headProbe: {
      attempted: true,
      ok: input.headOk,
      ...(input.headStatus !== undefined ? { status: input.headStatus } : {}),
      ...(input.headContentLength !== undefined ? { contentLength: input.headContentLength } : {}),
      ...(input.headContentType ? { contentType: input.headContentType } : {}),
      ...(input.headError ? { error: input.headError } : {}),
    },
    ...(input.headError ? {
      transportRecovery: {
        from: 'HEAD',
        to: 'GET',
        reason: input.headError,
      },
    } : {}),
  };
}



function resolveReferenceArtifact(request: MediaGenerationRequest): MediaArtifact | null {
  const options = asRecord(request.options);
  const candidate = asRecord(options?.['referenceArtifact']) ?? asRecord(options?.['sourceArtifact']);
  if (!candidate) return null;
  const mimeType = trimString(candidate['mimeType']) ?? 'application/octet-stream';
  return {
    mimeType,
    ...(trimString(candidate['dataBase64']) ? { dataBase64: trimString(candidate['dataBase64']) } : {}),
    ...(trimString(candidate['uri']) ? { uri: trimString(candidate['uri']) } : {}),
    ...(trimString(candidate['filename']) ? { filename: trimString(candidate['filename']) } : {}),
    metadata: asRecord(candidate['metadata']) ?? {},
  };
}

function resolveReferenceUrl(request: MediaGenerationRequest): string | undefined {
  const options = asRecord(request.options);
  const direct = trimString(options?.['referenceUrl']) ?? trimString(options?.['imageUrl']) ?? trimString(options?.['videoUrl']);
  if (direct) return direct;
  const artifact = resolveReferenceArtifact(request);
  return artifact ? toDataUrl(artifact) : undefined;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = 120_000, lifetime: DeliveryLifetime = {}): Promise<unknown> {
  const response = await fetchResponse(url, init, timeoutMs, lifetime);
  const result: unknown = await response.json();
  assertDeliveryCurrent(lifetime);
  return result;
}

async function fetchResponse(url: string, init: RequestInit, timeoutMs = 120_000, lifetime: DeliveryLifetime = {}): Promise<Response> {
  assertDeliveryCurrent(lifetime);
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = lifetime.signal ? AbortSignal.any([deadline, lifetime.signal]) : deadline;
  const response = await instrumentedFetch(url, { ...init, signal });
  assertDeliveryCurrent(lifetime);
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* Preserve the structural status. */ }
    assertDeliveryCurrent(lifetime);
    throw new Error(`Media provider request failed (${response.status}).`);
  }
  return response;
}

/** Keep waits cancellable and fence the original credential aliases at each request. */
function generationTransport(lifetime: DeliveryLifetime, environmentKeys: readonly string[]) {
  const environment = environmentKeys.map(key => process.env[key]);
  const signal = lifetime.signal, current = lifetime.assertCurrent;
  const assertCurrent = () => {
    if (lifetime.signal !== signal || lifetime.assertCurrent !== current
      || environmentKeys.some((key, index) => process.env[key] !== environment[index])) throw new Error('Media generation owner changed.');
    assertDeliveryCurrent(lifetime);
  };
  const owned = { signal, assertCurrent };
  assertCurrent();
  return {
    fetchJson: (url: string, init: RequestInit, timeoutMs?: number) => fetchJson(url, init, timeoutMs, owned),
    inferVideoArtifact: (providerId: string, url: string) => maybeInlineArtifact(providerId, url, 'video/mp4', 'video.mp4', 1_500_000, owned),
    inferImageArtifact: (providerId: string, url: string) => maybeInlineArtifact(providerId, url, 'image/png', 'image.png', 5_000_000, owned),
    async sleep(delayMs: number) {
      assertCurrent();
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Media generation cancelled.', 'AbortError')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delayMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      assertCurrent();
    },
  };
}

function buildArtifactFromRemote(
  providerId: string,
  url: string,
  mimeType = 'application/octet-stream',
  filename?: string,
  retrieval?: {
    readonly headOk: boolean;
    readonly headStatus?: number | undefined;
    readonly headContentLength?: number | undefined;
    readonly headContentType?: string | undefined;
    readonly headError?: string | undefined;
  },
): MediaArtifact {
  return {
    uri: url,
    mimeType,
    ...(filename ? { filename } : {}),
    metadata: buildRemoteArtifactMetadata(providerId, url, {
      inlined: false,
      retrievalMethod: 'remote-reference',
      headOk: retrieval?.headOk ?? false,
      headStatus: retrieval?.headStatus,
      headContentLength: retrieval?.headContentLength,
      headContentType: retrieval?.headContentType,
      headError: retrieval?.headError,
    }),
  };
}

/** The body, or null once it exceeds `limit` bytes, so a response without a content-length is not buffered whole. */
async function readBodyUpTo(response: Response, limit: number): Promise<Buffer | null> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.byteLength;
    if (size > limit) { void reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
}

async function maybeInlineArtifact(
  providerId: string,
  url: string,
  fallbackMimeType: string,
  filename?: string,
  maxInlineBytes = 5_000_000,
  lifetime: DeliveryLifetime = {},
): Promise<MediaArtifact> {
  let head: Response | null = null;
  let headError: string | undefined;
  try {
    assertDeliveryCurrent(lifetime);
    const deadline = AbortSignal.timeout(20_000);
    head = await instrumentedFetch(url, { method: 'HEAD', signal: lifetime.signal ? AbortSignal.any([deadline, lifetime.signal]) : deadline });
    assertDeliveryCurrent(lifetime);
  } catch {
    assertDeliveryCurrent(lifetime);
    headError = 'Media artifact HEAD probe failed.';
    logger.warn('Media artifact HEAD probe failed; recovering with GET', {
      url,
      providerId,
      recovery: 'HEAD_TO_GET',
      error: headError,
    });
  }
  const contentLength = Number.parseInt(head?.headers.get('content-length') ?? '', 10);
  const contentType = head?.headers.get('content-type')?.trim() || fallbackMimeType;
  const normalizedContentLength = Number.isFinite(contentLength) ? contentLength : undefined;
  const retrieval = {
    headOk: head?.ok ?? false,
    headStatus: head?.status,
    headContentLength: normalizedContentLength,
    headContentType: contentType,
    headError,
  };
  if (Number.isFinite(contentLength) && contentLength > maxInlineBytes) {
    return buildArtifactFromRemote(providerId, url, contentType, filename, retrieval);
  }
  assertDeliveryCurrent(lifetime);
  const response = await fetchResponse(url, { method: 'GET' }, 120_000, lifetime);
  const buffer = await readBodyUpTo(response, maxInlineBytes);
  assertDeliveryCurrent(lifetime);
  const mimeType = response.headers.get('content-type')?.trim() || contentType;
  if (buffer === null) {
    return buildArtifactFromRemote(providerId, url, mimeType, filename, {
      ...retrieval,
      headContentType: mimeType,
    });
  }
  return {
    uri: url,
    mimeType,
    ...(filename ? { filename } : {}),
    dataBase64: buffer.toString('base64'),
    sizeBytes: buffer.length,
    metadata: buildRemoteArtifactMetadata(providerId, url, {
      ...retrieval,
      inlined: true,
      retrievalMethod: 'GET',
      headContentType: mimeType,
    }),
  };
}

function createByteplusProvider(): MediaProvider {
  const envVars = ['BYTEPLUS_API_KEY'] as const;
  const defaultModel = 'seedance-1-0-lite-t2v-250428';
  const defaultBaseUrl = 'https://ark.ap-southeast.bytepluses.com/api/v3';
  return {
    id: 'byteplus',
    label: 'BytePlus',
    capabilities: ['generate'],
    status() {
      const configured = readFirstEnv(envVars) !== null;
      return buildStatus('byteplus', 'BytePlus', configured, configured
        ? 'BytePlus video generation key available.'
        : 'Set BYTEPLUS_API_KEY to enable BytePlus video generation.');
    },
    async generate(request: MediaGenerationRequest, lifetime: DeliveryLifetime = {}): Promise<MediaGenerationResult> {
      const { fetchJson, inferVideoArtifact, sleep } = generationTransport(lifetime, [...envVars, 'COMFY_BASE_URL']);
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) throw new Error('BytePlus API key missing');
      const options = asRecord(request.options) ?? {};
      const model = trimString(request.modelId) ?? trimString(options['model']) ?? defaultModel;
      const baseUrl = vendorBaseUrl(options, defaultBaseUrl, 'BytePlus');
      const referenceUrl = resolveReferenceUrl(request);
      const content: Array<Record<string, unknown>> = [{ type: 'text', text: request.prompt }];
      if (referenceUrl) {
        content.push({
          type: 'image_url',
          image_url: { url: referenceUrl },
          role: 'first_frame',
        });
      }
      const submitted = await fetchJson(`${baseUrl}/contents/generations/tasks`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          content,
          ...(trimString(options['aspectRatio']) ? { ratio: trimString(options['aspectRatio']) } : {}),
          ...(trimString(options['resolution']) ? { resolution: trimString(options['resolution']) } : {}),
          ...(asNumber(options['durationSeconds']) != null ? { duration: Math.max(1, Math.round(asNumber(options['durationSeconds'])!)) } : {}),
          ...(asBool(options['audio']) != null ? { generate_audio: asBool(options['audio']) } : {}),
          ...(asBool(options['watermark']) != null ? { watermark: asBool(options['watermark']) } : {}),
        }),
      }) as { id?: string };
      const taskId = trimString(submitted.id);
      if (!taskId) throw new Error('BytePlus response missing task id');
      return afterSubmission('BytePlus', taskId, lifetime,
        () => cancelRemoteTask(`${baseUrl}/contents/generations/tasks/${taskId}`, 'DELETE', { Authorization: `Bearer ${apiKey}` }),
        async () => {
          let completed: Record<string, unknown> | null = null;
          for (let attempt = 0; attempt < 120; attempt += 1) {
            const payload = await fetchJson(`${baseUrl}/contents/generations/tasks/${taskId}`, {
              method: 'GET',
              headers: { Authorization: `Bearer ${apiKey}` },
            }, 60_000) as Record<string, unknown>;
            const status = trimString(payload['status'])?.toLowerCase();
            if (status === 'succeeded') {
              completed = payload;
              break;
            }
            if (status === 'failed' || status === 'cancelled') {
              const error = asRecord(payload['error']);
              throw new ProviderTaskEnded(trimString(error?.['message']) ?? 'BytePlus generation failed');
            }
            await sleep(5_000);
          }
          if (!completed) throw new Error('BytePlus generation timed out');
          const contentRecord = asRecord(completed['content']);
          const videoUrl = trimString(contentRecord?.['video_url']) ?? trimString(contentRecord?.['file_url']);
          if (!videoUrl) throw new Error('BytePlus generation completed without a video URL');
          return {
            providerId: 'byteplus',
            artifacts: [await inferVideoArtifact('byteplus', videoUrl)],
            metadata: {
              taskId,
              model,
            },
          };
        });
    },
  };
}

function createRunwayProvider(): MediaProvider {
  const envVars = ['RUNWAYML_API_SECRET', 'RUNWAY_API_KEY'] as const;
  const defaultBaseUrl = 'https://api.dev.runwayml.com';
  const defaultModel = 'gen4.5';
  return {
    id: 'runway',
    label: 'Runway',
    capabilities: ['generate'],
    status() {
      const configured = readFirstEnv(envVars) !== null;
      return buildStatus('runway', 'Runway', configured, configured
        ? 'Runway API key available.'
        : 'Set RUNWAYML_API_SECRET or RUNWAY_API_KEY to enable Runway generation.');
    },
    async generate(request: MediaGenerationRequest, lifetime: DeliveryLifetime = {}): Promise<MediaGenerationResult> {
      const { fetchJson, inferVideoArtifact, sleep } = generationTransport(lifetime, [...envVars, 'COMFY_BASE_URL']);
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) throw new Error('Runway API key missing');
      const options = asRecord(request.options) ?? {};
      const baseUrl = vendorBaseUrl(options, defaultBaseUrl, 'Runway');
      const model = trimString(request.modelId) ?? trimString(options['model']) ?? defaultModel;
      const referenceArtifact = resolveReferenceArtifact(request);
      const endpoint = referenceArtifact
        ? referenceArtifact.mimeType.startsWith('video/') ? '/v1/video_to_video' : '/v1/image_to_video'
        : '/v1/text_to_video';
      const body: Record<string, unknown> = {
        model,
        promptText: request.prompt,
        ratio: trimString(options['size']) ?? trimString(options['aspectRatio']) ?? '1280:720',
        ...(asNumber(options['durationSeconds']) != null ? { duration: Math.max(2, Math.round(asNumber(options['durationSeconds'])!)) } : { duration: 5 }),
      };
      const referenceUrl = resolveReferenceUrl(request);
      if (endpoint === '/v1/image_to_video' && referenceUrl) body['promptImage'] = referenceUrl;
      if (endpoint === '/v1/video_to_video' && referenceUrl) body['videoUri'] = referenceUrl;
      const submitted = await fetchJson(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Runway-Version': '2024-11-06',
        },
        body: JSON.stringify(body),
      }) as { id?: string };
      const taskId = trimString(submitted.id);
      if (!taskId) throw new Error('Runway response missing task id');
      return afterSubmission('Runway', taskId, lifetime,
        () => cancelRemoteTask(`${baseUrl}/v1/tasks/${taskId}`, 'DELETE', { Authorization: `Bearer ${apiKey}`, 'X-Runway-Version': '2024-11-06' }),
        async () => {
          let completed: Record<string, unknown> | null = null;
          for (let attempt = 0; attempt < 120; attempt += 1) {
            const payload = await fetchJson(`${baseUrl}/v1/tasks/${taskId}`, {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'X-Runway-Version': '2024-11-06',
              },
            }, 60_000) as Record<string, unknown>;
            const status = trimString(payload['status'])?.toUpperCase();
            if (status === 'SUCCEEDED') {
              completed = payload;
              break;
            }
            if (status === 'FAILED' || status === 'CANCELLED') {
              throw new ProviderTaskEnded(trimString(payload['failure']) ?? 'Runway generation failed');
            }
            await sleep(5_000);
          }
          if (!completed) throw new Error('Runway generation timed out');
          const outputs = Array.isArray(completed['output'])
            ? (completed['output'] as unknown[]).filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
            : [];
          if (outputs.length === 0) throw new Error('Runway generation completed without output URLs');
          return {
            providerId: 'runway',
            artifacts: await Promise.all(outputs.map((url) => inferVideoArtifact('runway', url))),
            metadata: { taskId, model },
          };
        });
    },
  };
}

function createAlibabaProvider(): MediaProvider {
  const envVars = ['MODELSTUDIO_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY'] as const;
  const defaultBaseUrl = 'https://dashscope-intl.aliyuncs.com';
  const defaultModel = 'wan2.6-t2v';
  return {
    id: 'alibaba',
    label: 'Alibaba Model Studio',
    capabilities: ['generate'],
    status() {
      const configured = readFirstEnv(envVars) !== null;
      return buildStatus('alibaba', 'Alibaba Model Studio', configured, configured
        ? 'Alibaba video generation key available.'
        : 'Set MODELSTUDIO_API_KEY, DASHSCOPE_API_KEY, or QWEN_API_KEY to enable Alibaba generation.');
    },
    async generate(request: MediaGenerationRequest, lifetime: DeliveryLifetime = {}): Promise<MediaGenerationResult> {
      const { fetchJson, inferVideoArtifact, sleep } = generationTransport(lifetime, [...envVars, 'COMFY_BASE_URL']);
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) throw new Error('Alibaba API key missing');
      const options = asRecord(request.options) ?? {};
      const baseUrl = vendorBaseUrl(options, defaultBaseUrl, 'Alibaba');
      const model = trimString(request.modelId) ?? trimString(options['model']) ?? defaultModel;
      const referenceUrl = resolveReferenceUrl(request);
      const submitted = await fetchJson(`${baseUrl.replace(/\/+$/, '')}/api/v1/services/aigc/video-generation/video-synthesis`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable',
        },
        body: JSON.stringify({
          model,
          input: {
            prompt: request.prompt,
            ...(referenceUrl ? { img_url: referenceUrl } : {}),
          },
          parameters: {
            ...(trimString(options['size']) ? { size: trimString(options['size']) } : {}),
            ...(trimString(options['aspectRatio']) ? { aspect_ratio: trimString(options['aspectRatio']) } : {}),
            ...(asNumber(options['durationSeconds']) != null ? { duration: Math.max(1, Math.round(asNumber(options['durationSeconds'])!)) } : {}),
            ...(asBool(options['audio']) != null ? { enable_audio: asBool(options['audio']) } : {}),
            ...(asBool(options['watermark']) != null ? { watermark: asBool(options['watermark']) } : {}),
          },
        }),
      }) as { output?: { task_id?: string } };
      const taskId = trimString(asRecord(submitted.output)?.['task_id']);
      if (!taskId) throw new Error('Alibaba response missing task id');
      const taskBase = `${baseUrl.replace(/\/+$/, '')}/api/v1/tasks/${taskId}`;
      return afterSubmission('Alibaba', taskId, lifetime,
        () => cancelRemoteTask(`${taskBase}/cancel`, 'POST', { Authorization: `Bearer ${apiKey}` }),
        async () => {
          let completed: Record<string, unknown> | null = null;
          for (let attempt = 0; attempt < 120; attempt += 1) {
            const payload = await fetchJson(taskBase, {
              method: 'GET',
              headers: { Authorization: `Bearer ${apiKey}` },
            }, 60_000) as Record<string, unknown>;
            const output = asRecord(payload['output']);
            const status = trimString(output?.['task_status'])?.toUpperCase();
            if (status === 'SUCCEEDED') {
              completed = payload;
              break;
            }
            if (status === 'FAILED' || status === 'CANCELED') {
              throw new ProviderTaskEnded(trimString(output?.['message']) ?? 'Alibaba generation failed');
            }
            await sleep(2_500);
          }
          if (!completed) throw new Error('Alibaba generation timed out');
          const output = asRecord(completed['output']);
          const results = Array.isArray(output?.['results']) ? output?.['results'] as Array<Record<string, unknown>> : [];
          const urls = [
            ...results.map((entry) => trimString(entry['video_url'])).filter((entry): entry is string => Boolean(entry)),
            trimString(output?.['video_url']),
          ].filter((entry): entry is string => Boolean(entry));
          if (urls.length === 0) throw new Error('Alibaba generation completed without a video URL');
          return {
            providerId: 'alibaba',
            artifacts: await Promise.all(urls.map((url) => inferVideoArtifact('alibaba', url))),
            metadata: { taskId, model },
          };
        });
    },
  };
}

function createFalProvider(): MediaProvider {
  const envVars = ['FAL_KEY', 'FAL_API_KEY'] as const;
  const defaultBaseUrl = 'https://fal.run';
  const defaultModel = 'fal-ai/minimax/video-01-live';
  return {
    id: 'fal',
    label: 'fal',
    capabilities: ['generate'],
    status() {
      const configured = readFirstEnv(envVars) !== null;
      return buildStatus('fal', 'fal', configured, configured
        ? 'fal API key available.'
        : 'Set FAL_KEY or FAL_API_KEY to enable fal generation.');
    },
    async generate(request: MediaGenerationRequest, lifetime: DeliveryLifetime = {}): Promise<MediaGenerationResult> {
      const { fetchJson, inferVideoArtifact, inferImageArtifact, sleep } = generationTransport(lifetime, [...envVars, 'COMFY_BASE_URL']);
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) throw new Error('fal API key missing');
      const options = asRecord(request.options) ?? {};
      const baseUrl = vendorBaseUrl(options, defaultBaseUrl, 'fal');
      const model = trimString(request.modelId) ?? trimString(options['model']) ?? defaultModel;
      const isImage = (request.outputMimeType?.startsWith('image/') ?? false) || asBool(options['image']) === true;
      const path = trimString(options['path']) ?? (isImage ? 'fal-ai/flux/dev' : model);
      const queueBase = baseUrl.replace('://fal.run', '://queue.fal.run');
      const submitted = await fetchJson(`${queueBase.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`, {
        method: 'POST',
        headers: {
          Authorization: `Key ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: request.prompt,
          ...(resolveReferenceUrl(request) ? { image_url: resolveReferenceUrl(request) } : {}),
          ...(trimString(options['aspectRatio']) ? { aspect_ratio: trimString(options['aspectRatio']) } : {}),
          ...(trimString(options['size']) ? { size: trimString(options['size']) } : {}),
          ...(trimString(options['resolution']) ? { resolution: trimString(options['resolution']) } : {}),
          ...(asNumber(options['durationSeconds']) != null ? { duration: Math.max(1, Math.round(asNumber(options['durationSeconds'])!)) } : {}),
        }),
      }, 60_000) as Record<string, unknown>;
      const statusUrl = trimString(submitted['status_url']);
      const responseUrl = trimString(submitted['response_url']);
      if (!statusUrl || !responseUrl) throw new Error('fal response missing queue URLs');
      // The key is sent to these URLs, so they must be on the queue host the job was submitted to.
      const queueHost = new URL(queueBase).host;
      const queueUrl = (value: string): string => {
        let host: string | undefined;
        try { host = new URL(value).host; } catch { /* reported below */ }
        if (host !== queueHost) throw new Error(`fal returned a queue URL outside ${queueHost}; it was not followed.`);
        return value;
      };
      const taskId = trimString(submitted['request_id']) ?? new URL(responseUrl).pathname.split('/').filter(Boolean).pop() ?? 'unknown';
      const cancelUrl = trimString(submitted['cancel_url']);
      return afterSubmission('fal', taskId, lifetime,
        cancelUrl ? () => cancelRemoteTask(queueUrl(cancelUrl), 'PUT', { Authorization: `Key ${apiKey}` }) : undefined,
        async () => {
          let completed: Record<string, unknown> | null = null;
          for (let attempt = 0; attempt < 120; attempt += 1) {
            const payload = await fetchJson(queueUrl(statusUrl), {
              method: 'GET',
              headers: { Authorization: `Key ${apiKey}` },
            }, 60_000) as Record<string, unknown>;
            const status = trimString(payload['status'])?.toUpperCase();
            if (status === 'COMPLETED') {
              completed = await fetchJson(queueUrl(responseUrl), {
                method: 'GET',
                headers: { Authorization: `Key ${apiKey}` },
              }, 60_000) as Record<string, unknown>;
              break;
            }
            if (status === 'FAILED' || status === 'CANCELLED') {
              throw new ProviderTaskEnded(trimString(payload['detail']) ?? trimString(asRecord(payload['error'])?.['message']) ?? 'fal generation failed');
            }
            await sleep(5_000);
          }
          if (!completed) throw new Error('fal generation timed out');
          const videoUrl = trimString(asRecord(completed['video'])?.['url'])
            ?? trimString(asRecord((Array.isArray(completed['videos']) ? (completed['videos'] as Array<Record<string, unknown>>)[0] : null))?.['url']);
          const imageUrl = trimString(asRecord(completed['image'])?.['url'])
            ?? trimString(asRecord((Array.isArray(completed['images']) ? (completed['images'] as Array<Record<string, unknown>>)[0] : null))?.['url']);
          const finalUrl = isImage ? imageUrl ?? videoUrl : videoUrl ?? imageUrl;
          if (!finalUrl) throw new Error('fal generation completed without an output URL');
          return {
            providerId: 'fal',
            artifacts: [isImage ? await inferImageArtifact('fal', finalUrl) : await inferVideoArtifact('fal', finalUrl)],
            metadata: { model: path, taskId },
          };
        });
    },
  };
}

/**
 * A workflow file is posted to the Comfy server, so only files under the working
 * directory or COMFY_WORKFLOW_DIR are read, and a parse failure never quotes the file.
 */
async function readWorkflowFile(workflowPath: string): Promise<Record<string, unknown>> {
  const { readFileSync, realpathSync } = await import('node:fs');
  const { resolve, sep } = await import('node:path');
  const roots = [process.cwd(), trimString(process.env['COMFY_WORKFLOW_DIR'])].filter((root): root is string => root !== undefined)
    .map((root) => realpathSync(resolve(root)));
  let real: string;
  try { real = realpathSync(resolve(workflowPath)); } catch { throw new Error('Comfy options.workflowPath does not name a readable file.'); }
  if (!roots.some((root) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep))) {
    throw new Error('Comfy options.workflowPath must be inside the working directory or COMFY_WORKFLOW_DIR.');
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(real, 'utf-8'));
    const record = asRecord(parsed);
    if (record) return record;
  } catch { /* reported without the file's content below */ }
  throw new Error('Comfy workflow file is not a JSON object.');
}

function createComfyProvider(): MediaProvider {
  const envVars = ['COMFY_API_KEY'] as const;
  return {
    id: 'comfy',
    label: 'Comfy',
    capabilities: ['generate'],
    status() {
      const configured = Boolean(trimString(process.env['COMFY_BASE_URL']) || readFirstEnv(envVars));
      return buildStatus(
        'comfy',
        'Comfy',
        configured,
        configured
          ? 'COMFY_BASE_URL or COMFY_API_KEY is set; the server is not contacted to check it. Generation also needs options.workflow or options.workflowPath.'
          : 'Comfy expects COMFY_BASE_URL plus options.workflow or options.workflowPath; COMFY_API_KEY is optional for cloud deployments.',
      );
    },
    async generate(request: MediaGenerationRequest, lifetime: DeliveryLifetime = {}): Promise<MediaGenerationResult> {
      const { fetchJson, inferVideoArtifact, inferImageArtifact, sleep } = generationTransport(lifetime, [...envVars, 'COMFY_BASE_URL']);
      const options = asRecord(request.options) ?? {};
      const baseUrl = comfyBaseUrl(options);
      const cloud = new URL(baseUrl).hostname === COMFY_CLOUD_HOST;
      const apiKey = readFirstEnv(envVars);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers['x-api-key'] = apiKey;
      const workflowInline = asRecord(options['workflow']);
      let workflow = workflowInline;
      if (!workflow) {
        const workflowPath = trimString(options['workflowPath']);
        if (!workflowPath) throw new Error('Comfy generation requires options.workflow or options.workflowPath.');
        workflow = await readWorkflowFile(workflowPath);
      }
      const reference = resolveReferenceArtifact(request);
      if (reference && trimString(options['inputImageNodeId']) && reference.dataBase64) {
        const inputImageNodeId = trimString(options['inputImageNodeId'])!;
        const node = asRecord(workflow[inputImageNodeId]);
        const inputs = asRecord(node?.['inputs']);
        if (inputs) {
          inputs['image'] = `data:${reference.mimeType};base64,${reference.dataBase64}`;
        }
      }
      const endpoint = cloud ? '/api/prompt' : '/prompt';
      const submitted = await fetchJson(`${baseUrl.replace(/\/+$/, '')}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          prompt: workflow,
          ...(apiKey && cloud ? { extra_data: { api_key_comfy_org: apiKey } } : {}),
        }),
      }) as Record<string, unknown>;
      const taskId = trimString(submitted['prompt_id']) ?? trimString(submitted['id']);
      if (!taskId) throw new Error('Comfy response missing task id');
      return afterSubmission('Comfy', taskId, lifetime, undefined, async () => {
      let outputs: Array<Record<string, unknown>> = [];
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const historyPath = cloud ? `/api/history_v2/${taskId}` : `/history/${taskId}`;
        const payload = await fetchJson(`${baseUrl.replace(/\/+$/, '')}${historyPath}`, {
          method: 'GET',
          ...(apiKey ? { headers: { 'x-api-key': apiKey } } : {}),
        } as RequestInit, 60_000) as Record<string, unknown>;
        const reported = trimString(payload['status'])?.toLowerCase();
        if (reported === 'failed' || reported === 'error' || reported === 'cancelled') throw new ProviderTaskEnded(`Comfy generation ${reported}`);
        if (cloud) {
          const records = Array.isArray(payload['outputs']) ? payload['outputs'] as Array<Record<string, unknown>> : [];
          if (records.length > 0) {
            outputs = records;
            break;
          }
        } else {
          const record = asRecord(payload[taskId]);
          if (trimString(asRecord(record?.['status'])?.['status_str'])?.toLowerCase() === 'error') throw new ProviderTaskEnded('Comfy generation failed');
          const outputRecord = asRecord(record?.['outputs']);
          // Image nodes report `images`; video nodes report `gifs` or `videos`.
          const flattened = outputRecord
            ? Object.values(outputRecord).flatMap((value) => ['images', 'gifs', 'videos'].flatMap((key) => Array.isArray(asRecord(value)?.[key]) ? (asRecord(value)?.[key] as unknown[]) : []))
            : [];
          if (flattened.length > 0) {
            outputs = flattened.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null) as Array<Record<string, unknown>>;
            break;
          }
        }
        await sleep(5_000);
      }
      if (outputs.length === 0) throw new Error('Comfy generation timed out');
      const artifacts: MediaArtifact[] = [];
      for (const entry of outputs) {
        const remoteUrl = trimString(entry['url']);
        if (remoteUrl) {
          artifacts.push((request.outputMimeType?.startsWith('video/') ?? false) ? await inferVideoArtifact('comfy', remoteUrl) : await inferImageArtifact('comfy', remoteUrl));
          continue;
        }
        const filename = trimString(entry['filename']);
        if (!filename) continue;
        const viewPath = cloud
          ? `/api/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(trimString(entry['subfolder']) ?? '')}&type=${encodeURIComponent(trimString(entry['type']) ?? 'output')}`
          : `/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(trimString(entry['subfolder']) ?? '')}&type=${encodeURIComponent(trimString(entry['type']) ?? 'output')}`;
        const remote = `${baseUrl.replace(/\/+$/, '')}${viewPath}`;
        artifacts.push((request.outputMimeType?.startsWith('video/') ?? false) ? await inferVideoArtifact('comfy', remote) : await inferImageArtifact('comfy', remote));
      }
      if (artifacts.length === 0) throw new Error('Comfy generation completed without downloadable artifacts');
      return {
        providerId: 'comfy',
        artifacts,
        metadata: { taskId },
      };
      });
    },
  };
}

export function builtinGenerationProviders(): readonly MediaProvider[] {
  return [
    createByteplusProvider(),
    createRunwayProvider(),
    createAlibabaProvider(),
    createFalProvider(),
    createComfyProvider(),
  ];
}
