/**
 * memory-consolidation-scheduler.ts, the daemon-side driver that makes the
 * consolidation engine actually run.
 *
 * The engine (memory-consolidation.ts) was complete but had no production
 * wiring in this runtime, the only driver lived in the agent surface behind
 * an agent-local toggle, so consolidation effectively never ran. The DAEMON is
 * the memory store's single writer, so this scheduler runs the pass here, on
 * the two triggers the engine's enum already names:
 *
 * - `idle`: the runtime has been continuously idle for minIdleMs and at least
 *   intervalMs has passed since the last run (the preferred, cheap moment);
 * - `schedule`: the slow fallback, even a never-idle daemon consolidates once
 *   per SCHEDULE_FACTOR x intervalMs, so a busy host cannot starve the pass
 *   forever.
 *
 * Mechanical outcomes (reversible merges, never-referenced decay) just happen,
 * with the engine's own run receipts logged and retained on a bounded ring;
 * judgment outcomes are PROPOSALS kept in the memory store once each
 * (listProposals), routed to the existing confirmation-gated memory routes;
 * nothing is ever auto-deleted (the engine marks stale, never deletes, see
 * its module contract). The last completed pass is the store's consolidation
 * cursor, so a restart does not make a pass due again, and a due pass with
 * nothing changed since sends no request.
 *
 * Timers are unref'd and injectable; `learning.consolidation.enabled: false`
 * remains the user's off switch, re-read live on every wake.
 */
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import {
  readMemoryConsolidationCursor,
  runMemoryConsolidation,
  type MemoryConsolidationProposal,
  type MemoryConsolidationRegistry,
  type MemoryConsolidationRunReceipt,
  type MemoryConsolidationUsageLookup,
} from './memory-consolidation.js';
import { memoryUsageSignal, type MemoryUsageEntry } from './memory-usage-stats.js';
import {
  resolveMemoryConsolidationConfig,
  type MemoryConsolidationConfigSource,
} from './memory-consolidation-config.js';

/** A never-idle daemon still consolidates once per SCHEDULE_FACTOR x intervalMs. */
const SCHEDULE_FACTOR = 4;
/** How many run receipts the scheduler retains for inspection. */
const RECEIPT_RING_SIZE = 20;

export interface MemoryConsolidationSchedulerOptions {
  /** With `usage` (MemoryRegistry has it), decay reads the usage counters on the records unless `usageLookup` is given. */
  readonly memoryRegistry: MemoryConsolidationRegistry & { usage?(id: string): MemoryUsageEntry | null };
  /** Live config source (ConfigManager.getRaw shape); re-read every wake. */
  readonly configSource: MemoryConsolidationConfigSource;
  /** True when the runtime is idle right now (e.g. no busy broker sessions). */
  readonly isIdle: () => boolean;
  /** Usage instrumentation; defaults to the counters on the memory records (see memoryRegistry). */
  readonly usageLookup?: MemoryConsolidationUsageLookup | undefined;
  readonly now?: (() => number) | undefined;
  readonly setTimer?: ((fn: () => void, ms: number) => ReturnType<typeof setTimeout>) | undefined;
  readonly clearTimer?: ((timer: ReturnType<typeof setTimeout>) => void) | undefined;
  /** Wake cadence for the due-ness check (5 minutes by default). */
  readonly checkIntervalMs?: number | undefined;
  /** Optional receipt sink invoked after every run (in addition to the log + ring). */
  readonly onReceipt?: ((receipt: MemoryConsolidationRunReceipt) => void) | undefined;
}

export class MemoryConsolidationScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Seeded from the store's cursor at the first wake, so a restart does not make a pass due. */
  private lastRunAt: number | null = null;
  /** First-tick timestamp: the schedule fallback baselines here, so a busy daemon consolidates SCHEDULE_FACTOR x intervalMs after start, not instantly. */
  private startedAt: number | null = null;
  private idleSince: number | null = null;
  private readonly receipts: MemoryConsolidationRunReceipt[] = [];
  private running: Promise<void> | null = null;

  constructor(private readonly options: MemoryConsolidationSchedulerOptions) {}

  private get checkIntervalMs(): number {
    return this.options.checkIntervalMs ?? 5 * 60 * 1000;
  }

  start(): void {
    this.stopped = false;
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      (this.options.clearTimer ?? clearTimeout)(this.timer);
      this.timer = null;
    }
  }

  /** The retained receipts, newest last (bounded ring). */
  listReceipts(): readonly MemoryConsolidationRunReceipt[] {
    return this.receipts;
  }

  /**
   * The proposals still waiting for a person, each once, from the memory
   * store; they survive a restart. A registry without a proposal table falls
   * back to the proposals of the retained receipts.
   */
  listProposals(): readonly MemoryConsolidationProposal[] {
    const registry = this.options.memoryRegistry;
    return registry.listConsolidationProposals ? registry.listConsolidationProposals() : this.receipts.flatMap((receipt) => receipt.proposed);
  }

  private usageLookup(): MemoryConsolidationUsageLookup | undefined {
    if (this.options.usageLookup) return this.options.usageLookup;
    const registry = this.options.memoryRegistry;
    if (!registry.usage) return undefined;
    return (id) => memoryUsageSignal(registry.usage?.(id));
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    // Every tick ends here, including ticks an external caller made while a
    // timer was already armed: replace that timer rather than adding a chain.
    if (this.timer) (this.options.clearTimer ?? clearTimeout)(this.timer);
    const setTimer = this.options.setTimer ?? setTimeout;
    this.timer = setTimer(() => {
      this.timer = null;
      void this.tick();
    }, this.checkIntervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * One wake: track continuous idleness, then run when due, the idle trigger
   * at intervalMs cadence, or the slow schedule fallback when the runtime has
   * not offered an idle window for SCHEDULE_FACTOR x intervalMs. A wake that
   * arrives while a pass is in flight joins that pass instead of starting a
   * second one, and the next wake is armed once it settles.
   */
  async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.runOnce();
    } finally {
      this.scheduleNext();
    }
  }

  /**
   * The same due-ness check and run as a wake, for callers outside the timer
   * (power wake catch-up). It joins an in-flight pass and never arms a timer.
   */
  runNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.runOnce();
  }

  private runOnce(): Promise<void> {
    if (!this.running) {
      this.running = this.evaluate().finally(() => { this.running = null; });
    }
    return this.running;
  }

  private async evaluate(): Promise<void> {
    try {
      const now = (this.options.now ?? Date.now)();
      if (this.startedAt === null) this.startedAt = now;
      if (this.lastRunAt === null) this.lastRunAt = Math.min(now, readMemoryConsolidationCursor(this.options.memoryRegistry)?.at ?? 0);
      const config = resolveMemoryConsolidationConfig(this.options.configSource);
      if (!config.enabled) return;

      const idleNow = this.options.isIdle();
      if (idleNow && this.idleSince === null) this.idleSince = now;
      if (!idleNow) this.idleSince = null;
      const idleLongEnough = idleNow && this.idleSince !== null && now - this.idleSince >= config.minIdleMs;

      const lastRunAt = this.lastRunAt ?? 0;
      const dueForIdleRun = idleLongEnough && now - lastRunAt >= config.intervalMs;
      const dueForScheduleRun = now - Math.max(lastRunAt, this.startedAt) >= config.intervalMs * SCHEDULE_FACTOR;
      if (!dueForIdleRun && !dueForScheduleRun) return;

      // A failed pass counts as an attempt too: without this a provider outage
      // leaves the pass due, and every wake would start the pass again. The
      // cursor keeps what the failed pass did not compare for the next one.
      this.lastRunAt = now;
      const usageLookup = this.usageLookup();
      const receipt = await runMemoryConsolidation({
        memoryRegistry: this.options.memoryRegistry,
        config,
        now,
        trigger: dueForIdleRun ? 'idle' : 'schedule',
        idle: idleNow,
        ...(usageLookup ? { usageLookup } : {}),
      });
      this.receipts.push(receipt);
      if (this.receipts.length > RECEIPT_RING_SIZE) this.receipts.splice(0, this.receipts.length - RECEIPT_RING_SIZE);
      logger.info('[memory] consolidation ran', {
        runId: receipt.runId,
        trigger: receipt.trigger,
        scanned: receipt.scanned,
        merged: receipt.merged.length,
        decayed: receipt.decayed.length,
        archived: receipt.archived.length,
        proposed: receipt.proposed.length,
        pairsRead: receipt.pairsRead ?? 0,
      });
      try {
        this.options.onReceipt?.(receipt);
      } catch (error) {
        logger.warn('[memory] consolidation receipt sink failed', { error: summarizeError(error) });
      }
    } catch (error) {
      logger.warn('[memory] consolidation run failed', { error: summarizeError(error) });
    }
  }
}
