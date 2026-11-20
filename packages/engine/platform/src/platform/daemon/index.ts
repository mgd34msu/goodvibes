export { DaemonServer } from './facade.js';
export { bootDaemon } from './boot.js';
export type { BootDaemonOptions, BootedDaemon } from './boot.js';
// Fatal-boot disclosure: a direct, unbuffered descriptor write immune to a
// replaced process.stdout/stderr and to exit-time truncation. Both the TUI
// and the agent vendored this as an identical local mirror because the
// published platform predated this export path; this is the one implementation.
export { describeFatalFailure, reportFatalBootFailure, writeExitingStdoutLine, writeFatalLine } from './fatal-boot-report.js';
// Port-conflict-honest Bun.serve wrapper: bounds a thrown request-handler
// failure to a stack-free JSON 500 without swallowing a real bind-time
// failure (e.g. EADDRINUSE), which still propagates to the caller.
export { createHostRequestFailureResponse, createSafeHostServeFactory } from './safe-serve.js';
export type { DaemonUpdateArtifact } from './facade-lifecycle.js';
export { readLifecycleMarker } from './lifecycle-marker.js';
export type { LifecycleMarker } from './lifecycle-marker.js';
export { HttpListener } from './http-listener.js';
// Hosted sessions: the composition a product wires, and the option shape it
// states its trust posture through. The engine itself is
// `@goodvibes-jev/engine/platform/platform/hosted-sessions`.
export { composeHostedSessions } from './hosted-sessions-composition.js';
export type {
  DaemonHostedSessionsOptions,
  HostedSessionCompositionInput,
} from './hosted-sessions-composition.js';
export { PlatformServiceManager, MANAGED_UNIT_RESTART_POLICY, managedUnitStartDeadlineMs, SERVICE_STATE_ROOT, serviceStateDirectory } from './service-manager.js';
export { DAEMON_SERVICE_NAME, DARWIN_DAEMON_SERVICE_LABEL, resolveDaemonServiceDefault, resolveServiceUnitHome } from './daemon-service-default.js';
export { MANAGED_SERVICE_DESCRIPTION, buildManagedDaemonServiceDefinition, resolveServiceLauncher } from './managed-service-definition.js';
export type { ManagedDaemonServiceDefinitionInput } from './managed-service-definition.js';

export type { ManagedDaemonLaunch, ManagedServiceActionResult, ManagedServiceStatus } from './service-manager.js';
export { isPortAvailable, requirePortAvailable } from './port-check.js';

export { resolveHostBinding, resolveWebPort } from './host-resolver.js';
export type { ResolvedHostBinding } from './host-resolver.js';
export {
  resolveAuthenticatedPrincipal,
  resolvePrivateHostFetchOptions,
} from './http-policy.js';
export { createDaemonChannelRouteHandlers } from './http/channel-routes.js';
export { createDaemonControlRouteHandlers } from './http/control-routes.js';
export { createDaemonIntegrationRouteHandlers } from './http/integration-routes.js';
export { createDaemonKnowledgeRouteHandlers } from './http/knowledge-routes.js';
export { createDaemonMediaRouteHandlers } from './http/media-routes.js';
export { createDaemonSystemRouteHandlers } from './http/system-routes.js';
export { createDaemonTelemetryRouteHandlers } from './http/telemetry-routes.js';
export { jsonErrorResponse } from '@goodvibes-jev/engine/daemon-api';
export {
  dispatchClusterGroupRoutes,
  type ClusterGroupRouteContext,
  type ClusterGroupVerbs,
} from './http/cluster-group-routes.js';

/** Products compose the actual authenticated dispatcher through this public surface. */
export { DaemonControlPlaneHelper } from './control-plane.js';
export type { DaemonControlPlaneContext } from './control-plane.js';

export { defaultDownloadBaseUrl } from './auto-updater.js';
