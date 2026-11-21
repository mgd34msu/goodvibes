/**
 * Policy loader with signature validation.
 *
 * Wraps the raw policy bundle loading path with a signature validation
 * step. In managed mode, bundles with invalid or missing signatures are
 * rejected. In non-managed mode, unsigned bundles are allowed through
 * with a `SignatureStatus` of `'unsigned'` for UI display.
 *
 * This module does NOT perform I/O itself, it accepts a pre-parsed
 * `SignedPolicyBundle` so callers control the loading strategy.
 */

import { join } from 'node:path';
import { GoodVibesError } from '@goodvibes/engine/errors';
import type { PolicyRule } from './types.js';
import type {
  PolicyBundleId,
  SignatureStatus,
  ProvenanceSource,
  SignedPolicyBundle,
} from './policy-signer.js';
import { verifyBundle } from './policy-signer.js';
import type { FeatureFlagReader } from '../feature-flags/index.js';
import { isFeatureGateEnabled } from '../feature-flags/index.js';

// ── Loader types ──────────────────────────────────────────────────────────────

/**
 * A policy bundle payload: the rules array and optional metadata.
 */
export interface PolicyBundlePayload {
  /** Version tag for schema migration. */
  version: number;
  /** The ordered list of policy rules to register with the evaluator. */
  rules: PolicyRule[];
  /** Optional human-readable bundle description. */
  description?: string | undefined;
}

/**
 * Provenance record attached to every loaded policy bundle.
 *
 * Carried forward onto each `PermissionDecision` produced by an evaluator
 * that was configured from this bundle.
 */
export interface BundleProvenance {
  /** Stable identifier for the bundle instance. */
  policyBundleId: PolicyBundleId;
  /** Validation outcome for the bundle's signature. */
  signatureStatus: SignatureStatus;
  /** Where the bundle originated from. */
  provenanceSource: ProvenanceSource;
  /** ISO 8601 timestamp from the bundle, if present. */
  issuedAt?: string | undefined;
  /** Human-readable issuer label, if present in the bundle. */
  issuer?: string | undefined;
}

/**
 * Result returned by `loadPolicyBundle()`.
 */
export interface PolicyLoadResult {
  /** Whether the bundle was successfully loaded and validated. */
  ok: boolean;
  /** The extracted policy rules (only populated when `ok` is true). */
  rules?: PolicyRule[] | undefined;
  /** Provenance record for the bundle. */
  provenance: BundleProvenance;
  /** Human-readable explanation of why loading failed (when `ok` is false). */
  error?: string | undefined;
}

// ── Error class ───────────────────────────────────────────────────────────────

/**
 * PolicySignatureError, Thrown when a managed-mode bundle fails signature
 * validation and the caller opts into strict error throwing.
 *
 * Managed mode MUST reject bundles with invalid or missing signatures.
 */
export class PolicySignatureError extends GoodVibesError {
  declare readonly code: 'POLICY_SIGNATURE_INVALID';
  constructor(
    /** The bundle ID that failed validation. */
    public readonly bundleId: PolicyBundleId,
    /** The validation outcome. */
    public readonly signatureStatus: SignatureStatus,
    message: string,
  ) {
    super(message, { code: 'POLICY_SIGNATURE_INVALID', category: 'permission', source: 'runtime', recoverable: false });
    this.name = 'PolicySignatureError';
  }
}

// ── Loader options ────────────────────────────────────────────────────────────

/**
 * Options controlling how `loadPolicyBundle()` behaves.
 */
export interface PolicyLoaderOptions {
  /**
   * HMAC-SHA256 signing key (Buffer or hex string).
   *
   * Required when `managed` is true; optional otherwise. When absent,
   * signature verification is skipped and status is set to `'skipped'`.
   * A bundle whose signature is present but does not verify is rejected in every mode.
   */
  signingKey?: Buffer | string | undefined;

  /**
   * When true, the loader operates in managed mode:
   *   - Bundles with `SignatureStatus` of `'invalid'` or `'missing'` are rejected.
   *   - Bundles with `SignatureStatus` of `'unsigned'` are rejected.
   *   - Only `'valid'` signatures are accepted.
   *
   * When false (default), unsigned bundles are permitted with status `'unsigned'`.
   */
  managed?: boolean | undefined;

  /**
   * Describes where the bundle was loaded from.
   * Defaults to `'inline'` when not provided.
   */
  provenanceSource?: ProvenanceSource | undefined;

  /**
   * When true, `loadPolicyBundle()` throws a `PolicySignatureError` on
   * rejection in managed mode instead of returning `{ ok: false }`.
   *
   * Defaults to false.
   */
  throwOnRejection?: boolean | undefined;

  /**
   * The capability gates control signature validation when supplied by platform runtime services.
   * Hosts without runtime gates can provide explicit loader options.
   */
  featureFlags?: FeatureFlagReader | undefined;

  /**
   * The home directory a path-scope pattern of `~` or `~/...` names. Each such
   * pattern is expanded once, when the bundle is loaded. With none given, a
   * bundle holding such a pattern is refused, since the rule could never match.
   */
  homeDirectory?: string | undefined;
}

// ── Core loader ───────────────────────────────────────────────────────────────

/**
 * loadPolicyBundle, Validates and loads a signed policy bundle.
 *
 * Performs signature verification and returns the extracted rules with
 * a full provenance record. In managed mode, bundles that are unsigned,
 * missing a signature, or carry an invalid signature are rejected.
 *
 * In non-managed mode, unsigned bundles are accepted with status `'unsigned'`
 * so the UI can display a warning.
 *
 * @param bundle , The pre-parsed signed bundle object.
 * @param options, Loader behaviour options.
 *
 * @example
 * ```ts
 * const result = loadPolicyBundle(bundle, {
 *   signingKey: process.env['POLICY_SIGNING_KEY'],
 *   managed: true,
 *   provenanceSource: 'local-file',
 * });
 * if (!result.ok) {
 *   throw new Error(`Policy load failed: ${result.error}`);
 * }
 * ```
 */
export function loadPolicyBundle(
  bundle: SignedPolicyBundle<PolicyBundlePayload>,
  options: PolicyLoaderOptions = {},
): PolicyLoadResult {
  const {
    signingKey,
    managed = false,
    provenanceSource = 'inline',
    throwOnRejection = false,
  } = options;
  const signingEnabled = isFeatureGateEnabled(options.featureFlags, 'policy-signing');

  const homeDirectory = options.homeDirectory?.trim() ? options.homeDirectory : undefined;
  const shapeError = describeBundleShapeError(bundle, homeDirectory);
  const provenanceFor = (signatureStatus: SignatureStatus): BundleProvenance => ({
    policyBundleId: typeof bundle?.bundleId === 'string' ? bundle.bundleId : '',
    signatureStatus,
    provenanceSource,
    issuedAt: bundle?.issuedAt,
    issuer: bundle?.issuer,
  });
  if (shapeError !== undefined) {
    return { ok: false, provenance: provenanceFor('skipped'), error: `Not a policy bundle: ${shapeError}` };
  }

  const reject = (signatureStatus: SignatureStatus, msg: string): PolicyLoadResult => {
    if (throwOnRejection) throw new PolicySignatureError(bundle.bundleId, signatureStatus, msg);
    return { ok: false, provenance: provenanceFor(signatureStatus), error: msg };
  };

  // ── Signature validation ────────────────────────────────────────────────────
  let signatureStatus: SignatureStatus;

  if (!signingEnabled) {
    signatureStatus = 'skipped';
  } else if (!signingKey) {
    // No key supplied, skip verification (permitted in non-managed mode)
    signatureStatus = 'skipped';
  } else if (!bundle.signature) {
    // Key supplied but bundle has no signature, unsigned in non-managed, rejected in managed
    signatureStatus = 'unsigned';
  } else {
    const result = verifyBundle(bundle, signingKey);
    signatureStatus = result.status;
  }

  // A signature that is present and does not verify is never loadable: the bundle was altered or
  // signed with another key, whatever mode the host runs in.
  if (signatureStatus === 'invalid') {
    return reject(signatureStatus,
      `Policy bundle "${bundle.bundleId}" was rejected: its signature does not verify against the configured signing key.`);
  }

  // ── Managed-mode enforcement ────────────────────────────────────────────────
  if (managed && signingEnabled) {
    const rejected =
      signatureStatus === 'missing'
      || signatureStatus === 'unsigned'
      || signatureStatus === 'skipped'; // managed mode requires a key + valid sig

    if (rejected) {
      return reject(signatureStatus,
        `Managed-mode policy rejection: bundle "${bundle.bundleId}" ` +
        `has signatureStatus="${signatureStatus}". ` +
        `Only bundles with a valid HMAC-SHA256 signature are accepted in managed mode` +
        (signingKey ? '.' : ', and no signing key is configured (set GOODVIBES_POLICY_SIGNING_KEY to a hex key of at least 16 bytes).'));
    }
  }

  return {
    ok: true,
    // A bundle is the managed source: every rule it carries is a managed rule.
    rules: bundle.payload.rules.map((rule) => ({ ...expandHomePatterns(rule, homeDirectory), origin: 'managed' as const })),
    provenance: provenanceFor(signatureStatus),
  };
}

const RULE_TYPES: ReadonlySet<string> = new Set(['prefix', 'arg-shape', 'path-scope', 'network-scope', 'mode-constraint']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The modes the gate evaluates policy under; a mode-constraint rule naming another can never apply. */
const GATE_POLICY_MODES: ReadonlySet<string> = new Set(['default', 'plan', 'allow-all']);

function isStringList(value: unknown, nonEmpty: boolean): boolean {
  return Array.isArray(value) && (!nonEmpty || value.length > 0) && value.every((item) => typeof item === 'string' && item.length > 0);
}

/** Whether a path pattern names the home directory: exactly `~`, or starting with `~/`. */
function isHomePattern(pattern: string): boolean {
  return pattern === '~' || pattern.startsWith('~/');
}

/**
 * A path-scope rule with each `~` or `~/...` pattern joined onto the home
 * directory, the same rule the shell path service expands a path by; other
 * rules, and every rule when no home directory is known, are returned as they are.
 */
function expandHomePatterns(rule: PolicyRule, homeDirectory: string | undefined): PolicyRule {
  if (rule.type !== 'path-scope' || homeDirectory === undefined || !rule.pathPatterns.some(isHomePattern)) return rule;
  return {
    ...rule,
    pathPatterns: rule.pathPatterns.map((pattern) => (pattern === '~' ? homeDirectory : pattern.startsWith('~/') ? join(homeDirectory, pattern.slice(2)) : pattern)),
  };
}

/** What a rule of its type is missing, or undefined when the evaluator can apply it as written. */
function describeRuleFieldError(rule: Record<string, unknown>, at: string, homeDirectory: string | undefined): string | undefined {
  const pattern = rule['toolPattern'];
  if (!(typeof pattern === 'string' && pattern.length > 0) && !isStringList(pattern, true)) {
    return `${at} needs a toolPattern: a tool name, "*", or a list of names.`;
  }
  switch (rule['type']) {
    case 'prefix':
      if (rule['commandPrefixes'] !== undefined && !isStringList(rule['commandPrefixes'], false)) return `${at} commandPrefixes must be a list of strings.`;
      if (rule['exactCommands'] !== undefined && !isStringList(rule['exactCommands'], false)) return `${at} exactCommands must be a list of strings.`;
      return undefined;
    case 'arg-shape':
      return isRecord(rule['argMatchers']) && Object.keys(rule['argMatchers']).length > 0 ? undefined : `${at} needs argMatchers: an object of argument names to values or /patterns/.`;
    case 'path-scope': {
      if (!isStringList(rule['pathPatterns'], true)) return `${at} needs pathPatterns: a non-empty list of path globs.`;
      const home = homeDirectory === undefined ? (rule['pathPatterns'] as string[]).find(isHomePattern) : undefined;
      return home === undefined
        ? undefined
        : `${at} pathPattern "${home}" starts with ~, and no home directory is known here to expand it; write it as an absolute path.`;
    }
    case 'network-scope':
      if (!isStringList(rule['hostPatterns'], true)) return `${at} needs hostPatterns: a non-empty list of host globs.`;
      if (rule['ports'] !== undefined && !(Array.isArray(rule['ports']) && rule['ports'].every((port) => Number.isInteger(port) && port >= 0 && port <= 65_535))) {
        return `${at} ports must be a list of port numbers (0 means any).`;
      }
      return undefined;
    case 'mode-constraint': {
      const modes = rule['activeModes'];
      if (!isStringList(modes, true)) return `${at} needs activeModes: a non-empty list of modes.`;
      const never = (modes as string[]).filter((mode) => !GATE_POLICY_MODES.has(mode));
      return never.length > 0
        ? `${at} names mode(s) ${never.join(', ')} that policy is never evaluated under; use ${[...GATE_POLICY_MODES].join(', ')}.`
        : undefined;
    }
    default:
      return undefined;
  }
}

/** What is wrong with a parsed bundle's shape, or undefined when the loader can read it. Parsed JSON can be anything. */
function describeBundleShapeError(bundle: unknown, homeDirectory: string | undefined): string | undefined {
  if (!isRecord(bundle)) return 'expected an object with bundleId and payload.';
  if (typeof bundle['bundleId'] !== 'string' || bundle['bundleId'].length === 0) return 'bundleId must be a non-empty string.';
  const payload = bundle['payload'];
  if (!isRecord(payload) || !Array.isArray(payload['rules'])) return 'payload.rules must be an array.';
  for (const [index, rule] of (payload['rules'] as unknown[]).entries()) {
    const at = `rule ${index + 1}`;
    if (!isRecord(rule) || typeof rule['id'] !== 'string') return `${at} needs a string id.`;
    if (typeof rule['type'] !== 'string' || !RULE_TYPES.has(rule['type'])) return `${at} has an unknown type.`;
    if (rule['effect'] !== 'allow' && rule['effect'] !== 'deny') return `${at} effect must be "allow" or "deny".`;
    // A bundle is managed policy; a rule claiming to be the owner's own answer is not one.
    if (rule['origin'] !== undefined && rule['origin'] !== 'managed') return `${at} has origin "${String(rule['origin'])}"; a policy bundle carries managed rules only (omit origin or use "managed").`;
    const fieldError = describeRuleFieldError(rule, `${at} (${rule['type']})`, homeDirectory);
    if (fieldError !== undefined) return fieldError;
  }
  return undefined;
}

/**
 * createUnsignedBundle, Convenience helper for non-managed/test usage.
 *
 * Creates a bare `SignedPolicyBundle` without a signature. The resulting
 * bundle will be accepted in non-managed mode with status `'unsigned'`.
 *
 * @param bundleId, Unique identifier for this bundle.
 * @param payload , The policy payload.
 */
export function createUnsignedBundle(
  bundleId: PolicyBundleId,
  payload: PolicyBundlePayload,
): SignedPolicyBundle<PolicyBundlePayload> {
  return {
    bundleId,
    issuedAt: new Date().toISOString(),
    payload,
    // No signature field
  };
}
