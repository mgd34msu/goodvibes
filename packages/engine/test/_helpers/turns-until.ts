import { eventLoopTurns } from './event-loop-turns.ts';

/**
 * Waits for background work with no promise to await (a detached executor
 * writing its outcome to a store) by checking after each event-loop turn. The
 * bound is a count of turns, not a duration, so a loaded machine runs the same
 * number of turns and the outcome does not depend on its speed.
 */
export async function turnsUntil(check: () => boolean | Promise<boolean>, what: string, maxTurns = 100_000): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn++) {
    if (await check()) return;
    await eventLoopTurns(1);
  }
  throw new Error(`Background work did not reach its expected state: ${what}`);
}
