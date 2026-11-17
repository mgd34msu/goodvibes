import {
  parseNativeShellCli,
  shellMetadataResult,
  requireValidCliOverrides,
  applyCliModelSelection,
  resolveShellRoots,
  type ShellEntrypointOwnership,
  type ShellEntrypointRoots,
} from '@goodvibes-jev/engine/terminal-shell/cli-entrypoint';
export type { ShellEntrypointRoots } from '@goodvibes-jev/engine/terminal-shell/cli-entrypoint';
import { readConnectedHostReadiness } from '../runtime/connected-host-readiness.ts';
import { canonicalizePairingHost, readAgentHostPairing } from '../runtime/connected-host-pairing-store.ts';
import { resolveConnectedHostBaseUrl } from '../config/connected-host-dial.ts';
import { extractNativeHeadlessOptions } from './native-headless-options.ts';
import { headlessRunFlagErrors } from '@goodvibes-jev/engine/terminal-shell/headless-turn-events';
import { runNativeHeadlessCommand } from './native-headless-command.ts';
import { existsSync } from 'node:fs';
import { connectedHostOperatorTokenPath, readConnectedHostOperatorToken } from '../runtime/connected-host-auth.ts';
import { fetchDaemonCredentialAvailability } from '../config/credential-status.ts';
import { join } from 'node:path';
import { AgentConfigManager, type ConfigManager } from '../config/index.ts';
import { formatProviderModel, getModelIdFromProviderModel, getProviderIdFromModel } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { readOnboardingCheckMarker } from '../runtime/onboarding/index.ts';
import { GlobalNetworkTransportInstaller } from '@/runtime/index.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { configureActivityLogger } from '@goodvibes-jev/engine/platform/platform/utils';
import {
  applyRuntimeCommandEndpointFlagOverrides,
  applyRuntimeConfigOverrides,
  applyRuntimeConfigValue,
  applyRuntimeFeatureOverrides,
  applyRuntimeUrlOverride,
  buildCliStatusSnapshot,
  handleGoodVibesCliCommand,
  parseGoodVibesCli,
  renderCliStatus,
  renderCompletion,
  renderGoodVibesCommandHelp,
  renderGoodVibesHelp,
  renderGoodVibesVersion,
  renderOnboardingCliStatus,
} from './index.ts';
import { resolveDoctorExitCode } from './doctor-exit.ts';
import { buildCliServicePosture } from './service-posture.ts';
import { inspectCliExternalRuntime } from './external-runtime.ts';
import { inspectConnectedHostMetrics } from './connected-host-metrics.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { writeExitingStdoutLine, writeFatalLine } from '../utils/fatal-boot-write.ts';
import { readCheckpointRegistrationSetting } from '../config/checkpoint-settings.ts';
import { resolveCheckpointEligibilitySync } from '../config/workspace-registration.ts';
import { AgentProfileUsageError, resolveAgentRuntimeProfileHome, resolveSelectedAgentRuntimeProfileHome } from '../agent/runtime-profile.ts';

function readEnvRuntimeUrl(): { readonly source: string; readonly value: string } | null {
  const runtimeUrl = process.env['GOODVIBES_AGENT_RUNTIME_URL'];
  if (runtimeUrl !== undefined) return { source: 'GOODVIBES_AGENT_RUNTIME_URL', value: runtimeUrl };
  const legacyBaseUrl = process.env['GOODVIBES_AGENT_BASE_URL'];
  if (legacyBaseUrl !== undefined) return { source: 'GOODVIBES_AGENT_BASE_URL', value: legacyBaseUrl };
  return null;
}

export type PreparedShellCliRuntime = {
  readonly cli: ReturnType<typeof parseGoodVibesCli>;
  readonly configManager: ConfigManager;
  readonly bootstrapWorkingDir: string;
  readonly bootstrapHomeDirectory: string;
};

export function resolveShellEntrypointOwnership(
  roots: ShellEntrypointRoots,
  workingDirOverride?: string,
  options: {
    readonly agentProfile?: string;
    readonly useSelectedProfile: boolean;
  } = { useSelectedProfile: true },
): ShellEntrypointOwnership {
  const selectedProfile = options.agentProfile
    ? resolveAgentRuntimeProfileHome(roots.homeDirectory, options.agentProfile, { mustExist: true })
    : options.useSelectedProfile
      ? resolveSelectedAgentRuntimeProfileHome(roots.homeDirectory)
      : null;
  const homeDirectory = selectedProfile?.homeDirectory ?? roots.homeDirectory;
  return resolveShellRoots(roots, workingDirOverride, homeDirectory);
}

export async function prepareShellCliRuntime(
  argv: readonly string[],
  roots: ShellEntrypointRoots,
  binary = 'goodvibes-agent',
): Promise<PreparedShellCliRuntime> {
  const { native, cli } = parseNativeShellCli(argv, binary, extractNativeHeadlessOptions, parseGoodVibesCli);
  const errors = [...cli.errors, ...headlessRunFlagErrors(native.run ?? {}, cli.command, cli.flags.outputFormat)];

  if (errors.length > 0) {
    writeFatalLine(errors.join('\n'));
    writeFatalLine('');
    writeFatalLine(renderGoodVibesHelp(binary));
    process.exit(2);
  }

  const metadata = shellMetadataResult(cli, binary, {
    help: renderGoodVibesHelp,
    commandHelp: renderGoodVibesCommandHelp,
    version: renderGoodVibesVersion,
    completion: renderCompletion,
  });
  if (metadata) {
    if (metadata.stdout !== undefined) writeExitingStdoutLine(metadata.stdout);
    if (metadata.stderr !== undefined) writeFatalLine(metadata.stderr);
    process.exit(metadata.exitCode);
  }

  let ownership: ShellEntrypointOwnership;
  try {
    ownership = resolveShellEntrypointOwnership(roots, cli.flags.workingDir ?? (cli.command === 'tui' ? cli.commandArgs[0] : undefined), {
      agentProfile: cli.command === 'profiles' ? undefined : cli.flags.agentProfile,
      useSelectedProfile: cli.command !== 'profiles',
    });
  } catch (error) {
    writeFatalLine(error instanceof Error ? error.message : String(error));
    // A malformed name is a usage error; a profile that does not exist is a refusal.
    process.exit(error instanceof AgentProfileUsageError ? 2 : 1);
  }
  const { workingDirectory: bootstrapWorkingDir, homeDirectory: bootstrapHomeDirectory } = ownership;
  configureActivityLogger(join(bootstrapWorkingDir, '.goodvibes', 'logs'));
  const configManager = new AgentConfigManager({
    workingDir: bootstrapWorkingDir,
    homeDir: bootstrapHomeDirectory,
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
  });
  new GlobalNetworkTransportInstaller().install(configManager);

  const envRuntimeUrl = readEnvRuntimeUrl();
  const envRuntimeUrlErrors = envRuntimeUrl ? applyRuntimeUrlOverride(configManager, envRuntimeUrl.value, envRuntimeUrl.source) : [];
  requireValidCliOverrides(envRuntimeUrlErrors, writeFatalLine, process.exit);

  const overrideErrors = applyRuntimeConfigOverrides(configManager, cli.flags.configOverrides);
  requireValidCliOverrides(overrideErrors, writeFatalLine, process.exit);
  const featureOverrideErrors = applyRuntimeFeatureOverrides(configManager, {
    enableFeatures: cli.flags.enableFeatures,
    disableFeatures: cli.flags.disableFeatures,
  });
  requireValidCliOverrides(featureOverrideErrors, writeFatalLine, process.exit);

  applyCliModelSelection(cli.flags, {
    current: () => configManager.get('provider.model'),
    provider: getProviderIdFromModel,
    model: getModelIdFromProviderModel,
    format: formatProviderModel,
    apply: (model) => {
      applyRuntimeConfigValue(configManager, 'provider.model', model);
    },
  });
  if (cli.flags.runtimeUrl !== undefined) {
    const runtimeUrlErrors = applyRuntimeUrlOverride(configManager, cli.flags.runtimeUrl);
    if (runtimeUrlErrors.length > 0) {
      writeFatalLine(runtimeUrlErrors.join('\n'));
      process.exit(2);
    }
  }
  const endpointOverrideErrors = applyRuntimeCommandEndpointFlagOverrides(configManager, cli.command, cli.flags);
  requireValidCliOverrides(endpointOverrideErrors, writeFatalLine, process.exit);

  if (cli.command === 'run') {
    process.exit(
      await runNativeHeadlessCommand(
        { cli, configManager, workingDirectory: bootstrapWorkingDir, homeDirectory: bootstrapHomeDirectory },
        native.mode,
        native.run,
      ),
    );
  }

  if (cli.command === 'onboarding' && cli.commandArgs[0] === 'status') {
    const shellPaths = createShellPathService({ workingDirectory: bootstrapWorkingDir, homeDirectory: bootstrapHomeDirectory });
    const selectedHost = canonicalizePairingHost(resolveConnectedHostBaseUrl(configManager)) ?? '(invalid endpoint)';
    const nativeReadiness = await readConnectedHostReadiness({ configManager, homeDirectory: bootstrapHomeDirectory });
    const pairingStatus = readAgentHostPairing(bootstrapHomeDirectory, selectedHost).status;
    writeExitingStdoutLine(
      renderOnboardingCliStatus({
        configManager,
        workingDirectory: bootstrapWorkingDir,
        homeDirectory: bootstrapHomeDirectory,
        onboardingMarker: readOnboardingCheckMarker(shellPaths),
        nativeReadiness,
        pairingStatus,
        selectedHost,
        outputFormat: cli.flags.outputFormat,
      }),
    );
    process.exit(0);
  }

  if (cli.command === 'status' || cli.command === 'doctor') {
    const shellPaths = createShellPathService({
      workingDirectory: bootstrapWorkingDir,
      homeDirectory: bootstrapHomeDirectory,
    });
    const userStorePath = shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'auth-users.json');
    const bootstrapCredentialPath = shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'auth-bootstrap.txt');
    const operatorTokenPath = connectedHostOperatorTokenPath(bootstrapHomeDirectory);
    const onboardingMarker = readOnboardingCheckMarker(shellPaths);
    const service = await buildCliServicePosture({
      configManager,
      workingDirectory: bootstrapWorkingDir,
      homeDirectory: bootstrapHomeDirectory,
    });
    const externalRuntime = await inspectCliExternalRuntime({
      configManager,
      homeDirectory: bootstrapHomeDirectory,
    });
    // Only probe host metrics when the host is actually reachable, otherwise
    // the unreachability is already reported in the connected-host block above,
    // and skipping the call avoids a second connect-timeout wait. When reachable,
    // the probe classifies token/scope/route state honestly (including the
    // read:telemetry scope-missing case) rather than rendering zeros.
    const connectedHostMetrics = externalRuntime.reachable
      ? await inspectConnectedHostMetrics({
          configManager,
          homeDirectory: bootstrapHomeDirectory,
        })
      : undefined;
    // One bounded, secret-free read of what the host's store holds, beside the metrics.
    const connectedHostCredentials = externalRuntime.reachable
      ? await fetchDaemonCredentialAvailability({
          baseUrl: externalRuntime.baseUrl,
          token: readConnectedHostOperatorToken(bootstrapHomeDirectory, externalRuntime.baseUrl).token,
        })
      : undefined;
    const effectiveOperatorTokenPath = externalRuntime.operatorToken.present ? externalRuntime.operatorToken.path : operatorTokenPath;
    const checkpoints = {
      // Honest to the checkpoint boundary: a workspace is "registered" for
      // checkpoints only when it is checkpoint-ELIGIBLE (an explicit owner
      // opt-in), not merely present in the shared store as a TUI self-record.
      workspaceRegistered: resolveCheckpointEligibilitySync(shellPaths, bootstrapWorkingDir).status === 'covered',
      unregisteredWorkspaceMode: readCheckpointRegistrationSetting(configManager),
    };
    const statusOptions = {
      configManager,
      workingDirectory: bootstrapWorkingDir,
      homeDirectory: bootstrapHomeDirectory,
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
    process.exit(cli.command === 'doctor' ? resolveDoctorExitCode(snapshot.findings, cli.commandArgs.includes('--strict')) : 0);
  }

  const cliCommandResult = await handleGoodVibesCliCommand({
    cli,
    configManager,
    workingDirectory: bootstrapWorkingDir,
    homeDirectory: bootstrapHomeDirectory,
  });
  if (cliCommandResult.handled) {
    process.exit(cliCommandResult.exitCode);
  }

  return { cli, configManager, bootstrapWorkingDir, bootstrapHomeDirectory };
}
