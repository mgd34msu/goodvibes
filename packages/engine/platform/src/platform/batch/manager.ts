import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { httpStatusOf, structuralFailureConclusions } from '@goodvibes-jev/engine/errors';
import { STALE_TEMP_FILE_MIN_AGE_MS, writeDocument } from '../utils/atomic-json-store.js';
import type { ConfigManager } from '../config/manager.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type {
  ChatResponse,
  LLMProvider,
  ProviderBatchAdapter,
  ProviderBatchPollResult,
  ProviderBatchResult,
  ProviderBatchStatus,
} from '../providers/interface.js';
import { readFailureTransience } from '../integrations/delivery.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import type {
  CreateDaemonBatchJobInput,
  DaemonBatchJob,
  DaemonBatchJobStatus,
  DaemonBatchProviderCancelResult,
  DaemonBatchRuntimeSnapshot,
  DaemonBatchTickResult,
} from './types.js';
import { DaemonBatchError, daemonBatchJobLifecycle } from './types.js';
import { isRecord } from '../utils/record-coerce.js';

const BATCH_JOB_STATUSES = new Set<DaemonBatchJobStatus>(daemonBatchJobLifecycle.states);

/**
 * Submissions a job gets before a failure that could clear is given up on.
 * A resource bound on paid provider calls, not a reading: each failure is
 * still read for whether another submission could succeed at all.
 */
export const MAX_BATCH_SUBMIT_ATTEMPTS = 5;

/** Largest request, in serialized bytes, a batch job may carry from any source. */
export const MAX_BATCH_REQUEST_BYTES = 4 * 1024 * 1024;

/** Finished jobs are kept this long, and at most this many, then dropped from the store. */
export const BATCH_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const BATCH_TERMINAL_RETENTION_COUNT = 1000;

/** Batch metadata key that carries a job's submission id to the provider. */
export const BATCH_SUBMISSION_METADATA_KEY = 'goodvibesSubmissionId';

/** Error code on a submitting job whose create call failed before the provider's answer arrived. */
const BATCH_SUBMISSION_UNANSWERED = 'BATCH_SUBMISSION_UNANSWERED';

/** A provider adapter that can find a batch by the metadata it was created with. */
type BatchAdapterWithLookup = ProviderBatchAdapter & {
  findBatchByMetadata?(key: string, value: string, createdAfterMs: number): Promise<ProviderBatchPollResult | null>;
};

const PROVIDER_TERMINAL = new Set<ProviderBatchStatus>(['completed', 'failed', 'cancelled', 'expired']);

function now(): number {
  return Date.now();
}

function estimateJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isTerminal(status: DaemonBatchJobStatus): boolean {
  return daemonBatchJobLifecycle.isTerminal(status);
}

/** Why a stored job row cannot be used, or null when it can. */
function invalidJobReason(jobId: string, value: unknown): string | null {
  if (!isRecord(value)) return 'the row is not an object';
  const job = value as Partial<DaemonBatchJob>;
  if (typeof job.id !== 'string' || job.id.length === 0 || job.id !== jobId) return 'the id is missing or does not match its file';
  if (typeof job.provider !== 'string' || typeof job.model !== 'string') return 'provider or model is missing';
  if (typeof job.status !== 'string' || !BATCH_JOB_STATUSES.has(job.status as DaemonBatchJobStatus)) return `status '${String(job.status)}' is not a batch job status`;
  if (!isFiniteNumber(job.createdAt) || !isFiniteNumber(job.updatedAt) || !isFiniteNumber(job.attempts)) return 'createdAt, updatedAt or attempts is not a number';
  if (!isRecord(job.request) || !Array.isArray(job.request.messages) || job.request.messages.length === 0) return 'request.messages is missing or empty';
  for (const message of job.request.messages) {
    if (!isRecord(message) || typeof message['role'] !== 'string') return 'a request message has no role';
  }
  if (job.request.tools !== undefined && !Array.isArray(job.request.tools)) return 'request.tools is not an array';
  if (job.metadata !== undefined && !isRecord(job.metadata)) return 'metadata is not an object';
  if (job.source !== undefined && !isRecord(job.source)) return 'source is not an object';
  if (job.submissionId !== undefined && typeof job.submissionId !== 'string') return 'submissionId is not a string';
  if (job.error !== undefined && (!isRecord(job.error) || typeof job.error.message !== 'string')) return 'error has no message';
  return null;
}

interface QuarantinedRow {
  readonly source: string;
  readonly reason: string;
  readonly quarantinedAt: number;
  readonly value: unknown;
}

/**
 * One provider submission in flight: written once before the paid create call
 * (instead of one `submitting` row per job), and again with the provider batch
 * id once the provider answers, so a daemon that stops part-way through
 * writing the job rows still knows which batch holds them.
 */
interface BatchSubmissionRecord {
  readonly version: 1;
  readonly submissionId: string;
  readonly submittedAt: number;
  readonly jobIds: readonly string[];
  readonly providerBatchId?: string | undefined;
  readonly providerBatchStatus?: ProviderBatchStatus | undefined;
}

function isSubmissionRecord(value: unknown): value is BatchSubmissionRecord {
  if (!isRecord(value)) return false;
  const jobIds: unknown = value['jobIds'];
  return typeof value['submissionId'] === 'string'
    && isFiniteNumber(value['submittedAt'])
    && Array.isArray(jobIds)
    && (jobIds as readonly unknown[]).every((id) => typeof id === 'string')
    && (value['providerBatchId'] === undefined || typeof value['providerBatchId'] === 'string');
}

/** The job status a provider batch's create answer puts its jobs in. */
function submittedStatus(status: ProviderBatchStatus): DaemonBatchJobStatus {
  return status === 'running' ? 'running' : status === 'failed' ? 'failed' : 'submitted';
}

/**
 * One file per job (`<dir>/<id>.json`, a few hundred bytes), one per request
 * (`<id>.request.json`, written once when the job is made) and one per result
 * (`<id>.result.json`, written once when it completes), so a status change
 * writes one small file and pruning is an unlink. A provider submission in
 * flight is one `<submissionId>.submission.json`.
 * A row that cannot be used is moved to `batch-jobs.invalid.json` with the
 * reason, and the rest are served.
 */
class BatchJobFiles {
  readonly dir: string;
  readonly invalidPath: string;
  /** Results already on disk; a result is written once, when its job completes. */
  private readonly resultsOnDisk = new Set<string>();
  /** Requests already in their own file; a row read with its request inline is split on its next write. */
  private readonly requestsOnDisk = new Set<string>();

  constructor(storePath: string) {
    const base = storePath.endsWith('.json') ? storePath.slice(0, -'.json'.length) : storePath;
    this.dir = base;
    this.invalidPath = `${base}.invalid.json`;
  }

  private jobPath(id: string): string {
    return join(this.dir, `${encodeURIComponent(id)}.json`);
  }

  private resultPath(id: string): string {
    return join(this.dir, `${encodeURIComponent(id)}.result.json`);
  }

  private requestPath(id: string): string {
    return join(this.dir, `${encodeURIComponent(id)}.request.json`);
  }

  private submissionPath(submissionId: string): string {
    return join(this.dir, `${encodeURIComponent(submissionId)}.submission.json`);
  }

  /** Reads every job. Throws only when the directory itself cannot be made or read. */
  loadAll(): Record<string, DaemonBatchJob> {
    mkdirSync(this.dir, { recursive: true });
    const invalid: QuarantinedRow[] = [];
    const badFiles: string[] = [];
    const submissionFiles: string[] = [];
    const requestFiles: string[] = [];
    const jobs: Record<string, DaemonBatchJob> = {};
    const staleBefore = now() - STALE_TEMP_FILE_MIN_AGE_MS;
    for (const name of readdirSync(this.dir)) {
      const path = join(this.dir, name);
      if (name.includes('.json.tmp-')) {
        // A write a stopped process never renamed into place.
        try { if (statSync(path).mtimeMs < staleBefore) unlinkSync(path); } catch { /* gone already */ }
        continue;
      }
      if (name.endsWith('.submission.json')) {
        submissionFiles.push(path);
        continue;
      }
      // Requests are matched to their rows after every row is read.
      if (name.endsWith('.request.json')) {
        requestFiles.push(name);
        continue;
      }
      if (!name.endsWith('.json') || name.endsWith('.result.json')) continue;
      let id: string;
      try { id = decodeURIComponent(name.slice(0, -'.json'.length)); } catch { id = name; }
      let value: unknown;
      let text = '';
      try {
        text = readFileSync(path, 'utf-8');
        value = JSON.parse(text);
      } catch (error) {
        invalid.push({ source: path, reason: `not readable JSON: ${summarizeError(error)}`, quarantinedAt: now(), value: text });
        badFiles.push(path);
        continue;
      }
      const withRequest = this.withRequest(id, value);
      if (typeof withRequest === 'string') {
        invalid.push({ source: path, reason: withRequest, quarantinedAt: now(), value });
        badFiles.push(path);
        continue;
      }
      value = withRequest;
      const reason = invalidJobReason(id, value);
      if (reason) {
        invalid.push({ source: path, reason, quarantinedAt: now(), value });
        badFiles.push(path);
        continue;
      }
      const job = value as DaemonBatchJob;
      jobs[id] = job.status === 'completed' ? this.withResult(job) : job;
    }
    for (const path of submissionFiles) this.applySubmission(path, jobs);
    // A request whose row was never written (the job was refused when its row
    // could not be saved) belongs to no job; it is removed, not kept forever.
    for (const name of requestFiles) {
      let id: string;
      try { id = decodeURIComponent(name.slice(0, -'.request.json'.length)); } catch { continue; }
      if (jobs[id] || badFiles.some((path) => path === this.jobPath(id))) continue;
      try { unlinkSync(join(this.dir, name)); } catch { /* removed already; tried again next start */ }
    }
    if (invalid.length > 0) {
      try {
        this.quarantine(invalid);
        for (const path of badFiles) {
          try { unlinkSync(path); } catch { /* already copied into the quarantine file */ }
        }
      } catch (error) {
        // The bad rows stay where they are and are skipped again next start; the rest are served.
        logger.warn('Batch job rows that could not be read were skipped but could not be moved aside', {
          path: this.invalidPath,
          files: badFiles,
          error: summarizeError(error),
        });
      }
    }
    return jobs;
  }

  /**
   * The row with its request: from `<id>.request.json`, or inline in a row
   * written before requests had their own file. A string is why it has none.
   */
  private withRequest(id: string, value: unknown): unknown {
    if (!isRecord(value) || value['request'] !== undefined) return value;
    try {
      const request: unknown = JSON.parse(readFileSync(this.requestPath(id), 'utf-8'));
      this.requestsOnDisk.add(id);
      return { ...value, request };
    } catch (error) {
      return `its request file ${this.requestPath(id)} is missing or not readable JSON: ${summarizeError(error)}`;
    }
  }

  /**
   * Puts the jobs of a submission the daemon was making when it stopped back
   * in the state that submission reached: `submitting` with its submission
   * id, or in its provider batch when the provider had answered. A file whose
   * jobs have all moved on is removed.
   */
  private applySubmission(path: string, jobs: Record<string, DaemonBatchJob>): void {
    let record: unknown;
    try {
      record = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (error) {
      record = undefined;
      logger.warn('A batch submission file is not readable JSON and is removed; its jobs keep the state their own rows record', { path, error: summarizeError(error) });
    }
    // Kept while a job still depends on it: one waiting for its submission to
    // be confirmed, or one whose row could not be brought up to date.
    let keep = false;
    if (isSubmissionRecord(record)) {
      for (const id of record.jobIds) {
        const job = jobs[id];
        if (!job) continue;
        const pending = job.status === 'queued' || (job.status === 'submitting' && (job.submissionId === undefined || job.submissionId === record.submissionId));
        if (!pending) continue;
        if (record.providerBatchId === undefined || record.providerBatchStatus === undefined) {
          jobs[id] = { ...job, status: 'submitting', submissionId: record.submissionId, submittedAt: record.submittedAt };
          keep = true;
          continue;
        }
        // The provider had answered and the daemon stopped before this row
        // said so: it joins its provider batch, and the row is written now.
        const status = submittedStatus(record.providerBatchStatus);
        const timestamp = now();
        const joined: DaemonBatchJob = {
          ...job,
          status,
          updatedAt: timestamp,
          attempts: job.attempts + 1,
          submissionId: record.submissionId,
          submittedAt: record.submittedAt,
          providerBatchId: record.providerBatchId,
          providerBatchStatus: record.providerBatchStatus,
          ...(status === 'failed' ? { completedAt: timestamp, error: { message: 'The provider refused to create the batch.' } } : {}),
        };
        jobs[id] = joined;
        try {
          this.save(joined);
        } catch (error) {
          keep = true;
          logger.warn('A batch job row could not be brought up to date with its provider batch; the submission file is kept and read again next start', {
            jobId: id,
            path,
            error: summarizeError(error),
          });
        }
      }
    } else if (record !== undefined) {
      logger.warn('A batch submission file does not name a submission and its jobs; it is removed', { path });
    }
    if (!keep) {
      try { unlinkSync(path); } catch { /* removed already */ }
    }
  }

  /** Writes a submission before its paid provider call, and again with the provider's answer. Throws when not written. */
  saveSubmission(record: BatchSubmissionRecord): void {
    writeDocument(this.submissionPath(record.submissionId), record, { indent: null });
  }

  /** Removes a submission once every job row records where it went. */
  removeSubmission(submissionId: string): void {
    try { unlinkSync(this.submissionPath(submissionId)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('A finished batch submission file could not be removed; the next start reads it and finds its jobs moved on', {
          path: this.submissionPath(submissionId),
          error: summarizeError(error),
        });
      }
    }
  }

  private withResult(job: DaemonBatchJob): DaemonBatchJob {
    try {
      const result = JSON.parse(readFileSync(this.resultPath(job.id), 'utf-8')) as ChatResponse;
      this.resultsOnDisk.add(job.id);
      return { ...job, result };
    } catch {
      logger.warn('Batch job is completed but its result file is missing or unreadable', { jobId: job.id, path: this.resultPath(job.id) });
      return job;
    }
  }

  private quarantine(rows: readonly QuarantinedRow[]): void {
    if (rows.length === 0) return;
    let entries: unknown[] = [];
    if (existsSync(this.invalidPath)) {
      try {
        const existing = JSON.parse(readFileSync(this.invalidPath, 'utf-8')) as { entries?: unknown };
        entries = Array.isArray(existing.entries) ? existing.entries : [existing];
      } catch {
        entries = [{ source: this.invalidPath, reason: 'the quarantine file was not readable JSON', quarantinedAt: now(), value: readFileSync(this.invalidPath, 'utf-8') }];
      }
    }
    writeDocument(this.invalidPath, { version: 1, entries: [...entries, ...rows] });
    logger.warn('Batch job rows that could not be read were moved aside; the other jobs are served', {
      path: this.invalidPath,
      rows: rows.map((row) => ({ source: row.source, reason: row.reason })),
    });
  }

  /**
   * Writes the job's row, its request the first time (before the row that
   * needs it), and its result the first time it has one. Throws when not written.
   */
  save(job: DaemonBatchJob): void {
    const { result, request, ...row } = job;
    if (!this.requestsOnDisk.has(job.id)) {
      writeDocument(this.requestPath(job.id), request, { indent: null });
      this.requestsOnDisk.add(job.id);
    }
    if (result !== undefined && !this.resultsOnDisk.has(job.id)) {
      writeDocument(this.resultPath(job.id), result, { indent: null });
      this.resultsOnDisk.add(job.id);
    }
    writeDocument(this.jobPath(job.id), row, { indent: null });
  }

  remove(id: string): void {
    for (const path of [this.jobPath(id), this.resultPath(id), this.requestPath(id)]) {
      try { unlinkSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn('A pruned batch job file could not be removed; it is pruned again after the next start', { path, error: summarizeError(error) });
        }
      }
    }
    this.resultsOnDisk.delete(id);
    this.requestsOnDisk.delete(id);
  }
}

/** Lets the daemon answer other requests between the synchronous row writes of one batch. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Statuses from something between the daemon and the provider that gave up waiting: the provider may still have acted. */
const UNANSWERED_STATUSES: ReadonlySet<number> = new Set([408, 504, 524]);

/**
 * Whether a failed create call can have left a batch at the provider. A
 * provider that answered with a status made none, and a connection that was
 * never opened sent nothing; a reset, a timeout or a lost answer may have
 * reached it.
 */
function createMayHaveReachedProvider(error: unknown): boolean {
  const status = httpStatusOf(error);
  if (status !== undefined) return UNANSWERED_STATUSES.has(status);
  for (const holder of [error, isRecord(error) ? error['cause'] : undefined]) {
    const code = isRecord(holder) && typeof holder['code'] === 'string' ? holder['code'] : undefined;
    if (code !== undefined && structuralFailureConclusions({ message: code, code }).beforeResponse) return false;
  }
  return true;
}

type JobPatch = Partial<Omit<DaemonBatchJob, 'id' | 'status' | 'updatedAt'>>;

/** The Cloudflare queue message a job request came from, when it came from one. */
function queueMessageIdOf(input: CreateDaemonBatchJobInput): string | undefined {
  return input.source?.kind === 'cloudflare-queue' ? input.source.id : undefined;
}

export class DaemonBatchManager {
  private readonly files: BatchJobFiles;
  private jobs: Record<string, DaemonBatchJob> | null = null;
  /** Jobs whose latest state is not on disk yet; written again at the end of each pass. */
  private readonly unsaved = new Set<string>();
  /**
   * Live fallback requests still waiting on the provider, by queue message id:
   * a redelivery of that message while its first request runs gets the same
   * job instead of a second paid request.
   */
  private readonly liveInFlight = new Map<string, Promise<DaemonBatchJob>>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<DaemonBatchTickResult> | null = null;

  constructor(
    private readonly options: {
      readonly configManager: Pick<ConfigManager, 'get' | 'getControlPlaneConfigDir'>;
      readonly providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'getRegistered' | 'listProviders'>;
      /** The store's name: jobs live in the directory of the same name without `.json`. */
      readonly storePath?: string | undefined;
      /**
       * Called once when a job reaches a final state (completed, failed,
       * cancelled, expired, dead-lettered), so the daemon can publish it on the
       * event stream and a surface can show the result without polling.
       */
      readonly onJobSettled?: ((job: DaemonBatchJob) => void) | undefined;
    },
  ) {
    this.files = new BatchJobFiles(
      options.storePath ?? join(options.configManager.getControlPlaneConfigDir(), 'batch-jobs.json'),
    );
  }

  start(): void {
    if (this.interval !== null) return;
    this.interval = setInterval(() => {
      void this.tick().catch((error) => {
        logger.warn('Batch manager tick failed', { error: summarizeError(error) });
      });
    }, this.options.configManager.get('batch.tickIntervalMs'));
    this.interval.unref?.();
  }

  dispose(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** `batch.mode` as the manager applies it, for a route deciding whether a batch-capable request is queued. */
  currentMode(): DaemonBatchRuntimeSnapshot['mode'] {
    return this.getMode();
  }

  /**
   * Whether a job for this provider and model would go to the provider's Batch
   * API. A route that queues work nobody asked to batch asks this first: for a
   * provider that cannot batch, the ordinary live request is the honest
   * answer, not a job record around it. Two registry lookups, no I/O.
   */
  canBatch(providerId: string, model: string): boolean {
    try {
      this.requireProviderBatchSupport(this.getBatchProvider(model, providerId), providerId);
      return true;
    } catch {
      return false;
    }
  }

  async describeRuntime(): Promise<DaemonBatchRuntimeSnapshot> {
    return {
      mode: this.getMode(),
      fallback: this.getFallback(),
      queueBackend: this.getQueueBackend(),
      cloudflare: {
        enabled: this.options.configManager.get('cloudflare.enabled'),
        freeTierMode: this.options.configManager.get('cloudflare.freeTierMode'),
        accountId: this.options.configManager.get('cloudflare.accountId'),
        workerName: this.options.configManager.get('cloudflare.workerName'),
        workerBaseUrl: this.options.configManager.get('cloudflare.workerBaseUrl'),
        daemonBaseUrl: this.options.configManager.get('cloudflare.daemonBaseUrl'),
        queueName: this.options.configManager.get('cloudflare.queueName'),
        deadLetterQueueName: this.options.configManager.get('cloudflare.deadLetterQueueName'),
        maxQueueOpsPerDay: this.options.configManager.get('cloudflare.maxQueueOpsPerDay'),
      },
      limits: {
        tickIntervalMs: this.options.configManager.get('batch.tickIntervalMs'),
        maxDelayMs: this.options.configManager.get('batch.maxDelayMs'),
        maxJobsPerProviderBatch: this.options.configManager.get('batch.maxJobsPerProviderBatch'),
        maxQueuePayloadBytes: this.options.configManager.get('batch.maxQueuePayloadBytes'),
        maxQueueMessagesPerDay: this.options.configManager.get('batch.maxQueueMessagesPerDay'),
      },
      supportedProviders: this.options.providerRegistry
        .listProviders()
        .filter((provider) => Boolean(
          provider.batch?.endpoints.includes('/v1/chat/completions') ||
          provider.batch?.endpoints.includes('/v1/messages/batches'),
        ))
        .map((provider) => provider.name)
        .sort(),
    };
  }

  /**
   * `signal`: the caller's request. Only the live fallback uses it: a caller
   * that went away cancels the provider request it was waiting on.
   */
  async createJob(input: CreateDaemonBatchJobInput, options: { readonly signal?: AbortSignal | undefined } = {}): Promise<DaemonBatchJob> {
    if (this.getMode() === 'off') {
      throw new DaemonBatchError('Daemon batch mode is off.', 'BATCH_DISABLED', 409);
    }
    if (input.executionMode === 'live') {
      throw new DaemonBatchError('This endpoint only accepts batch jobs. Use the live daemon route for immediate execution.', 'LIVE_REQUEST_NOT_ACCEPTED', 400);
    }
    if (!input.request || !Array.isArray(input.request.messages) || input.request.messages.length === 0) {
      throw new DaemonBatchError('Batch jobs require request.messages.', 'INVALID_BATCH_REQUEST', 400);
    }
    const defaults = this.options.providerRegistry.getCurrentModel();
    const provider = input.provider?.trim() || defaults.provider;
    const model = input.model?.trim() || defaults.id;
    const providerInstance = this.getBatchProvider(model, provider);
    // A provider that cannot batch runs the request on the live path when
    // `batch.fallback` is `live`, and the job is answered already finished.
    let runLive = false;
    try {
      this.requireProviderBatchSupport(providerInstance, provider);
    } catch (error) {
      if (this.getFallback() !== 'live') throw error;
      runLive = true;
    }
    const payloadBytes = estimateJsonBytes(input);
    if (payloadBytes > MAX_BATCH_REQUEST_BYTES) {
      throw new DaemonBatchError(
        `Batch request is ${payloadBytes} bytes, above the ${MAX_BATCH_REQUEST_BYTES} byte limit. Split it into smaller jobs.`,
        'BATCH_REQUEST_TOO_LARGE',
        413,
      );
    }
    // The queue message limit is for bodies that travelled in the queue; the
    // provisioned Worker keeps larger bodies in R2 and says so on the job.
    if (input.source?.kind === 'cloudflare-queue' && input.metadata?.['goodvibes.payload'] !== 'r2') {
      const maxPayload = this.options.configManager.get('batch.maxQueuePayloadBytes');
      if (payloadBytes > maxPayload) {
        throw new DaemonBatchError(
          `Cloudflare queue batch signal is ${payloadBytes} bytes, above configured limit ${maxPayload}. Store the payload in the daemon and queue only a signal.`,
          'QUEUE_PAYLOAD_TOO_LARGE',
          413,
        );
      }
    }
    if (runLive) {
      const redelivered = this.findQueueRedelivery(input);
      if (redelivered) return redelivered;
      const queueMessageId = queueMessageIdOf(input);
      if (!queueMessageId) return this.runLiveJob(input, provider, model, providerInstance, options.signal);
      const running = this.liveInFlight.get(queueMessageId);
      if (running) return running;
      // The job is stored before this promise settles, so the entry is gone only once the job can be found.
      const started = this.runLiveJob(input, provider, model, providerInstance, options.signal)
        .finally(() => { this.liveInFlight.delete(queueMessageId); });
      this.liveInFlight.set(queueMessageId, started);
      return started;
    }

    const jobs = this.load();
    const existing = this.findQueueRedelivery(input);
    if (existing) return existing;
    const timestamp = now();
    const job: DaemonBatchJob = {
      id: `batch-job-${crypto.randomUUID()}`,
      provider,
      model,
      status: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
      request: copyBatchRequest(input.request),
      ...(input.source ? { source: input.source } : {}),
      ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
      attempts: 0,
    };
    try {
      this.files.save(job);
    } catch (error) {
      throw this.storeWriteError(error, 'the job was not queued', 'send the job again');
    }
    jobs[job.id] = job;
    if (input.flush) {
      await this.tick({ flushJobId: job.id });
      return this.jobs?.[job.id] ?? job;
    }
    return job;
  }

  /** A queue redelivers a message whose first attempt may have committed before the reply was lost: the same queue message is the same job. */
  private findQueueRedelivery(input: CreateDaemonBatchJobInput): DaemonBatchJob | undefined {
    const queueMessageId = queueMessageIdOf(input);
    if (!queueMessageId) return undefined;
    return Object.values(this.load()).find((job) => job.source?.kind === 'cloudflare-queue' && job.source.id === queueMessageId);
  }

  /**
   * The `fallback: live` path: one ordinary chat request to the provider, kept
   * as a job that is created finished (completed with its result, or failed with
   * the provider's error), so the caller reads it like any batch job.
   */
  private async runLiveJob(input: CreateDaemonBatchJobInput, provider: string, model: string, providerInstance: LLMProvider, signal?: AbortSignal): Promise<DaemonBatchJob> {
    const request = copyBatchRequest(input.request);
    const startedAt = now();
    let outcome: Pick<DaemonBatchJob, 'status' | 'result' | 'error'>;
    try {
      const result = await providerInstance.chat({
        model,
        messages: [...request.messages],
        ...(request.tools ? { tools: [...request.tools] } : {}),
        ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
        ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        ...(request.reasoningSummary !== undefined ? { reasoningSummary: request.reasoningSummary } : {}),
        ...(signal ? { signal } : {}),
      });
      outcome = { status: 'completed', result };
    } catch (error) {
      // The caller went away and cancelled it: nobody reads a job, so none is kept.
      if (signal?.aborted) throw error;
      outcome = { status: 'failed', error: { code: 'LIVE_FALLBACK_FAILED', message: `${provider} cannot batch, so the request ran live, and the live request failed: ${summarizeError(error)}` } };
    }
    const finishedAt = now();
    const job: DaemonBatchJob = {
      id: `batch-job-${crypto.randomUUID()}`,
      provider,
      model,
      ...outcome,
      createdAt: startedAt,
      updatedAt: finishedAt,
      completedAt: finishedAt,
      request,
      ...(input.source ? { source: input.source } : {}),
      // Says how the job ran: the provider has no batch for it, and none was billed at batch rates.
      metadata: { ...(input.metadata ?? {}), 'goodvibes.execution': 'live-fallback' },
      attempts: 1,
    };
    this.load()[job.id] = job;
    if (!this.save(job)) {
      logger.warn('A live fallback batch job finished but its record is not on disk yet; it is written again at the end of the next pass', { jobId: job.id });
    }
    this.notifySettled(job);
    return job;
  }

  private notifySettled(job: DaemonBatchJob): void {
    if (!this.options.onJobSettled || !daemonBatchJobLifecycle.isTerminal(job.status)) return;
    try {
      this.options.onJobSettled(job);
    } catch (error) {
      logger.warn('Publishing a finished batch job failed; the job itself is saved', { jobId: job.id, error: summarizeError(error) });
    }
  }

  /** A job by its id, or by the queue job id a Cloudflare Worker answered at enqueue (`source.id`). */
  async getJob(jobId: string): Promise<DaemonBatchJob | null> {
    const jobs = this.load();
    return jobs[jobId]
      ?? Object.values(jobs).find((job) => job.source?.kind === 'cloudflare-queue' && job.source.id === jobId)
      ?? null;
  }

  async listJobs(limit = 100): Promise<readonly DaemonBatchJob[]> {
    return Object.values(this.load())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Math.min(limit, 1000)));
  }

  async cancelJob(jobId: string): Promise<DaemonBatchJob> {
    const job = this.load()[jobId];
    if (!job) throw new DaemonBatchError(`Batch job '${jobId}' was not found.`, 'BATCH_JOB_NOT_FOUND', 404);
    if (isTerminal(job.status)) {
      // A cancel whose save failed earlier is saved now, so a retry of the cancel does what it says.
      if (this.unsaved.has(jobId) && !this.save(job)) {
        throw this.storeWriteError(undefined, `the job is ${job.status} in this daemon but not saved`, 'cancel it again');
      }
      return job;
    }
    if (job.status === 'queued' || job.status === 'submitting') {
      const cancelled = this.transition(jobId, 'cancelled', { completedAt: now() });
      if (cancelled && this.unsaved.has(jobId)) {
        throw this.storeWriteError(undefined, 'the job is cancelled in this daemon but not saved, so a restart would queue it again', 'cancel it again');
      }
      return cancelled ?? job;
    }
    const providerBatchId = job.providerBatchId ?? '';
    throw new DaemonBatchError(
      `Batch job '${jobId}' is already in provider batch '${providerBatchId}', which the provider runs as a whole.`,
      'BATCH_JOB_ALREADY_SUBMITTED',
      409,
      {
        state: `the job is ${job.status} at ${job.provider}`,
        next: [
          `Cancel the whole provider batch with POST /api/batch/provider-batches/${encodeURIComponent(providerBatchId)}/cancel`,
          'Or wait for the result and ignore it',
        ],
      },
    );
  }

  /**
   * Cancels a whole provider batch at the provider and marks its jobs. A
   * provider that is still winding down answers `running`; requests it
   * finished before the cancel are collected by the next pass, the rest are
   * marked cancelled when it ends.
   */
  async cancelProviderBatch(providerBatchId: string): Promise<DaemonBatchProviderCancelResult> {
    const all = Object.values(this.load()).filter((job) => job.providerBatchId === providerBatchId);
    const first = all[0];
    if (!first) {
      throw new DaemonBatchError(`No batch job belongs to provider batch '${providerBatchId}'.`, 'BATCH_PROVIDER_BATCH_NOT_FOUND', 404, {
        state: 'nothing was cancelled',
        next: ['List jobs with GET /api/batch/jobs and use the providerBatchId shown on a submitted job'],
      });
    }
    const open = all.filter((job) => !isTerminal(job.status));
    if (open.length === 0) {
      return { providerBatchId, providerStatus: first.providerBatchStatus ?? 'completed', jobs: all };
    }
    const provider = this.getBatchProvider(first.model, first.provider);
    this.requireProviderBatchSupport(provider, first.provider);
    const adapter = provider.batch!;
    if (!adapter.cancelBatch) {
      throw new DaemonBatchError(`Provider '${first.provider}' cannot cancel a batch through its API.`, 'BATCH_PROVIDER_CANCEL_UNSUPPORTED', 409, {
        state: 'the provider batch is still running',
        next: [`Cancel batch '${providerBatchId}' in the ${first.provider} console`, 'Or wait for the result'],
      });
    }
    const polled = await adapter.cancelBatch(providerBatchId);
    const tickResult = emptyTickResult();
    await this.applyPolledBatch(adapter, providerBatchId, open.map((job) => job.id), polled, tickResult);
    this.saveUnsaved();
    const jobs = this.load();
    return { providerBatchId, providerStatus: polled.status, jobs: all.map((job) => jobs[job.id] ?? job) };
  }

  async tick(options: { readonly forceSubmit?: boolean; readonly flushJobId?: string } = {}): Promise<DaemonBatchTickResult> {
    if (this.ticking) {
      const running = this.ticking;
      if (options.forceSubmit !== true && options.flushJobId === undefined) return running;
      // The running pass took its queue before this request existed and does
      // not force it; wait for it, then run one that does.
      await running.catch(() => undefined);
      return this.tick(options);
    }
    this.ticking = this.runTick(options).finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async runTick(options: { readonly forceSubmit?: boolean; readonly flushJobId?: string }): Promise<DaemonBatchTickResult> {
    const result = emptyTickResult();
    if (this.getMode() === 'off') return result;
    this.load();
    try {
      await this.reconcileSubmitting(result);
      await this.submitQueuedJobs(result, options);
      await this.pollProviderBatches(result);
      this.pruneFinishedJobs();
    } finally {
      this.saveUnsaved();
    }
    return result;
  }

  private async submitQueuedJobs(
    result: DaemonBatchTickResult,
    options: { readonly forceSubmit?: boolean; readonly flushJobId?: string },
  ): Promise<void> {
    const queued = Object.values(this.load()).filter((job) => job.status === 'queued');
    if (queued.length === 0) return;
    const maxDelayMs = this.options.configManager.get('batch.maxDelayMs');
    const maxJobs = this.options.configManager.get('batch.maxJobsPerProviderBatch');
    const grouped = new Map<string, DaemonBatchJob[]>();
    for (const job of queued) {
      // A flush sends its own job now; other jobs still wait for their delay.
      const due = options.forceSubmit === true || job.id === options.flushJobId || maxDelayMs <= 0 || now() - job.createdAt >= maxDelayMs;
      if (!due) continue;
      const key = `${job.provider}\u0000${job.model}`;
      const bucket = grouped.get(key) ?? [];
      bucket.push(job);
      grouped.set(key, bucket);
    }
    for (const jobs of grouped.values()) {
      for (let i = 0; i < jobs.length; i += maxJobs) {
        const slice = jobs.slice(i, i + maxJobs);
        if (slice.length > 0) await this.submitProviderBatch(slice.map((job) => job.id), result);
      }
    }
  }

  private async submitProviderBatch(jobIds: readonly string[], result: DaemonBatchTickResult): Promise<void> {
    // The slice was chosen before earlier slices awaited the provider; a job
    // cancelled since then must not be sent (a paid request the operator called off).
    const submissionId = `batch-submission-${crypto.randomUUID()}`;
    const startedAt = now();
    const marked: DaemonBatchJob[] = [];
    for (const id of jobIds) {
      if (this.jobs?.[id]?.status !== 'queued') continue;
      // In memory only: the one submission file below records all of them.
      const next = this.transition(id, 'submitting', { submissionId, submittedAt: startedAt }, { persist: false });
      if (next) marked.push(next);
    }
    const first = marked[0];
    if (!first) return;
    const submission: BatchSubmissionRecord = { version: 1, submissionId, submittedAt: startedAt, jobIds: marked.map((job) => job.id) };
    try {
      this.files.saveSubmission(submission);
    } catch (error) {
      // The provider call is paid and not idempotent. Without the submission
      // id on disk a restart could not find the batch and would pay again.
      for (const job of marked) {
        this.transition(job.id, 'queued', { submissionId: undefined, submittedAt: undefined }, { persist: false });
      }
      logger.warn('Batch jobs were not submitted because the job store could not be written; they stay queued', {
        path: this.files.dir,
        jobs: marked.length,
        error: summarizeError(error),
      });
      return;
    }

    let created: Awaited<ReturnType<ProviderBatchAdapter['createChatBatch']>>;
    try {
      const provider = this.getBatchProvider(first.model, first.provider);
      this.requireProviderBatchSupport(provider, first.provider);
      created = await provider.batch!.createChatBatch({
        requests: marked.map((job) => ({
          customId: job.id,
          params: {
            model: job.model,
            messages: [...job.request.messages],
            ...(job.request.tools ? { tools: [...job.request.tools] } : {}),
            ...(job.request.systemPrompt ? { systemPrompt: job.request.systemPrompt } : {}),
            ...(job.request.maxTokens !== undefined ? { maxTokens: job.request.maxTokens } : {}),
            ...(job.request.reasoningEffort ? { reasoningEffort: job.request.reasoningEffort } : {}),
            ...(job.request.reasoningSummary !== undefined ? { reasoningSummary: job.request.reasoningSummary } : {}),
          },
        })),
        metadata: {
          source: 'goodvibes-platform',
          provider: first.provider,
          model: first.model,
          [BATCH_SUBMISSION_METADATA_KEY]: submissionId,
        },
        completionWindow: '24h',
      });
    } catch (error: unknown) {
      const retryable = await this.readRetryable(error, 'batch.submit', {
        provider: first.provider,
        model: first.model,
        jobs: marked.length,
      });
      const errorRecord = { message: summarizeError(error) };
      if (retryable && createMayHaveReachedProvider(error)) {
        // The provider may have made the batch and only its answer was lost.
        // The jobs stay submitting under this submission id, and the next pass
        // asks the provider for it: found, they join it; not there, they are
        // queued again with this attempt counted. Nothing is paid for twice.
        for (const snap of marked) {
          const job = this.jobs?.[snap.id];
          if (!job || job.status !== 'submitting') continue;
          this.transition(job.id, 'submitting', { error: { ...errorRecord, code: BATCH_SUBMISSION_UNANSWERED } }, { persist: false });
        }
        logger.warn('A provider batch create call failed before its answer arrived; the next pass asks the provider whether it made the batch', {
          provider: first.provider,
          submissionId,
          jobs: marked.length,
        });
        return;
      }
      for (const snap of marked) {
        // A job cancelled while the call was in flight stays cancelled (the lifecycle refuses the move).
        const job = this.jobs?.[snap.id];
        if (!job || job.status !== 'submitting') continue;
        const attempts = job.attempts + 1;
        if (retryable && attempts < MAX_BATCH_SUBMIT_ATTEMPTS) {
          this.putBack(job.id, { attempts, error: errorRecord });
        } else if (this.transition(job.id, 'dead_lettered', { attempts, completedAt: now(), error: errorRecord })) {
          result.failedJobs += 1;
        }
        await yieldToEventLoop();
      }
      // The provider answered, so it holds no batch for this submission.
      this.files.removeSubmission(submissionId);
      return;
    }

    // The provider's answer is recorded once, before the job rows, so a daemon
    // that stops while they are written still finds every job's batch.
    try {
      this.files.saveSubmission({ ...submission, providerBatchId: created.providerBatchId, providerBatchStatus: created.status });
    } catch (error) {
      logger.warn('A provider batch was created but could not be recorded beside its jobs; each job row records it as it is written', {
        provider: first.provider,
        providerBatchId: created.providerBatchId,
        error: summarizeError(error),
      });
    }
    const markedIds = marked.map((job) => job.id);
    const counted = await this.recordSubmitted(markedIds, created, result);
    if (!markedIds.some((id) => this.unsaved.has(id))) this.files.removeSubmission(submissionId);
    result.submittedProviderBatches += 1;
    if (counted.superseded.length > 0) {
      logger.warn('Batch jobs were cancelled while their provider batch was being created; the provider batch still holds them and their results will be ignored', {
        providerBatchId: created.providerBatchId,
        provider: first.provider,
        jobIds: counted.superseded,
      });
    }
  }

  /**
   * Moves submitting jobs to the state of the provider batch that holds them.
   * Each row is written before the next provider batch is made, with a yield
   * between rows so other requests are answered while a large batch is recorded.
   */
  private async recordSubmitted(
    jobIds: readonly string[],
    created: { readonly providerBatchId: string; readonly status: ProviderBatchStatus; readonly raw?: unknown },
    result: DaemonBatchTickResult,
  ): Promise<{ superseded: string[] }> {
    const timestamp = now();
    const target = submittedStatus(created.status);
    const superseded: string[] = [];
    for (const [index, id] of jobIds.entries()) {
      if (index > 0) await yieldToEventLoop();
      const job = this.jobs?.[id];
      const moved = job && job.status === 'submitting'
        ? this.transition(id, target, {
          attempts: job.attempts + 1,
          providerBatchId: created.providerBatchId,
          providerBatchStatus: created.status,
          // A job that joins its batch carries no error from a create call whose answer was lost.
          ...(created.status === 'failed'
            ? { completedAt: timestamp, error: { message: 'The provider refused to create the batch.', raw: created.raw } }
            : { error: undefined }),
        })
        : null;
      if (!moved) {
        superseded.push(id);
        continue;
      }
      if (target === 'failed') result.failedJobs += 1;
      else result.submittedJobs += 1;
    }
    return { superseded };
  }

  /**
   * A job still `submitting` when a pass starts was left by a daemon that
   * stopped during the provider call, or by a create call whose answer was
   * lost. The provider is asked for the batch by its submission id: found, the
   * job joins it; not there, it is queued again with the attempt counted (and
   * dead-lettered once the attempts are spent); a provider that cannot be
   * asked gets no second paid call, and the job fails with what to check.
   */
  private async reconcileSubmitting(result: DaemonBatchTickResult): Promise<void> {
    const groups = new Map<string, DaemonBatchJob[]>();
    for (const job of Object.values(this.load())) {
      if (job.status !== 'submitting') continue;
      const key = job.submissionId ?? `job:${job.id}`;
      const bucket = groups.get(key) ?? [];
      bucket.push(job);
      groups.set(key, bucket);
    }
    for (const jobs of groups.values()) {
      const first = jobs[0]!;
      const ids = jobs.map((job) => job.id);
      const submittedAt = first.submittedAt ?? first.updatedAt;
      let lookup: BatchAdapterWithLookup['findBatchByMetadata'];
      try {
        const provider = this.getBatchProvider(first.model, first.provider);
        this.requireProviderBatchSupport(provider, first.provider);
        const adapter = provider.batch as BatchAdapterWithLookup;
        lookup = adapter.findBatchByMetadata?.bind(adapter);
      } catch {
        lookup = undefined;
      }
      if (!lookup || !first.submissionId) {
        await this.failUnconfirmed(jobs, first.provider, submittedAt, result);
        if (first.submissionId) this.files.removeSubmission(first.submissionId);
        continue;
      }
      let found: ProviderBatchPollResult | null;
      try {
        found = await lookup(BATCH_SUBMISSION_METADATA_KEY, first.submissionId, submittedAt);
      } catch (error: unknown) {
        const retryable = await this.readRetryable(error, 'batch.poll', {
          provider: first.provider,
          submissionId: first.submissionId,
        });
        if (!retryable) {
          await this.failUnconfirmed(jobs, first.provider, submittedAt, result);
          this.files.removeSubmission(first.submissionId);
        }
        continue;
      }
      if (found) {
        await this.recordSubmitted(ids, found, result);
        logger.info('A provider batch whose create answer never arrived was found and resumed', {
          provider: first.provider,
          providerBatchId: found.providerBatchId,
          jobs: ids.length,
        });
      } else {
        for (const [index, id] of ids.entries()) {
          if (index > 0) await yieldToEventLoop();
          const job = this.jobs?.[id];
          if (!job || job.status !== 'submitting') continue;
          const attempts = job.attempts + 1;
          if (attempts < MAX_BATCH_SUBMIT_ATTEMPTS) {
            this.putBack(id, { attempts });
          } else if (this.transition(id, 'dead_lettered', {
            attempts,
            completedAt: now(),
            error: job.error ?? { message: `${first.provider} holds no batch for this job after ${attempts} submissions.` },
          })) {
            result.failedJobs += 1;
          }
        }
      }
      if (!ids.some((id) => this.unsaved.has(id))) this.files.removeSubmission(first.submissionId);
    }
  }

  private async failUnconfirmed(jobs: readonly DaemonBatchJob[], provider: string, submittedAt: number, result: DaemonBatchTickResult): Promise<void> {
    const when = new Date(submittedAt).toISOString();
    for (const [index, job] of jobs.entries()) {
      if (index > 0) await yieldToEventLoop();
      const cause = job.error?.code === BATCH_SUBMISSION_UNANSWERED
        ? `The answer to sending this job to ${provider} was lost (${job.error.message})`
        : `The daemon stopped while sending this job to ${provider}`;
      const moved = this.transition(job.id, 'failed', {
        completedAt: now(),
        error: {
          code: 'BATCH_SUBMISSION_UNCONFIRMED',
          message: `${cause}, and ${provider} cannot be asked whether it accepted the batch. It was not sent again, so it is not paid for twice. Check ${provider}'s batch list for a batch created around ${when}; if there is none, create the job again.`,
        },
      });
      if (moved) result.failedJobs += 1;
    }
  }

  private async pollProviderBatches(result: DaemonBatchTickResult): Promise<void> {
    const pendingByProviderBatch = new Map<string, DaemonBatchJob[]>();
    for (const job of Object.values(this.load())) {
      if (!job.providerBatchId || (job.status !== 'submitted' && job.status !== 'running')) continue;
      const key = `${job.provider}\u0000${job.model}\u0000${job.providerBatchId}`;
      const bucket = pendingByProviderBatch.get(key) ?? [];
      bucket.push(job);
      pendingByProviderBatch.set(key, bucket);
    }
    for (const jobs of pendingByProviderBatch.values()) {
      const first = jobs[0]!;
      const providerBatchId = first.providerBatchId!;
      const ids = jobs.map((job) => job.id);
      try {
        const provider = this.getBatchProvider(first.model, first.provider);
        this.requireProviderBatchSupport(provider, first.provider);
        const adapter = provider.batch!;
        const polled = await adapter.retrieveBatch(providerBatchId);
        result.polledProviderBatches += 1;
        await this.applyPolledBatch(adapter, providerBatchId, ids, polled, result);
      } catch (error: unknown) {
        // Whether this provider batch is lost or only this poll failed. A
        // batch still running at the provider (already paid for) is kept for
        // the next poll unless the failure cannot clear.
        const retryable = await this.readRetryable(error, 'batch.poll', {
          provider: first.provider,
          providerBatchId,
        });
        if (retryable) continue;
        for (const [index, id] of ids.entries()) {
          if (index > 0) await yieldToEventLoop();
          if (this.transition(id, 'dead_lettered', { completedAt: now(), error: { message: summarizeError(error) } })) {
            result.failedJobs += 1;
          }
        }
      }
    }
  }

  /** Applies what the provider says about one batch to its open jobs, collecting results when there are any. */
  private async applyPolledBatch(
    adapter: ProviderBatchAdapter,
    providerBatchId: string,
    jobIds: readonly string[],
    polled: ProviderBatchPollResult,
    result: DaemonBatchTickResult,
  ): Promise<void> {
    for (const id of jobIds) {
      const job = this.jobs?.[id];
      if (!job || isTerminal(job.status)) continue;
      const to = polled.status === 'running' ? 'running' : job.status;
      // A poll that changes nothing writes nothing.
      if (to !== job.status || job.providerBatchStatus !== polled.status) {
        this.transition(id, to, { providerBatchStatus: polled.status });
        await yieldToEventLoop();
      }
    }
    if (polled.resultAvailable || polled.status === 'completed') {
      await this.applyProviderResults(await adapter.getResults(providerBatchId), result);
    }
    if (PROVIDER_TERMINAL.has(polled.status)) await this.finishJobsWithoutResult(jobIds, polled, result);
  }

  /**
   * A provider batch that has ended leaves no job open: a job it returned no
   * result for takes the batch's end state instead of being polled forever.
   */
  private async finishJobsWithoutResult(
    jobIds: readonly string[],
    polled: ProviderBatchPollResult,
    result: DaemonBatchTickResult,
  ): Promise<void> {
    const status: DaemonBatchJobStatus = polled.status === 'cancelled' ? 'cancelled' : polled.status === 'expired' ? 'expired' : 'failed';
    const message = polled.status === 'completed'
      ? 'The provider completed the batch but returned no result for this job.'
      : polled.status === 'failed'
        ? 'The provider batch failed.'
        : `The provider batch was ${polled.status} before this job ran.`;
    for (const id of jobIds) {
      const job = this.jobs?.[id];
      if (!job || isTerminal(job.status)) continue;
      const moved = this.transition(id, status, {
        completedAt: now(),
        error: { message, ...(polled.status === 'failed' ? { raw: polled.raw } : {}) },
      });
      if (moved && status === 'failed') result.failedJobs += 1;
      await yieldToEventLoop();
    }
  }

  /** Records each result, yielding between rows so a large batch does not hold the daemon. */
  private async applyProviderResults(providerResults: readonly ProviderBatchResult[], tickResult: DaemonBatchTickResult): Promise<void> {
    for (const [index, providerResult] of providerResults.entries()) {
      if (index > 0) await yieldToEventLoop();
      const job = this.jobs?.[providerResult.customId];
      if (!job || isTerminal(job.status)) continue;
      if (providerResult.status === 'succeeded' && providerResult.response) {
        if (this.transition(job.id, 'completed', { completedAt: now(), result: providerResult.response })) {
          tickResult.completedJobs += 1;
        }
        continue;
      }
      const status = providerResult.status === 'cancelled'
        ? 'cancelled'
        : providerResult.status === 'expired'
          ? 'expired'
          : 'failed';
      const moved = this.transition(job.id, status, {
        completedAt: now(),
        error: providerResult.error ?? { message: `Provider batch request ${status}.`, raw: providerResult.raw },
      });
      if (moved && status === 'failed') tickResult.failedJobs += 1;
    }
  }

  /** Drops finished jobs past the retention age, then the oldest beyond the retention count. */
  private pruneFinishedJobs(): void {
    const jobs = this.load();
    const cutoff = now() - BATCH_TERMINAL_RETENTION_MS;
    const finished = Object.values(jobs)
      .filter((job) => isTerminal(job.status))
      .sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt));
    finished.forEach((job, index) => {
      if (index >= BATCH_TERMINAL_RETENTION_COUNT || (job.completedAt ?? job.updatedAt) < cutoff) {
        delete jobs[job.id];
        this.unsaved.delete(job.id);
        this.files.remove(job.id);
      }
    });
  }

  /**
   * The one place a job's status changes: the move must be in the lifecycle
   * table (a terminal job never moves), and the row is written at once
   * unless `persist: false` says another file records the move (a
   * submission records all of its jobs going `submitting` in one write).
   * Returns the job as stored in memory, or null when the move is not legal.
   */
  private transition(id: string, to: DaemonBatchJobStatus, patch: JobPatch, options: { readonly persist?: boolean } = {}): DaemonBatchJob | null {
    const current = this.jobs?.[id];
    if (!current || !daemonBatchJobLifecycle.can(current.status, to)) return null;
    const next: DaemonBatchJob = { ...current, ...patch, status: to, updatedAt: now() };
    this.jobs![id] = next;
    if (options.persist !== false) this.save(next);
    this.notifySettled(next);
    return next;
  }

  /** A submitting job goes back to the queue: the provider has no batch for it. */
  private putBack(id: string, patch: JobPatch): void {
    this.transition(id, 'queued', { ...patch, submissionId: undefined, submittedAt: undefined });
  }

  private save(job: DaemonBatchJob): boolean {
    try {
      this.files.save(job);
      this.unsaved.delete(job.id);
      return true;
    } catch (error) {
      this.unsaved.add(job.id);
      logger.warn('A batch job could not be written; it is written again at the end of the pass', {
        jobId: job.id,
        status: job.status,
        path: this.files.dir,
        error: summarizeError(error),
      });
      return false;
    }
  }

  private saveUnsaved(): void {
    for (const id of [...this.unsaved]) {
      const job = this.jobs?.[id];
      if (!job) this.unsaved.delete(id);
      else this.save(job);
    }
  }

  /**
   * Whether another attempt could succeed: the error's structure first, then
   * a reading of its wording. A failure that cannot be read counts as
   * retryable, so the attempt cap still bounds it.
   */
  private async readRetryable(error: unknown, operation: 'batch.submit' | 'batch.poll', context: Record<string, unknown>): Promise<boolean> {
    try {
      const transience = await readFailureTransience(error, operation, { fromProvider: true });
      logger.warn(`Provider ${operation === 'batch.submit' ? 'batch submission' : 'batch call'} failed`, {
        ...context,
        error: summarizeError(error),
        failureClass: transience.failureClass,
        basis: transience.basis,
        detail: transience.detail,
      });
      return transience.failureClass === 'retryable';
    } catch (readError: unknown) {
      logger.warn(`Provider ${operation === 'batch.submit' ? 'batch submission' : 'batch call'} failed and the failure could not be read; it is retried within the attempt limit`, {
        ...context,
        error: summarizeError(error),
        readError: summarizeError(readError),
      });
      return true;
    }
  }

  private storeWriteError(error: unknown, state: string, retry: string): DaemonBatchError {
    const detail = error === undefined ? '' : ` ${summarizeError(error)}`;
    return new DaemonBatchError(`The batch job store at ${this.files.dir} could not be written.${detail}`, 'BATCH_STORE_WRITE_FAILED', 500, {
      state,
      next: [`Check that ${this.files.dir} is writable and the disk has space, then ${retry}`],
    });
  }

  private getBatchProvider(model: string, providerId: string): LLMProvider {
    if (providerId === 'openai') return this.options.providerRegistry.getRegistered('openai');
    return this.options.providerRegistry.getForModel(model, providerId);
  }

  private requireProviderBatchSupport(provider: LLMProvider, providerId: string): void {
    if (!provider.batch) {
      throw new DaemonBatchError(`Provider '${providerId}' does not expose a provider Batch API adapter.`, 'BATCH_PROVIDER_UNSUPPORTED', 409);
    }
    if (typeof provider.isConfigured === 'function' && !provider.isConfigured()) {
      throw new DaemonBatchError(`Provider '${providerId}' is not configured for Batch API use. Batch API routes require provider API-key credentials.`, 'BATCH_PROVIDER_NOT_CONFIGURED', 409);
    }
  }

  /** The jobs, read from disk once per process. A failed read is not kept, so a repaired store is read on the next call. */
  private load(): Record<string, DaemonBatchJob> {
    if (this.jobs) return this.jobs;
    try {
      this.jobs = this.files.loadAll();
    } catch (error) {
      throw new DaemonBatchError(`The batch job store at ${this.files.dir} could not be read. ${summarizeError(error)}`, 'BATCH_STORE_UNAVAILABLE', 500, {
        state: 'no batch job was read or changed',
        next: [`Check that ${this.files.dir} exists and is readable by the daemon, then retry`],
      });
    }
    return this.jobs;
  }

  private getMode(): DaemonBatchRuntimeSnapshot['mode'] {
    const value = this.options.configManager.get('batch.mode');
    return value === 'explicit' || value === 'eligible-by-default' ? value : 'off';
  }

  private getFallback(): DaemonBatchRuntimeSnapshot['fallback'] {
    const value = this.options.configManager.get('batch.fallback');
    return value === 'fail' ? 'fail' : 'live';
  }

  private getQueueBackend(): DaemonBatchRuntimeSnapshot['queueBackend'] {
    const value = this.options.configManager.get('batch.queueBackend');
    return value === 'cloudflare' ? 'cloudflare' : 'local';
  }

}

function emptyTickResult(): DaemonBatchTickResult {
  return {
    submittedProviderBatches: 0,
    submittedJobs: 0,
    polledProviderBatches: 0,
    completedJobs: 0,
    failedJobs: 0,
  };
}

function copyBatchRequest(request: CreateDaemonBatchJobInput['request']): DaemonBatchJob['request'] {
  return {
    messages: [...request.messages],
    ...(request.tools ? { tools: [...request.tools] } : {}),
    ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
    ...(request.reasoningSummary !== undefined ? { reasoningSummary: request.reasoningSummary } : {}),
  };
}
