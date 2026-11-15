/**
 * routes/flags-graduation.ts
 *
 * Handler for flags.graduation.report. Reads the feature-flag registry and the
 * owner graduation annotations (both static module data) and returns the
 * feature defaults report. Registered from register-gateway-verb-groups.ts;
 * needs no runtime dependency, so it is always registered.
 *
 * The daemon holds no divergence readings: the permissions divergence
 * simulation runs in the terminal app (`/policy simulate`) and its readings
 * stay in that process, so instrumented capabilities report that no evidence
 * was collected here.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { buildFlagGraduationReport } from '../../runtime/feature-flags/graduation.js';

/** Build the flags.graduation.report handler. */
export function createFlagsGraduationReportHandler(): GatewayMethodHandler {
  return async () => buildFlagGraduationReport();
}

/** Attach the flags.graduation.report handler to its descriptor. Missing descriptor is a silent no-op. */
export function registerFlagsGraduationGatewayMethods(catalog: GatewayMethodCatalog): void {
  const descriptor = catalog.get('flags.graduation.report');
  if (descriptor) {
    catalog.register(descriptor, createFlagsGraduationReportHandler(), { replace: true });
  }
}
