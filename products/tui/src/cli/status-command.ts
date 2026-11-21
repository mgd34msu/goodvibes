import { existsSync } from 'node:fs';
import { readCliModelInUse, readCliProviderSignInFacts, readSavedCliModelInUse } from '@goodvibes/engine/terminal-shell/cli-status-facts';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { GoodVibesCliParseResult } from '@goodvibes/engine/terminal-shell/cli-types';
import { readPersistedWorkspaceTrust } from '@goodvibes/engine/platform/platform/runtime/workspace-trust';
import { WorkspaceRegistrationManager } from '@goodvibes/engine/platform/platform/runtime/workspace-registration';
import { createShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell-paths';
import { createFeatureFlagManager } from '@goodvibes/engine/platform/platform/runtime/feature-flags/manager';
import { deriveFeatureStates } from '@goodvibes/engine/platform/platform/runtime/feature-flags/feature-settings';
import { detectSandboxAvailability, probeSandboxHost } from '@goodvibes/engine/platform/platform/tools/exec/sandbox';
import { readAuthPaths } from './auth-paths.ts';
import { readOnboardingCheckMarker } from '../runtime/onboarding/markers.ts';
import { buildCliServicePosture, getGoodVibesPackageRoot, resolveGoodVibesDaemonExecutable } from './service-posture.ts';
import { runInstallSelfCheck } from '../runtime/install-self-check.ts';
import {
  buildCliStatusSnapshot,
  renderCliStatus,
  renderOnboardingCliStatus,
  resolveDoctorExitCode,
  type CliRelayStatus,
  type CliSandboxStatus,
  type CliWorkspaceStatus,
} from './status.ts';
import { GOODVIBES_TUI_SURFACE_ROOT, TUI_TRUSTS_SAVED_SCANNED_SERVERS } from '../config/surface.ts';

/** What `status`, `doctor` and `setup status` read: the prepared configuration and its roots. */
export interface StatusCommandRuntime {
  readonly cli: GoodVibesCliParseResult;
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
}

/** `status`, `doctor` and `setup status`: prints the report and returns the exit code. */
export async function runStatusCommand(runtime: StatusCommandRuntime): Promise<number> {
  const { cli, configManager, workingDirectory, homeDirectory } = runtime;
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  const onboardingMarker = readOnboardingCheckMarker(shellPaths);
  const service = await buildCliServicePosture({ configManager, workingDirectory, homeDirectory });
  // Read-only workspace posture for the report: the trust reader and
  // registration resolve() never write, so `status`/`doctor` observe state
  // without mutating it.
  const trustView = readPersistedWorkspaceTrust(shellPaths, GOODVIBES_TUI_SURFACE_ROOT);
  const registrationEvaluation = await new WorkspaceRegistrationManager({ shellPaths }).evaluate();
  const workspaceStatus: CliWorkspaceStatus = {
    trustLevel: trustView.level,
    trustLegacyIgnored: trustView.legacyIgnored,
    trustFault: trustView.fault,
    registrationStatus: registrationEvaluation.status,
    registrationRoot: registrationEvaluation.root,
    registeredBy: registrationEvaluation.coveredBy,
    viaWorktreeLink: registrationEvaluation.viaWorktreeLink,
    registrationBroad: registrationEvaluation.broad,
  };
  // Honest per-command exec sandbox posture: the host probe (a bwrap spawn on
  // Linux, a no-op elsewhere) is what makes "available" trustworthy.
  const sandboxAvailability = detectSandboxAvailability(probeSandboxHost());
  const sandboxFeatureFlags = createFeatureFlagManager();
  sandboxFeatureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
  const sandboxStatus: CliSandboxStatus = {
    configEnabled: Boolean(configManager.getCategory('sandbox').enabled),
    featureEnabled: sandboxFeatureFlags.isEnabled('exec-sandbox'),
    available: sandboxAvailability.available,
    backend: sandboxAvailability.backend,
    reason: sandboxAvailability.reason,
    networkIsolationGuaranteed: sandboxAvailability.networkIsolationGuaranteed,
  };
  // Reuses sandboxFeatureFlags (already derived from the same domain settings keys)
  // for the relay-connect gate rather than constructing a second FeatureFlagManager.
  const relayCategory = configManager.getCategory('relay');
  const relayStatus: CliRelayStatus = {
    configEnabled: relayCategory.enabled === true,
    featureEnabled: sandboxFeatureFlags.isEnabled('relay-connect'),
    url: String(relayCategory.url ?? ''),
    requireStepUpForMutations: relayCategory.requireStepUpForMutations === true,
  };
  // The model a run would use, resolved as the registry a run builds resolves it (custom providers, the saved
  // scan): from the saved names when they settle it, else by building that registry, loaded only then.
  const modelInUse = readSavedCliModelInUse(configManager, { homeDirectory, surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT, trustScannedServer: TUI_TRUSTS_SAVED_SCANNED_SERVERS })
    ?? await (await import('./one-shot-services.ts')).withProviderServices(runtime, ({ providerRegistry }) => readCliModelInUse(providerRegistry), { modelData: 'skip' });
  const statusOptions = {
    configManager,
    workingDirectory,
    homeDirectory,
    modelInUse,
    providerSignIn: readCliProviderSignInFacts(configManager, shellPaths, modelInUse.provider),
    onboardingMarker,
    auth: readAuthPaths({ workingDirectory, homeDirectory }),
    service,
    install: runInstallSelfCheck({
      execPath: process.execPath,
      packageRoot: getGoodVibesPackageRoot(),
      daemon: resolveGoodVibesDaemonExecutable(),
      fileExists: existsSync,
    }),
    doctor: cli.command === 'doctor',
    outputFormat: cli.flags.outputFormat,
    workspace: workspaceStatus,
    sandbox: sandboxStatus,
    relay: relayStatus,
  };
  const snapshot = buildCliStatusSnapshot(statusOptions);
  console.log(cli.command === 'setup' ? renderOnboardingCliStatus(statusOptions) : renderCliStatus(statusOptions));
  // Advisory findings are notes on an otherwise-usable install and must
  // never make a healthy install report failure, only a must-fix finding
  // exits non-zero; --strict (for CI) flips advisories to failures too.
  return cli.command === 'doctor' ? resolveDoctorExitCode(snapshot.findings, cli.flags.strict) : 0;
}
