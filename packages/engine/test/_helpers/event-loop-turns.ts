/**
 * Lets already-started asynchronous work run to its next stopping point without
 * measuring time: each turn is one trip round the event loop, so the number of
 * turns, not the speed of the machine, decides how far queued continuations get.
 * Use it to show that something held back stays held back; gate positive
 * outcomes on the promise that produces them instead.
 */
export async function eventLoopTurns(turns = 25): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Waits until every promise `pending()` has returned so far has settled and no
 * newer one appeared while waiting, so work that a settled promise queued next
 * has also run.
 */
export async function settleAll(pending: () => readonly Promise<unknown>[]): Promise<void> {
  let seen = -1;
  while (seen !== pending().length) {
    seen = pending().length;
    await Promise.allSettled(pending());
    await eventLoopTurns(3);
  }
}
