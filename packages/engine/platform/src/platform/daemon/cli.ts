import { prepareConfiguredProjectContext } from '../knowledge/project-planning/configured-project.js';
import { REGULAR_KNOWLEDGE_DB_FILE } from '../knowledge/store-config.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../config/manager.js';
import { resolveDaemonEnabled } from '../config/index.js';
import { RuntimeEventBus, configureRuntimeEventBusDefaults, runtimeEventBusOptionsFrom } from '../runtime/events/index.js';
import { createRuntimeStore } from '../runtime/store/index.js';
import { composeRuntimeServices } from '../runtime/services.js';
import { createHostPowerSeam } from '../power/runtime-wiring.js';
import { DaemonServer } from './facade.js';
import { createHostShutdown, settleDaemonStart } from './cli-shutdown.js';
import { HttpListener } from './http-listener.js';
import { resolveDaemonServiceDefault, resolveServiceUnitHome } from './daemon-service-default.js';
import { PlatformServiceManager } from './service-manager.js';
import { VERSION } from '../version.js';
import { configureActivityLogger, flushActivityLogSync, logger } from '../utils/logger.js';
import { GlobalNetworkTransportInstaller } from '../runtime/network/index.js';
import { summarizeError } from '../utils/error-display.js';
import { ensureDaemonHome, writeDaemonSetting } from '../workspace/daemon-home.js';
import { parseCliFlag, resolveDaemonCliPaths } from './cli-paths.js';
import { reportFatalBootFailure, writeExitingStdoutLine, writeFatalLine } from './fatal-boot-report.js';
import { readDaemonCliTokens } from './cli-tokens.js';
import { WorkspaceSwapManager } from '../workspace/workspace-swap-manager.js';

/**
 * The one-command service install: `goodvibes-daemon --install-service`
 * writes the service unit (with the survival contract) and reports the
 * follow-up commands, no raw HTTP call, no admin-token juggling. This is
 * what the detached-spawn hint names for setups where the daemon could not
 * promote itself.
 */
function installServiceAndExit(config: ConfigManager, workingDir: string): never {
  // The unit goes under the login home, never this process's GOODVIBES_HOME tree.
  const unitHome = resolveServiceUnitHome();
  const manager = new PlatformServiceManager(config, {
    workingDirectory: workingDir,
    homeDirectory: unitHome,
    binaryBaseName: 'goodvibes',
    defaultServiceName: resolveDaemonServiceDefault(),
    defaultServiceDescription: 'goodvibes omnichannel daemon host',
  });
  try {
    const result = manager.install();
    // Written synchronously: every line here is immediately followed by a
    // process exit, and a stream write can still be in flight when it lands.
    writeExitingStdoutLine(`service unit installed: ${result.path} (${result.serviceName}, ${result.platform})`);
    for (const command of result.suggestedCommands) writeExitingStdoutLine(`  next: ${command}`);
    if (result.lingerNote) writeExitingStdoutLine(result.lingerNote);
    process.exit(0);
  } catch (error) {
    writeFatalLine(`service install failed: ${summarizeError(error)}`);
    process.exit(1);
  }
}

/** How long a working-directory move waits for the answer to the request that asked for it to reach the caller. */
const MOVE_ANSWER_GRACE_MS = 100;

/** One host on one working directory: its listeners, services and the owner of its root. */
interface ServingHost {
  readonly workingDir: string;
  readonly swapManager: WorkspaceSwapManager;
  /** Stops the listeners; with `closeServices` the runtime services too (a move builds new ones). */
  stop(closeServices: boolean): Promise<void>;
}

async function main(): Promise<void> {
  const { workingDirectory: startWorkingDir, homeDirectory, daemonHomeDir, daemonTierPath } = resolveDaemonCliPaths();
  const startOverride = parseCliFlag(process.argv, '--working-dir') !== undefined ? '--working-dir'
    : process.env['GOODVIBES_WORKING_DIR'] ? 'GOODVIBES_WORKING_DIR' : undefined;
  const networkTransport = new GlobalNetworkTransportInstaller();
  let current: ServingHost | undefined;
  // Read through a call: `serve` sets it, which the narrowing of a local read would not see.
  const serving = (): ServingHost | undefined => current;
  let moveTarget: string | undefined;
  let moving: Promise<void> | undefined;

  // Declared before the daemon: a handover that stopped the runtime and then could not complete leaves this
  // process serving nothing, and a service manager restarts it only if it ends with a failure status.
  const shutdown = createHostShutdown(async () => {
    logger.info('goodvibes daemon host stopping');
    // A move under way sees `ending` at its next step and stops a host it built after this.
    moveTarget = undefined;
    await serving()?.stop(false);
  }, exitCode => {
    // Set exitCode rather than calling process.exit so that connection
    // drains can complete before the process terminates naturally. The log is
    // not left to that: it is written here, on this thread, because a shutdown
    // that then dies to a signal or a hung socket must still have said so.
    flushActivityLogSync();
    process.exitCode = exitCode;
  });
  let ending = false;
  const end = (exitCode?: number): Promise<void> => { ending = true; return shutdown(exitCode); };
  process.on('SIGINT', () => void end());
  process.on('SIGTERM', () => void end());

  // A working-directory change moves the whole host in this process: every
  // service stops and starts again on the new root, the listeners on the same address.
  const moveWorkspace = (workingDir: string): void => {
    moveTarget = workingDir;
    moving ??= new Promise<void>((resolve) => { setTimeout(resolve, MOVE_ANSWER_GRACE_MS); })
      .then(runMoves)
      .catch((error: unknown) => {
        logger.error('goodvibes daemon host could not move or start again', { error: summarizeError(error) });
        void end(1);
      })
      .finally(() => { moving = undefined; });
  };

  async function runMoves(): Promise<void> {
    for (let host = serving(); moveTarget !== undefined && !ending && host; host = serving()) {
      const target = moveTarget;
      moveTarget = undefined;
      const from = host.workingDir;
      logger.info('goodvibes daemon host moving', { from, to: target });
      await host.stop(true);
      current = undefined;
      let failure: string;
      try {
        if (await serve(target) === 'ended') return;
        serving()?.swapManager.announceArrival(from);
        continue;
      } catch (error) {
        failure = summarizeError(error);
      }
      // Back to the root it left, with the saved setting put back, so the daemon keeps serving.
      logger.error('goodvibes daemon host could not start in the new working directory; starting again in the previous one', { from, to: target, error: failure });
      await serving()?.stop(true).catch(() => undefined);
      current = undefined;
      try { writeDaemonSetting(daemonHomeDir, 'runtime.workingDir', from); }
      catch (error) { logger.warn('the saved working directory could not be put back', { workingDir: from, error: summarizeError(error) }); }
      if (await serve(from) === 'ended') return;
      serving()?.swapManager.announceReturn(target, failure);
    }
  }

  async function serve(workingDir: string): Promise<'serving' | 'ended'> {
    // Give the shared logger a destination before anything else runs.
    //
    // `logger` buffers into a file only once `configure()` has named one; until
    // then every info/warn/error in the whole platform is dropped on the floor.
    // The TUI and agent entrypoints both do this at startup, so the standalone
    // daemon was the ONE host where a delivery failure, a rejected bot token, or
    // an unroutable reply produced no record anywhere, which is precisely how a
    // dropped surface reply looked identical to a message that never arrived.
    configureActivityLogger(join(workingDir, '.goodvibes', 'logs'));
    // `--daemon-home` / `GOODVIBES_DAEMON_HOME` names the daemon's own state
    // directory (`~/.goodvibes/daemon` by default). It was parsed here and then
    // threaded only into the identity files, `ensureDaemonHome`, the operator
    // token path, while the ConfigManager derived its daemon tier from
    // `homedir()` regardless. So a daemon told to keep its state somewhere else
    // read its settings from the real home anyway, and the flag silently governed
    // half of what it names. daemon-config-tier.ts has always said a caller
    // honouring the flag should resolve the home first and use
    // `daemonConfigPathForHome`; this is that caller finally doing it.
    const config = new ConfigManager({
      workingDir,
      homeDir: homeDirectory,
      surfaceRoot: 'goodvibes',
      daemonTierPath,
      // The standalone daemon owns its settings store, so it is the process that
      // migrates that file on disk. Every client reads the same file and applies
      // migrations only to its own in-memory view.
      ownsDaemonTier: true,
    });
    if (process.argv.includes('--install-service')) {
      installServiceAndExit(config, workingDir);
    }
    networkTransport.install(config);
    // Point the bus listener cap at `runtime.eventBus.maxListeners` before the
    // first bus exists, so every bus this process builds later, including ones
    // built by components that hold no ConfigManager, uses the operator's number.
    configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) => config.get(key)));
    const runtimeBus = new RuntimeEventBus();

    ensureDaemonHome(daemonHomeDir);
    const runtimeStore = createRuntimeStore();
    await prepareConfiguredProjectContext(config, workingDir, REGULAR_KNOWLEDGE_DB_FILE, { activate: true });
    // The shipped daemon's choices: one trust owner in front of every ask this
    // daemon raises (an undecided workspace asks once, as an approval any attached
    // surface can answer), and the one home-scoped memory store every product opens.
    const runtimeServices = composeRuntimeServices({
      surface: 'daemon',
      roots: {
        surfaceRoot: 'goodvibes',
        workingDir,
        homeDirectory,
        // The same override, threaded into the credential store so it MOVES the
        // daemon-scoped secret tier too. runtime/secrets-composition.ts records
        // what happened while no composition root passed it: a throwaway daemon
        // given `--daemon-home /tmp/...` kept reading the owner's real secret
        // store, long-polled their real bot token, and stopped their inbound messages.
        daemonHome: daemonHomeDir,
      },
      memoryStore: 'home',
      workspaceTrust: 'surface',
      permissionHost: {},
      hostSeams: {
        configManager: config,
        runtimeBus,
        runtimeStore,
        getConversationTitle: () => 'goodvibes daemon',
        // Observes externally-launched coding-agent sessions on the host read-only
        // (fleet visibility + steer; never counted, never stopped).
        observeExternalAgents: true,
        // Owns the host sleep edge (work inhibition, keep-awake, sleep-edge
        // checkpoint/catch-up).
        powerSeam: createHostPowerSeam(),
      },
    });

    const userAuth = runtimeServices.localUserAuthManager;

    // The one owner of the working directory: a change moves this host once no session is mid-turn.
    const swapManager = new WorkspaceSwapManager(workingDir, {
      runtimeBus,
      daemonHomeDir,
      startOverride,
      moveHost: moveWorkspace,
      getBusySessionCount: () => runtimeServices.sessionBroker.countBusySessions(),
    });

    // The daemon CLI IS the platform-released artifact, so its update identity is
    // the platform release version and the running executable. Embedders never get
    // this default, they pass their own artifact identity (or none).
    const daemon = new DaemonServer({ runtimeBus, userAuth, runtimeServices, swapManager, updateArtifact: { version: VERSION },
      onIncompleteHandover: () => { void end(1).finally(() => process.exit(1)); } });
    const listener = new HttpListener({
      hookDispatcher: runtimeServices.hookDispatcher,
      userAuth,
      configManager: config,
      runtimeBus,
    });
    const { daemonToken, httpToken } = readDaemonCliTokens(process.env);

    daemon.enable({ daemon: true }, daemonToken);
    listener.enable({ httpListener: true }, httpToken);

    current = {
      workingDir,
      swapManager,
      async stop(closeServices: boolean): Promise<void> {
        swapManager.dispose();
        await Promise.allSettled([listener.stop(), daemon.stop()]);
        if (closeServices) await runtimeServices.close();
      },
    };

    const [startOutcome] = await Promise.all([
      daemon.start(),
      config.get('danger.httpListener') ? listener.start() : Promise.resolve(),
    ]);
    if (await settleDaemonStart(startOutcome, end, message => logger.error(message)) === 'ended') return 'ended';
    if (ending) {
      // The process began to stop while this host was being built (during a move).
      await serving()?.stop(false);
      return 'ended';
    }

    logger.info('goodvibes daemon host started', {
      daemon: resolveDaemonEnabled(config),
      httpListener: config.get('danger.httpListener'),
      workingDir,
      daemonHomeDir,
    });
    return 'serving';
  }

  await serve(startWorkingDir);
}

void main().catch(async (error) => {
  // A daemon that dies during startup must leave the reason where an operator
  // will actually find it: on the file descriptor the service journal is
  // attached to, written synchronously, BEFORE the activity log is attempted.
  // Doing it the other way round is what shipped mute, see fatal-boot-report.ts.
  reportFatalBootFailure(error);
  process.exit(1);
});
