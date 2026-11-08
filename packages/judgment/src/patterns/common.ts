/** Maps with at most `limit` calls in flight, preserving order. A failed call
 * stops admitting new work; already admitted calls settle before rejection.
 * The original first failure is preserved for typed cancellation/refusal.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await fn(items[index]!, index); }
      catch (error) {
        if (!failed) { failed = true; failure = error; }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failed) throw failure;
  return results;
}
