/**
 * The live sandbox proofs (test/live/) run inside real bubblewrap. A host that
 * lacks a capability one of them needs fails that file at load, naming what is
 * missing: a missing sandbox is never a pass and never a skip.
 */
export function requireLiveHost(capability: string, available: boolean): void {
  if (!available) throw new Error(`Live sandbox proof: ${capability} is unavailable on this host`);
}
