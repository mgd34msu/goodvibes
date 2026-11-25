import {
  parseNativeShellCli,
  shellMetadataResult,
  writeCliUsageRefusal,
  applyCliModelSelection,
  resolveShellRoots,
  type ShellEntrypointOwnership,
  type ShellEntrypointRoots,
} from '@goodvibes/engine/terminal-shell/cli-entrypoint';
export type { ShellEntrypointRoots } from '@goodvibes/engine/terminal-shell/cli-entrypoint';
// Only what every command shares loads here: parsing, the configuration and
// its overrides. Each command's own module graph loads when it is chosen, so
// `status` never loads the headless turn and neither loads the terminal UI.
import { headlessRunFlagErrors } from '@goodvibes/engine/terminal-shell/headless-turn-events';
import { join } from 'node:path';
import { DAEMON_STATE_SURFACE_ROOT } from '@goodvibes/engine/platform/platform/daemon/lifecycle-marker';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { AgentConfigManager } from '../config/host-settings.ts';
import { formatProviderModel, getModelIdFromProviderModel, getProviderIdFromModel } from '@goodvibes/engine/platform/platform/providers/provider-model';
import { GlobalNetworkTransportInstaller } from '@goodvibes/engine/platform/platform/runtime/transport';
import { configureActivityLogger } from '@goodvibes/engine/platform/platform/utils';
import {
  applyRuntimeCommandEndpointFlagOverrides,
  applyRuntimeConfigOverrides,
  applyRuntimeConfigValue,
  applyRuntimeFeatureOverrides,
  applyRuntimeUrlOverride,
} from './config-overrides.ts';
import { parseGoodVibesCli } from './parser.ts';
import { renderCompletion } from './completion.ts';
import { renderGoodVibesCommandHelp, renderGoodVibesHelp, renderGoodVibesUsageLine, renderGoodVibesVersion } from './help.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { writeExitingStdoutLine, writeFatalLine } from '../utils/fatal-boot-write.ts';
import { AgentProfileUsageError, resolveAgentRuntimeProfileHome, resolveSelectedAgentRuntimeProfileHome } from '../agent/runtime-profile.ts';
import { deferIngestionNoticesToApp } from '@goodvibes/engine/platform/platform/config';

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
  const { native, cli } = parseNativeShellCli(argv, binary, parseGoodVibesCli);
  const errors = [...cli.errors, ...headlessRunFlagErrors(native.run ?? {}, cli.command, cli.flags.outputFormat)];

  // A usage error is the error and, for a wrong command line, the command's one usage line; JSON when asked for.
  const refuseUsage = async (lines: readonly string[], usageLine?: string): Promise<never> => {
    await writeCliUsageRefusal(cli, lines, usageLine, {
      stdout: writeExitingStdoutLine,
      stderr: writeFatalLine,
      loadRunResultWriter: async () => (await import('./native-headless.ts')).writeNativeHeadlessResult,
    });
    process.exit(2);
  };
  if (errors.length > 0) {
    await refuseUsage(errors, renderGoodVibesUsageLine(cli, binary));
  }

  for (const warning of cli.warnings) console.warn(`[${binary}] warning: ${warning}`);

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
  // The full-screen app shows skipped settings itself; stderr would repeat them under it.
  if (cli.command === 'tui') deferIngestionNoticesToApp();
  const configManager = new AgentConfigManager({
    workingDir: bootstrapWorkingDir,
    homeDir: bootstrapHomeDirectory,
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    // Providers of your own are the daemon's, one folder for every program (the Agent's own were carried into it once).
    providersDir: join(bootstrapHomeDirectory, '.goodvibes', DAEMON_STATE_SURFACE_ROOT, 'providers'),
  });
  new GlobalNetworkTransportInstaller().install(configManager);

  const envRuntimeUrl = readEnvRuntimeUrl();
  // Override errors end the run before runtime construction, headless effects or command dispatch.
  const envRuntimeUrlErrors = envRuntimeUrl ? applyRuntimeUrlOverride(configManager, envRuntimeUrl.value, envRuntimeUrl.source) : [];
  if (envRuntimeUrlErrors.length > 0) await refuseUsage(envRuntimeUrlErrors);

  const overrideErrors = applyRuntimeConfigOverrides(configManager, cli.flags.configOverrides);
  if (overrideErrors.length > 0) await refuseUsage(overrideErrors);
  const featureOverrideErrors = applyRuntimeFeatureOverrides(configManager, {
    enableFeatures: cli.flags.enableFeatures,
    disableFeatures: cli.flags.disableFeatures,
  });
  if (featureOverrideErrors.length > 0) await refuseUsage(featureOverrideErrors);

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
    if (runtimeUrlErrors.length > 0) await refuseUsage(runtimeUrlErrors);
  }
  const endpointOverrideErrors = applyRuntimeCommandEndpointFlagOverrides(configManager, cli.command, cli.flags);
  if (endpointOverrideErrors.length > 0) await refuseUsage(endpointOverrideErrors);

  const commandRuntime = { cli, configManager, workingDirectory: bootstrapWorkingDir, homeDirectory: bootstrapHomeDirectory };
  if (cli.command === 'run') {
    const { runNativeHeadlessCommand } = await import('./native-headless-command.ts');
    process.exit(await runNativeHeadlessCommand(commandRuntime, native.mode, native.run));
  }

  if (cli.command === 'onboarding' && cli.commandArgs[0] === 'status') {
    const { runOnboardingStatusCommand } = await import('./status-command.ts');
    process.exit(await runOnboardingStatusCommand(commandRuntime));
  }

  if (cli.command === 'status' || cli.command === 'doctor') {
    const { runStatusCommand } = await import('./status-command.ts');
    process.exit(await runStatusCommand(commandRuntime));
  }

  const { handleGoodVibesCliCommand } = await import('./management.ts');
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
