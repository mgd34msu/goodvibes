import {
  forwardKeepAwakeToAdoptedDaemon,
  type ForwardKeepAwakeDeps,
  type ForwardKeepAwakeOutcome,
} from '@goodvibes-jev/engine/platform/platform/power';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';

/**
 * The one line the owner reads when the daemon did not take, or could not act
 * on, a keep-awake change. Only the daemon's hold outlives this process, so a
 * toggle that stayed local is worth saying; null means the daemon holds it as
 * asked.
 */
export function describeKeepAwakeOutcome(enabled: boolean, outcome: ForwardKeepAwakeOutcome): string | null {
  const word = enabled ? 'on' : 'off';
  if (!outcome.attempted) {
    return `Keep-awake is ${word} in this process only; no daemon is reachable right now, so it will not outlive this process.`;
  }
  if (!outcome.result.ok) {
    return `Keep-awake is ${word} in this process only; the daemon did not take it (${outcome.result.error}), so it will not outlive this process.`;
  }
  if (enabled && outcome.result.keepAwakeState === 'refused') {
    return 'The daemon accepted keep-awake but the system refused to hold the host awake, so the machine can still sleep.';
  }
  return null;
}

export interface KeepAwakeForwardDeps extends ForwardKeepAwakeDeps {
  /** Shown to the owner. Absent: the outcome is logged only. */
  readonly notify?: ((text: string) => void) | undefined;
  /** Whether an unreachable daemon is worth a notice (a toggle: yes; a re-send on attach: it is online by definition). */
  readonly tellWhenUnreachable?: boolean;
}

/** Forward a keep-awake change to the adopted daemon and report what the daemon did. Never throws. */
export async function forwardKeepAwakeWithNotice(enabled: boolean, deps: KeepAwakeForwardDeps): Promise<void> {
  try {
    const outcome = await forwardKeepAwakeToAdoptedDaemon(enabled, deps);
    if (!outcome.attempted && deps.tellWhenUnreachable === false) return;
    const line = describeKeepAwakeOutcome(enabled, outcome);
    if (line === null) return;
    logger.warn('[power] keep-awake daemon forward did not hold', { enabled, attempted: outcome.attempted });
    deps.notify?.(line);
  } catch (error) {
    logger.warn('[power] keep-awake daemon forward failed', { error: summarizeError(error) });
  }
}

/**
 * Runs keep-awake forwards one after another, in the order they were asked, so a
 * slow "on" re-send can never reach the daemon after an "off" the owner set
 * meanwhile. A step that fails does not stop the ones behind it.
 */
export function createKeepAwakeForwardQueue(): { run<T>(step: () => Promise<T>): Promise<T> } {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(step: () => Promise<T>): Promise<T> {
      const result = tail.then(step);
      tail = result.catch(() => {});
      return result;
    },
  };
}

/**
 * The re-send done once per attach: queued behind any toggle already on its way,
 * and the setting is read when its turn comes, so an "off" the owner set
 * meanwhile is never followed by a late "on".
 */
export function queueKeepAwakeResend(
  queue: { run<T>(step: () => Promise<T>): Promise<T> },
  readKeepAwake: () => boolean,
  deps: KeepAwakeForwardDeps,
): Promise<void> {
  return queue.run(async () => {
    if (!readKeepAwake()) return;
    await forwardKeepAwakeWithNotice(true, { ...deps, tellWhenUnreachable: false });
  });
}
