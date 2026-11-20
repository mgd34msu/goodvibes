import { startupNoticeWriter } from '@goodvibes-jev/engine/terminal-shell/cli-entrypoint';
import {
  parseNativeShellCli,
  shellMetadataResult,
  requireValidCliOverrides,
  applyCliModelSelection,
  resolveShellRoots,
  type ShellEntrypointRoots,
} from '@goodvibes-jev/engine/terminal-shell/cli-entrypoint';
export type { ShellEntrypointRoots } from '@goodvibes-jev/engine/terminal-shell/cli-entrypoint';
// Only what every command shares loads here: parsing, the configuration and
// its overrides. Each command's own module graph loads when it is chosen, so
// `status` never loads the headless turn and neither loads the terminal UI.
import { headlessRunFlagErrors } from '@goodvibes-jev/engine/terminal-shell/headless-turn-events';
import { join, resolve } from 'node:path';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { TuiConfigManager } from '../config/host-settings.ts';
import { formatProviderModel, getModelIdFromProviderModel, getProviderIdFromModel } from '@goodvibes-jev/engine/platform/platform/providers/provider-model';
import { GlobalNetworkTransportInstaller } from '@goodvibes-jev/engine/platform/platform/runtime/transport';
import { configureActivityLogger } from '@goodvibes-jev/engine/platform/platform/utils';
import {
  applyRuntimeCommandEndpointFlagOverrides,
  applyRuntimeConfigOverrides,
  applyRuntimeConfigValue,
  applyRuntimeFeatureFlagOverrides,
} from '@goodvibes-jev/engine/terminal-shell/cli-config-overrides';
import { parseGoodVibesCli } from '@goodvibes-jev/engine/terminal-shell/cli-parser';
import { renderCompletion } from './completion.ts';
import { renderGoodVibesCommandHelp, renderGoodVibesHelp, renderGoodVibesVersion } from './help.ts';
import { ensureGoodvibesGitignore } from './ensure-goodvibes-gitignore.ts';
import { parseDeepLink } from '../input/commands/deep-link.ts';
import { registerSelfAcpCommand } from '../self-acp-command.ts';
import { deferIngestionNoticesToApp } from '@goodvibes-jev/engine/platform/platform/config';

export type PreparedShellCliRuntime = {
  readonly cli: ReturnType<typeof parseGoodVibesCli>;
  readonly configManager: ConfigManager;
  readonly bootstrapWorkingDir: string;
  readonly bootstrapHomeDirectory: string;
};

const resolveShellEntrypointOwnership = resolveShellRoots;

export async function prepareShellCliRuntime(
  argv: readonly string[],
  roots: ShellEntrypointRoots,
  binary = 'goodvibes',
): Promise<PreparedShellCliRuntime> {
  // Product-owned host pairing is isolated from shared CLI/model dispatch.
  if (argv[0] === 'host') {
    const { runTuiHostCommand } = await import('./host-pair-command.ts');
    process.exit(await runTuiHostCommand(argv.slice(1), roots));
  }
  const { native, cli } = parseNativeShellCli(argv, binary, parseGoodVibesCli);
  const errors = [...cli.errors, ...headlessRunFlagErrors(native.run ?? {}, cli.command, cli.flags.outputFormat)];

  if (errors.length > 0) {
    console.error(errors.join('\n'));
    console.error('');
    console.error(renderGoodVibesHelp(binary));
    process.exit(2);
  }

  if (cli.warnings.length > 0) {
    for (const warning of cli.warnings) {
      console.warn(`[goodvibes] warning: ${warning}`);
    }
  }

  const metadata = shellMetadataResult(cli, binary, {
    help: renderGoodVibesHelp,
    commandHelp: renderGoodVibesCommandHelp,
    version: renderGoodVibesVersion,
    completion: renderCompletion,
  });
  if (metadata) {
    if (metadata.stdout !== undefined) console.log(metadata.stdout);
    if (metadata.stderr !== undefined) console.error(metadata.stderr);
    process.exit(metadata.exitCode);
  }

  if (cli.command === 'serve') {
    // The daemon is its own product and its own binary. This app is a client:
    // it never hosts one, so `serve` names something it cannot do. Say which
    // command to run instead rather than starting a daemon that would be a
    // second, drifting copy of the real one.
    console.error(
      '`goodvibes serve` is gone: the daemon is a separate program now. Run `goodvibes-daemon serve` (installed alongside this app), or `goodvibes service start` to start the installed service.',
    );
    process.exit(2);
  }

  const { workingDirectory: bootstrapWorkingDir, homeDirectory: bootstrapHomeDirectory } = resolveShellEntrypointOwnership(
    roots,
    cli.flags.workingDir ?? (cli.command === 'tui' ? cli.commandArgs[0] : undefined),
  );
  // One daemon home for the whole process: the flag wins over GOODVIBES_DAEMON_HOME,
  // and every reader resolves it through resolveGoodVibesDaemonHome.
  if (cli.flags.daemonHome) process.env['GOODVIBES_DAEMON_HOME'] = resolve(cli.flags.daemonHome);
  configureActivityLogger(join(bootstrapWorkingDir, '.goodvibes', 'logs'));
  // Only prints the first time the rule is actually appended (not on every
  // launch), see ensureGoodvibesGitignore's return-value doc.
  // `status` and `doctor` are diagnostics: they never edit the project's files.
  const isDiagnostic = cli.command === 'status' || cli.command === 'doctor' || (cli.command === 'setup' && cli.commandArgs[0] === 'status');
  if (cli.command !== 'run' && !isDiagnostic && ensureGoodvibesGitignore(bootstrapWorkingDir)) {
    startupNoticeWriter(cli, { out: console.log, err: console.error })(
      "[goodvibes] git now ignores '.goodvibes/' in this clone (.git/info/exclude; your .gitignore is unchanged): it holds transient TUI state (logs, session cache, exec output), not project source.",
    );
  }
  // The full-screen app shows skipped settings itself; stderr would repeat them under it.
  if (cli.command === 'tui') deferIngestionNoticesToApp();
  const configManager = new TuiConfigManager({
    workingDir: bootstrapWorkingDir,
    homeDir: bootstrapHomeDirectory,
    surfaceRoot: 'tui',
  });
  new GlobalNetworkTransportInstaller().install(configManager);

  const overrideErrors = applyRuntimeConfigOverrides(configManager, cli.flags.configOverrides);
  requireValidCliOverrides(overrideErrors, console.error, process.exit);
  const featureOverrideErrors = applyRuntimeFeatureFlagOverrides(configManager, {
    enableFeatures: cli.flags.enableFeatures,
    disableFeatures: cli.flags.disableFeatures,
  });
  requireValidCliOverrides(featureOverrideErrors, console.error, process.exit);

  applyCliModelSelection(cli.flags, {
    current: () => configManager.get('provider.model'),
    provider: getProviderIdFromModel,
    model: getModelIdFromProviderModel,
    format: formatProviderModel,
    apply: (model) => {
      applyRuntimeConfigValue(configManager, 'provider.model', model);
    },
  });
  const endpointOverrideErrors = applyRuntimeCommandEndpointFlagOverrides(configManager, cli.command, cli.flags);
  requireValidCliOverrides(endpointOverrideErrors, console.error, process.exit);

  if (cli.command === 'open' && (cli.commandArgs.length !== 1 || !parseDeepLink(cli.commandArgs[0]!))) {
    console.error(`goodvibes open takes one link: goodvibes://open/<view>[?target=<id>[:<kind>]]${cli.commandArgs[0] ? ` ("${cli.commandArgs[0]}" is not one)` : ''}.`);
    process.exit(2);
  }

  if (cli.command === 'doctor' && ['explain', 'routing', 'hooks'].includes(cli.commandArgs[0] ?? '')) {
    const { handleDoctorSubcommand } = await import('./doctor.ts');
    const result = await handleDoctorSubcommand({
      subcommand: cli.commandArgs[0]!,
      args: cli.commandArgs.slice(1),
      configManager,
      workingDirectory: bootstrapWorkingDir,
      homeDirectory: bootstrapHomeDirectory,
      outputFormat: cli.flags.outputFormat,
    });
    if (result) {
      console.log(result.output);
      process.exit(result.exitCode);
    }
  }

  const commandRuntime = { cli, configManager, workingDirectory: bootstrapWorkingDir, homeDirectory: bootstrapHomeDirectory };
  if (isDiagnostic) {
    const { runStatusCommand } = await import('./status-command.ts');
    process.exit(await runStatusCommand(commandRuntime));
  }

  // Everything from here on (a turn, management, the terminal UI) may start ACP agents.
  await registerSelfAcpCommand();
  if (cli.command === 'run') {
    const { runNativeHeadlessCommand } = await import('./native-headless-command.ts');
    process.exit(await runNativeHeadlessCommand(commandRuntime, native.mode, native.run));
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
