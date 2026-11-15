import { createPendingHostServices } from '@goodvibes-jev/engine/terminal-shell/host-service-status';
import {
  pendingHostServiceStatus,
  hostServiceIsActive,
  hostServiceIsBlocked,
} from '@goodvibes-jev/engine/terminal-shell/host-service-status';
/**
 * Connected-host (daemon + HTTP listener) discovery for GoodVibes Agent.
 *
 * Split out of bootstrap.ts (which is near the 800-line architecture cap) to
 * keep this concern, and the Agent's daemon-lifecycle boundary, in one
 * small, readable place.
 *
 * Discovery routes through the platform-shared adopt-or-spawn policy
 * (decideDaemonAdoption/classifyDaemonProbe) with `adoptOnly: true`, so a
 * reachable, version-compatible daemon is adopted and anything else (absent,
 * blocked, or on an incompatible wire version) is reported honestly. The
 * Agent never spawns or embeds a daemon of its own and never restarts a
 * running one. One bounded exception at boot: when discovery finds nothing
 * on the configured port but the host's service entry IS installed on this
 * machine, the Agent issues a single start through the platform service
 * manager, waits a bounded time for the daemon to answer, re-probes, and
 * reports what it did (the platform's autostartInstalledDaemon decides and acts;
 * the wording below is the Agent's). A machine with the host installed but
 * stopped must not hand the user homework.
 */
import { startExternalServices } from '@/runtime/index.ts';
import {
  autostartInstalledDaemon,
  createDaemonServiceControl,
  type DaemonServiceControl,
} from '@goodvibes-jev/engine/platform/platform/runtime/client';
import type { SpineReachability } from '@goodvibes-jev/engine/platform/platform/runtime/session-spine';
import type {
  DeferredStartupCoordinator,
  ExternalServicesHandle,
  HostServiceStatus,
  HostServicesConfig,
  RuntimeEventBus,
} from '@/runtime/index.ts';
import type { HookDispatcher } from '@goodvibes-jev/engine/platform/platform/hooks';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import type { RuntimeServices } from './services.ts';
import type { UiRuntimeServices } from './ui-services.ts';
import { connectedHostBaseUrl } from '../config/connected-host-dial.ts';

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
  readonly runtimeBus: RuntimeEventBus;
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
  const { configManager, runtimeBus, hookDispatcher, services, uiServices, deferredStartup, systemMessageRouter, requestRender } = options;
  const startServices = options.startServices ?? startExternalServices;

  // Connected-host honesty receipts ("updated from X to Y", "restarted after
  // a crash at HH:MM", settings migrations) captured off the once-per-attach
  // receipt-reading /status read (bootstrap.ts's memory-spine onAttach, peek
  // then acknowledge): delivery at the daemon is once-only, so every captured receipt renders here, buffered ones from before
  // this sink attaches flush immediately.
  services.daemonReceiptFeed.attach((receipt) => {
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
  // ({version, execPath}): with adoptOnly the agent never constructs or embeds
  // a DaemonServer, so there is no daemon-side hourly update loop here to feed
  //, absent means host-managed, which is exactly the agent's stance toward
  // whichever host it adopts. The agent's OWN binary updates at launch through
  // its launch auto-update path instead (src/cli/launch-auto-update.ts).
  const startAgentExternalServices = (): Promise<ExternalServicesHandle> =>
    // The daemon-grade view, because this platform entry point still takes that
    // whole shape. Under `adoptOnly: true` it reads `localUserAuthManager` and
    // `configManager` and never constructs a DaemonServer, see the view's own
    // doc comment in runtime/services.ts for exactly which two members it
    // substitutes and why neither is dereferenced here.
    startServices(configManager, runtimeBus, hookDispatcher, services.asDaemonGradeView(), { adoptOnly: true });

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

  // Boot-time start of an installed-but-stopped host: when discovery found
  // nothing on the configured port, check the platform service manager for an
  // installed host entry, start it once, wait a bounded time, and re-probe.
  // Every skip/failure path is honest; errors here never break discovery.
  const maybeStartInstalledConnectedHost = async (): Promise<void> => {
    const seams = options.connectedHostAutostart ?? {};
    try {
      const probeReachability = seams.probeReachability ?? (() => services.sessionSpineClient.probeReachability());
      const outcome = await autostartInstalledDaemon({
        daemonMode: externalServices.daemonStatus.mode,
        control:
          seams.control ??
          createDaemonServiceControl({
            configManager: services.configManager,
            workingDirectory: services.workingDirectory,
            homeDirectory: services.homeDirectory,
          }),
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
          systemMessageRouter.low(
            outcome.action === 'started'
              ? `[Startup] Connected host was installed but stopped; started it (service "${outcome.serviceName}")${suffix}.`
              : `[Startup] Connected host service "${outcome.serviceName}" was already starting; connected once it answered${suffix}.`,
          );
          break;
        }
        case 'start-failed': {
          systemMessageRouter.high(
            `[Startup] Connected host is installed but not answering, and starting it did not succeed: ${outcome.reason}. Start it manually with: goodvibes service start`,
          );
          break;
        }
        case 'not-installed':
        case 'none':
          break;
      }
    } catch (error) {
      logger.debug('Boot-time connected-host start check failed', { error: summarizeError(error) });
    }
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
  // host/port through the shared adopt-or-spawn policy (adoptOnly, Agent
  // never spawns or embeds) and replace the pending status with an honest
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
      systemMessageRouter.high(`[Startup] Connected-host discovery failed: ${message}`);
      requestRender();
    },
  });

  return {
    getStatus: () => externalServices,
    whenDiscovered: () => discoveryComplete,
    stop: async () => {
      await externalServices.stop();
    },
  };
}
