/**
 * Plugin extension trust framework.
 *
 * Defines trust tiers (untrusted, limited, trusted), signed manifest
 * validation for the trusted tier, and the PluginTrustStore that manages
 * trust records with persistence support.
 *
 * Trust tiers gate access to high-risk capabilities:
 *   - untrusted, only safe, read-only capabilities allowed
 *   - limited  , moderate capabilities; high-risk capabilities blocked
 *   - trusted  , full capability set; requires signed manifest validation
 */

import { createPublicKey, verify } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { captureOwnedJson } from '../../gate/judgment-input.js';
import { logger } from '../../utils/logger.js';
import type { PluginCapability } from './types.js';
import { isHighRiskCapability } from './manifest.js';

// ── Trust Tier ────────────────────────────────────────────────────────────────

/**
 * The three trust tiers available to a plugin.
 *
 * - `untrusted`, Default for newly discovered plugins. Only safe capabilities
 *   are accessible. The plugin may not have been reviewed.
 * - `limited`  , Operator-reviewed plugin. Moderate capabilities granted.
 *   High-risk capabilities (shell.exec, filesystem.write, network.outbound)
 *   remain blocked without explicit trust escalation.
 * - `trusted`  , Fully trusted plugin. Requires a valid signed manifest.
 *   All declared capabilities may be granted (subject to runtime policy).
 */
export type PluginTrustTier = 'untrusted' | 'limited' | 'trusted';

// ── Trust Record ──────────────────────────────────────────────────────────────

/**
 * A persisted trust record for a single plugin.
 */
export interface PluginTrustRecord {
  /** Plugin identifier (manifest name). */
  readonly pluginName: string;
  /** Current trust tier. */
  tier: PluginTrustTier;
  /** Unix epoch ms when the trust record was last updated. */
  updatedAt: number;
  /** Who or what granted this trust level. */
  grantedBy: 'operator' | 'signed-manifest';
  /**
   * Fingerprint of the verified signature for trusted-tier plugins.
   * Undefined for untrusted/limited plugins.
   */
  signatureFingerprint?: string | undefined;
  /** Identifies the public-key verifier used for a persisted signed grant. */
  signatureAlgorithm?: 'ed25519-v1' | undefined;
  /** Optional human-readable note attached by the operator. */
  note?: string | undefined;
}

// ── Signature Validation ──────────────────────────────────────────────────────

/**
 * Result of validating a plugin's signed manifest.
 */
export interface SignatureValidationResult {
  /** Whether the signature is valid. */
  valid: boolean;
  /** A stable fingerprint derived from the signature (e.g. hex digest prefix). */
  fingerprint?: string | undefined;
  /** Human-readable failure reason. Only set when `valid` is false. */
  reason?: string | undefined;
}

/** Canonical UTF-8 bytes for an Ed25519 manifest signature. All own JSON
 * fields except the root signature participate, including entry point, hooks
 * and runtime constraints. Object keys and the capability list are sorted.
 * This authenticates manifest metadata, not the plugin's executable files.
 */
export function pluginManifestSignaturePayload(manifest: object): Buffer {
  const captured = captureOwnedJson(manifest, nodeTypes.isProxy) as Record<string, unknown>;
  if (!captured || Array.isArray(captured) || typeof captured.name !== 'string' || typeof captured.version !== 'string'
    || (captured.capabilities !== undefined && (!Array.isArray(captured.capabilities) || captured.capabilities.some(value => typeof value !== 'string')))) {
    throw new Error('Invalid plugin signature manifest');
  }
  const { signature: _signature, ...unsigned } = captured;
  unsigned.capabilities = [...((captured.capabilities as readonly string[] | undefined) ?? [])].sort();
  const canonical = JSON.stringify(unsigned, (_key, value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : value);
  if (canonical.length > 1_000_000) throw new Error('Plugin signature manifest exceeds its size limit');
  return Buffer.from('goodvibes-plugin-manifest:ed25519:v1\n' + canonical, 'utf8');
}

/** Verify a complete manifest with the publisher's PEM Ed25519 public key.
 * No private/shared signing secret is distributed to plugin consumers.
 * A manifest signature alone does not authenticate the installed code bytes.
 */
export function validatePluginSignature(
  manifest: { name: string; version: string; capabilities?: string[] | undefined; signature?: string | undefined },
  publicKey?: string,
): SignatureValidationResult {
  try {
    const captured = captureOwnedJson(manifest, nodeTypes.isProxy) as typeof manifest;
    const signature = captured.signature;
    if (!signature || typeof signature !== 'string') return { valid: false, reason: 'No signature field present in manifest' };
    // Ed25519 signatures are exactly 64 bytes. Require canonical base64 so
    // malformed encodings are not silently truncated by Buffer's decoder.
    const decoded = Buffer.from(signature, 'base64');
    if (decoded.length !== 64 || decoded.toString('base64') !== signature) return { valid: false, reason: 'Invalid Ed25519 signature encoding' };
    if (!publicKey) return { valid: false, reason: 'No verification key was supplied, so the signature cannot be verified' };
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519') return { valid: false, reason: 'An Ed25519 public key is required' };
    if (!verify(null, pluginManifestSignaturePayload(captured), key, decoded)) return { valid: false, reason: 'Manifest signature mismatch' };
    return { valid: true, fingerprint: signature.slice(0, 16) };
  } catch {
    // Key/parser errors may quote input. Keep the verification result value-free.
    return { valid: false, reason: 'Invalid plugin manifest or verification key' };
  }
}

// ── Capability filtering by trust tier ───────────────────────────────────────

/**
 * Capabilities that are safe for any trust tier (including untrusted).
 */
export const SAFE_CAPABILITIES: ReadonlyArray<PluginCapability> = [
  'register.tool',
  'register.provider',
  'register.panel',
  'register.hook',
  'filesystem.read',
] as const;

/**
 * filterCapabilitiesByTrust, Returns the subset of `requested` capabilities
 * that are permitted for the given trust tier.
 *
 * - `untrusted`: only SAFE_CAPABILITIES
 * - `limited`:   all capabilities except HIGH_RISK_CAPABILITIES
 * - `trusted`:   all capabilities (HIGH_RISK_CAPABILITIES included)
 */
export function filterCapabilitiesByTrust(
  requested: ReadonlyArray<PluginCapability>,
  tier: PluginTrustTier,
): { permitted: PluginCapability[]; blocked: PluginCapability[]; reasons: Partial<Record<PluginCapability, string>> } {
  const permitted: PluginCapability[] = [];
  const blocked: PluginCapability[] = [];
  const reasons: Partial<Record<PluginCapability, string>> = {};

  for (const cap of requested) {
    if (tier === 'trusted') {
      permitted.push(cap);
    } else if (tier === 'limited') {
      if (isHighRiskCapability(cap)) {
        blocked.push(cap);
        reasons[cap] = `Capability '${cap}' requires trust tier 'trusted' (current: limited)`;
      } else {
        permitted.push(cap);
      }
    } else {
      // untrusted
      if ((SAFE_CAPABILITIES as ReadonlyArray<string>).includes(cap)) {
        permitted.push(cap);
      } else {
        blocked.push(cap);
        reasons[cap] = `Capability '${cap}' requires trust tier 'limited' or higher (current: untrusted)`;
      }
    }
  }

  return { permitted, blocked, reasons };
}

// ── Trust Store ───────────────────────────────────────────────────────────────

/**
 * PluginTrustStore, In-memory trust registry for all plugins.
 *
 * Callers are responsible for persistence (serialise/deserialise via
 * `exportRecords` / `importRecords`). The PluginManager bridges this to
 * the plugins.json state file.
 */
export class PluginTrustStore {
  private readonly records = new Map<string, PluginTrustRecord>();

  /**
   * Returns the trust record for a plugin, or `undefined` if not yet assessed.
   * Callers should treat `undefined` as implicitly `untrusted`.
   */
  getRecord(pluginName: string): Readonly<PluginTrustRecord> | undefined {
    return this.records.get(pluginName);
  }

  /**
   * Returns the trust tier for a plugin.
   * Plugins without an explicit record are treated as `untrusted`.
   */
  getTier(pluginName: string): PluginTrustTier {
    return this.records.get(pluginName)?.tier ?? 'untrusted';
  }

  /**
   * setTier, Explicitly assign a trust tier to a plugin.
   *
   * Intended for operator use via `/plugin trust`.
   * For the `trusted` tier, prefer `trustSigned()` which also validates the signature.
   */
  setTier(
    pluginName: string,
    tier: PluginTrustTier,
    options: { note?: string | undefined } = {},
  ): PluginTrustRecord {
    const record: PluginTrustRecord = {
      pluginName,
      tier,
      updatedAt: Date.now(),
      grantedBy: 'operator',
      note: options.note,
    };
    this.records.set(pluginName, record);
    logger.info(`[plugin-trust] ${pluginName}: tier set to '${tier}'${options.note ? `, ${options.note}` : ''}`);
    return record;
  }

  /**
   * trustSigned, Elevate a plugin to the `trusted` tier after verifying its
   * signed manifest. Returns `{ ok: false, reason }` if validation fails.
   */
  trustSigned(
    pluginName: string,
    manifest: { name: string; version: string; capabilities?: string[] | undefined; signature?: string | undefined },
    publicKey?: string,
  ): { ok: true; record: PluginTrustRecord } | { ok: false; reason: string } {
    let captured: typeof manifest;
    try { captured = captureOwnedJson(manifest, nodeTypes.isProxy) as typeof manifest; }
    catch { return { ok: false, reason: 'Invalid plugin signature manifest' }; }
    if (captured.name !== pluginName) return { ok: false, reason: 'Signed manifest belongs to another plugin' };
    const validation = validatePluginSignature(captured, publicKey);
    if (!validation.valid) {
      logger.warn(`[plugin-trust] ${pluginName}: signature validation failed, ${validation.reason}`);
      return { ok: false, reason: validation.reason! };
    }

    const record: PluginTrustRecord = {
      pluginName,
      tier: 'trusted',
      updatedAt: Date.now(),
      grantedBy: 'signed-manifest',
      signatureFingerprint: validation.fingerprint,
      signatureAlgorithm: 'ed25519-v1',
    };
    this.records.set(pluginName, record);
    logger.info(`[plugin-trust] ${pluginName}: elevated to 'trusted' via signed manifest (fingerprint=${validation.fingerprint})`);
    return { ok: true, record };
  }

  /**
   * verify, Verify the current signature on a plugin manifest without
   * changing its tier. Useful for `/plugin verify` inspection.
   */
  verify(
    manifest: { name: string; version: string; capabilities?: string[] | undefined; signature?: string | undefined },
    publicKey?: string,
  ): SignatureValidationResult {
    return validatePluginSignature(manifest, publicKey);
  }

  /** Returns all trust records as an array. */
  getAllRecords(): ReadonlyArray<Readonly<PluginTrustRecord>> {
    return Array.from(this.records.values());
  }

  /** Export all records for persistence. */
  exportRecords(): Record<string, PluginTrustRecord> {
    const out: Record<string, PluginTrustRecord> = {};
    for (const [name, record] of this.records) {
      out[name] = { ...record };
    }
    return out;
  }

  /** Import records from persisted state. Merges into existing records. */
  importRecords(records: Record<string, PluginTrustRecord>): void {
    for (const [name, record] of Object.entries(records)) {
      // Prior HMAC-based records did not establish publisher identity with a
      // public key. They cannot retain an automatic signed-manifest grant.
      this.records.set(name, record.grantedBy === 'signed-manifest' && record.signatureAlgorithm !== 'ed25519-v1'
        ? { ...record, tier: 'untrusted', signatureFingerprint: undefined,
          note: 'Reverify an Ed25519 publisher signature before restoring signed-manifest trust.' }
        : { ...record });
    }
    logger.debug(`[plugin-trust] Imported ${Object.keys(records).length} trust record(s)`);
  }
}
