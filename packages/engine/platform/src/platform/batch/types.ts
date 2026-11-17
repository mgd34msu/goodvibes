import type { ChatRequest, ChatResponse, ProviderBatchStatus, ProviderMessage } from '../providers/interface.js';
import type { ToolDefinition } from '../types/tools.js';
import { defineLifecycle } from '../utils/lifecycle-machine.js';

export type DaemonBatchMode = 'off' | 'explicit' | 'eligible-by-default';
export type DaemonBatchFallback = 'live' | 'fail';
export type DaemonBatchQueueBackend = 'local' | 'cloudflare';

export type DaemonBatchJobStatus =
  | 'queued'
  | 'submitting'
  | 'submitted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'dead_lettered';

/**
 * The legal moves of a batch job. Every status write in manager.ts goes
 * through this table; a move it does not list is not made.
 *  - createJob: (new) -> queued
 *  - submission: queued -> submitting (saved before the paid provider call),
 *    then submitting -> submitted | running | failed, or back to queued for a
 *    retry, or dead_lettered; a create call whose answer was lost stays
 *    submitting (submitting -> submitting, recording the error) for the next
 *    pass to ask the provider
 *  - start-up reconcile of a submitting job left by a stopped daemon: found at
 *    the provider -> submitted | running | failed; not there -> queued; the
 *    provider cannot be asked -> failed
 *  - cancelJob: queued | submitting -> cancelled
 *  - poll: submitted -> running; provider terminal -> completed | failed | cancelled | expired;
 *    unretryable poll failure -> dead_lettered
 * Terminal states never move.
 */
export const daemonBatchJobLifecycle = defineLifecycle<DaemonBatchJobStatus>('batch job', {
  queued: ['submitting', 'cancelled'],
  submitting: ['submitting', 'queued', 'submitted', 'running', 'failed', 'cancelled', 'dead_lettered'],
  submitted: ['submitted', 'running', 'completed', 'failed', 'cancelled', 'expired', 'dead_lettered'],
  running: ['running', 'completed', 'failed', 'cancelled', 'expired', 'dead_lettered'],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
  dead_lettered: [],
});

export interface DaemonBatchChatRequest {
  readonly messages: readonly ProviderMessage[];
  readonly tools?: readonly ToolDefinition[] | undefined;
  readonly systemPrompt?: string | undefined;
  readonly maxTokens?: number | undefined;
  readonly reasoningEffort?: ChatRequest['reasoningEffort'] | undefined;
  readonly reasoningSummary?: boolean | undefined;
}

export interface CreateDaemonBatchJobInput {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly request: DaemonBatchChatRequest;
  readonly executionMode?: 'batch' | 'live' | undefined;
  readonly source?: {
    readonly kind: 'daemon-api' | 'cloudflare-worker' | 'cloudflare-queue' | 'automation' | 'client';
    readonly id?: string | undefined;
  };
  readonly metadata?: Record<string, string> | undefined;
  readonly flush?: boolean | undefined;
}

export interface DaemonBatchJob {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly status: DaemonBatchJobStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly request: DaemonBatchChatRequest;
  readonly source?: CreateDaemonBatchJobInput['source'] | undefined;
  readonly metadata?: Record<string, string> | undefined;
  readonly attempts: number;
  /** Sent to the provider as batch metadata, so a batch accepted just before the daemon stopped is found instead of paid for twice. */
  readonly submissionId?: string | undefined;
  readonly providerBatchId?: string | undefined;
  readonly providerBatchStatus?: ProviderBatchStatus | undefined;
  readonly submittedAt?: number | undefined;
  readonly completedAt?: number | undefined;
  readonly result?: ChatResponse | undefined;
  readonly error?: {
    readonly message: string;
    readonly code?: string | undefined;
    readonly raw?: unknown | undefined;
  } | undefined;
}

export interface DaemonBatchTickResult {
  submittedProviderBatches: number;
  submittedJobs: number;
  polledProviderBatches: number;
  completedJobs: number;
  failedJobs: number;
}

export interface DaemonBatchRuntimeSnapshot {
  readonly mode: DaemonBatchMode;
  readonly fallback: DaemonBatchFallback;
  readonly queueBackend: DaemonBatchQueueBackend;
  readonly cloudflare: {
    readonly enabled: boolean;
    readonly freeTierMode: boolean;
    readonly accountId: string;
    readonly workerName: string;
    readonly workerBaseUrl: string;
    readonly daemonBaseUrl: string;
    readonly queueName: string;
    readonly deadLetterQueueName: string;
    readonly maxQueueOpsPerDay: number;
  };
  readonly limits: {
    readonly tickIntervalMs: number;
    readonly maxDelayMs: number;
    readonly maxJobsPerProviderBatch: number;
    readonly maxQueuePayloadBytes: number;
    readonly maxQueueMessagesPerDay: number;
  };
  readonly supportedProviders: readonly string[];
}

/** What cancelling a whole provider batch did. */
export interface DaemonBatchProviderCancelResult {
  readonly providerBatchId: string;
  /** The provider's status after the cancel. `running` means it is still winding down; finished requests are collected by the next pass. */
  readonly providerStatus: ProviderBatchStatus;
  /** Every job in that provider batch, as the cancel left it. */
  readonly jobs: readonly DaemonBatchJob[];
}

export class DaemonBatchError extends Error {
  readonly status: number;
  readonly code: string;
  /** The state the refusal leaves things in, for callers that read refusals (`readRefusal`). */
  readonly state: string | undefined;
  /** What the caller can do next. */
  readonly next: readonly string[] | undefined;

  constructor(message: string, code: string, status = 400, refusal?: { readonly state: string; readonly next: readonly string[] }) {
    super(message);
    this.name = 'DaemonBatchError';
    this.code = code;
    this.status = status;
    this.state = refusal?.state;
    this.next = refusal?.next;
  }
}
