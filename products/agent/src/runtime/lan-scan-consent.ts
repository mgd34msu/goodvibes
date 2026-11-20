/**
 * LAN-scan consent gate.
 *
 * The platform's provider start-up pass (`startBackgroundProviderDiscovery` in
 * `@goodvibes/engine/platform/platform/runtime`) does three things: it registers
 * the providers whose API key is in the environment, restores the model
 * servers an earlier session found, and scans for model servers. The consent
 * here covers only the part that reaches other machines: probing the local
 * subnet (254 addresses per non-internal network interface) and registering
 * the servers it finds there.
 *
 * At every start the Agent runs the pass. Without consent it scans this
 * computer only (loopback, which needs no consent) and registers only servers
 * on this computer; with consent it scans the subnet too. The first start with
 * no recorded decision explains the subnet scan once and records "off".
 * `/network-scan on` records consent and scans at once.
 *
 * The platform reports what it found as data; this file words it, one summary
 * line per outcome, never a host:port per server (`/provider` shows the detail).
 */
import {
  startBackgroundProviderRegistration,
  type BackgroundProviderDiscoveryOptions,
  type BackgroundRuntimeTaskHandle,
  type HostSystemMessageSink,
} from '@/runtime/index.ts';
import type { ProviderDiscoveryReporter } from '@goodvibes/engine/platform/platform/runtime/bootstrap';
import {
  loadLanScanConsent,
  saveLanScanConsent,
  type ConsentRoots,
} from './lan-scan-consent-store.ts';

export {
  agentTrustsScannedServer,
  discoveredProvidersFilePath,
  loadLanScanConsent,
  saveLanScanConsent,
  type LanScanConsentState,
  type LanScanDecision,
} from './lan-scan-consent-store.ts';

// ── Wording ──────────────────────────────────────────────────────────────

export const NETWORK_SCAN_ENABLE_COMMAND = '/network-scan on';
export const NETWORK_SCAN_DISABLE_COMMAND = '/network-scan off';
export const NETWORK_SCAN_STATUS_COMMAND = '/network-scan';

/** Shown exactly once, the very first time the Agent starts and no decision has been recorded yet. */
export function firstRunConsentMessage(): string {
  return (
    '[Scan] Model servers on this computer (such as Ollama or LM Studio) are found at each start. ' +
    'Scanning the local network for model servers on other devices is off by default. ' +
    'If turned on, it checks other devices on this computer\'s local network (your subnet only, nothing beyond it) ' +
    'so the servers it finds can be added as chat providers. ' +
    'Servers it finds are remembered for the next start. ' +
    `Turn it on with ${NETWORK_SCAN_ENABLE_COMMAND}; nothing on the network is scanned until you do.`
  );
}

// ── Wording the platform's report ───────────────────────────────────────

const servers = (count: number): string => `${count} model server${count === 1 ? '' : 's'}`;

function reporterFor(router: HostSystemMessageSink, networkScan: boolean): ProviderDiscoveryReporter {
  return {
    restored({ registered, unregisteredNetwork }) {
      if (registered.length > 0) router.low(`[Local] ${servers(registered.length)} from the last session registered as providers, run /provider to see them.`);
      if (unregisteredNetwork.length > 0) {
        router.low(`[Local] ${servers(unregisteredNetwork.length)} saved from the network ${unregisteredNetwork.length === 1 ? 'was' : 'were'} not registered because network scanning is off; ${NETWORK_SCAN_ENABLE_COMMAND} registers ${unregisteredNetwork.length === 1 ? 'it' : 'them'}.`);
      }
    },
    scanned({ found, kept, unregisteredNetwork, skipped }) {
      if (found.length > 0) router.low(`[Scan] Discovered ${servers(found.length)} ${networkScan ? 'on this computer and its network' : 'on this computer'}, run /provider to see them.`);
      if (kept.length > 0) router.low(`[Scan] ${servers(kept.length)} saved earlier did not answer this scan; ${kept.length === 1 ? 'it is' : 'they are'} kept.`);
      if (unregisteredNetwork.length > 0) router.low(`[Scan] ${servers(unregisteredNetwork.length)} on the network ${unregisteredNetwork.length === 1 ? 'was' : 'were'} not registered.`);
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

/** The options the start-up pass ran with, so `/network-scan on` can scan at once. */
let lastGateOptions: LanScanGateOptions | null = null;

function startPass(options: LanScanGateOptions, networkScan: boolean): BackgroundRuntimeTaskHandle {
  const { startDiscovery = startBackgroundProviderRegistration } = options;
  return startDiscovery({
    ...options,
    registerNetworkServers: networkScan,
    report: reporterFor(options.systemMessageRouter, networkScan),
  });
}

/**
 * The Agent's provider start-up pass. Bootstrap calls it once; it always
 * registers environment-key providers, restores saved servers on this computer
 * and scans this computer, and scans the subnet only with recorded consent.
 * The first start with no decision explains the subnet scan and records "off".
 */
export function runGatedLanScan(options: LanScanGateOptions): BackgroundRuntimeTaskHandle {
  const { shellPaths, surfaceRoot, systemMessageRouter } = options;
  lastGateOptions = options;
  const existing = loadLanScanConsent(shellPaths, surfaceRoot);
  if (!existing) {
    saveLanScanConsent(shellPaths, surfaceRoot, 'declined');
    systemMessageRouter.low(firstRunConsentMessage());
  }
  return startPass(options, existing?.decision === 'granted');
}

/**
 * Scan the network now, after the owner turned scanning on. False when the
 * start-up pass has not run in this process (nothing to scan with yet); the
 * next start then scans.
 */
export function startLanScanNow(): boolean {
  if (!lastGateOptions) return false;
  startPass(lastGateOptions, true);
  return true;
}

/**
 * Look for model servers on this computer again (never the network): first
 * run's "look again" when none was found. False before the start-up pass ran.
 */
export function scanThisComputerNow(): boolean {
  if (!lastGateOptions) return false;
  startPass(lastGateOptions, false);
  return true;
}
