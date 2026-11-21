/**
 * Plugin extension trust framework.
 *
 * Defines trust tiers (untrusted, limited, trusted), signed manifest
 * validation for the trusted tier, and the PluginTrustStore that manages
 * trust records with persistence support.
 *
 * The tier decides what a plugin may do, and the plugin loader enforces it
 * at every start (plugins/loader.ts, plugins/api.ts):
 *   - untrusted, panels, commands and reading files only: its registrations
 *                of tools, providers, event hooks, gateway methods, channels
 *                and delivery strategies are refused
 *   - limited  , also the tools, providers and hooks its manifest declares,
 *                and gateway methods, channels and delivery strategies
 *   - trusted  , also the high-risk capabilities it declares (shell.exec,
 *                filesystem.write, network.outbound); a plugin that declares
 *                one is not started below this tier, because code running in
 *                this process cannot be held to a capability it was refused
 * A registration the manifest does not declare is refused at every tier.
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
 * - `untrusted`, Default for newly discovered plugins: may add panels and
 *   commands and read files; it may not put tools before the model, receive
 *   prompts as a provider, subscribe to runtime events, answer gateway calls,
 *   or receive or deliver channel messages.
 * - `limited`  , Owner-reviewed plugin: the tools, providers and hooks its
 *   manifest declares, and gateway methods, channels and delivery strategies.
 *   High-risk capabilities stay withheld.
 * - `trusted`  , Everything it declares, high-risk included. Set by a verified
 *   signature or by the owner after one confirmation.
 */
export type PluginTrustTier = 'untrusted' | 'limited' | 'trusted';

/** Why a tier the owner set does not apply to the copy of a plugin found now (PluginTrustStore.unappliedTier). */
export type PluginTrustUnappliedReason = 'files-changed' | 'moved' | 'unbound';

/** A tier the owner set that is not applied to the copy found now, and why. */
export interface PluginUnappliedTier {
  readonly tier: Exclude<PluginTrustTier, 'untrusted'>;
  readonly why: PluginTrustUnappliedReason;
}

/**
 * The sentence that says why a set tier is not applied and how to apply it,
 * for refusals, capability readings and plugin lists.
 */
export function describeUnappliedTier(pluginName: string, unapplied: PluginUnappliedTier, command = 'plugin'): string {
  const again = `set it again with /${command} trust ${pluginName} ${unapplied.tier}`;
  if (unapplied.why === 'unbound') {
    return `its tier '${unapplied.tier}' was set by an earlier version, before a tier was bound to a plugin's files, so it runs untrusted; ${again}`;
  }
  const cause = unapplied.why === 'files-changed' ? 'for files that have since changed' : 'for a copy in a different folder';
  return `its tier '${unapplied.tier}' was set ${cause}, so it runs untrusted; review the change, then ${again}`;
}

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
  /**
   * The copy the tier was given to: its directory and the content digest of
   * its manifest and every file in its directory (plugins/loader.ts pluginContentDigest). The
   * tier applies to that copy only; a same-named copy elsewhere, or this copy
   * after its code changed, starts untrusted until trust is given to it.
   */
  boundDir?: string | undefined;
  contentDigest?: string | undefined;
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
 * Capabilities an untrusted plugin is granted: display and reading. Tools,
 * providers and hooks put a plugin in the model's loop or the event stream,
 * so they need the owner's `limited` decision.
 */
export const SAFE_CAPABILITIES: ReadonlyArray<PluginCapability> = [
  'register.panel',
  'filesystem.read',
] as const;

/**
 * filterCapabilitiesByTrust, Returns the subset of `requested` capabilities
 * that are permitted for the given trust tier.
 *
 * - `untrusted`: only SAFE_CAPABILITIES (panels, reading files)
 * - `limited`:   all capabilities except HIGH_RISK_CAPABILITIES (adds tools, providers, hooks)
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
        reasons[cap] = `Capability '${cap}' needs trust tier 'trusted'; the plugin's tier is 'limited'`;
      } else {
        permitted.push(cap);
      }
    } else {
      // untrusted
      if ((SAFE_CAPABILITIES as ReadonlyArray<string>).includes(cap)) {
        permitted.push(cap);
      } else {
        blocked.push(cap);
        reasons[cap] = `Capability '${cap}' needs trust tier '${isHighRiskCapability(cap) ? 'trusted' : 'limited'}'; the plugin's tier is 'untrusted'`;
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
   * The tier of one copy of a plugin: the record's tier when the record was
   * given to this copy (same directory, same content digest), else
   * `untrusted`. What runs is what was trusted.
   */
  tierFor(pluginName: string, copy: { readonly dir: string; readonly digest: string | null }): PluginTrustTier {
    const record = this.records.get(pluginName);
    if (!record) return 'untrusted';
    if (record.boundDir !== copy.dir || copy.digest === null || record.contentDigest !== copy.digest) return 'untrusted';
    return record.tier;
  }

  /**
   * A tier the owner set that {@link tierFor} does not apply to this copy, and
   * why: `unbound` (a record kept from before tiers were bound to a copy),
   * `moved` (it was given to a copy in another directory) or `files-changed`
   * (this copy's manifest or a file in its directory changed since, or cannot be read).
   * Undefined when there is no such tier: no record, an untrusted one, or one
   * that applies.
   */
  unappliedTier(pluginName: string, copy: { readonly dir: string; readonly digest: string | null }): PluginUnappliedTier | undefined {
    const record = this.records.get(pluginName);
    if (!record || record.tier === 'untrusted') return undefined;
    if (record.boundDir === undefined || record.contentDigest === undefined) return { tier: record.tier, why: 'unbound' };
    if (record.boundDir !== copy.dir) return { tier: record.tier, why: 'moved' };
    if (copy.digest === null || record.contentDigest !== copy.digest) return { tier: record.tier, why: 'files-changed' };
    return undefined;
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
    options: { note?: string | undefined; boundDir?: string | undefined; contentDigest?: string | undefined } = {},
  ): PluginTrustRecord {
    const record: PluginTrustRecord = {
      pluginName,
      tier,
      updatedAt: Date.now(),
      grantedBy: 'operator',
      note: options.note,
      ...(options.boundDir !== undefined ? { boundDir: options.boundDir } : {}),
      ...(options.contentDigest !== undefined ? { contentDigest: options.contentDigest } : {}),
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
    binding: { readonly boundDir?: string | undefined; readonly contentDigest?: string | undefined } = {},
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
      ...(binding.boundDir !== undefined ? { boundDir: binding.boundDir } : {}),
      ...(binding.contentDigest !== undefined ? { contentDigest: binding.contentDigest } : {}),
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
