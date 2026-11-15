import { setImmediate } from 'node:timers/promises';

/**
 * Lets every already-scheduled promise continuation and I/O callback run, a
 * fixed number of event-loop turns and no wall-clock time. For asserting that
 * something has not happened yet, where the thing waited on is held by the test.
 */
export async function settleTurns(turns = 50): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await setImmediate();
}
