/**
 * The daemon's answer to flags.status: restart-gated features whose saved
 * setting the running daemon has not applied yet. config.get carries saved
 * values only, so this is what tells Settings a feature is running in a state
 * other than the one it shows as saved.
 */

export type FeatureGateState = 'enabled' | 'disabled';

export interface FeaturePendingRestart {
  readonly featureId: string;
  /** The state the running daemon has. */
  readonly running: FeatureGateState;
  /** The saved state, applied at the next daemon start. */
  readonly saved: FeatureGateState;
}

export interface FeatureRestartStatus {
  readonly pendingRestart: readonly FeaturePendingRestart[];
}

function isGateState(value: unknown): value is FeatureGateState {
  return value === 'enabled' || value === 'disabled';
}

/** Validate the wire answer; a malformed one is refused rather than shown as "nothing pending". */
export function readFeatureRestartStatus(value: unknown): FeatureRestartStatus {
  const list = value && typeof value === 'object' ? (value as { pendingRestart?: unknown }).pendingRestart : undefined;
  if (!Array.isArray(list)) throw new Error('The daemon sent no feature restart status.');
  const pendingRestart: FeaturePendingRestart[] = [];
  for (const entry of list) {
    const row = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    if (typeof row.featureId !== 'string' || !isGateState(row.running) || !isGateState(row.saved)) {
      throw new Error('The daemon sent a feature restart entry this page cannot read.');
    }
    pendingRestart.push({ featureId: row.featureId, running: row.running, saved: row.saved });
  }
  return { pendingRestart };
}
