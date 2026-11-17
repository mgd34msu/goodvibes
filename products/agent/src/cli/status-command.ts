import { existsSync } from 'node:fs';
import { readConnectedHostReadiness } from '../runtime/connected-host-readiness.ts';
import { canonicalizePairingHost, readAgentHostPairing } from '@goodvibes-jev/engine/terminal-shell/agent-turn/connected-host-pairing-store';
import { resolveConnectedHostBaseUrl } from '@goodvibes-jev/engine/terminal-shell/agent-turn/connected-host-dial';
import { connectedHostOperatorTokenPath, readConnectedHostOperatorToken } from '@goodvibes-jev/engine/terminal-shell/agent-turn/connected-host-auth';
import { fetchDaemonCredentialAvailability } from '../config/credential-status.ts';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { readOnboardingDoneMarker } from '../runtime/onboarding/completion.ts';
import { createShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell-paths';
import { buildCliStatusSnapshot, renderCliStatus, renderOnboardingCliStatus } from './status.ts';
import type { GoodVibesCliParseResult } from './types.ts';
import { resolveDoctorExitCode } from './doctor-exit.ts';
import { buildCliServicePosture } from './service-posture.ts';
import { inspectCliExternalRuntime } from './external-runtime.ts';
import { inspectConnectedHostMetrics } from './connected-host-metrics.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { writeExitingStdoutLine } from '../utils/fatal-boot-write.ts';
import { readCheckpointRegistrationSetting } from '@goodvibes-jev/engine/platform/platform/config/checkpoint-settings';
import { resolveCheckpointEligibilitySync } from '../config/workspace-registration.ts';

/** What `status`, `doctor` and `onboarding status` read: the prepared configuration and its roots. */
export interface StatusCommandRuntime {
  readonly cli: GoodVibesCliParseResult;
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
}

/** `onboarding status`: prints the report and returns the exit code. */
export async function runOnboardingStatusCommand(runtime: StatusCommandRuntime): Promise<number> {
  const { cli, configManager, workingDirectory, homeDirectory } = runtime;
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  const selectedHost = canonicalizePairingHost(resolveConnectedHostBaseUrl(configManager)) ?? '(invalid endpoint)';
  const nativeReadiness = await readConnectedHostReadiness({ configManager, homeDirectory });
  const pairingStatus = readAgentHostPairing(homeDirectory, selectedHost).status;
  writeExitingStdoutLine(
    renderOnboardingCliStatus({
      configManager,
      workingDirectory,
      homeDirectory,
      onboardingMarker: readOnboardingDoneMarker(shellPaths),
      nativeReadiness,
      pairingStatus,
      selectedHost,
      outputFormat: cli.flags.outputFormat,
    }),
  );
  return 0;
}

/** `status` and `doctor`: prints the report and returns the exit code. */
export async function runStatusCommand(runtime: StatusCommandRuntime): Promise<number> {
  const { cli, configManager, workingDirectory, homeDirectory } = runtime;
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  const userStorePath = shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'auth-users.json');
  const bootstrapCredentialPath = shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'auth-bootstrap.txt');
  const operatorTokenPath = connectedHostOperatorTokenPath(homeDirectory);
  const onboardingMarker = readOnboardingDoneMarker(shellPaths);
  const service = await buildCliServicePosture({ configManager, workingDirectory, homeDirectory });
  const externalRuntime = await inspectCliExternalRuntime({ configManager, homeDirectory });
  // Only probe host metrics when the host is actually reachable, otherwise
  // the unreachability is already reported in the connected-host block above,
  // and skipping the call avoids a second connect-timeout wait. When reachable,
  // the probe classifies token/scope/route state honestly (including the
  // read:telemetry scope-missing case) rather than rendering zeros.
  const connectedHostMetrics = externalRuntime.reachable
    ? await inspectConnectedHostMetrics({ configManager, homeDirectory })
    : undefined;
  // One bounded, secret-free read of what the host's store holds, beside the metrics.
  const connectedHostCredentials = externalRuntime.reachable
    ? await fetchDaemonCredentialAvailability({
        baseUrl: externalRuntime.baseUrl,
        token: readConnectedHostOperatorToken(homeDirectory, externalRuntime.baseUrl).token,
      })
    : undefined;
  const effectiveOperatorTokenPath = externalRuntime.operatorToken.present ? externalRuntime.operatorToken.path : operatorTokenPath;
  const checkpoints = {
    // Honest to the checkpoint boundary: a workspace is "registered" for
    // checkpoints only when it is checkpoint-ELIGIBLE (an explicit owner
    // opt-in), not merely present in the shared store as a TUI self-record.
    workspaceRegistered: resolveCheckpointEligibilitySync(shellPaths, workingDirectory).status === 'covered',
    unregisteredWorkspaceMode: readCheckpointRegistrationSetting(configManager),
  };
  const statusOptions = {
    configManager,
    workingDirectory,
    homeDirectory,
    onboardingMarker,
    checkpoints,
    auth: {
      userStorePath,
      userStorePresent: existsSync(userStorePath),
      bootstrapCredentialPath,
      bootstrapCredentialPresent: existsSync(bootstrapCredentialPath),
      operatorTokenPath: effectiveOperatorTokenPath,
      operatorTokenPresent: externalRuntime.operatorToken.present,
    },
    service,
    externalRuntime,
    connectedHostMetrics,
    ...(connectedHostCredentials ? { connectedHostCredentials } : {}),
    doctor: cli.command === 'doctor',
    outputFormat: cli.flags.outputFormat,
  };
  const snapshot = buildCliStatusSnapshot(statusOptions);
  writeExitingStdoutLine(renderCliStatus(statusOptions, snapshot));
  return cli.command === 'doctor' ? resolveDoctorExitCode(snapshot.findings, cli.commandArgs.includes('--strict')) : 0;
}
