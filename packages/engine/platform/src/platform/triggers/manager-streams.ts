/**
 * manager-streams.ts, the stream watcher kind's lifecycle.
 *
 * Split out of manager.ts so the supervisor file stays inside the 800-line
 * hand-authored cap. Spawn the long-lived command
 * through the injected stream host, feed every chunk to a StreamLineProcessor,
 * emit a batch when one is ready, and put a stream command that exits through
 * the same backoff ladder and breaker every other kind uses.
 *
 * These are free functions over a narrow `StreamOwner` view of the manager
 * rather than methods, so the coupling back to the supervisor is written down
 * explicitly instead of being "whatever `this` happens to have".
 */

import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { renderStreamPrompt, resolveStreamOptions, StreamLineProcessor } from './stream-watchers.js';
import { applyFailure, backoffDelayFor, type SupervisionPolicy } from './supervision.js';
import type { TriggerManagerConfig, TriggerStreamHost } from './manager-types.js';
import type { StreamTriggerSpec, TriggerRecord } from './types.js';

/** Per-trigger stream state: the line processor plus its supervision handles. */
export interface StreamRuntime {
  readonly processor: StreamLineProcessor;
  streamId: string | null;
  timer: ReturnType<typeof setInterval> | null;
  ready?: boolean;
  pendingExit?: { readonly code: number | null };
  /** An agent turn for an earlier batch is still running; later lines stay queued. */
  inFlight?: boolean;
  /** When the last batch started a turn. The executor returns as soon as the agent is spawned, so this gap is what spaces turns. */
  lastTurnAt?: number;
  /** When the stream was activated; how long it then stayed up decides whether its exit counts against it. */
  activatedAt?: number;
}

/** Least time between two unforced agent turns from one stream; queued lines wait, and the queue is bounded. */
export const STREAM_TURN_MIN_GAP_MS = 30_000;

/** Exactly what the stream lifecycle needs from the supervisor. */
export interface StreamOwner {
  readonly streams: Map<string, StreamRuntime>;
  readonly records: Map<string, TriggerRecord>;
  readonly streamHost: TriggerStreamHost | undefined;
  readonly policy: SupervisionPolicy;
  config(): TriggerManagerConfig;
  now(): number;
  /** Saves one trigger's record. */
  persist(id: string): void;
  readonly deferActivation?: boolean;
  assertCurrent?(id: string, runtime: StreamRuntime): void;
  /** Resolves true when the action was delivered, false when it failed (the failure is already on the record). */
  fireAction(
    id: string,
    reason: string,
    fingerprint: string,
    kind: 'condition' | 'stream',
    promptOverride?: string,
  ): Promise<boolean>;
}

export async function startStreamTrigger(
  owner: StreamOwner,
  record: TriggerRecord,
  spec: StreamTriggerSpec,
  now: number,
): Promise<TriggerRecord> {
  const host = owner.streamHost;
  if (!host) {
    throw new Error('A stream trigger needs a stream host; none is wired on this TriggerManager.');
  }
  const id = record.definition.id;
  const config = owner.config();
  const processor = new StreamLineProcessor(resolveStreamOptions(spec, {
    ...(config.streamBatchLines !== undefined ? { batchLines: config.streamBatchLines } : {}),
    ...(config.streamBatchIntervalMs !== undefined ? { batchIntervalMs: config.streamBatchIntervalMs } : {}),
    ...(config.streamQueueLimit !== undefined ? { queueLimit: config.streamQueueLimit } : {}),
  }));
  const runtime: StreamRuntime = { processor, streamId: null, timer: null, ready: false };
  owner.streams.set(id, runtime);

  let started: Awaited<ReturnType<TriggerStreamHost['start']>>;
  try { started = await host.start({
    triggerId: id,
    command: spec.command,
    args: spec.args ?? [],
    ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
    onChunk: (chunk: string) => {
      if (owner.streams.get(id) !== runtime) return;
      processor.push(chunk, owner.now());
      if (runtime.ready) drainStreamTrigger(owner, id);
    },
    onExit: (exitCode: number | null) => {
      if (owner.streams.get(id) !== runtime) return;
      processor.finish(owner.now());
      if (runtime.ready) { drainStreamTrigger(owner, id, true); handleStreamExit(owner, id, exitCode); }
      else runtime.pendingExit = { code: exitCode };
    },
  }); } catch (error) {
    if (owner.streams.get(id) === runtime) owner.streams.delete(id);
    throw error;
  }
  runtime.streamId = started.streamId;
  try { owner.assertCurrent?.(id, runtime); }
  catch (error) { host.stop(started.streamId); runtime.streamId = null; if (owner.streams.get(id) === runtime) owner.streams.delete(id); throw error; }
  if (!owner.deferActivation) {
    if (!owner.records.has(id)) owner.records.set(id, { ...record, state: 'running', nextCheckAt: now, updatedAt: now });
    activateStreamTrigger(owner, id);
  }

  return { ...record, state: 'running', nextCheckAt: now, updatedAt: now };
}

/** Native manager calls this only after the actual running record is durable. */
export function activateStreamTrigger(owner: StreamOwner, id: string): void {
  const runtime = owner.streams.get(id), record = owner.records.get(id);
  if (!runtime || !record || record.definition.spec.kind !== 'stream' || runtime.ready) return;
  owner.assertCurrent?.(id, runtime);
  runtime.ready = true;
  runtime.activatedAt = owner.now();
  const config = owner.config(), spec = record.definition.spec;
  const interval = Math.max(50, spec.batchIntervalMs ?? config.streamBatchIntervalMs ?? 1_000);
  runtime.timer = setInterval(() => { drainStreamTrigger(owner, id); }, interval); runtime.timer.unref?.();
  if (runtime.pendingExit) {
    const { code } = runtime.pendingExit; delete runtime.pendingExit;
    drainStreamTrigger(owner, id, true); handleStreamExit(owner, id, code);
  } else drainStreamTrigger(owner, id);
}

/**
 * Emits whatever batches are ready. An agent runs only when one is. While the
 * stream runs, turns are spaced by the minimum gap and one at a time; when it
 * ends (`force`), everything still queued goes out as one final batch.
 * `fired` is recorded once, when the action returned; a batch whose action
 * failed goes back at the head of the queue while the stream still runs.
 */
export function drainStreamTrigger(owner: StreamOwner, id: string, force = false): void {
  const runtime = owner.streams.get(id);
  const record = owner.records.get(id);
  if (!runtime || !record || record.definition.spec.kind !== 'stream' || runtime.ready === false || !owner.config().enabled) return;
  const spec = record.definition.spec;
  for (;;) {
    if (!force && (runtime.inFlight
      || (runtime.lastTurnAt !== undefined && owner.now() - runtime.lastTurnAt < STREAM_TURN_MIN_GAP_MS))) break;
    const now = owner.now();
    const batch = force ? runtime.processor.takeFinal(now) : runtime.processor.takeBatch(now);
    if (!batch) break;
    const current = owner.records.get(id);
    if (current && current.droppedLines !== runtime.processor.droppedTotal) {
      owner.records.set(id, { ...current, droppedLines: runtime.processor.droppedTotal, updatedAt: now });
    }
    const prompt = renderStreamPrompt(batch, record.definition.label, spec.match.pattern);
    runtime.inFlight = true; runtime.lastTurnAt = now;
    const reason = `${batch.lines.length} line(s) matched ${spec.match.pattern}${batch.final ? ' as the command ended' : ''}${batch.dropped > 0 ? `, ${batch.dropped} dropped` : ''}`;
    const giveBack = (): void => { if (!batch.final && owner.streams.get(id) === runtime) runtime.processor.requeue(batch.lines, owner.now()); };
    void owner.fireAction(id, reason, `stream:${batch.lines[0] ?? ''}`, 'stream', prompt).then((delivered) => {
      if (!delivered) giveBack();
    }, (error: unknown) => {
      logger.warn('Stream trigger action failed', { triggerId: id, error: summarizeError(error) });
      giveBack();
    }).finally(() => { runtime.inFlight = false; });
    if (batch.final) break;
  }
}

/**
 * A supervised stream command that exits walks the same ladder and breaker,
 * counting only the exits that say something is wrong. A stream that stayed
 * up for at least the first rung of the ladder, or delivered a matched line,
 * was healthy: its strikes and rung start again from zero. An exit with code 0
 * is a restart, not a strike: at once after a healthy run, on the ladder
 * (without a strike) after a short one, so `tail -f` across a log rotation
 * never parks the watcher.
 */
export function handleStreamExit(owner: StreamOwner, id: string, exitCode: number | null): void {
  const record = owner.records.get(id);
  if (!record || record.definition.spec.kind !== 'stream') return;
  if (record.state === 'cancelled') return;
  const runtime = owner.streams.get(id);
  const now = owner.now();
  const healthy = runtime !== undefined && (runtime.processor.matchedTotal > 0
    || (runtime.activatedAt !== undefined && now - runtime.activatedAt >= backoffDelayFor(owner.policy, 0)));
  if (runtime) {
    if (runtime.timer) clearInterval(runtime.timer);
    runtime.timer = null; runtime.streamId = null; runtime.ready = false;
    owner.streams.delete(id);
  }
  const spec = record.definition.spec;
  if (spec.restart === false) {
    owner.records.set(id, {
      ...record,
      state: 'idle',
      nextCheckAt: undefined,
      runs: [...record.runs, { at: now, outcome: 'skipped', detail: `stream command exited (${exitCode}); restart disabled` }],
      updatedAt: now,
    });
    owner.persist(id);
    return;
  }
  const base = healthy ? { strikes: 0, backoffRung: 0 } : { strikes: record.strikes, backoffRung: record.backoffRung };
  if (exitCode === 0) {
    const delayMs = healthy ? 0 : backoffDelayFor(owner.policy, base.backoffRung);
    owner.records.set(id, {
      ...record,
      state: 'backoff',
      strikes: base.strikes,
      backoffRung: healthy ? 0 : Math.min(base.backoffRung + 1, Math.max(0, owner.policy.ladderMs.length - 1)),
      nextCheckAt: now + delayMs,
      lastError: undefined,
      runs: [...record.runs, { at: now, outcome: 'skipped', detail: delayMs === 0 ? 'stream command ended normally; restarting it' : `stream command ended normally soon after starting; restarting in ${delayMs}ms` }],
      updatedAt: now,
    });
    owner.persist(id);
    return;
  }
  // An exit carries only its code and no wording to read, so it spends the
  // retry budget like any failure a retry may clear.
  const outcome = applyFailure(base, owner.policy, now);
  owner.records.set(id, {
    ...record,
    state: outcome.state,
    strikes: outcome.strikes,
    backoffRung: outcome.backoffRung,
    nextCheckAt: Number.isFinite(outcome.nextCheckAt) ? outcome.nextCheckAt : undefined,
    lastError: `stream command exited with ${exitCode}`,
    runs: [...record.runs, {
      at: now,
      outcome: 'failed',
      detail: outcome.breakerOpened
        ? `stream command exited (${exitCode}); breaker opened after ${outcome.strikes} consecutive failed runs; reset the trigger to start it again`
        : `stream command exited (${exitCode}); restarting in ${outcome.delayMs}ms`,
    }],
    updatedAt: now,
  });
  owner.persist(id);
}
