/**
 * Plugin lifecycle system types.
 *
 * The lifecycle states, the capability manifest the plugin manager resolves
 * and the lifecycle state machine's transition result.
 */

import type { PluginManifest } from '../../plugins/loader.js';

/** States for the plugin lifecycle machine. */
export type PluginLifecycleState =
  | 'discovered'
  | 'loading'
  | 'loaded'
  | 'active'
  | 'degraded'
  | 'error'
  | 'unloading'
  | 'disabled';

// ── Capability manifest ───────────────────────────────────────────────────────

/**
 * The set of capabilities a plugin can declare in its manifest.
 *
 * All capabilities are **deny-by-default**: a plugin must explicitly request
 * each capability and the runtime must grant it before the capability is
 * exercisable.
 */
export type PluginCapability =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'network.outbound'
  | 'shell.exec'
  | 'register.tool'
  | 'register.provider'
  | 'register.panel'
  | 'register.hook';

/** All defined capability strings as a readonly array. */
export const ALL_CAPABILITIES: ReadonlyArray<PluginCapability> = [
  'filesystem.read',
  'filesystem.write',
  'network.outbound',
  'shell.exec',
  'register.tool',
  'register.provider',
  'register.panel',
  'register.hook',
] as const;

/**
 * High-risk capabilities that require the `trusted` tier to be granted.
 * These capabilities can have significant side-effects outside the process.
 */
export const HIGH_RISK_CAPABILITIES: ReadonlyArray<PluginCapability> = [
  'filesystem.write',
  'network.outbound',
  'shell.exec',
] as const;

/**
 * Capability manifest embedded in (or derived from) a plugin's manifest.json.
 *
 * `requested` lists every capability the plugin declares it needs.
 * `granted` is resolved by the runtime after validation, it may be a strict
 * subset of `requested` if some capabilities are denied by policy.
 */
export interface PluginCapabilityManifest {
  /** Capabilities declared by the plugin author. */
  readonly requested: ReadonlyArray<PluginCapability>;
  /** Capabilities actually granted by the runtime. Populated after resolution. */
  granted: PluginCapability[];
  /** Capabilities that were requested but explicitly denied by runtime policy. */
  denied: PluginCapability[];
  /** Human-readable denial reasons keyed by capability. */
  denialReasons: Partial<Record<PluginCapability, string>>;
}

// ── Extended plugin manifest ──────────────────────────────────────────────────

/**
 * PluginManifestV2 extends the loader's PluginManifest with capability
 * declarations and trust framework fields.
 * Stored inside manifest.json under the `capabilities` key.
 * Omitting the key is equivalent to requesting no capabilities.
 */
export interface PluginManifestV2 extends PluginManifest {
  /** Optional capability list declared by the plugin. */
  capabilities?: PluginCapability[] | undefined;
  /**
   * Minimum runtime version this plugin requires.
   * Semver string (e.g. "0.9.0"). Unset = no constraint.
   */
  minRuntimeVersion?: string | undefined;
  /**
   * Base64-encoded Ed25519 signature of the complete canonical manifest payload.
   * Required for plugins that want to operate at the `trusted` tier.
   */
  signature?: string | undefined;
  /**
   * Declared trust tier hint from the plugin author.
   * The runtime validates this against the actual trust record; it does not
   * grant trust by itself.
   */
  trustTier?: import('./trust.js').PluginTrustTier | undefined;
}

// ── State machine ─────────────────────────────────────────────────────────────

/**
 * Result of a state machine transition attempt.
 */
export type TransitionResult =
  | { ok: true; from: PluginLifecycleState; to: PluginLifecycleState }
  | { ok: false; reason: string };
