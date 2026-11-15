/**
 * The one polling helper for daemon tests that wait on asynchronous product
 * state with no event to await. A read is pending while it returns `undefined`,
 * `null` or `false`, so every caller shares one rule.
 */
export async function waitFor<T>(
  read: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  timeoutMs = 5_000,
  intervalMs = 25,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Timed out waiting for value');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Waits until `predicate` holds; the failure names what was awaited. */
export async function until(predicate: () => boolean, label: string, timeoutMs = 5_000, intervalMs = 5): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
