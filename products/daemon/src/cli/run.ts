/** CLI dispatch without import-time startup. Adapted from the upstream daemon/cli. */
import { homedir } from 'node:os';
import { writeSync } from 'node:fs';
// Each command's module loads when that command is chosen, so `--version`,
// `--help` and `status` never load serving, MCP, cluster or service code.
import type { DaemonCommandResult } from '../daemon/status-command.js';
import type { ManagedServiceActionRunner } from '../daemon/service-commands.js';
import type { DaemonProcessOptions } from '../daemon/process-lifecycle.js';
import { VERSION } from '../version.js';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import { parseDaemonCli } from './parser.js';
import { answersHelpFlag, renderGoodVibesDaemonHelp, renderDaemonCommandHelp, renderGoodVibesVersion, renderDaemonCliCatalog } from './help.js';
import { daemonCommandFailureLines } from './command-failure.js';
import { runCompletionCommand } from './completion.js';
import { daemonCommandSpec, isRawInterceptCommand } from './command-catalog.js';
import type { DaemonCliRuntime } from './serve.js';
import type { ShippedServiceExecutable } from './service-executable.js';
import type { ChunkSink, ChunkSource } from '@goodvibes-jev/engine/platform/platform/mcp/server';

export interface DaemonCliOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /** Required for serve until all built-in inbox prerequisites are available. */
  readonly runtime?: DaemonCliRuntime;
  /** Shipped hosts load their service composition only for actual activation. */
  readonly createRuntime?: () => Promise<DaemonCliRuntime>;
  /** Explicit installed executable that composes the same runtime; never guessed from Bun. */
  readonly serviceBinaryPath?: string;
  /** Code-owned shipped entrypoint admission, invoked only for service activation (it may load its module then). */
  readonly resolveServiceExecutable?: () => ShippedServiceExecutable | undefined | Promise<ShippedServiceExecutable | undefined>;
  /** Trusted embedding port; ordinary commands use the real platform manager. */
  readonly serviceActionRunner?: ManagedServiceActionRunner;
  readonly process?: DaemonProcessOptions;
  /**
   * Record an uncaught exception or unhandled rejection of a serving daemon in
   * its crash log. The shipped entry turns it on; an embedding caller keeps its
   * own process handlers.
   */
  readonly captureCrashes?: boolean;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  /** Explicit local credential-bearing output; automatic startup otherwise requires a TTY. */
  readonly pairingOutput?: (line: string) => void;
  /** `mcp serve` transport; the process's own stdin/stdout unless an embedding supplies a pair. */
  readonly mcpStdio?: { readonly input: ChunkSource; readonly output: ChunkSink };
}

const PARTIAL = 'Serving requires an explicit production inbox composition. Configured providers require trusted local account admission.';

/** Returns a command exit code; serving remains owned until shutdown completes. */
export async function runDaemonCli(argv: readonly string[], options: DaemonCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((line: string) => { writeSync(1, `${line}\n`); });
  const stderr = options.stderr ?? ((line: string) => { writeSync(2, `${line}\n`); });
  const result = (answer: DaemonCommandResult, write = answer.exitCode === 0 ? stdout : stderr): number => {
    for (const line of answer.lines) write(line);
    return answer.exitCode;
  };
  const refuse = (line: string): number => result({ exitCode: 2, lines: [line] });
  const env = options.env ?? process.env;
  try {
    const cli = parseDaemonCli(argv);
    if (cli.errors.length) {
      // The unit carries no endpoint flags, so the parser refuses these before dispatch; name the supported route.
      const endpointFlag = cli.command === 'install-service'
        && cli.errors.some((error) => /^--(port|hostname) is not a flag/.test(error));
      return result({ exitCode: 2, lines: [...cli.errors,
        ...(endpointFlag ? ['The installed service reads controlPlane.host and controlPlane.port from settings each time it starts, so a flag here could never reach it.',
          `Set the persistent binding instead: goodvibes-daemon config set controlPlane.host <host> / controlPlane.port <port>, then run \`${cli.command}\` again.`] : []),
        '', renderGoodVibesDaemonHelp()] });
    }
    for (const warning of cli.warnings) stderr(`[goodvibes-daemon] warning: ${warning}`);
    if (cli.flags.help || cli.command === 'help') {
      const topic = cli.command === 'help' ? cli.commandArgs[0] : cli.rawCommand;
      if (cli.flags.json) {
        if (topic !== undefined) return refuse('Machine help requires: goodvibes-daemon --help --json');
        return result({ exitCode: 0, lines: [renderDaemonCliCatalog()] });
      }
      const page = topic === undefined ? renderGoodVibesDaemonHelp() : renderDaemonCommandHelp(topic);
      // The partial-composition note is only true of a build with no runtime to serve with.
      const composed = options.runtime !== undefined || options.createRuntime !== undefined;
      return page === null ? refuse(`Unknown command: ${topic}`) : result({ exitCode: 0, lines: composed ? [page] : [page, '', PARTIAL] });
    }
    // Passthrough commands read their own arguments, so the parser leaves `--help` to them;
    // the pages advertise `<command> --help`. `send` answers it with its own usage.
    if (isRawInterceptCommand(cli.command) && cli.command !== 'send' && answersHelpFlag(daemonCommandSpec(cli.command)) && cli.commandArgs.length === 1
      && (cli.commandArgs[0] === '--help' || cli.commandArgs[0] === '-h')) {
      return result({ exitCode: 0, lines: [renderDaemonCommandHelp(cli.command)!] });
    }
    if (cli.flags.version || cli.command === 'version') return result({ exitCode: 0, lines: [renderGoodVibesVersion()] });
    if (cli.command === 'completion') return result(runCompletionCommand(cli.commandArgs));
    if (cli.command === 'check-install-reader') {
      const { runInstallReaderCheck } = await import('./check-install-reader.js');
      return runInstallReaderCheck(cli.commandArgs, { stdout, stderr });
    }
    if (cli.command === 'send') {
      const { prepareSendCommand, runPreparedSendCommand } = await import('../daemon/send/command.js');
      const prepared = prepareSendCommand(cli.commandArgs);
      if (prepared.kind === 'result') return result(prepared.result);
      const [{ createDaemonCliConfiguration }, { isDeclaredSecretBearingConfigKey }] = await Promise.all([
        import('./configuration.js'), import('@goodvibes-jev/engine/platform/platform/config'),
      ]);
      const configuration = createDaemonCliConfiguration(cli.flags, env, options.cwd, { diagnosticMode: 'structural' });
      const withheld = configuration.config.getIngestionQuarantine()
        .filter((entry) => isDeclaredSecretBearingConfigKey(entry.key));
      if (withheld.length) return refuse(`Configured credentials were withheld: ${[...new Set(withheld.map((entry) => entry.key))].join(', ')}. Nothing was sent.`);
      const { readAllStdin } = await import('../daemon/send/stdin.js');
      return result(await runPreparedSendCommand(prepared.args, {
        configManager: configuration.config, readStdin: readAllStdin, stdinIsTty: process.stdin.isTTY === true,
        deliver: async (request) => {
          const { createSendStack } = await import('../daemon/send/composition.js');
          return createSendStack(configuration).deliver(request);
        },
      }));
    }
    const needsRuntime = ['serve', 'install-service', 'start-service', 'restart-service'].includes(cli.command);
    const runtime = options.runtime ?? (needsRuntime ? await options.createRuntime?.() : undefined);
    if (cli.command === 'serve' && typeof runtime?.inboxFactory !== 'function') return refuse(PARTIAL);
    let serviceExecutable: ShippedServiceExecutable | undefined;
    if (['install-service', 'start-service', 'restart-service'].includes(cli.command)) {
      if (typeof runtime?.inboxFactory !== 'function') return refuse(PARTIAL);
      serviceExecutable = await options.resolveServiceExecutable?.();
      if (!serviceExecutable && !options.serviceBinaryPath) return refuse(`${PARTIAL} Service activation requires an explicitly composed executable.`);
      serviceExecutable?.assertCurrent();
    }

    if (cli.command === 'provision-wake-model') {
      if (cli.commandArgs.some((arg) => arg === '--help' || arg === '-h')) return result({ exitCode: 0, lines: [renderDaemonCommandHelp(cli.command)!] });
      if (cli.commandArgs.some((arg) => arg !== '--strict')) return refuse('Usage: goodvibes-daemon provision-wake-model [--strict] [--help]');
      const [{ resolveDaemonCliOwnership }, { runProvisionWakeModelCommand }] = await Promise.all([
        import('./configuration.js'), import('../daemon/provision-wake-model.js'),
      ]);
      const { homeDirectory } = resolveDaemonCliOwnership(cli.flags, env, options.cwd);
      // Provisioning and service commands preserve their stdout receipt even when
      // a nonzero status carries a degraded/absent state.
      return result(await runProvisionWakeModelCommand(cli.commandArgs, { homeDirectory, env }), stdout);
    }
    if (cli.command === 'webui' && cli.commandArgs.includes('--json')) {
      // Machine discovery is an inspection: no migration, settings bootstrap,
      // network transport, runtime composition, token acquisition or listener.
      const [{ createDaemonCliConfiguration }, { runWebuiCommand }] = await Promise.all([
        import('./configuration.js'), import('../daemon/webui-command.js'),
      ]);
      const configuration = createDaemonCliConfiguration(cli.flags, env, options.cwd, { readOnly: true, diagnosticMode: 'structural' });
      return result(runWebuiCommand(cli.commandArgs, { configManager: configuration.config, baseDirectory: configuration.workingDirectory }));
    }
    const [{ createDaemonCliConfiguration }, { createDaemonCommandRemote }] = await Promise.all([
      import('./configuration.js'), import('../daemon/remote-transport.js'),
    ]);
    const configuration = createDaemonCliConfiguration(cli.flags, env, options.cwd,
      // A malformed settings file can hold a credential at the parse error; every command withholds it from its diagnostics.
      cli.command === 'serve' || cli.command === 'mcp' ? { readOnly: true, diagnosticMode: 'structural' } : { diagnosticMode: 'structural' });
    const { config, homeDirectory, daemonHomeDirectory, workingDirectory } = configuration;
    const remoteFlags = { host: cli.flags.host, port: cli.flags.port, token: cli.flags.token, json: cli.flags.json };
    const remote = createDaemonCommandRemote({ configManager: config, daemonHomeDir: daemonHomeDirectory, controlPlaneConfigDir: config.getControlPlaneConfigDir() });
    switch (cli.command) {
      case 'config': {
        const [{ runConfigCommand }, { createRuntimeSecretsManager }] = await Promise.all([
          import('../daemon/config-command.js'), import('@goodvibes-jev/engine/platform/platform/config'),
        ]);
        return result(await runConfigCommand(cli.commandArgs, { configManager: config, json: cli.flags.json,
          openSecretStore: () => createRuntimeSecretsManager({ projectRoot: workingDirectory, globalHome: homeDirectory,
            surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT, daemonHome: daemonHomeDirectory, configManager: config, diagnosticMode: 'structural' }) }));
      }
      case 'status': {
        const [{ runStatusCommand }, { surfaceCrashLogPath }] = await Promise.all([
          import('../daemon/status-command.js'), import('@goodvibes-jev/engine/platform/platform/runtime/operations'),
        ]);
        return result(await runStatusCommand({ ...remote, flags: remoteFlags,
          crashLogPath: surfaceCrashLogPath(homeDirectory, GOODVIBES_DAEMON_SURFACE_ROOT) }));
      }
      case 'update': {
        const { runUpdateCommand } = await import('../daemon/status-command.js');
        return result(await runUpdateCommand({ ...remote, flags: { ...remoteFlags, check: cli.flags.check } }));
      }
      case 'sessions': {
        const { runSessionsCommand } = await import('../daemon/sessions-command.js');
        return result(await runSessionsCommand({ ...remote, flags: { ...remoteFlags, all: cli.flags.all }, args: cli.commandArgs }));
      }
      case 'pair': {
        const [{ runPairCommand }, { readOperatorTokenFile }, { readLegacySharedRevoked }, { controlPlaneStorePath }, { createShellPathService }] = await Promise.all([
          import('../daemon/pair-command.js'),
          import('@goodvibes-jev/engine/platform/platform/workspace'),
          import('@goodvibes-jev/engine/platform/platform/pairing'),
          import('@goodvibes-jev/engine/platform/platform/control-plane'),
          import('@goodvibes-jev/engine/platform/platform/runtime/shell'),
        ]);
        return result(await runPairCommand({ ...remote,
          version: VERSION, readToken: readOperatorTokenFile, operatorToken: env.GOODVIBES_DAEMON_TOKEN?.trim() ? env.GOODVIBES_DAEMON_TOKEN : undefined,
          sharedTokenRevoked: () => readLegacySharedRevoked(controlPlaneStorePath(createShellPathService({ workingDirectory, homeDirectory }),
            GOODVIBES_DAEMON_SURFACE_ROOT, 'pairing-tokens.json')),
          flags: { ...remoteFlags, yes: cli.flags.yes } }));
      }
      case 'mcp': {
        const { runMcpCommand } = await import('../daemon/mcp-command.js');
        return await runMcpCommand({ configManager: config, daemonHomeDir: daemonHomeDirectory,
          flags: { ...remoteFlags, categories: cli.flags.categories, allowWrite: cli.flags.allowWrite, allowDestructive: cli.flags.allowDestructive }, args: cli.commandArgs, stderr, fetchImpl: remote.fetchImpl,
          input: options.mcpStdio?.input ?? process.stdin, output: options.mcpStdio?.output ?? process.stdout });
      }
      case 'webui': {
        const { runWebuiCommand } = await import('../daemon/webui-command.js');
        return result(runWebuiCommand(cli.commandArgs, { configManager: config, baseDirectory: workingDirectory }));
      }
      case 'cluster': {
        const { runClusterCommand } = await import('@goodvibes-jev/engine/terminal-shell/cluster-commands');
        const answer = await runClusterCommand({ argv: cli.commandArgs, configManager: config, daemonHomeDir: daemonHomeDirectory, fetchImpl: remote.fetchImpl });
        if (answer.rawOutput) stdout(answer.rawOutput);
        return result(answer);
      }
      case 'serve': {
        const { prepareDaemonCliServe, runConfiguredDaemonCli } = await import('./serve.js');
        const errors = prepareDaemonCliServe(config, cli.flags);
        if (errors.length) return result({ exitCode: 2, lines: errors });
        const [{ repairDaemonSuiteBeforeStartup }, { installProcessCrashCapture, surfaceCrashLogPath }] = await Promise.all([
          import('./startup-suite-repair.js'),
          import('@goodvibes-jev/engine/platform/platform/runtime/operations'),
        ]);
        const originalArgv = [...argv];
        const releaseCrashCapture = options.captureCrashes === true ? installProcessCrashCapture({
          surface: 'daemon', version: VERSION, writeStderr: stderr,
          crashLogPath: surfaceCrashLogPath(configuration.homeDirectory, GOODVIBES_DAEMON_SURFACE_ROOT),
        }) : undefined;
        const processHandle = runConfiguredDaemonCli(configuration, runtime!, env, options.process, stderr, stdout, options.pairingOutput,
          async signal => {
            if (await repairDaemonSuiteBeforeStartup({ configuration, argv: originalArgv, env, signal, print: stdout })) return null;
            signal.throwIfAborted();
            const active = createDaemonCliConfiguration(cli.flags, env, options.cwd, { diagnosticMode: 'structural' });
            const currentErrors = prepareDaemonCliServe(active.config, cli.flags);
            if (currentErrors.length) throw new Error('Daemon serving configuration changed before activation');
            signal.throwIfAborted(); return active;
          });
        try { return await processHandle.finished; }
        finally { releaseCrashCapture?.(); }
      }
      default: {
        const { isDaemonServiceSubcommand, runDaemonServiceCli, resolveInstalledDaemonBinary } = await import('../daemon/service-commands.js');
        if (!isDaemonServiceSubcommand(cli.command)) return refuse('This command has no migrated dispatcher.');
        const servicePlatform = config.get('service.platform');
        if (configuration.isOverridden && ['install-service', 'start-service', 'restart-service'].includes(cli.command)
          && servicePlatform !== 'systemd' && !(servicePlatform === 'auto' && process.platform === 'linux')) {
          return refuse('Service activation with selected tree or daemon homes currently requires systemd. No service was changed.');
        }
        serviceExecutable?.assertCurrent();
        return result(await runDaemonServiceCli({ subcommand: cli.command,
          binaryPath: serviceExecutable?.binaryPath ?? options.serviceBinaryPath ?? resolveInstalledDaemonBinary({ moduleUrl: import.meta.url }),
          ...(serviceExecutable ? { assertCurrent: serviceExecutable.assertCurrent } : {}),
          configManager: config, homeDir: homeDirectory, daemonHomeDirectory, unitHomeDir: env.HOME?.trim() || homedir(), workingDirectory,
          requireInstalledDefinitionMatch: configuration.isOverridden || cli.flags.workingDir !== undefined
            || env.GOODVIBES_WORKING_DIR !== undefined, actionRunner: options.serviceActionRunner,
          json: cli.flags.json,
        }), stdout);
      }
    }
  } catch (error) {
    // Do not render arbitrary config, transport, plugin or credential exceptions.
    for (const line of daemonCommandFailureLines(error)) stderr(line);
    return 1;
  }
}
