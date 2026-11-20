import type {
  MediaArtifact,
  MediaCollectOptions,
  MediaGenerationRequest,
  MediaGenerationResult,
  MediaOutputKind,
  MediaGenerationProvider,
  MediaProviderStatus,
  MediaProviderTask,
} from './provider-registry.js';
import { revealOrNull } from '../security/secret.js';
import { mediaOutputKindOf } from './provider-registry.js';
import type { ArtifactStore } from '../artifacts/index.js';
import type { SecretsManager } from '../config/secrets.js';
import { instrumentedFetch } from '../utils/fetch-with-timeout.js';
import { assertDeliveryCurrent, type DeliveryLifetime } from '../utils/delivery-lifetime.js';
import { isRecord } from '../utils/record-coerce.js';
import { classifyFailure, RefusalError, refusal } from '@goodvibes/engine/errors';
import { fetchFailurePhase } from '../state/operation.js';

/** What the built-in generation providers are given by the product that registers them. */
export interface MediaGenerationDeps {
  /** A key saved here is used when its environment variable is unset. */
  readonly secrets?: Pick<SecretsManager, 'get' | 'revisionSource'> | undefined;
  /** Outputs are streamed here; without it an output is returned as the provider's URL. */
  readonly artifactStore?: Pick<ArtifactStore, 'createFromStream'> | undefined;
}

/** How long a request waits for the job by default before answering pending. */
const DEFAULT_WAIT_MS = 600_000;
/** Consecutive poll failures a status code or errno marks as transient before the wait gives up. */
const MAX_TRANSIENT_POLL_FAILURES = 5;
const OUTPUT_DOWNLOAD_TIMEOUT_MS = 300_000;

function readFirstEnv(envVars: readonly string[]): string | null {
  for (const envVar of envVars) {
    const value = process.env[envVar];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * One provider's key: the environment first, then the secret store. A stored
 * key is read once per secret-store revision, so a send after the first costs
 * an integer compare.
 */
class ProviderKey {
  #stored: { readonly revision: number; readonly value: string | null } | undefined;

  constructor(private readonly names: readonly string[], private readonly secrets: MediaGenerationDeps['secrets']) {}

  /** No I/O: the environment, or a stored key read at the current revision. */
  known(): string | null {
    const env = readFirstEnv(this.names);
    if (env) return env;
    const stored = this.#stored;
    return stored && this.secrets && stored.revision === this.secrets.revisionSource.revision() ? stored.value : null;
  }

  async resolve(): Promise<string | null> {
    const env = readFirstEnv(this.names);
    if (env || !this.secrets) return env;
    const revision = this.secrets.revisionSource.revision();
    if (this.#stored?.revision === revision) return this.#stored.value;
    let value: string | null = null;
    for (const name of this.names) {
      const stored = revealOrNull(await this.secrets.get(name), 'dispatch')?.trim();
      if (stored) { value = stored; break; }
    }
    this.#stored = { revision, value };
    return value;
  }
}

/** Whether the caller still wants this delivery (not cancelled, still current). */
function deliveryStillCurrent(lifetime: DeliveryLifetime): boolean {
  try { assertDeliveryCurrent(lifetime); return true; } catch { return false; }
}

/** A job the provider itself reported as failed or cancelled, or finished without a usable output: nothing is left running. */
class ProviderTaskEnded extends Error {}

/**
 * Runs everything that follows a successful submission. The job is paid for and
 * keeps running remotely, so any failure names the provider and task id (the
 * only handle for finding or cancelling it) on the thrown error, and an abort
 * cancels the remote job when the provider has a cancel call.
 */
async function afterSubmission<T>(
  label: string,
  task: MediaProviderTask,
  signal: AbortSignal | undefined,
  cancel: (() => Promise<unknown>) | undefined,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    let note: string | undefined;
    if (!(error instanceof ProviderTaskEnded)) {
      note = `${label} task ${task.taskId} was submitted and may still be running; collect it with this task id`;
      if (signal?.aborted && cancel) {
        try { await cancel(); note = `${label} task ${task.taskId} was cancelled because the request was aborted`; }
        catch { note = `${label} task ${task.taskId} may still be running; cancelling it failed`; }
      }
    }
    const providerTask = { providerId: task.providerId, taskId: task.taskId };
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
 * A base URL receives the provider's API key, so it must stay on the vendor's
 * own domain over https. A collect request's resume data passes through here too.
 */
function vendorBaseUrl(requested: string | undefined, defaultBaseUrl: string, vendor: string): string {
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
 * The API key goes to this host, so a per-request base URL may only name the
 * configured server (COMFY_BASE_URL, else the local default) or Comfy Cloud over https.
 */
function comfyBaseUrl(requested: string | undefined): string {
  const configured = trimString(process.env['COMFY_BASE_URL']) ?? 'http://127.0.0.1:8188';
  let allowed: URL;
  try { allowed = new URL(configured); } catch { throw new Error('COMFY_BASE_URL is not a valid URL.'); }
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

function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

interface ResolvedReference {
  readonly url: string;
  readonly kind: 'image' | 'video';
  readonly artifact?: MediaArtifact | undefined;
}

function resolveReferenceArtifact(options: Record<string, unknown>): MediaArtifact | null {
  const candidate = asRecord(options['referenceArtifact']) ?? asRecord(options['sourceArtifact']);
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

const VIDEO_EXTENSION = /\.(?:mp4|mov|webm|mkv|avi|m4v)(?:$|[?#])/i;

/** Every way a request can name a reference, with the kind it is, so no provider drops or mistypes one. */
function resolveReference(options: Record<string, unknown>): ResolvedReference | undefined {
  const video = trimString(options['videoUrl']);
  if (video) return { url: video, kind: 'video' };
  const image = trimString(options['imageUrl']);
  if (image) return { url: image, kind: 'image' };
  const reference = trimString(options['referenceUrl']);
  if (reference) {
    const declared = mediaOutputKindOf(trimString(options['referenceMimeType']));
    const kind = declared === 'video' || (declared === undefined && (reference.startsWith('data:video/') || VIDEO_EXTENSION.test(reference))) ? 'video' : 'image';
    return { url: reference, kind };
  }
  const artifact = resolveReferenceArtifact(options);
  if (!artifact) return undefined;
  const url = artifact.uri?.trim() || (artifact.dataBase64?.trim() ? `data:${artifact.mimeType};base64,${artifact.dataBase64.trim()}` : undefined);
  if (!url) return undefined;
  return { url, kind: artifact.mimeType.startsWith('video/') ? 'video' : 'image', artifact };
}

function httpFailure(label: string, status: number, retryAfter: string | null): Error {
  const seconds = retryAfter ? Number.parseInt(retryAfter, 10) : Number.NaN;
  return Object.assign(new Error(`${label} request failed (${status}).`), {
    status,
    ...(Number.isFinite(seconds) && seconds >= 0 ? { retryAfterMs: seconds * 1000 } : {}),
  });
}

/** Request plumbing shared by every provider: the caller's signal and fence on every request. */
interface Transport {
  readonly signal: AbortSignal | undefined;
  response(url: string, init: RequestInit, timeoutMs?: number): Promise<Response>;
  json(url: string, init: RequestInit, timeoutMs?: number): Promise<unknown>;
  sleep(delayMs: number): Promise<void>;
}

/** The provider may have taken a job whose answer this request never read: it may be running and charged, with no task id here. */
function submissionOutcomeUnknown(label: string, cause: unknown): RefusalError {
  return new RefusalError(refusal({
    code: 'MEDIA_SUBMIT_OUTCOME_UNKNOWN',
    state: `the job was sent to ${label}; whether it was accepted is not known`,
    reason: `${label}'s answer to the submission was not read (${cause instanceof Error ? cause.message : String(cause)}), so no task id is known`,
    next: [`Look for the job in ${label}'s own console before submitting it again: it may be running and charged`],
    retryable: false,
  }), { cause });
}

/**
 * `follow` (polling, downloads): the caller's cancellation aborts a request in
 * flight and is checked before and after each one. `submit`: a cancellation is
 * checked before the request is sent, but once it is sent the answer is read
 * whatever happens to the caller, because an accepted job is paid for and its
 * task id is the only handle on it; a submission whose answer cannot be read
 * is reported as of unknown outcome, never as not sent.
 */
function transportFor(label: string, lifetime: DeliveryLifetime, phase: 'submit' | 'follow' = 'follow'): Transport {
  const response = async (url: string, init: RequestInit, timeoutMs = 120_000): Promise<Response> => {
    assertDeliveryCurrent(lifetime);
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = phase === 'follow' && lifetime.signal ? AbortSignal.any([deadline, lifetime.signal]) : deadline;
    let answered: Response;
    try {
      answered = await instrumentedFetch(url, { ...init, signal });
    } catch (error) {
      if (phase === 'submit' && fetchFailurePhase(error) === 'sent') throw submissionOutcomeUnknown(label, error);
      throw error;
    }
    if (phase === 'follow') assertDeliveryCurrent(lifetime);
    if (!answered.ok) {
      try { await answered.body?.cancel(); } catch { /* the status is what is reported */ }
      throw httpFailure(label, answered.status, answered.headers.get('retry-after'));
    }
    return answered;
  };
  return {
    signal: lifetime.signal,
    response,
    async json(url, init, timeoutMs) {
      const answered = await response(url, init, timeoutMs);
      let result: unknown;
      try { result = await answered.json(); } catch (error) {
        if (phase === 'submit') throw submissionOutcomeUnknown(label, error);
        throw error;
      }
      if (phase === 'follow') assertDeliveryCurrent(lifetime);
      return result;
    },
    async sleep(delayMs) {
      const signal = lifetime.signal;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Media generation cancelled.', 'AbortError')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delayMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      assertDeliveryCurrent(lifetime);
    },
  };
}

/** One output a finished job reported. `headers` go only to the URL the provider built from its own base. */
interface OutputRef {
  readonly url: string;
  readonly kind: MediaOutputKind;
  readonly headers?: Record<string, string> | undefined;
}

type PollStep =
  | { readonly state: 'running' }
  | { readonly state: 'done'; readonly outputs: readonly OutputRef[] }
  | { readonly state: 'ended'; readonly message: string };

/**
 * Waits for a submitted job. A poll that fails with a transient status or errno
 * (429, 5xx, a reset, a per-request timeout) is retried on the next interval,
 * up to five in a row; the wait ends at the deadline with the job still owned
 * by its task id, never with its result thrown away.
 */
export async function pollTask<T>(
  poll: () => Promise<{ readonly state: 'running' } | { readonly state: 'done'; readonly value: T } | { readonly state: 'ended'; readonly message: string }>,
  options: { readonly deadline: number; readonly intervalMs: number; readonly sleep: (ms: number) => Promise<void>; readonly signal?: AbortSignal | undefined },
): Promise<{ readonly done: true; readonly value: T } | { readonly done: false }> {
  let transientFailures = 0;
  // The first check always runs, so a zero wait polls once as documented; later ones only while time is left.
  let polled = false;
  for (;;) {
    options.signal?.throwIfAborted();
    if (polled && Date.now() >= options.deadline) return { done: false };
    polled = true;
    let step: Awaited<ReturnType<typeof poll>> | undefined;
    try {
      step = await poll();
      transientFailures = 0;
    } catch (error) {
      if (options.signal?.aborted || error instanceof ProviderTaskEnded) throw error;
      const failure = classifyFailure(error);
      if (!failure?.retryable || ++transientFailures > MAX_TRANSIENT_POLL_FAILURES) throw error;
      const remaining = options.deadline - Date.now();
      if (remaining <= 0) return { done: false };
      await options.sleep(Math.min(Math.max(failure.retryAfterMs ?? options.intervalMs, options.intervalMs), remaining));
      continue;
    }
    if (step.state === 'done') return { done: true, value: step.value };
    if (step.state === 'ended') throw new ProviderTaskEnded(step.message);
    const remaining = options.deadline - Date.now();
    if (remaining <= 0) return { done: false };
    await options.sleep(Math.min(options.intervalMs, remaining));
  }
}

function waitMsFrom(value: unknown): number {
  const seconds = asNumber(value);
  return seconds === undefined ? DEFAULT_WAIT_MS : Math.max(0, Math.min(seconds * 1000, 3_600_000));
}

const OUTPUT_KINDS: readonly MediaOutputKind[] = ['image', 'video', 'audio'];

const DEFAULT_MIME: Record<MediaOutputKind, { readonly mimeType: string; readonly extension: string }> = {
  image: { mimeType: 'image/png', extension: 'png' },
  video: { mimeType: 'video/mp4', extension: 'mp4' },
  audio: { mimeType: 'audio/mpeg', extension: 'mp3' },
};

/** Streams one output into the artifact store, or, with no store, names the provider's URL. */
async function deliverOutput(
  providerId: string,
  output: OutputRef,
  index: number,
  transport: Transport,
  artifactStore: MediaGenerationDeps['artifactStore'],
): Promise<MediaArtifact> {
  const fallback = DEFAULT_MIME[output.kind];
  const filename = `${providerId}-${index + 1}.${fallback.extension}`;
  const metadata = { source: 'media-generation-provider', sourceProviderId: providerId, sourceUrl: output.url };
  if (!artifactStore) {
    return { uri: output.url, mimeType: fallback.mimeType, filename, metadata: { ...metadata, retrievalMethod: 'remote-reference' } };
  }
  const response = await transport.response(output.url, { method: 'GET', ...(output.headers ? { headers: output.headers } : {}) }, OUTPUT_DOWNLOAD_TIMEOUT_MS);
  const length = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  const descriptor = await artifactStore.createFromStream({
    stream: response.body ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
    mimeType: response.headers.get('content-type')?.split(';')[0]?.trim() || fallback.mimeType,
    filename,
    sourceUri: output.url,
    ...(Number.isFinite(length) && length >= 0 ? { sizeBytes: length } : {}),
    metadata,
  }, { signal: transport.signal });
  return {
    id: descriptor.id,
    artifactId: descriptor.id,
    uri: output.url,
    mimeType: descriptor.mimeType,
    ...(descriptor.filename ? { filename: descriptor.filename } : {}),
    sizeBytes: descriptor.sizeBytes,
    metadata: { ...metadata, retrievalMethod: 'stored' },
  };
}

interface SubmitContext {
  readonly key: string | null;
  readonly options: Record<string, unknown>;
  readonly transport: Transport;
}

interface PollContext {
  readonly key: string | null;
  readonly transport: Transport;
}

interface Submitted {
  readonly taskId: string;
  readonly resume: Record<string, string>;
  readonly model?: string | undefined;
}

/** Everything that differs between providers; submission, waiting, collecting and storing are shared. */
interface GenerationSpec {
  readonly id: string;
  readonly label: string;
  readonly outputs: readonly MediaOutputKind[];
  readonly keyNames: readonly string[];
  /** Comfy runs without a key on a local server. */
  readonly keyOptional?: boolean;
  readonly intervalMs: number;
  configured(key: string | null): boolean;
  detail(configured: boolean): string;
  submit(request: MediaGenerationRequest, kind: MediaOutputKind, context: SubmitContext): Promise<Submitted>;
  poll(task: MediaProviderTask, context: PollContext): Promise<PollStep>;
  cancel?(task: MediaProviderTask, key: string | null): Promise<void>;
}

function refuseOutput(spec: GenerationSpec, kind: MediaOutputKind): RefusalError {
  return new RefusalError(refusal({
    code: 'MEDIA_OUTPUT_UNSUPPORTED',
    state: `${spec.label} makes ${spec.outputs.join(' and ')}`,
    reason: `${spec.label} makes ${spec.outputs.join(' and ')}, not ${kind}; nothing was sent to it`,
    next: [`Ask for ${spec.outputs.join(' or ')}, or name a provider that makes ${kind}`],
    status: 400,
  }));
}

function refuseMissingKey(spec: GenerationSpec): RefusalError {
  return new RefusalError(refusal({
    code: 'PROVIDER_NOT_CONFIGURED',
    state: `${spec.label} has no API key`,
    reason: `${spec.label} has no API key (${spec.keyNames.join(' or ')}); nothing was sent`,
    next: [`Set ${spec.keyNames.join(' or ')} in the environment or the secret store`],
    status: 409,
  }));
}

function requestedKind(spec: GenerationSpec, request: MediaGenerationRequest, options: Record<string, unknown>): MediaOutputKind {
  const kind = mediaOutputKindOf(request.outputMimeType) ?? (asBool(options['image']) === true ? 'image' : undefined) ?? spec.outputs[0]!;
  if (!spec.outputs.includes(kind)) throw refuseOutput(spec, kind);
  return kind;
}

function createGenerationProvider(spec: GenerationSpec, deps: MediaGenerationDeps): MediaGenerationProvider {
  const key = new ProviderKey(spec.keyNames, deps.secrets);
  const status = (configured: boolean): MediaProviderStatus => ({
    id: spec.id,
    label: spec.label,
    state: configured ? 'healthy' : 'unconfigured',
    capabilities: ['generate'],
    configured,
    detail: spec.detail(configured),
    // Status reads local configuration only; the provider is not contacted.
    metadata: { verified: false, outputs: [...spec.outputs] },
  });

  /** The provider accepted the job and then the request was cancelled: the remote job is cancelled when the provider can, and the task stays in the result either way. */
  const acceptedThenCancelled = async (task: MediaProviderTask, keyValue: string | null, model: string | undefined): Promise<MediaGenerationResult> => {
    let cancelled = false;
    if (spec.cancel) {
      try { await spec.cancel(task, keyValue); cancelled = true; } catch { cancelled = false; }
    }
    return {
      providerId: spec.id,
      artifacts: [],
      pending: task,
      metadata: {
        taskId: task.taskId,
        ...(model ? { model } : {}),
        state: cancelled ? 'cancelled' : 'pending',
        note: cancelled
          ? `${spec.label} accepted task ${task.taskId} before the request was cancelled; the task was then cancelled at ${spec.label}`
          : `${spec.label} accepted task ${task.taskId} before the request was cancelled; it may still run and be charged: collect it with this task id${spec.cancel ? ' (cancelling it there failed)' : ''}`,
      },
    };
  };

  const finish = async (task: MediaProviderTask, keyValue: string | null, transport: Transport, waitMs: number, model: string | undefined): Promise<MediaGenerationResult> =>
    afterSubmission(spec.label, task, transport.signal, spec.cancel ? () => spec.cancel!(task, keyValue) : undefined, async () => {
      const waited = await pollTask(async () => {
        const step = await spec.poll(task, { key: keyValue, transport });
        return step.state === 'done' ? { state: 'done' as const, value: step.outputs } : step;
      }, { deadline: Date.now() + waitMs, intervalMs: spec.intervalMs, sleep: transport.sleep, signal: transport.signal });
      const metadata = { taskId: task.taskId, ...(model ? { model } : {}) };
      if (!waited.done) {
        return { providerId: spec.id, artifacts: [], pending: task, metadata: { ...metadata, state: 'pending' } };
      }
      const artifacts: MediaArtifact[] = [];
      for (const [index, output] of waited.value.entries()) {
        artifacts.push(await deliverOutput(spec.id, output, index, transport, deps.artifactStore));
      }
      return { providerId: spec.id, artifacts, metadata };
    });

  return {
    id: spec.id,
    label: spec.label,
    capabilities: ['generate'],
    outputs: spec.outputs,
    isConfigured: () => spec.configured(key.known()),
    resolveConfigured: async () => spec.configured(await key.resolve()),
    async status() {
      return status(spec.configured(await key.resolve()));
    },
    async generate(request: MediaGenerationRequest, lifetime: DeliveryLifetime = {}): Promise<MediaGenerationResult> {
      const options = asRecord(request.options) ?? {};
      const kind = requestedKind(spec, request, options);
      const keyValue = await key.resolve();
      if (!keyValue && !spec.keyOptional) throw refuseMissingKey(spec);
      const submitted = await spec.submit(request, kind, { key: keyValue, options, transport: transportFor(spec.label, lifetime, 'submit') });
      const task: MediaProviderTask = { providerId: spec.id, taskId: submitted.taskId, resume: { ...submitted.resume, output: kind } };
      // Cancelled while the provider was answering: the job was accepted, so the result carries its task id instead of an error.
      if (!deliveryStillCurrent(lifetime)) return await acceptedThenCancelled(task, keyValue, submitted.model);
      return finish(task, keyValue, transportFor(spec.label, lifetime), waitMsFrom(options['waitSeconds']), submitted.model);
    },
    async collect(task: MediaProviderTask, options: MediaCollectOptions = {}, lifetime: DeliveryLifetime = {}): Promise<MediaGenerationResult> {
      const taskId = trimString(task.taskId);
      if (task.providerId !== spec.id || !taskId) {
        throw new RefusalError(refusal({
          code: 'MEDIA_TASK_INVALID',
          state: `the task names ${task.providerId || 'no provider'}${taskId ? '' : ' and no task id'}`,
          reason: `${spec.label} can only collect its own jobs by task id`,
          next: ['Pass the pending result exactly as the generation returned it'],
          status: 400,
        }));
      }
      const keyValue = await key.resolve();
      if (!keyValue && !spec.keyOptional) throw refuseMissingKey(spec);
      const resume = { ...(task.resume ?? {}) };
      const output = OUTPUT_KINDS.find((kind) => kind === resume['output']) ?? spec.outputs[0]!;
      if (!spec.outputs.includes(output)) throw refuseOutput(spec, output);
      return finish({ providerId: spec.id, taskId, resume: { ...resume, output } }, keyValue, transportFor(spec.label, lifetime), waitMsFrom(options.waitSeconds), resume['model']);
    },
  };
}

function refuseVideoReference(label: string): RefusalError {
  return new RefusalError(refusal({
    code: 'MEDIA_REFERENCE_UNSUPPORTED',
    state: `${label} takes an image as the first frame`,
    reason: `${label} takes an image as the first frame, not a video reference; nothing was sent to it`,
    next: ['Pass an image reference (options.imageUrl or an image referenceArtifact), or use runway for video-to-video'],
    status: 400,
  }));
}

function bytePlusSpec(): GenerationSpec {
  const defaultBaseUrl = 'https://ark.ap-southeast.bytepluses.com/api/v3';
  const base = (requested: string | undefined) => trimBase(vendorBaseUrl(requested, defaultBaseUrl, 'BytePlus'));
  const taskUrl = (task: MediaProviderTask) => `${base(task.resume?.['baseUrl'])}/contents/generations/tasks/${encodeURIComponent(task.taskId)}`;
  return {
    id: 'byteplus',
    label: 'BytePlus',
    outputs: ['video'],
    keyNames: ['BYTEPLUS_API_KEY'],
    intervalMs: 5_000,
    configured: (key) => key !== null,
    detail: (configured) => configured
      ? 'BytePlus video generation key available.'
      : 'Set BYTEPLUS_API_KEY to enable BytePlus video generation.',
    async submit(request, _kind, { key, options, transport }) {
      const baseUrl = base(trimString(options['baseUrl']));
      const model = trimString(request.modelId) ?? trimString(options['model']) ?? 'seedance-1-0-lite-t2v-250428';
      const reference = resolveReference(options);
      if (reference?.kind === 'video') throw refuseVideoReference('BytePlus');
      const content: Array<Record<string, unknown>> = [{ type: 'text', text: request.prompt }];
      if (reference) content.push({ type: 'image_url', image_url: { url: reference.url }, role: 'first_frame' });
      const submitted = await transport.json(`${baseUrl}/contents/generations/tasks`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
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
      return { taskId, model, resume: { model, ...(baseUrl !== defaultBaseUrl ? { baseUrl } : {}) } };
    },
    async poll(task, { key, transport }) {
      const payload = asRecord(await transport.json(taskUrl(task), { method: 'GET', headers: { Authorization: `Bearer ${key}` } }, 60_000)) ?? {};
      const status = trimString(payload['status'])?.toLowerCase();
      if (status === 'failed' || status === 'cancelled') {
        return { state: 'ended', message: trimString(asRecord(payload['error'])?.['message']) ?? 'BytePlus generation failed' };
      }
      if (status !== 'succeeded') return { state: 'running' };
      const content = asRecord(payload['content']);
      const url = trimString(content?.['video_url']) ?? trimString(content?.['file_url']);
      if (!url) return { state: 'ended', message: 'BytePlus generation completed without a video URL' };
      return { state: 'done', outputs: [{ url, kind: 'video' }] };
    },
    cancel: (task, key) => cancelRemoteTask(taskUrl(task), 'DELETE', { Authorization: `Bearer ${key}` }),
  };
}

function runwaySpec(): GenerationSpec {
  const defaultBaseUrl = 'https://api.dev.runwayml.com';
  const base = (requested: string | undefined) => trimBase(vendorBaseUrl(requested, defaultBaseUrl, 'Runway'));
  const headers = (key: string | null) => ({ Authorization: `Bearer ${key}`, 'X-Runway-Version': '2024-11-06' });
  const taskUrl = (task: MediaProviderTask) => `${base(task.resume?.['baseUrl'])}/v1/tasks/${encodeURIComponent(task.taskId)}`;
  return {
    id: 'runway',
    label: 'Runway',
    outputs: ['video'],
    keyNames: ['RUNWAYML_API_SECRET', 'RUNWAY_API_KEY'],
    intervalMs: 5_000,
    configured: (key) => key !== null,
    detail: (configured) => configured
      ? 'Runway video generation key available.'
      : 'Set RUNWAYML_API_SECRET or RUNWAY_API_KEY to enable Runway video generation.',
    async submit(request, _kind, { key, options, transport }) {
      const baseUrl = base(trimString(options['baseUrl']));
      const model = trimString(request.modelId) ?? trimString(options['model']) ?? 'gen4.5';
      // The endpoint follows the reference however it was named, so an image or video given by URL is never dropped.
      const reference = resolveReference(options);
      const endpoint = !reference ? '/v1/text_to_video' : reference.kind === 'video' ? '/v1/video_to_video' : '/v1/image_to_video';
      const body: Record<string, unknown> = {
        model,
        promptText: request.prompt,
        ratio: trimString(options['size']) ?? trimString(options['aspectRatio']) ?? '1280:720',
        duration: asNumber(options['durationSeconds']) != null ? Math.max(2, Math.round(asNumber(options['durationSeconds'])!)) : 5,
      };
      if (reference?.kind === 'image') body['promptImage'] = reference.url;
      if (reference?.kind === 'video') body['videoUri'] = reference.url;
      const submitted = await transport.json(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { ...headers(key), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }) as { id?: string };
      const taskId = trimString(submitted.id);
      if (!taskId) throw new Error('Runway response missing task id');
      return { taskId, model, resume: { model, ...(baseUrl !== defaultBaseUrl ? { baseUrl } : {}) } };
    },
    async poll(task, { key, transport }) {
      const payload = asRecord(await transport.json(taskUrl(task), { method: 'GET', headers: headers(key) }, 60_000)) ?? {};
      const status = trimString(payload['status'])?.toUpperCase();
      if (status === 'FAILED' || status === 'CANCELLED') return { state: 'ended', message: trimString(payload['failure']) ?? 'Runway generation failed' };
      if (status !== 'SUCCEEDED') return { state: 'running' };
      const urls = Array.isArray(payload['output'])
        ? (payload['output'] as unknown[]).filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : [];
      if (urls.length === 0) return { state: 'ended', message: 'Runway generation completed without output URLs' };
      return { state: 'done', outputs: urls.map((url) => ({ url, kind: 'video' as const })) };
    },
    cancel: (task, key) => cancelRemoteTask(taskUrl(task), 'DELETE', headers(key)),
  };
}

function alibabaSpec(): GenerationSpec {
  const defaultBaseUrl = 'https://dashscope-intl.aliyuncs.com';
  const base = (requested: string | undefined) => trimBase(vendorBaseUrl(requested, defaultBaseUrl, 'Alibaba'));
  const taskUrl = (task: MediaProviderTask) => `${base(task.resume?.['baseUrl'])}/api/v1/tasks/${encodeURIComponent(task.taskId)}`;
  return {
    id: 'alibaba',
    label: 'Alibaba Model Studio',
    outputs: ['video'],
    keyNames: ['MODELSTUDIO_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
    intervalMs: 2_500,
    configured: (key) => key !== null,
    detail: (configured) => configured
      ? 'Alibaba video generation key available.'
      : 'Set MODELSTUDIO_API_KEY, DASHSCOPE_API_KEY, or QWEN_API_KEY to enable Alibaba video generation.',
    async submit(request, _kind, { key, options, transport }) {
      const baseUrl = base(trimString(options['baseUrl']));
      const model = trimString(request.modelId) ?? trimString(options['model']) ?? 'wan2.6-t2v';
      const reference = resolveReference(options);
      if (reference?.kind === 'video') throw refuseVideoReference('Alibaba Model Studio');
      const submitted = await transport.json(`${baseUrl}/api/v1/services/aigc/video-generation/video-synthesis`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' },
        body: JSON.stringify({
          model,
          input: { prompt: request.prompt, ...(reference ? { img_url: reference.url } : {}) },
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
      return { taskId, model, resume: { model, ...(baseUrl !== defaultBaseUrl ? { baseUrl } : {}) } };
    },
    async poll(task, { key, transport }) {
      const payload = asRecord(await transport.json(taskUrl(task), { method: 'GET', headers: { Authorization: `Bearer ${key}` } }, 60_000)) ?? {};
      const output = asRecord(payload['output']);
      const status = trimString(output?.['task_status'])?.toUpperCase();
      if (status === 'FAILED' || status === 'CANCELED') return { state: 'ended', message: trimString(output?.['message']) ?? 'Alibaba generation failed' };
      if (status !== 'SUCCEEDED') return { state: 'running' };
      const results = Array.isArray(output?.['results']) ? output?.['results'] as Array<Record<string, unknown>> : [];
      const urls = [...results.map((entry) => trimString(entry['video_url'])), trimString(output?.['video_url'])]
        .filter((entry): entry is string => Boolean(entry));
      if (urls.length === 0) return { state: 'ended', message: 'Alibaba generation completed without a video URL' };
      return { state: 'done', outputs: urls.map((url) => ({ url, kind: 'video' as const })) };
    },
    cancel: (task, key) => cancelRemoteTask(`${taskUrl(task)}/cancel`, 'POST', { Authorization: `Bearer ${key}` }),
  };
}

const FAL_DEFAULT_MODEL: Record<'image' | 'video', string> = { image: 'fal-ai/flux/dev', video: 'fal-ai/minimax/video-01-live' };

function falSpec(): GenerationSpec {
  const defaultBaseUrl = 'https://fal.run';
  const queueBase = (requested: string | undefined) => trimBase(vendorBaseUrl(requested, defaultBaseUrl, 'fal').replace('://fal.run', '://queue.fal.run'));
  // The key is sent to these URLs, so they must be on the queue host the job was submitted to.
  const queueUrl = (task: MediaProviderTask, name: 'statusUrl' | 'responseUrl' | 'cancelUrl'): string => {
    const value = task.resume?.[name];
    const host = new URL(queueBase(task.resume?.['baseUrl'])).host;
    let actual: string | undefined;
    try { actual = value ? new URL(value).host : undefined; } catch { /* reported below */ }
    if (!value || actual !== host) throw new Error(`fal returned a queue URL outside ${host}; it was not followed.`);
    return value;
  };
  return {
    id: 'fal',
    label: 'fal',
    outputs: ['image', 'video'],
    keyNames: ['FAL_KEY', 'FAL_API_KEY'],
    intervalMs: 5_000,
    configured: (key) => key !== null,
    detail: (configured) => configured
      ? 'fal API key available; makes images and video.'
      : 'Set FAL_KEY or FAL_API_KEY to enable fal image and video generation.',
    async submit(request, kind, { key, options, transport }) {
      const baseUrl = trimString(options['baseUrl']);
      const queue = queueBase(baseUrl);
      // The model asked for is the model used; a default applies only when none was named.
      const model = trimString(options['path']) ?? trimString(request.modelId) ?? trimString(options['model']) ?? FAL_DEFAULT_MODEL[kind === 'video' ? 'video' : 'image'];
      const reference = resolveReference(options);
      const submitted = asRecord(await transport.json(`${queue}/${model.replace(/^\/+/, '')}`, {
        method: 'POST',
        headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: request.prompt,
          ...(reference ? { [reference.kind === 'video' ? 'video_url' : 'image_url']: reference.url } : {}),
          ...(trimString(options['aspectRatio']) ? { aspect_ratio: trimString(options['aspectRatio']) } : {}),
          ...(trimString(options['size']) ? { size: trimString(options['size']) } : {}),
          ...(trimString(options['resolution']) ? { resolution: trimString(options['resolution']) } : {}),
          ...(asNumber(options['durationSeconds']) != null ? { duration: Math.max(1, Math.round(asNumber(options['durationSeconds'])!)) } : {}),
        }),
      }, 60_000)) ?? {};
      const statusUrl = trimString(submitted['status_url']);
      const responseUrl = trimString(submitted['response_url']);
      if (!statusUrl || !responseUrl) throw new Error('fal response missing queue URLs');
      const cancelUrl = trimString(submitted['cancel_url']);
      // Each queue address is checked against the queue host where it is followed, here and in a later collect.
      const resume = { model, statusUrl, responseUrl, ...(cancelUrl ? { cancelUrl } : {}), ...(baseUrl ? { baseUrl } : {}) };
      const taskId = trimString(submitted['request_id']) ?? new URL(responseUrl).pathname.split('/').filter(Boolean).pop() ?? 'unknown';
      return { taskId, model, resume };
    },
    async poll(task, { key, transport }) {
      const auth = { Authorization: `Key ${key}` };
      const payload = asRecord(await transport.json(queueUrl(task, 'statusUrl'), { method: 'GET', headers: auth }, 60_000)) ?? {};
      const status = trimString(payload['status'])?.toUpperCase();
      if (status === 'FAILED' || status === 'CANCELLED') {
        return { state: 'ended', message: trimString(payload['detail']) ?? trimString(asRecord(payload['error'])?.['message']) ?? 'fal generation failed' };
      }
      if (status !== 'COMPLETED') return { state: 'running' };
      const completed = asRecord(await transport.json(queueUrl(task, 'responseUrl'), { method: 'GET', headers: auth }, 60_000)) ?? {};
      const first = (single: string, plural: string) => trimString(asRecord(completed[single])?.['url'])
        ?? trimString(asRecord(Array.isArray(completed[plural]) ? (completed[plural] as unknown[])[0] : null)?.['url']);
      const kind = task.resume?.['output'] === 'video' ? 'video' : 'image';
      const url = kind === 'image' ? first('image', 'images') : first('video', 'videos');
      if (!url) {
        const other = kind === 'image' ? first('video', 'videos') : first('image', 'images');
        const model = task.resume?.['model'] ?? 'the model';
        return {
          state: 'ended',
          message: other
            ? `fal ${model} returned ${kind === 'image' ? 'video' : 'an image'}, not ${kind === 'image' ? 'an image' : 'video'}: it is not ${kind === 'image' ? 'an image' : 'a video'} model. Its output: ${other}`
            : 'fal generation completed without an output URL',
        };
      }
      return { state: 'done', outputs: [{ url, kind }] };
    },
    async cancel(task, key) {
      if (!task.resume?.['cancelUrl']) throw new Error('fal gave no cancel address');
      await cancelRemoteTask(queueUrl(task, 'cancelUrl'), 'PUT', { Authorization: `Key ${key}` });
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

function comfySpec(): GenerationSpec {
  return {
    id: 'comfy',
    label: 'Comfy',
    outputs: ['image', 'video'],
    keyNames: ['COMFY_API_KEY'],
    keyOptional: true,
    intervalMs: 5_000,
    configured: (key) => Boolean(trimString(process.env['COMFY_BASE_URL']) || key),
    detail: (configured) => configured
      ? 'COMFY_BASE_URL or COMFY_API_KEY is set; the server is not contacted to check it. Generation also needs options.workflow or options.workflowPath; what it makes depends on the workflow.'
      : 'Comfy expects COMFY_BASE_URL plus options.workflow or options.workflowPath; COMFY_API_KEY is optional for cloud deployments.',
    async submit(_request, _kind, { key, options, transport }) {
      const baseUrl = trimBase(comfyBaseUrl(trimString(options['baseUrl'])));
      const cloud = new URL(baseUrl).hostname === COMFY_CLOUD_HOST;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (key) headers['x-api-key'] = key;
      let workflow = asRecord(options['workflow']);
      if (!workflow) {
        const workflowPath = trimString(options['workflowPath']);
        if (!workflowPath) throw new Error('Comfy generation requires options.workflow or options.workflowPath.');
        workflow = await readWorkflowFile(workflowPath);
      }
      const reference = resolveReference(options);
      const inputImageNodeId = trimString(options['inputImageNodeId']);
      if (reference?.artifact?.dataBase64 && inputImageNodeId) {
        const inputs = asRecord(asRecord(workflow[inputImageNodeId])?.['inputs']);
        if (inputs) inputs['image'] = `data:${reference.artifact.mimeType};base64,${reference.artifact.dataBase64}`;
      }
      const submitted = asRecord(await transport.json(`${baseUrl}${cloud ? '/api/prompt' : '/prompt'}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt: workflow, ...(key && cloud ? { extra_data: { api_key_comfy_org: key } } : {}) }),
      })) ?? {};
      const taskId = trimString(submitted['prompt_id']) ?? trimString(submitted['id']);
      if (!taskId) throw new Error('Comfy response missing task id');
      return { taskId, resume: { ...(trimString(options['baseUrl']) ? { baseUrl } : {}) } };
    },
    async poll(task, { key, transport }) {
      const baseUrl = trimBase(comfyBaseUrl(task.resume?.['baseUrl']));
      const cloud = new URL(baseUrl).hostname === COMFY_CLOUD_HOST;
      const kind: MediaOutputKind = task.resume?.['output'] === 'video' ? 'video' : 'image';
      const auth = key ? { 'x-api-key': key } : undefined;
      const id = encodeURIComponent(task.taskId);
      const payload = asRecord(await transport.json(`${baseUrl}${cloud ? `/api/history_v2/${id}` : `/history/${id}`}`, {
        method: 'GET', ...(auth ? { headers: auth } : {}),
      }, 60_000)) ?? {};
      const reported = trimString(payload['status'])?.toLowerCase();
      if (reported === 'failed' || reported === 'error' || reported === 'cancelled') return { state: 'ended', message: `Comfy generation ${reported}` };
      let entries: Array<Record<string, unknown>> = [];
      if (cloud) {
        entries = Array.isArray(payload['outputs']) ? (payload['outputs'] as unknown[]).filter((entry): entry is Record<string, unknown> => isRecord(entry)) : [];
      } else {
        const record = asRecord(payload[task.taskId]);
        if (trimString(asRecord(record?.['status'])?.['status_str'])?.toLowerCase() === 'error') return { state: 'ended', message: 'Comfy generation failed' };
        const outputRecord = asRecord(record?.['outputs']);
        // Image nodes report `images`; video nodes report `gifs` or `videos`.
        entries = outputRecord
          ? Object.values(outputRecord).flatMap((value) => ['images', 'gifs', 'videos'].flatMap((name) => {
            const list = asRecord(value)?.[name];
            return Array.isArray(list) ? list.filter((entry): entry is Record<string, unknown> => isRecord(entry)) : [];
          }))
          : [];
      }
      if (entries.length === 0) return { state: 'running' };
      const outputs: OutputRef[] = [];
      for (const entry of entries) {
        const remote = trimString(entry['url']);
        if (remote) { outputs.push({ url: remote, kind }); continue; }
        const filename = trimString(entry['filename']);
        if (!filename) continue;
        const query = `filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(trimString(entry['subfolder']) ?? '')}&type=${encodeURIComponent(trimString(entry['type']) ?? 'output')}`;
        outputs.push({ url: `${baseUrl}${cloud ? '/api/view' : '/view'}?${query}`, kind, ...(auth ? { headers: auth } : {}) });
      }
      if (outputs.length === 0) return { state: 'ended', message: 'Comfy generation completed without downloadable artifacts' };
      return { state: 'done', outputs };
    },
  };
}

export function builtinGenerationProviders(deps: MediaGenerationDeps = {}): readonly MediaGenerationProvider[] {
  return [bytePlusSpec(), runwaySpec(), alibabaSpec(), falSpec(), comfySpec()].map((spec) => createGenerationProvider(spec, deps));
}
