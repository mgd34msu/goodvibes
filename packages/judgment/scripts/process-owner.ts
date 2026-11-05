/** CLI lifetime: stop network attempts and provider-directed waits on exit signals. */
let signal: AbortSignal | undefined;
export function judgmentProcessSignal(): AbortSignal {
  if (signal) return signal;
  const owner = new AbortController();
  const cancel = () => owner.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  return signal = owner.signal;
}
