/**
 * Config-driven policy bundle loading for the policy-as-code feature.
 *
 * Reads policy.bundleSource / policy.bundlePath and, when the policy-as-code
 * gate is on (policy.registryEnabled) and a file source is configured, loads that bundle into
 * the registry as a CANDIDATE at startup, making the config keys live without
 * requiring a /security policy action. Promotion requires simulation evidence and a
 * passing divergence gate; once promoted, the same unchanged bundle is enforced
 * again at the next start (policy-activation.json records it, with the file it
 * was read from: a bundle promoted or rolled back to from another file than
 * policy.bundlePath, one loaded with /security load-policy, is the one read at start;
 * when that file cannot be loaded, policy.bundlePath is loaded as the candidate instead
 * and the reason names both).
 * A bundle loaded at start that is not restored as active says why. Never throws, a
 * missing, unreadable, malformed or unverifiable bundle is logged, recorded on the
 * policy runtime state as the reason the configured bundle is not loaded, and skipped
 * (registry stays empty).
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { ConfigManager } from '../../config/manager.js';
import type { FeatureFlagReader } from '../feature-flags/index.js';
import { isFeatureGateEnabled } from '../feature-flags/index.js';
import type { PolicyRuntimeState } from './policy-runtime.js';
import type { PolicyRegistry } from './policy-registry.js';
import type { SignedPolicyBundle } from './policy-signer.js';
import type { PolicyBundlePayload } from './policy-loader.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

export function loadConfiguredPolicyBundle(
  configManager: Pick<ConfigManager, 'get' | 'getWorkingDirectory'> & Partial<Pick<ConfigManager, 'getControlPlaneConfigDir'>>,
  featureFlags: FeatureFlagReader,
  policyRuntimeState: Pick<PolicyRuntimeState, 'getRegistry'> & Partial<Pick<PolicyRuntimeState, 'recordConfiguredBundleFailure'>>,
): void {
  if (!isFeatureGateEnabled(featureFlags, 'policy-as-code')) return;
  if (configManager.get('policy.bundleSource') !== 'file') return;
  const configuredPath = configManager.get('policy.bundlePath').trim();
  if (!configuredPath) return;

  const workingDir = configManager.getWorkingDirectory();
  const configuredBundlePath = isAbsolute(configuredPath)
    ? configuredPath
    : resolve(workingDir ?? process.cwd(), configuredPath);
  // The bundle that was last made active (promote or rollback) is the one
  // enforced; it may have come from another file than the configured one.
  const registry = policyRuntimeState.getRegistry();
  const configDir = configManager.getControlPlaneConfigDir?.();
  if (configDir) registry.bindActivationRecord(join(configDir, POLICY_ACTIVATION_FILE));
  const activation = registry.readActivationRecord();
  const recordedPath = activation !== null && activation !== 'unreadable' ? activation.bundlePath : undefined;
  const activePath = recordedPath && recordedPath !== configuredBundlePath ? recordedPath : undefined;

  // The active bundle's file wins when it loads; when it does not, policy.bundlePath
  // is loaded as the candidate instead and restoreActivation decides whether it is
  // the promoted bundle.
  let activeFailure: string | undefined;
  let bundlePath = configuredBundlePath;
  let loaded = activePath ? loadBundleCandidate(registry, activePath) : undefined;
  if (activePath && loaded && 'reason' in loaded) {
    activeFailure = `the active policy bundle's file ${activePath} (from the activation record) ${loaded.reason}`;
    loaded = undefined;
  } else if (activePath) {
    bundlePath = activePath;
  }
  loaded ??= loadBundleCandidate(registry, configuredBundlePath);

  if ('reason' in loaded) {
    const configuredFailure = `${configuredBundlePath}: ${loaded.reason}`;
    const reason = activeFailure
      ? `${activeFailure}, and policy.bundlePath could not be loaded instead (${configuredFailure})`
      : configuredFailure;
    logger.warn('[policy-as-code] configured policy bundle not loaded', { bundlePath: configuredBundlePath, ...(activePath ? { activePath } : {}), error: reason });
    policyRuntimeState.recordConfiguredBundleFailure?.(reason);
    return;
  }
  const result = loaded.result;
  // A bundle promoted before, unchanged, is enforced again at once; any other stays a candidate and says why.
  const restored = registry.restoreActivation();
  const note = activeFailure
    ? restored.restored
      ? undefined
      : `${activeFailure}; policy.bundlePath (${configuredBundlePath}) was loaded as a candidate instead.${restored.reason ? ` ${restored.reason}` : ''}`
    : restored.reason;
  if (activeFailure) logger.warn('[policy-as-code] active policy bundle file not loaded; read policy.bundlePath instead', { activePath, configuredBundlePath, error: activeFailure });
  policyRuntimeState.recordConfiguredBundleFailure?.(note ?? null);
  logger.info(restored.restored ? '[policy-as-code] configured policy bundle is the promoted one; enforcing it' : '[policy-as-code] loaded configured policy bundle as candidate', {
    bundlePath,
    bundleId: result.provenance.policyBundleId,
    signatureStatus: result.provenance.signatureStatus,
    ...(bundlePath !== configuredBundlePath ? { configuredBundlePath, readFrom: 'the activation record' } : {}),
    ...(note ? { note } : {}),
  });
}

type CandidateLoad =
  | { readonly result: ReturnType<PolicyRegistry['loadCandidate']> }
  | { readonly reason: string };

/** Read one bundle file and load it into the registry as the candidate. */
function loadBundleCandidate(
  registry: Pick<PolicyRegistry, 'loadCandidate'>,
  bundlePath: string,
): CandidateLoad {
  let bundle: SignedPolicyBundle<PolicyBundlePayload>;
  try {
    bundle = JSON.parse(readFileSync(bundlePath, 'utf-8')) as SignedPolicyBundle<PolicyBundlePayload>;
  } catch (error) {
    return { reason: `could not be read as JSON (${summarizeError(error)})` };
  }
  let result: ReturnType<PolicyRegistry['loadCandidate']>;
  try {
    result = registry.loadCandidate(bundle, { sourcePath: bundlePath });
  } catch (error) {
    return { reason: `rejected at load (${summarizeError(error)})` };
  }
  if (!result.ok) return { reason: `rejected at load (${result.error ?? 'unknown reason'})` };
  return { result };
}

/** The record of which bundle is active, kept beside permission-rules.json. */
export const POLICY_ACTIVATION_FILE = 'policy-activation.json';
