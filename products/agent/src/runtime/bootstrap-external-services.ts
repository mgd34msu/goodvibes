import { createPendingHostServices } from '@goodvibes/engine/terminal-shell/host-service-status';
import {
  pendingHostServiceStatus,
  hostServiceIsActive,
  hostServiceIsBlocked,
} from '@goodvibes/engine/terminal-shell/host-service-status';
/**
 * Connected-host (daemon + HTTP listener) discovery for GoodVibes Agent.
 *
 * Discovery routes through the platform's host services, which only adopt:
 * a reachable, version-compatible daemon is adopted and anything else (absent,
 * blocked, or on an incompatible wire version) is reported honestly. The
 * Agent never spawns or embeds a daemon of its own and never restarts a
 * running one. One bounded exception: when discovery finds nothing on the
 * configured port but the daemon's service entry IS installed on this
 * machine, the Agent starts it once through the platform service manager,
 * waits a bounded time, re-probes and reports what it did. The controller's
 * `daemon` member is that same path, offered to the repair in
 * runtime/daemon-repair.ts, so a repair ends with the daemon adopted here.
 */
import { startExternalServices } from '@/runtime/index.ts';
import {
  autostartInstalledDaemon,
  createDaemonServiceControl,
  type DaemonServiceControl,
} from '@goodvibes/engine/platform/platform/runtime/client';
import type { SpineReachability } from '@goodvibes/engine/platform/platform/runtime/session-spine';
import type {
  DeferredStartupCoordinator,
  ExternalServicesHandle,
  HostServiceStatus,
  HostServicesConfig,
  RuntimeEventBus,
} from '@/runtime/index.ts';
import type { HookDispatcher } from '@goodvibes/engine/platform/platform/hooks';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { DAEMON_INSTALL_COMMAND, DAEMON_START_COMMAND, readDaemonServiceState, type DaemonHost, type DaemonBringUpResult } from './daemon-repair.ts';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import type { RuntimeServices } from './services.ts';
import type { UiRuntimeServices } from './ui-services.ts';
import { connectedHostBaseUrl } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-dial';
import { firstShowingOfSettingsNotice } from '@goodvibes/engine/terminal-shell/cli-config-overrides';

/**
 * This is a PROBE address, so it goes through the same wildcard→loopback
 * mapping every other dial site uses (config/connected-host-dial.ts) rather
 * than keeping a second, subtly different copy of it.
 */
function formatHostServiceBaseUrl(host: string, port: number): string {
  return connectedHostBaseUrl(host, port);
}

// Pending status shown before the deferred probe completes, honest
// 'unavailable', never a guessed 'external'.
function createPendingServiceStatus(configManager: HostServicesConfig, service: 'daemon' | 'httpListener'): HostServiceStatus {
  return pendingHostServiceStatus(configManager, service, {
    url: formatHostServiceBaseUrl,
    reason: 'Connected-host discovery has not completed yet',
  });
}

// 'blocked' (occupied by an unverified process) and 'incompatible' (a
// GoodVibes daemon on a wire-version band this Agent build refuses to adopt)
// both mean the configured port is held and unusable by this instance.

export interface AgentExternalServicesController {
  /** The most recently resolved (or pending) connected-host status. */
  getStatus(): ExternalServicesHandle;
  /**
   * Resolves once the deferred boot discovery (including any boot-time start
   * of an installed-but-stopped host) has settled. Later probes that reuse
   * the daemon's reachability (session/memory spine adoption) await this so
   * they see the post-discovery daemon state instead of racing it.
   */
  whenDiscovered(): Promise<void>;
  /** The daemon's service state and its bring-up (re-probe, autostart, adopt), for the repair. */
  readonly daemon: DaemonHost;
  stop(): Promise<void>;
}

/** Test seams for the boot-time start of an installed-but-stopped host. */
export interface ConnectedHostAutostartSeams {
  readonly control?: DaemonServiceControl;
  readonly probeReachability?: () => Promise<SpineReachability>;
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function wireAgentExternalServices(options: {
  readonly configManager: HostServicesConfig;
  /** Not read: host discovery publishes nothing on the bus. Accepted from existing callers. */
  readonly runtimeBus?: RuntimeEventBus;
  readonly hookDispatcher: HookDispatcher;
  readonly services: RuntimeServices;
  readonly uiServices: UiRuntimeServices;
  readonly deferredStartup: DeferredStartupCoordinator;
  readonly systemMessageRouter: SystemMessageRouter;
  readonly requestRender: () => void;
  /** Injectable discovery implementation (tests); defaults to the platform-shared policy. */
  readonly startServices?: typeof startExternalServices;
  readonly connectedHostAutostart?: ConnectedHostAutostartSeams;
}): AgentExternalServicesController {
  const { configManager, hookDispatcher, services, uiServices, deferredStartup, systemMessageRouter, requestRender } = options;
  const startServices = options.startServices ?? startExternalServices;

  // Connected-host honesty receipts ("updated from X to Y", "restarted after
  // a crash at HH:MM", settings migrations) captured off the once-per-attach
  // receipt-reading /status read (bootstrap.ts's memory-spine onAttach, peek
  // then acknowledge): delivery at the daemon is once-only, so every captured receipt renders here, buffered ones from before
  // this sink attaches flush immediately.
  services.daemonReceiptFeed.attach((receipt) => {
    // A settings notice this Agent already showed for the same file and key (one formatter writes both) is said once.
    if (!firstShowingOfSettingsNotice(receipt.text)) return;
    systemMessageRouter.high(`[Connected host] ${receipt.text}`);
    requestRender();
  });

  // Idle-time memory-consolidation run receipts (services.ts's local
  // scheduler): the SAME buffered-until-attach, exactly-once idiom as the
  // connected-host receipts just above, on its own feed so a local
  // consolidation run is never mislabeled "[Connected host]".
  services.memoryConsolidationReceiptFeed.attach((receipt) => {
    systemMessageRouter.high(`[Memory] ${receipt.text}`);
    requestRender();
  });

  const inspectAgentDependencies = () => {
    const daemonStatus = externalServices.daemonStatus;
    const httpListenerStatus = externalServices.httpListenerStatus;
    return {
      connectedHostRunning: hostServiceIsActive(daemonStatus),
      connectedHostPortInUse: hostServiceIsBlocked(daemonStatus),
      httpListenerRunning: hostServiceIsActive(httpListenerStatus),
      httpListenerPortInUse: hostServiceIsBlocked(httpListenerStatus),
      connectedHostStatus: daemonStatus,
      httpListenerStatus,
    };
  };

  let externalServices: ExternalServicesHandle = createPendingHostServices((name) => createPendingServiceStatus(configManager, name));
  let externalServicesPromise: Promise<ExternalServicesHandle> | null = null;

  // Deliberately NOT passing the daemon facade's `updateArtifact` identity
  // ({version, execPath}): the agent never constructs or embeds
  // a DaemonServer, so there is no daemon-side hourly update loop here to feed
  //, absent means host-managed, which is exactly the agent's stance toward
  // whichever host it adopts. The agent's OWN binary updates at launch through
  // its launch auto-update path instead (src/cli/launch-auto-update.ts).
  const startAgentExternalServices = (): Promise<ExternalServicesHandle> =>
    // The daemon-grade view, because this platform entry point still takes that
    // whole shape. It reads `localUserAuthManager` and `configManager` and never
    // constructs a DaemonServer, see the view's own doc comment in
    // runtime/services.ts for exactly which two members it substitutes and why
    // neither is dereferenced here.
    startServices(configManager, hookDispatcher, services.asDaemonGradeView());

  // The boot discovery, the boot-time autostart and `restart()` each replace the
  // adopted handle. Every replacement goes through here: the latest START wins (a
  // slower earlier completion is stopped and discarded, never allowed to overwrite
  // the newer status), and the handle it replaces is stopped, not dropped.
  let startGeneration = 0;
  const stopQuietly = async (handle: ExternalServicesHandle): Promise<void> => {
    try {
      await handle.stop();
    } catch (error) {
      logger.debug('Stopping a replaced connected-host handle failed', { error: summarizeError(error) });
    }
  };
  const replaceExternalServices = async (replaceOptions: { readonly previousAlreadyStopped?: boolean } = {}): Promise<ExternalServicesHandle> => {
    const mine = ++startGeneration;
    const pending = startAgentExternalServices();
    externalServicesPromise = pending;
    const handle = await pending;
    if (mine !== startGeneration) {
      await stopQuietly(handle);
      return (await externalServicesPromise) ?? handle;
    }
    const previous = externalServices;
    externalServices = handle;
    if (previous !== handle && !replaceOptions.previousAlreadyStopped) await stopQuietly(previous);
    return handle;
  };

  // One service query and one starter, shared by the boot-time start and the
  // repair's bring-up. Built on first use: a machine whose daemon answers at
  // boot never needs it.
  let serviceControl: DaemonServiceControl | null = null;
  const daemonServiceControl = (): DaemonServiceControl => {
    // The service's unit and pid file live under the login home the control
    // resolves, not this app's tree home.
    serviceControl ??= options.connectedHostAutostart?.control ?? createDaemonServiceControl({
      configManager: services.configManager,
      workingDirectory: services.workingDirectory,
    });
    return serviceControl;
  };

  // Start of an installed-but-stopped host: when discovery found nothing on
  // the configured port, start the installed service entry once, wait a
  // bounded time, and re-probe. Every skip/failure path is reported.
  const startInstalledConnectedHost = async (): Promise<DaemonBringUpResult & { readonly level: 'low' | 'high' | null }> => {
    const seams = options.connectedHostAutostart ?? {};
    const probeReachability = seams.probeReachability ?? (() => services.sessionSpineClient.probeReachability());
    const outcome = await autostartInstalledDaemon({
      daemonMode: externalServices.daemonStatus.mode,
      control: daemonServiceControl(),
      isReachable: async () => (await probeReachability()) === 'online',
      waitTimeoutMs: seams.waitTimeoutMs,
      pollIntervalMs: seams.pollIntervalMs,
      sleep: seams.sleep,
    });
    switch (outcome.action) {
      case 'started':
      case 'came-online': {
        const settled = await replaceExternalServices();
        const adopted = settled.daemonStatus.mode === 'external';
        const suffix = adopted
          ? ''
          : `, but adopting it still failed: ${settled.daemonStatus.reason ?? settled.daemonStatus.mode}`;
        return {
          answered: adopted,
          level: 'low',
          detail: outcome.action === 'started'
            ? `Connected host was installed but stopped; started it (service "${outcome.serviceName}")${suffix}`
            : `Connected host service "${outcome.serviceName}" was already starting; connected once it answered${suffix}`,
        };
      }
      case 'start-failed':
        return {
          answered: false,
          level: 'high',
          detail: `Connected host is installed but not answering, and starting it did not succeed: ${outcome.reason}. Start it with: ${DAEMON_START_COMMAND}`,
        };
      case 'not-installed':
        // Said at start-up: without it every host-backed feature fails one at a time with no reason given.
        return { answered: false, level: 'high', detail: `No GoodVibes host is running and no daemon service is installed on this machine, so host-backed features are off. Install and start it with: ${DAEMON_INSTALL_COMMAND}` };
      case 'none':
        return {
          answered: outcome.reason === 'daemon-active',
          level: null,
          detail: outcome.reason === 'daemon-active' ? 'Connected to the running daemon' : `Nothing was started (${outcome.reason})`,
        };
    }
  };

  const maybeStartInstalledConnectedHost = async (): Promise<void> => {
    try {
      const result = await startInstalledConnectedHost();
      if (result.level === 'low') systemMessageRouter.low(`[Startup] ${result.detail}.`);
      if (result.level === 'high') systemMessageRouter.high(`[Startup] ${result.detail}`);
    } catch (error) {
      logger.debug('Boot-time connected-host start check failed', { error: summarizeError(error) });
    }
  };

  const daemon: DaemonHost = {
    serviceState: () => readDaemonServiceState(daemonServiceControl()),
    // Re-probe under the current settings (the repair has just turned
    // discovery back on), then the same start the boot path runs.
    bringUp: async () => {
      if (externalServicesPromise) {
        try {
          await externalServicesPromise;
        } catch {
          // A failed earlier discovery does not prevent this one.
        }
      }
      await replaceExternalServices();
      const result = await startInstalledConnectedHost();
      requestRender();
      return { answered: result.answered, detail: result.detail };
    },
  };

  const platformExternalServices = uiServices.platform as typeof uiServices.platform & {
    externalServices: NonNullable<typeof uiServices.platform.externalServices>;
  };
  platformExternalServices.externalServices = {
    inspect: inspectAgentDependencies,
    restart: async () => {
      if (externalServicesPromise) {
        try {
          externalServices = await externalServicesPromise;
        } catch {
          // A failed previous startup should not prevent a re-probe attempt.
        }
      }
      await externalServices.stop();
      await replaceExternalServices({ previousAlreadyStopped: true });
      systemMessageRouter.high(
        '[Startup] GoodVibes Agent re-probed the connected GoodVibes host and adopted its current status; this route never starts or restarts the host itself.',
      );
      requestRender();
      return inspectAgentDependencies();
    },
  };

  // Connected-host discovery OFF the interactive path: probe the configured
  // host/port through the platform's adopt-only host services (the Agent
  // never spawns or embeds a daemon) and replace the pending status with an honest
  // one (adopted, incompatible, blocked, or unavailable). An unavailable
  // daemon then gets the one bounded installed-but-stopped start check.
  const discoveryComplete = deferredStartup.schedule({
    label: 'external-services',
    run: async () => {
      await replaceExternalServices();
      await maybeStartInstalledConnectedHost();
      requestRender();
    },
    onError: (error) => {
      const message = summarizeError(error);
      logger.error('Deferred connected-host discovery failed', { error: message });
      systemMessageRouter.high(`[Startup] Connected-host discovery failed: ${message}`, 'error');
      requestRender();
    },
  });

  return {
    getStatus: () => externalServices,
    whenDiscovered: () => discoveryComplete,
    daemon,
    stop: async () => {
      await externalServices.stop();
    },
  };
}
