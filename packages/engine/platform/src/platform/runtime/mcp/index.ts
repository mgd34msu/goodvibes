/**
 * src/runtime/mcp, MCP lifecycle barrel.
 *
 * The MCP registry composes one `McpLifecycleManager` as the owner of each
 * server's connection state and of reconnecting a server that dropped
 * (automatic reconnect is the `runtime.mcpLifecycle` setting). Embedders that
 * own their own connections can create one with `createMcpLifecycleManager()`
 * and a connector.
 *
 * Public API:
 *   - `createMcpLifecycleManager()`, factory function
 *   - All types from types.ts
 *   - State machine helpers from lifecycle.ts
 *   - Permission manager from permissions.ts
 *   - Schema freshness tracker from schema-freshness.ts
 *   - Manager from manager.ts
 */

export { McpLifecycleManager, type McpEventHandler, type McpLifecycleConnector, type McpLifecycleManagerOptions } from './manager.js';
export { McpPermissionManager, buildMcpAttackPathReview } from './permissions.js';
export { McpSchemaFreshnessTracker } from './schema-freshness.js';
export {
  canTransition,
  reachableFrom,
  applyTransition,
  isOperational,
  isTerminal,
  type TransitionResult,
} from './lifecycle.js';
export type {
  McpServerState,
  SchemaFreshness,
  McpSchemaRecord,
  QuarantineReason,
  QuarantineRecord,
  McpTrustLevel,
  McpTrustMode,
  McpServerRole,
  McpCapabilityClass,
  McpCoherenceVerdict,
  McpRiskLevel,
  McpPermission,
  McpTrustProfile,
  McpCoherenceAssessment,
  McpDecisionRecord,
  McpSecuritySnapshot,
  McpAttackPathFindingKind,
  McpAttackPathFinding,
  McpAttackPathReview,
  McpToolPermission,
  McpToolRuleRecord,
  McpServerPermissions,
  McpServerEntry,
  McpReconnectConfig,
  McpReconnectStatus,
} from './types.js';
export { DEFAULT_RECONNECT_CONFIG } from './types.js';

import { McpLifecycleManager } from './manager.js';
import type { McpLifecycleManagerOptions } from './manager.js';
import type { FeatureFlagManager } from '../feature-flags/index.js';

/**
 * Factory function for creating a `McpLifecycleManager`.
 *
 * With a flag manager, automatic reconnect also follows the `mcp-lifecycle`
 * gate (runtime.mcpLifecycle), read each time a server drops.
 *
 * @param options - The connector and optional configuration overrides
 */
export function createMcpLifecycleManager(
  options: McpLifecycleManagerOptions,
  flagManager?: Pick<FeatureFlagManager, 'isEnabled'> | null,
): McpLifecycleManager {
  if (!flagManager) return new McpLifecycleManager(options);
  const enabled = options.enabled;
  return new McpLifecycleManager({ ...options, enabled: () => flagManager.isEnabled('mcp-lifecycle') && (enabled?.() ?? true) });
}
