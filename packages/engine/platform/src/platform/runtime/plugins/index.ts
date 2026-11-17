/**
 * Plugin lifecycle building blocks, barrel export.
 *
 * The plugin manager (`platform/plugins/manager.ts`) is the one owner of
 * plugin loading, reloading, trust and quarantine; it publishes the lifecycle
 * events. This module holds the pieces it uses: the capability manifest, the
 * trust tiers, the quarantine engine and the lifecycle state machine.
 */

export type {
  PluginCapability,
  PluginCapabilityManifest,
  PluginManifestV2,
  TransitionResult,
  PluginLifecycleState,
} from './types.js';

export { ALL_CAPABILITIES, HIGH_RISK_CAPABILITIES } from './types.js';

export {
  VALID_TRANSITIONS,
  canTransition,
  applyTransition,
  isOperational,
  isReloadable,
  isTerminal,
} from './lifecycle.js';

export {
  resolveCapabilityManifest,
  hasCapability,
  validateManifestV2,
} from './manifest.js';

// Trust framework.
export type {
  PluginTrustTier,
  PluginTrustRecord,
  SignatureValidationResult,
} from './trust.js';
export {
  PluginTrustStore,
  validatePluginSignature,
  pluginManifestSignaturePayload,
  filterCapabilitiesByTrust,
  SAFE_CAPABILITIES,
} from './trust.js';

export type { QuarantineRecord } from './quarantine.js';
export { PluginQuarantineEngine } from './quarantine.js';

export { isHighRiskCapability } from './manifest.js';
