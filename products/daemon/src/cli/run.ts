/** CLI dispatch without import-time startup. Adapted from the upstream daemon/cli. */
import { writeSync } from 'node:fs';
// Each command's module loads when that command is chosen, so `--version`,
// `--help` and `status` never load serving, MCP, cluster or service code.
import type { DaemonCommandResult } from '../daemon/status-command.js';
import type { ManagedServiceActionRunner } from '../daemon/service-commands.js';
import type { DaemonProcessOptions } from '../daemon/process-lifecycle.js';
import { VERSION } from '../version.js';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import { parseDaemonCli } from './parser.js';
import { applyDaemonHomeEnvironment } from './daemon-home-environment.js';
import { answersHelpFlag, renderGoodVibesDaemonHelp, renderDaemonCommandHelp, renderGoodVibesVersion, renderDaemonCliCatalog } from './help.js';
import { daemonCommandFailureLines } from './command-failure.js';
import { runCompletionCommand } from './completion.js';
import { daemonCommandSpec, isRawInterceptCommand } from './command-catalog.js';
import { isActivatingServiceSubcommand, isDaemonServiceSubcommand } from '../daemon/service-subcommands.js';
import { readEnvDaemonToken } from './daemon-tokens.js';
import type { DaemonCliRuntime } from './serve.js';
import type { ShippedServiceExecutable } from './service-executable.js';
import type { ChunkSink, ChunkSource } from '@goodvibes/engine/platform/platform/mcp/server';

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
  // Whether the caller asked for a JSON document. Until the arguments parse, a
  // raw scan decides; after, the parsed flag or a passthrough command's own `--json`.
  let jsonRequested = argv.includes('--json');
  // Every failure a --json caller gets is one document on stdout, the same
  // {ok:false, code, error, fix} envelope the commands' own failures use.
  const failure = (exitCode: number, code: string, error: string, fix: string, prose: readonly string[]): number => (jsonRequested
    ? result({ exitCode, lines: [JSON.stringify({ ok: false, code, error, fix }, null, 2)] }, stdout)
    : result({ exitCode, lines: prose }));
  const refuse = (line: string): number => failure(2, 'COMMAND_REFUSED', line, 'see goodvibes-daemon --help', [line]);
  const env = options.env ?? process.env;
  try {
    const cli = parseDaemonCli(argv);
    if (cli.errors.length) {
      // The unit carries no endpoint flags, so the parser refuses these before dispatch; name the supported route.
      const endpointFlag = cli.command === 'install-service'
        && cli.refusedFlags.some((flag) => flag === '--port' || flag === '--hostname');
      const endpointLines = endpointFlag ? ['The installed service reads controlPlane.host and controlPlane.port from settings each time it starts, so a flag here could never reach it.',
        `Set the persistent binding instead: goodvibes-daemon config set controlPlane.host <host> / controlPlane.port <port>, then run \`${cli.command}\` again.`] : [];
      return failure(2, 'PARSE_ERROR', cli.errors.join('; '), endpointLines.length ? endpointLines.join(' ') : 'see goodvibes-daemon --help',
        [...cli.errors, ...endpointLines, '', renderGoodVibesDaemonHelp()]);
    }
    jsonRequested = cli.flags.json || (isRawInterceptCommand(cli.command) && cli.commandArgs.includes('--json'));
    for (const warning of cli.warnings) stderr(`[goodvibes-daemon] warning: ${warning}`);
    // A moved daemon home is this daemon's whole tree, for every reader in this process.
    if (env === process.env) applyDaemonHomeEnvironment(cli.flags, options.cwd ?? process.cwd());
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
        import('./configuration.js'), import('@goodvibes/engine/platform/platform/config'),
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
    const activates = isActivatingServiceSubcommand(cli.command);
    const needsRuntime = cli.command === 'serve' || activates;
    const runtime = options.runtime ?? (needsRuntime ? await options.createRuntime?.() : undefined);
    if (cli.command === 'serve' && typeof runtime?.inboxFactory !== 'function') return refuse(PARTIAL);
    let serviceExecutable: ShippedServiceExecutable | undefined;
    // refresh-service writes the same launch install-service does, so it is admitted the same way.
    if (activates) {
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
    // `webui enable --json` writes settings and takes the full path below; only the status query is an inspection.
    if (cli.command === 'webui' && cli.commandArgs.includes('--json') && !cli.commandArgs.includes('enable')) {
      // Machine discovery is an inspection: no migration, settings bootstrap,
      // network transport, runtime composition, token acquisition or listener.
      const [{ createDaemonCliConfiguration }, { runWebuiCommand }] = await Promise.all([
        import('./configuration.js'), import('../daemon/webui-command.js'),
      ]);
      const configuration = createDaemonCliConfiguration(cli.flags, env, options.cwd, { readOnly: true, diagnosticMode: 'structural' });
      return result(runWebuiCommand(cli.commandArgs, { configManager: configuration.config, baseDirectory: configuration.workingDirectory }));
    }
    const [{ createDaemonCliConfiguration }, { createDaemonCommandRemote }, { readOperatorTokenFile }] = await Promise.all([
      import('./configuration.js'), import('../daemon/remote-transport.js'),
      import('@goodvibes/engine/platform/platform/workspace/daemon-home'),
    ]);
    const configuration = createDaemonCliConfiguration(cli.flags, env, options.cwd,
      // A malformed settings file can hold a credential at the parse error; every command withholds it from its diagnostics.
      cli.command === 'serve' || cli.command === 'mcp' ? { readOnly: true, diagnosticMode: 'structural' } : { diagnosticMode: 'structural' });
    const { config, homeDirectory, daemonHomeDirectory, workingDirectory } = configuration;
    const remoteFlags = { host: cli.flags.host, port: cli.flags.port, token: cli.flags.token, json: cli.flags.json };
    // This machine's operator token as the daemon serves it: the environment override first, as serve takes it.
    const envDaemonToken = readEnvDaemonToken(env);
    const remote = createDaemonCommandRemote({ configManager: config, daemonHomeDir: daemonHomeDirectory, controlPlaneConfigDir: config.getControlPlaneConfigDir(),
      readToken: (home) => envDaemonToken ?? readOperatorTokenFile(home) });
    switch (cli.command) {
      case 'config': {
        const [{ runConfigCommand }, { createRuntimeSecretsManager }] = await Promise.all([
          import('../daemon/config-command.js'), import('@goodvibes/engine/platform/platform/config'),
        ]);
        return result(await runConfigCommand(cli.commandArgs, { configManager: config, json: cli.flags.json,
          openSecretStore: () => createRuntimeSecretsManager({ projectRoot: workingDirectory, globalHome: homeDirectory,
            surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT, daemonHome: daemonHomeDirectory, configManager: config, diagnosticMode: 'structural' }) }));
      }
      case 'status': {
        const [{ runStatusCommand }, { surfaceCrashLogPath }] = await Promise.all([
          import('../daemon/status-command.js'), import('@goodvibes/engine/platform/platform/runtime/crash-capture'),
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
        const [{ runPairCommand }, { readLegacySharedRevoked, pairingOriginUsesStableHost, refreshStableHostInputs }, { controlPlaneStorePath }, { createShellPathService }] = await Promise.all([
          import('../daemon/pair-command.js'),
          import('@goodvibes/engine/platform/platform/pairing'),
          import('@goodvibes/engine/platform/platform/control-plane'),
          import('@goodvibes/engine/platform/platform/runtime/shell'),
        ]);
        // The Tailscale and `.local` rungs are slow facts gathered asynchronously;
        // without them this one-shot command would print the DHCP address while
        // the running daemon offers the stable name.
        if (pairingOriginUsesStableHost(config)) await refreshStableHostInputs();
        return result(await runPairCommand({ ...remote,
          version: VERSION,
          // A token the environment sets is not the stored shared token, so its revocation does not apply to it.
          sharedTokenRevoked: () => envDaemonToken === undefined && readLegacySharedRevoked(controlPlaneStorePath(createShellPathService({ workingDirectory, homeDirectory }),
            GOODVIBES_DAEMON_SURFACE_ROOT, 'pairing-tokens.json')),
          flags: { ...remoteFlags, yes: cli.flags.yes } }));
      }
      case 'mcp': {
        const { runMcpCommand } = await import('../daemon/mcp-command.js');
        return await runMcpCommand({ configManager: config, daemonHomeDir: daemonHomeDirectory,
          flags: { ...remoteFlags, categories: cli.flags.categories, allowWrite: cli.flags.allowWrite, allowDestructive: cli.flags.allowDestructive }, args: cli.commandArgs, stderr, fetchImpl: remote.fetchImpl, readToken: remote.readToken,
          input: options.mcpStdio?.input ?? process.stdin, output: options.mcpStdio?.output ?? process.stdout });
      }
      case 'webui': {
        const [{ runWebuiCommand }, { controlPlaneOriginUsesStableHost, refreshStableHostInputs }] = await Promise.all([
          import('../daemon/webui-command.js'), import('@goodvibes/engine/platform/platform/pairing'),
        ]);
        // `enable` and `status` print (and `enable` may save) the origin through
        // the stable-name ladder; gather its slow facts first so the Tailscale
        // and `.local` names are offered as the running daemon offers them.
        const args = cli.commandArgs;
        if (!args.includes('disable') && !args.includes('--loopback')
          && (args.includes('--lan') || controlPlaneOriginUsesStableHost(config))) await refreshStableHostInputs();
        return result(runWebuiCommand(cli.commandArgs, { configManager: config, baseDirectory: workingDirectory }));
      }
      case 'cluster': {
        const { runClusterCommand } = await import('@goodvibes/engine/terminal-shell/cluster-commands');
        const answer = await runClusterCommand({ argv: cli.commandArgs, configManager: config, daemonHomeDir: daemonHomeDirectory, fetchImpl: remote.fetchImpl, readToken: remote.readToken });
        if (answer.rawOutput) stdout(answer.rawOutput);
        return result(answer);
      }
      case 'serve': {
        const { prepareDaemonCliServe, runConfiguredDaemonCli } = await import('./serve.js');
        const errors = prepareDaemonCliServe(config, cli.flags);
        if (errors.length) return result({ exitCode: 2, lines: errors });
        const [{ repairDaemonSuiteBeforeStartup }, { installProcessCrashCapture, surfaceCrashLogPath }] = await Promise.all([
          import('./startup-suite-repair.js'),
          import('@goodvibes/engine/platform/platform/runtime/operations'),
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
          }, undefined, undefined,
          // A working-directory change moves the daemon in this process: the same homes and
          // command-line settings over the new root. The start option that chose the first root
          // is still named, since a later start uses it again.
          (workingDirectory) => {
            const moved = createDaemonCliConfiguration({ ...cli.flags, workingDir: workingDirectory }, env, options.cwd, { diagnosticMode: 'structural' });
            const movedErrors = prepareDaemonCliServe(moved.config, cli.flags);
            if (movedErrors.length) throw new Error(movedErrors.join('; '));
            return { ...moved, workingDirectoryOverride: configuration.workingDirectoryOverride };
          });
        try { return await processHandle.finished; }
        finally { releaseCrashCapture?.(); }
      }
      default: {
        const { runDaemonServiceCli, resolveInstalledDaemonBinary } = await import('../daemon/service-commands.js');
        const { resolveServiceUnitHome } = await import('@goodvibes/engine/platform/platform/daemon/daemon-service-default');
        if (!isDaemonServiceSubcommand(cli.command)) return refuse('This command has no migrated dispatcher.');
        // A daemon with a moved tree or daemon home needs a service manager whose
        // definition carries GOODVIBES_HOME and --daemon-home: a systemd unit
        // (Environment=) and a LaunchAgent (EnvironmentVariables) do. A Windows
        // scheduled task created by schtasks has no environment of its own, and
        // the manual platform has no service manager, so there it would start
        // with the default home and serve the wrong tree.
        const { detectPlatform } = await import('@goodvibes/engine/platform/platform/daemon/service-manager');
        const servicePlatform = detectPlatform(String(config.get('service.platform')));
        if (configuration.isOverridden && activates
          && servicePlatform !== 'systemd' && servicePlatform !== 'launchd') {
          return refuse(servicePlatform === 'windows'
            ? 'A daemon with a moved home (GOODVIBES_HOME, GOODVIBES_DAEMON_HOME or --daemon-home) cannot run as a Windows scheduled task: a task created by schtasks carries no environment variables, so it would start with the default home. No service was changed. Start this daemon by hand instead: goodvibes-daemon serve'
            : 'A daemon with a moved home (GOODVIBES_HOME, GOODVIBES_DAEMON_HOME or --daemon-home) cannot be installed on the manual service platform, which has no service manager to give it that home. No service was changed. Start this daemon by hand instead: goodvibes-daemon serve');
        }
        serviceExecutable?.assertCurrent();
        return result(await runDaemonServiceCli({ subcommand: cli.command,
          binaryPath: serviceExecutable?.binaryPath ?? options.serviceBinaryPath ?? resolveInstalledDaemonBinary({ moduleUrl: import.meta.url }),
          ...(serviceExecutable ? { assertCurrent: serviceExecutable.assertCurrent } : {}),
          configManager: config, homeDir: homeDirectory, daemonHomeDirectory, unitHomeDir: resolveServiceUnitHome(env), workingDirectory,
          workingDirectoryExplicit: cli.flags.workingDir !== undefined || env.GOODVIBES_WORKING_DIR !== undefined,
          requireInstalledDefinitionMatch: configuration.isOverridden || cli.flags.workingDir !== undefined
            || env.GOODVIBES_WORKING_DIR !== undefined, actionRunner: options.serviceActionRunner,
          json: cli.flags.json,
        }), stdout);
      }
    }
  } catch (error) {
    // Do not render arbitrary config, transport, plugin or credential exceptions.
    const lines = daemonCommandFailureLines(error);
    const reason = lines.slice(1).join(' ').replace(/^Reason: /, '');
    return failure(1, 'COMMAND_FAILED', reason, 'run goodvibes-daemon status, or see the daemon log', lines);
  }
}
