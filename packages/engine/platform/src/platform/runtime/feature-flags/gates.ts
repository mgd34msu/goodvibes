import type { FeatureFlagManager } from './manager.js';
import { assertFeatureGateIdRegistered, featureDefaultState, getFeatureSettingsBinding } from './feature-settings.js';
import { FEATURE_FLAGS, FEATURE_FLAG_MAP } from './flags.js';
import type { FeatureInoperability } from './types.js';

export type FeatureFlagReader = Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;

/**
 * The declared reason a capability cannot operate in this build, or null when
 * it can. Surfaces read this to explain a control instead of offering one that
 * does nothing.
 */
export function featureInoperability(flagId: string): FeatureInoperability | null {
  return FEATURE_FLAG_MAP.get(flagId)?.notOperable ?? null;
}

export function isFeatureGateEnabled(
  featureFlags: FeatureFlagReader,
  flagId: string,
): boolean {
  // Membership first, even with no manager wired: a gate id absent from
  // FEATURE_SETTINGS could never be enabled by any setting, fail loudly at
  // the composition site instead of shipping the capability dead.
  assertFeatureGateIdRegistered(flagId, 'isFeatureGateEnabled');
  // A capability that cannot operate is OFF, whatever its settings key says
  // and even with no manager wired. Without this, a user flips the switch, the
  // config accepts it, and nothing happens, which is the exact failure this
  // field exists to prevent.
  if (featureInoperability(flagId) !== null) return false;
  // With no manager wired the answer is the feature's declared default, so a
  // default-off feature stays off in a composition that passes no manager.
  if (!featureFlags) return featureDefaultState(flagId) === 'enabled';
  return featureFlags.isEnabled(flagId);
}

export function requireFeatureGate(
  featureFlags: FeatureFlagReader,
  flagId: string,
  operation: string,
): void {
  if (isFeatureGateEnabled(featureFlags, flagId)) return;
  // Distinguish "you turned it off" from "it cannot work yet": pointing a user
  // at a settings key that will not help is worse than saying nothing.
  const inoperable = featureInoperability(flagId);
  if (inoperable !== null) {
    throw new Error(`the ${flagId} feature is not available in this build; cannot ${operation}. ${inoperable.detail}`);
  }
  const binding = getFeatureSettingsBinding(flagId);
  const hint = binding ? ` (see the ${binding.key} setting)` : '';
  throw new Error(`the ${flagId} feature is turned off${hint}; cannot ${operation}`);
}

const SURFACE_GATE_SUFFIX = '-surface';

/**
 * Every surface -> gate-id pair, read off the registry: a `<surface>-surface`
 * flag is that surface's gate, so a new channel adapter's flag is its gate
 * with no second table to keep in step (an unmapped adapter would read as OFF
 * with no settings recourse).
 */
const SURFACE_GATE_IDS: ReadonlyMap<string, string> = new Map(
  FEATURE_FLAGS
    .filter((flag) => flag.id.endsWith(SURFACE_GATE_SUFFIX))
    .map((flag) => [flag.id.slice(0, -SURFACE_GATE_SUFFIX.length), flag.id]),
);

export function surfaceFeatureGateId(surface: string): string | null {
  return SURFACE_GATE_IDS.get(surface) ?? null;
}

export function isSurfaceFeatureGateEnabled(
  featureFlags: FeatureFlagReader,
  surface: string,
): boolean {
  if (!featureFlags) return true;
  if (surface === 'tui' || surface === 'service') return true;
  const flagId = surfaceFeatureGateId(surface);
  // Route through isFeatureGateEnabled so the registry-membership check
  // applies to every surface gate reference too.
  return flagId ? isFeatureGateEnabled(featureFlags, flagId) : false;
}
