import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { normalizeConversationFollowUpItems, type ConversationFollowUpItem } from './conversation-follow-ups.js';

const FOLLOW_UP_DEDUP_TTL_MS = 60_000;
const FOLLOW_UP_RETRY_DELAY_MS = 250;
/** A follow-up whose recovery keeps failing is tried this many times in all, then dropped. */
const FOLLOW_UP_MAX_ATTEMPTS = 5;
const FOLLOW_UP_MAX_RETRY_DELAY_MS = 30_000;

export interface OrchestratorFollowUpRetryPolicy {
  /** Attempts in all before a failing follow-up is dropped. Default 5. */
  readonly maxAttempts?: number | undefined;
  /** Delay before the first retry; doubles per failed attempt. Default 250ms. */
  readonly baseDelayMs?: number | undefined;
  /** Ceiling for the backoff. Default 30s. */
  readonly maxDelayMs?: number | undefined;
}

export interface OrchestratorFollowUpRuntimeOptions {
  readonly getThinkingState: () => { readonly isThinking: boolean; readonly isCompacting: boolean };
  readonly getQueuedUserMessageCount: () => number;
  /** Resume the original authorized work through the ordinary tool loop and its completion gate. */
  readonly resumeWork: (items: readonly ConversationFollowUpItem[], signal: AbortSignal) => Promise<void>;
  readonly routeLowPriorityMessage: (message: string) => void;
  readonly retry?: OrchestratorFollowUpRetryPolicy | undefined;
}

export class OrchestratorFollowUpRuntime {
  private queue: ConversationFollowUpItem[] = [];
  private flushScheduled = false;
  private isRunning = false;
  private activeAbortController: AbortController | null = null;
  private activeBatch: ConversationFollowUpItem[] = [];
  private disposed = false;
  private readonly recentKeys = new Map<string, number>();
  /** Failed recovery attempts per follow-up key; cleared on success or when the follow-up is dropped. */
  private readonly failedAttempts = new Map<string, number>();
  private nextRetryDelayMs = FOLLOW_UP_RETRY_DELAY_MS;

  public constructor(private readonly options: OrchestratorFollowUpRuntimeOptions) {}

  public enqueue(item: ConversationFollowUpItem): void {
    if (this.disposed) return;
    const summary = item.summary.trim();
    if (summary.length === 0) return;
    const now = Date.now();
    this.pruneRecent(now);
    const lastSeenAt = this.recentKeys.get(item.key);
    if (lastSeenAt !== undefined && now - lastSeenAt < FOLLOW_UP_DEDUP_TTL_MS) return;
    this.recentKeys.set(item.key, now);
    this.queue.push({ ...item, summary });
    this.scheduleFlush();
  }

  public scheduleFlush(): void {
    if (this.disposed || this.flushScheduled || this.queue.length === 0) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      void this.flush().catch((error: unknown) => {
        logger.warn('Orchestrator follow-up flush failed before provider call', {
          error: summarizeError(error),
        });
      });
    });
  }

  /** Interrupt a pending recovery when a user turn takes priority or the session stops. */
  public cancel(requeue = false): void {
    if (requeue && this.activeAbortController && !this.activeAbortController.signal.aborted) {
      this.queue.unshift(...this.activeBatch);
    }
    this.activeAbortController?.abort();
  }

  public dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.cancel();
  }

  private pruneRecent(now: number): void {
    for (const [key, seenAt] of this.recentKeys.entries()) {
      if (now - seenAt >= FOLLOW_UP_DEDUP_TTL_MS) {
        this.recentKeys.delete(key);
      }
    }
  }

  private takeBatch(): ConversationFollowUpItem[] {
    const batch = normalizeConversationFollowUpItems(this.queue);
    if (batch.length === 0) {
      this.queue = [];
      return [];
    }
    const batchKeys = new Set(batch.map((item) => item.key));
    this.queue = this.queue.filter((item) => !batchKeys.has(item.key));
    return batch;
  }

  private async flush(): Promise<void> {
    if (this.disposed || this.queue.length === 0) return;
    const state = this.options.getThinkingState();
    if (state.isThinking || state.isCompacting || this.isRunning || this.options.getQueuedUserMessageCount() > 0) {
      const timer = setTimeout(() => this.scheduleFlush(), FOLLOW_UP_RETRY_DELAY_MS);
      timer.unref?.();
      return;
    }

    const batch = this.takeBatch();
    if (batch.length === 0) return;
    this.isRunning = true;
    const controller = new AbortController();
    this.activeAbortController = controller;
    this.activeBatch = batch;
    const { signal } = controller;
    try {
      signal.throwIfAborted();
      // Neither completed results nor failure notices may publish an unchecked
      // assistant message. Both are evidence for the same checked execution path.
      await this.options.resumeWork(batch, signal);
      for (const item of batch) this.failedAttempts.delete(item.key);
    } catch (error) {
      if (signal.aborted) return;
      this.handleFailure(batch, error);
    } finally {
      this.activeAbortController = null;
      this.activeBatch = [];
      this.isRunning = false;
      if (this.queue.length > 0) {
        const timer = setTimeout(() => this.scheduleFlush(), this.nextRetryDelayMs);
        timer.unref?.();
      }
      this.nextRetryDelayMs = this.baseDelayMs();
    }
  }

  private baseDelayMs(): number {
    return this.options.retry?.baseDelayMs ?? FOLLOW_UP_RETRY_DELAY_MS;
  }

  /**
   * A failed recovery re-queues its batch with a growing delay, but only up to
   * the attempt cap: past it the follow-up is dropped, logged, and the user is
   * told, so an endlessly failing one cannot retry forever.
   */
  private handleFailure(batch: readonly ConversationFollowUpItem[], error: unknown): void {
    const maxAttempts = Math.max(1, this.options.retry?.maxAttempts ?? FOLLOW_UP_MAX_ATTEMPTS);
    const maxDelayMs = this.options.retry?.maxDelayMs ?? FOLLOW_UP_MAX_RETRY_DELAY_MS;
    const kept: ConversationFollowUpItem[] = [];
    const dropped: ConversationFollowUpItem[] = [];
    let worst = 0;
    for (const item of batch) {
      const attempts = (this.failedAttempts.get(item.key) ?? 0) + 1;
      worst = Math.max(worst, attempts);
      if (attempts >= maxAttempts) {
        this.failedAttempts.delete(item.key);
        dropped.push(item);
      } else {
        this.failedAttempts.set(item.key, attempts);
        kept.push(item);
      }
    }
    const message = summarizeError(error);
    if (kept.length > 0) {
      this.queue.unshift(...kept);
      this.nextRetryDelayMs = Math.min(maxDelayMs, this.baseDelayMs() * 2 ** Math.max(0, worst - 1));
      logger.warn('Orchestrator follow-up recovery failed', { error: message, updates: kept.map((item) => item.summary) });
      this.options.routeLowPriorityMessage(`[Follow-up] Recovery remains pending: ${message}`);
    }
    if (dropped.length > 0) {
      const updates = dropped.map((item) => item.summary);
      logger.error('Orchestrator follow-up recovery abandoned after repeated failures', { error: message, attempts: maxAttempts, updates });
      this.options.routeLowPriorityMessage(`[Follow-up] Recovery abandoned after ${maxAttempts} failed attempts (${message}): ${updates.join('; ')}`);
    }
  }
}
