/**
 * serial-steps.ts, run asynchronous steps strictly one after another.
 *
 * A step starts only after every earlier step has settled, whether it resolved
 * or rejected, and each caller gets its own step's result or error. Used where
 * two overlapping callers would each replace one shared handle and leave the
 * loser's handle running with no owner.
 */
export function createSerialSteps(): <T>(step: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T,>(step: () => Promise<T>): Promise<T> => {
    const run = tail.then(step, step);
    tail = run.catch(() => {});
    return run;
  };
}
