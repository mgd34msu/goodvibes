/**
 * Config-driven policy bundle loading for the policy-as-code feature.
 *
 * Reads policy.bundleSource / policy.bundlePath and, when the policy-as-code
 * gate is on (policy.registryEnabled) and a file source is configured, loads that bundle into
 * the registry as a CANDIDATE at startup, making the config keys live without
 * requiring a /policy command. The bundle is never auto-promoted: promotion still
 * requires simulation evidence and a passing divergence gate. Never throws, a
 * missing, unreadable, malformed or unverifiable bundle is logged, recorded on the
 * policy runtime state as the reason the configured bundle is not loaded, and skipped
 * (registry stays empty).
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
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
  configManager: Pick<ConfigManager, 'get' | 'getWorkingDirectory'>,
  featureFlags: FeatureFlagReader,
  policyRuntimeState: Pick<PolicyRuntimeState, 'getRegistry'> & Partial<Pick<PolicyRuntimeState, 'recordConfiguredBundleFailure'>>,
): void {
  if (!isFeatureGateEnabled(featureFlags, 'policy-as-code')) return;
  if (configManager.get('policy.bundleSource') !== 'file') return;
  const configuredPath = configManager.get('policy.bundlePath').trim();
  if (!configuredPath) return;

  const workingDir = configManager.getWorkingDirectory();
  const bundlePath = isAbsolute(configuredPath)
    ? configuredPath
    : resolve(workingDir ?? process.cwd(), configuredPath);

  const fail = (reason: string): void => {
    logger.warn('[policy-as-code] configured policy bundle not loaded', { bundlePath, error: reason });
    policyRuntimeState.recordConfiguredBundleFailure?.(`${bundlePath}: ${reason}`);
  };

  let bundle: SignedPolicyBundle<PolicyBundlePayload>;
  try {
    bundle = JSON.parse(readFileSync(bundlePath, 'utf-8')) as SignedPolicyBundle<PolicyBundlePayload>;
  } catch (error) {
    fail(`could not be read as JSON (${summarizeError(error)})`);
    return;
  }

  let result: ReturnType<PolicyRegistry['loadCandidate']>;
  try {
    result = policyRuntimeState.getRegistry().loadCandidate(bundle);
  } catch (error) {
    fail(`rejected at load (${summarizeError(error)})`);
    return;
  }
  if (!result.ok) {
    fail(`rejected at load (${result.error ?? 'unknown reason'})`);
    return;
  }
  policyRuntimeState.recordConfiguredBundleFailure?.(null);
  logger.info('[policy-as-code] loaded configured policy bundle as candidate', {
    bundlePath,
    bundleId: result.provenance.policyBundleId,
    signatureStatus: result.provenance.signatureStatus,
  });
}
