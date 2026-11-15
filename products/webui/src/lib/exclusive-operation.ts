const tails = new Map<string, Promise<void>>();

/**
 * Run `operation` with nothing else of the same `name` running at the same time: a second
 * click or call in this tab queues behind it, and where the browser has Web Locks so does
 * another tab. For a read-then-send sequence (status, then start only if absent) whose
 * second step must not be taken by two observers of the same "absent".
 */
export function exclusiveOperation<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const locks: LockManager | undefined = typeof navigator === "undefined" ? undefined : navigator.locks;
  const crossTab = (): Promise<T> => (locks ? locks.request(name, operation) : operation());
  const result = (tails.get(name) ?? Promise.resolve()).then(crossTab);
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  tails.set(name, tail);
  void tail.then(() => {
    if (tails.get(name) === tail) tails.delete(name);
  });
  return result;
}
