import type { CapabilityIndexReport } from '@goodvibes-jev/engine/terminal-shell/agent-turn';

/**
 * The session's capability index: the one owner of "what can this agent do
 * right now".
 *
 * The boot check installs the resolver (the four declarations over in-memory
 * lookups and a handful of `stat`s) and every reader goes through here: the
 * prompt refreshes it once at the start of each turn, `capability_status`
 * refreshes it when asked, and both see the same stored report. So a
 * credential connected mid-session reaches the system prompt on the next turn,
 * not after a restart.
 *
 * Null means "not resolved yet", which is deliberately different from "nothing
 * is available". Everything that reads this must preserve that distinction:
 * reporting an unresolved index as an empty one is the exact mistake this whole
 * module set exists to end.
 */
let snapshot: CapabilityIndexReport | null = null;
let resolver: (() => CapabilityIndexReport) | null = null;

export function setCapabilitySnapshot(report: CapabilityIndexReport): void {
  snapshot = report;
}

/** Install how this session resolves the index; the boot check does this once. */
export function installCapabilityResolver(resolve: () => CapabilityIndexReport): void {
  resolver = resolve;
}

/**
 * Resolve the index now, store it and return it. Null when no resolver is
 * installed (the boot check has not run), in which case the stored report, if
 * any, is unchanged.
 */
export function refreshCapabilityIndex(): CapabilityIndexReport | null {
  if (!resolver) return null;
  snapshot = resolver();
  return snapshot;
}

export function capabilitySnapshot(): CapabilityIndexReport | null {
  return snapshot;
}

export function resetCapabilitySnapshotForTests(): void {
  snapshot = null;
  resolver = null;
}
