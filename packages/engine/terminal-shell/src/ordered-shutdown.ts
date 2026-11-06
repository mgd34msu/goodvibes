export type ShutdownCleanup = () => unknown;
export type AttemptShutdownCleanup = (cleanup: ShutdownCleanup) => Promise<void>;
/** Latch before invoking collaborators, drain every owner, and preserve failure order even for parallel drains. */
export function createOrderedShutdown<SessionData>(
  run: (sessionData: SessionData, attempt: AttemptShutdownCleanup) => Promise<void>,
  message: string,
): (sessionData: SessionData) => Promise<void> {
  let closing: Promise<void> | undefined;
  return (sessionData) =>
    (closing ??= Promise.resolve().then(async () => {
      const failures: { readonly order: number; readonly error: unknown }[] = [];
      let sequence = 0;
      const attempt: AttemptShutdownCleanup = async (cleanup) => {
        const order = sequence++;
        try {
          const result = cleanup();
          if (result === closing) throw new Error('A shutdown callback cannot await its own shutdown');
          await result;
        } catch (error) {
          failures.push({ order, error });
        }
      };
      await run(sessionData, attempt);
      const errors = failures.sort((a, b) => a.order - b.order).map(({ error }) => error);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, message);
    }));
}
/** Remove ownership before invoking any unsubscribe; one failure cannot strand siblings. */
export async function drainShutdownRegistry(registry: ShutdownCleanup[], attempt: AttemptShutdownCleanup): Promise<void> {
  for (const unsubscribe of registry.splice(0)) await attempt(unsubscribe);
}
export function clearIntervalSlot(slot: { value: ReturnType<typeof setInterval> | null }): void {
  const timer = slot.value;
  slot.value = null;
  if (timer !== null) clearInterval(timer);
}
