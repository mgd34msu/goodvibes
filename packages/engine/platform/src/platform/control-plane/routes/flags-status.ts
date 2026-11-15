/**
 * routes/flags-status.ts
 *
 * Handler for flags.status. The feature gate manager already records, per
 * restart-gated feature, the saved setting the running process has not applied
 * (FeatureFlagManager.listPendingRestarts); this sends that record as is. The
 * daemon composition registers it, because the manager is the daemon's own.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import type { FeatureFlagManager } from '../../runtime/feature-flags/manager.js';

/** Build the flags.status handler over the running gate manager. */
export function createFlagsStatusHandler(
  featureFlags: Pick<FeatureFlagManager, 'listPendingRestarts'>,
): GatewayMethodHandler {
  return async () => ({
    pendingRestart: featureFlags.listPendingRestarts().map(({ flagId, running, saved }) => ({
      featureId: flagId,
      running,
      saved,
    })),
  });
}

/** Attach the flags.status handler to its descriptor. Missing descriptor is a silent no-op. */
export function registerFlagsStatusGatewayMethods(
  catalog: GatewayMethodCatalog,
  featureFlags: Pick<FeatureFlagManager, 'listPendingRestarts'>,
): void {
  const descriptor = catalog.get('flags.status');
  if (descriptor) {
    catalog.register(descriptor, createFlagsStatusHandler(featureFlags), { replace: true });
  }
}
