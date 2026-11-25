/**
 * The Agent's provider start-up pass, and the network scan it no longer runs.
 *
 * The platform's start-up pass (`startBackgroundProviderRegistration` in
 * `@goodvibes/engine/platform/platform/runtime`) registers the providers whose
 * API key is in the environment, restores the model servers an earlier session
 * found on this computer, and scans this computer for model servers. The Agent
 * runs it at every start, for this computer only.
 *
 * Scanning the local network (the other devices on your subnet) is the
 * daemon's: one decision, held by the daemon, and the daemon's scan
 * (platform discovery/network-scan.ts; the Devices and network place turns it on
 * and off). A 3.5.0 Agent kept that decision in its own folder; the daemon
 * carries it once and the Agent's file is left as it is. When the daemon's
 * decision is on, the servers its scans found on the network are registered
 * here too, read from the daemon (`network-scan.status`).
 *
 * The platform reports what it found as data; this file words it, one summary
 * line per outcome, never a host:port per server.
 */
import {
  startBackgroundProviderRegistration,
  type BackgroundProviderDiscoveryOptions,
  type BackgroundRuntimeTaskHandle,
  type HostSystemMessageSink,
} from '@/runtime/index.ts';
import type { ProviderDiscoveryReporter } from '@goodvibes/engine/platform/platform/runtime/bootstrap';
import type { DiscoveredServer } from '@goodvibes/engine/platform/platform/discovery';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { logger } from '@goodvibes/engine/platform/platform/utils';
import { createAgentDaemonVerbCaller } from './client/daemon-verbs.ts';
import type { ConsentRoots } from './lan-scan-consent-store.ts';

export {
  agentTrustsScannedServer,
  discoveredProvidersFilePath,
} from './lan-scan-consent-store.ts';

// ── Wording the platform's report ───────────────────────────────────────

const servers = (count: number): string => `${count} model server${count === 1 ? '' : 's'}`;

function reporterFor(router: HostSystemMessageSink): ProviderDiscoveryReporter {
  return {
    restored({ registered }) {
      if (registered.length > 0) router.low(`[Local] ${servers(registered.length)} from the last session registered as providers; Models and providers lists them.`);
    },
    scanned({ found, kept, skipped }) {
      if (found.length > 0) router.low(`[Scan] Discovered ${servers(found.length)} on this computer; Models and providers lists them.`);
      if (kept.length > 0) router.low(`[Scan] ${servers(kept.length)} saved earlier did not answer this scan; ${kept.length === 1 ? 'it is' : 'they are'} kept.`);
      for (const server of skipped) router.low(`[Scan] ${server.host}:${server.port} answered but was left out: ${server.reason}`);
    },
  };
}

export interface LanScanGateOptions extends BackgroundProviderDiscoveryOptions {
  readonly shellPaths: BackgroundProviderDiscoveryOptions['shellPaths'] & ConsentRoots;
  /**
   * Injectable seam for tests. Defaults to the real platform pass
   * (`startBackgroundProviderRegistration`). Tests must supply a fake here
   * instead of exercising the real network, never let a test fall through to
   * the default.
   */
  readonly startDiscovery?: (opts: BackgroundProviderDiscoveryOptions) => BackgroundRuntimeTaskHandle;
}

/** The options the start-up pass ran with, so first run's "look again" can scan this computer again. */
let lastGateOptions: LanScanGateOptions | null = null;

function startPass(options: LanScanGateOptions): BackgroundRuntimeTaskHandle {
  const { startDiscovery = startBackgroundProviderRegistration } = options;
  return startDiscovery({ ...options, registerNetworkServers: false, report: reporterFor(options.systemMessageRouter) });
}

/**
 * The servers the daemon's network scans found, registered here while its decision is on. Off the start path; a
 * daemon that cannot be asked leaves this computer's servers only, and says nothing (the place says why).
 */
async function registerDaemonNetworkServers(options: LanScanGateOptions): Promise<void> {
  try {
    const daemon = createAgentDaemonVerbCaller({ configManager: options.configManager, homeDirectory: options.shellPaths.homeDirectory });
    if (!daemon.probe().available) return;
    const answer = await daemon.invoke<{ data?: { state?: unknown; servers?: unknown } }>('capabilities.run', { id: 'network-scan.status', inputs: {} });
    if (answer?.data?.state !== 'on' || !Array.isArray(answer.data.servers)) return;
    const network = (answer.data.servers as (DiscoveredServer & { network?: unknown })[])
      .filter((server) => server && server.network === true && typeof server.baseURL === 'string' && Array.isArray(server.models))
      .map(({ network: _network, ...server }) => server as DiscoveredServer);
    if (network.length === 0) return;
    options.providerRegistry.registerDiscoveredProviders(network);
    options.systemMessageRouter.low(`[Scan] ${servers(network.length)} the daemon found on your network registered as providers; Models and providers lists them.`);
  } catch (error) {
    logger.debug('[NetworkScan] the daemon\'s network servers could not be read at start', { error: summarizeError(error) });
  }
}

/**
 * The Agent's provider start-up pass: environment-key providers, saved servers on this computer and a scan of this
 * computer; then, from the daemon, the servers its network scans found while its decision is on.
 */
export function runGatedLanScan(options: LanScanGateOptions): BackgroundRuntimeTaskHandle {
  lastGateOptions = options;
  const handle = startPass(options);
  void registerDaemonNetworkServers(options);
  return handle;
}

/**
 * Look for model servers on this computer again (never the network): first
 * run's "look again" when none was found. False before the start-up pass ran.
 */
export function scanThisComputerNow(): boolean {
  if (!lastGateOptions) return false;
  startPass(lastGateOptions);
  return true;
}
