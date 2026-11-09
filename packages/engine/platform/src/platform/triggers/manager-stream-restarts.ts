/** Restart only a due supervised stream or an explicit operator reset. The
 * restart reservation is durable before entering the borrowed process host;
 * overlapping ticks share one original admitted operation per trigger.
 */
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { activateStreamTrigger, startStreamTrigger, type StreamOwner, type StreamRuntime } from './manager-streams.js';
import { applyFailure, isDue } from './supervision.js';
import type { TriggerManagerWork } from './manager-work.js';
import type { TriggerRecord } from './types.js';

export async function restartDueStreams(owner: StreamOwner, work: TriggerManagerWork, pending: Set<string>): Promise<void> {
  if (!owner.config().enabled || work.stopped) return;
  for (const record of [...owner.records.values()]) {
    const id = record.definition.id;
    if (record.definition.spec.kind !== 'stream' || pending.has(id) || owner.streams.has(id)
      || !isDue(record, owner.now()) || !(record.state === 'backoff' || record.state === 'idle' && record.nextCheckAt !== undefined)) continue;
    pending.add(id);
    try { await work.own(() => restartStream(owner, work, record)); }
    finally { pending.delete(id); }
  }
}

async function restartStream(owner: StreamOwner, work: TriggerManagerWork, original: TriggerRecord): Promise<void> {
  const id = original.definition.id, spec = original.definition.spec;
  if (spec.kind !== 'stream' || work.stopped || !owner.config().enabled || owner.records.get(id) !== original) return;
  const now = owner.now();
  const reserved: TriggerRecord = { ...original, state: 'running', nextCheckAt: undefined, updatedAt: now,
    lastError: 'stream restart reserved; acknowledgement unobserved',
    runs: [...original.runs, { at: now, outcome: 'checked', detail: 'stream restart reserved; acknowledgement unobserved' }],
  };
  owner.records.set(id, reserved); owner.persist();
  let runtime: StreamRuntime | undefined;
  try {
    const starting = startStreamTrigger(owner, reserved, spec, now);
    runtime = owner.streams.get(id);
    const running = await starting;
    if (work.stopped || !owner.config().enabled || owner.records.get(id) !== reserved) throw new Error('Stream restart owner retired');
    if (!runtime) throw new Error('Stream restart has no original process observation');
    owner.assertCurrent?.(id, runtime);
    owner.records.set(id, { ...running, lastError: undefined }); owner.persist();
    activateStreamTrigger(owner, id);
  } catch (error) {
    if (runtime?.timer) clearInterval(runtime.timer);
    if (runtime?.streamId) { const streamId = runtime.streamId; runtime.streamId = null; owner.streamHost?.stop(streamId); }
    if (runtime && owner.streams.get(id) === runtime) owner.streams.delete(id);
    // Cancellation, a newer record, or a failed native publication owns its
    // own outcome. Never overwrite it with a process-start failure.
    if (work.stopped || owner.records.get(id) !== reserved) throw error;
    const at = owner.now(), failure = applyFailure(reserved, owner.policy, at);
    owner.records.set(id, { ...reserved, state: failure.state, strikes: failure.strikes, backoffRung: failure.backoffRung,
      nextCheckAt: Number.isFinite(failure.nextCheckAt) ? failure.nextCheckAt : undefined,
      lastError: 'stream restart failed', updatedAt: at,
      runs: [...reserved.runs, { at, outcome: 'failed', detail: failure.breakerOpened ? 'stream restart failed; circuit open' : 'stream restart failed; retry scheduled' }],
    });
    owner.persist();
    logger.warn('Trigger stream restart failed', { triggerId: id, error: summarizeError(error) });
  }
}
