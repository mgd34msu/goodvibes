/**
 * Resolve once `condition` holds, yielding to the event loop between checks.
 * The bound is a count of loop turns, not a duration, so the outcome does not
 * depend on machine speed; a condition that never holds fails with its label.
 */
export async function waitUntil(condition: () => boolean, label = 'condition'): Promise<void> {
  for (let turn = 0; turn < 500; turn++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`waitUntil: ${label} never held`);
}

/** Let every promise continuation already queued run, without assuming how many awaits the work takes. */
export function flushAsync(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
