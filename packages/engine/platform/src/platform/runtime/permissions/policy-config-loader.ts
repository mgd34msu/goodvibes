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
 * policy.bundlePath, one loaded on the Policy tab of Permissions and safety, is the one read at start;
 * when that file cannot be loaded, policy.bundlePath is loaded as the candidate instead
 * and the reason names both).
 * A bundle loaded at start that is not restored as active says why. Never throws, a
 * missing, unreadable, malformed or unverifiable bundle is logged, recorded on the
 * policy runtime state as the reason the configured bundle is not loaded, and skipped
 * (registry stays empty).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DAEMON_STATE_SURFACE_ROOT } from '../../daemon/lifecycle-marker.js';
import { writeDocument } from '../../utils/atomic-json-store.js';
import { FeatureAnnouncementStore } from '../feature-announcements.js';
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
  // The one activation record every program follows: the daemon's (sharedPolicyActivationPath).
  if (configDir) registry.bindActivationRecord(sharedPolicyActivationPath(configDir));
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

/**
 * The one activation record every program on this machine follows: the daemon's, in its settings folder
 * (`~/.goodvibes/tui/policy-activation.json`, the folder the daemon and the terminal app share). The daemon writes it
 * when a policy is enforced or restored and announces the change; each program keeps its own copy of the bundle in
 * force (its registry) and reads this record again at start and on each announcement, so the gate in a running turn
 * reads its copy and never asks the daemon. `configDir`: any program's settings folder (`~/.goodvibes/<program>`).
 */
export function sharedPolicyActivationPath(configDir: string): string {
  return join(dirname(configDir), DAEMON_STATE_SURFACE_ROOT, POLICY_ACTIVATION_FILE);
}

/** The programs that kept an activation record of their own until 3.5.0, beside their settings: the Agent's. */
const PROGRAM_ACTIVATION_ROOTS: readonly string[] = ['agent'];

/** Where carrying the programs' own records into the one record is noted as done, beside it. */
const CARRIED_FILE = 'policy-activation-carried.json';

/** Which of two bundles refuses or asks more: its refusing rules, then its asking ones. Ties keep the first. */
function stricterOf(first: SignedPolicyBundle<PolicyBundlePayload> | null, second: SignedPolicyBundle<PolicyBundlePayload> | null): 'first' | 'second' {
  const weight = (bundle: SignedPolicyBundle<PolicyBundlePayload> | null): [number, number] => {
    const rules = Array.isArray(bundle?.payload?.rules) ? bundle.payload.rules as readonly { readonly effect?: unknown }[] : [];
    return [rules.filter((rule) => rule.effect === 'deny').length, rules.filter((rule) => rule.effect === 'prompt' || rule.effect === 'ask').length];
  };
  const [firstDeny, firstAsk] = weight(first);
  const [secondDeny, secondAsk] = weight(second);
  if (secondDeny !== firstDeny) return secondDeny > firstDeny ? 'second' : 'first';
  return secondAsk > firstAsk ? 'second' : 'first';
}

function readRecord(path: string): { readonly bundleId: string; readonly payloadHash: string; readonly bundlePath?: string | undefined } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { bundleId?: unknown; payloadHash?: unknown; bundlePath?: unknown } | null;
    if (parsed && typeof parsed.bundleId === 'string' && typeof parsed.payloadHash === 'string') {
      return { bundleId: parsed.bundleId, payloadHash: parsed.payloadHash, ...(typeof parsed.bundlePath === 'string' ? { bundlePath: parsed.bundlePath } : {}) };
    }
  } catch { /* absent or unreadable: nothing to carry */ }
  return null;
}

function readBundle(path: string | undefined): SignedPolicyBundle<PolicyBundlePayload> | null {
  if (!path) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')) as SignedPolicyBundle<PolicyBundlePayload>; } catch { return null; }
}

/**
 * Once, at the first start of this version: the policy each program enforced on its own until 3.5.0 (the Agent kept
 * its own record) is carried into the one record. Where only one program enforced a policy, that one is kept; where
 * two enforced different policies, the stricter (more refusing rules, then more asking ones) is kept, and the owner is
 * told once which (an announce-once line every program shows). The program's own record is left as it was, so a 3.5.0
 * binary after a rollback still enforces what it did. Never throws: a record that cannot be read is not carried.
 */
export function carryProgramPolicyActivations(configDir: string): void {
  const goodvibesRoot = dirname(configDir);
  const shared = sharedPolicyActivationPath(configDir);
  const marker = join(dirname(shared), CARRIED_FILE);
  if (existsSync(marker)) return;
  let note: string | null = null;
  try {
    for (const program of PROGRAM_ACTIVATION_ROOTS) {
      const own = readRecord(join(goodvibesRoot, program, POLICY_ACTIVATION_FILE));
      if (!own) continue;
      const held = readRecord(shared);
      if (held && held.bundleId === own.bundleId && held.payloadHash === own.payloadHash) continue;
      const keepOwn = !held || stricterOf(readBundle(held.bundlePath), readBundle(own.bundlePath)) === 'second';
      if (keepOwn) writeDocument(shared, JSON.parse(readFileSync(join(goodvibesRoot, program, POLICY_ACTIVATION_FILE), 'utf-8')) as Record<string, unknown>);
      note = !held
        ? `The policy the Agent enforced ("${own.bundleId}") is now the one every program on this machine follows.`
        : keepOwn
          ? `The terminal app enforced policy "${held.bundleId}" and the Agent "${own.bundleId}"; "${own.bundleId}" refuses more, so it is now the one every program on this machine follows.`
          : `The terminal app enforced policy "${held.bundleId}" and the Agent "${own.bundleId}"; "${held.bundleId}" refuses more, so it is now the one every program on this machine follows.`;
    }
    writeDocument(marker, { carriedAt: new Date().toISOString(), ...(note ? { note } : {}) });
  } catch (error) {
    logger.warn('[policy-as-code] the programs\' policy records could not be carried into the one record; tried again at the next start', { error: summarizeError(error) });
    return;
  }
  if (note) {
    logger.info(`[policy-as-code] ${note}`);
    try {
      new FeatureAnnouncementStore(join(dirname(shared), 'control-plane', 'feature-announcements.json')).record('policy-activation-carried', note);
    } catch { /* the line is in the log and in "See the policy in force" */ }
  }
}

/** What carrying the programs' records said, for "See the policy in force"; null when nothing was carried or noted. */
export function carriedPolicyNote(configDir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dirname(sharedPolicyActivationPath(configDir)), CARRIED_FILE), 'utf-8')) as { note?: unknown };
    return typeof parsed.note === 'string' ? parsed.note : null;
  } catch {
    return null;
  }
}
