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
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import {
  lanScanGranted,
  readLanScanConsent,
  saveLanScanConsent,
  type ConsentRoots,
} from './lan-scan-consent-store.ts';

export {
  agentTrustsScannedServer,
  discoveredProvidersFilePath,
  lanScanGranted,
  readLanScanConsent,
  saveLanScanConsent,
  type LanScanConsentRead,
  type LanScanConsentState,
  type LanScanDecision,
} from './lan-scan-consent-store.ts';

// ── Wording ──────────────────────────────────────────────────────────────

export const NETWORK_SCAN_ENABLE_COMMAND = '/network-scan on';
export const NETWORK_SCAN_DISABLE_COMMAND = '/network-scan off';
export const NETWORK_SCAN_STATUS_COMMAND = '/network-scan';

/**
 * Shown exactly once, the very first time the Agent starts and no decision has
 * been recorded yet. `saveFailure` is the reason the first-run "off" could not
 * be recorded; the notice then says so, and the next start shows it again.
 */
export function firstRunConsentMessage(saveFailure?: string): string {
  const notSaved = saveFailure
    ? ` This choice could not be saved (${saveFailure}), so this notice shows again at the next start.`
    : '';
  return (
    '[Scan] Model servers on this computer (such as Ollama or LM Studio) are found at each start. ' +
    'Scanning the local network for model servers on other devices is off by default. ' +
    'If turned on, it checks other devices on this computer\'s local network (your subnet only, nothing beyond it) ' +
    'so the servers it finds can be added as chat providers. ' +
    'Servers it finds are remembered for the next start. ' +
    `Turn it on with ${NETWORK_SCAN_ENABLE_COMMAND}; nothing on the network is scanned until you do.` +
    notSaved
  );
}

/** Shown at a start whose consent file exists but cannot be read: scanning stays off and the file is left as it is. */
export function unreadableConsentMessage(path: string, reason: string): string {
  return (
    `[Scan] The network-scanning decision in ${path} could not be read (${reason}), so the local network is not scanned at this start. ` +
    `The file is left as it is; fix it, or record a new decision with ${NETWORK_SCAN_ENABLE_COMMAND} or ${NETWORK_SCAN_DISABLE_COMMAND}.`
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
 * The first start with no consent file explains the subnet scan and records
 * "off"; a consent file that exists but cannot be read leaves the subnet
 * unscanned for this start, is reported, and is not overwritten.
 */
export function runGatedLanScan(options: LanScanGateOptions): BackgroundRuntimeTaskHandle {
  const { shellPaths, surfaceRoot, systemMessageRouter } = options;
  lastGateOptions = options;
  const consent = readLanScanConsent(shellPaths, surfaceRoot);
  if (consent.kind === 'absent') {
    let saveFailure: string | undefined;
    try {
      saveLanScanConsent(shellPaths, surfaceRoot, 'declined');
    } catch (err) {
      saveFailure = summarizeError(err);
    }
    systemMessageRouter.low(firstRunConsentMessage(saveFailure));
  } else if (consent.kind === 'unreadable') {
    systemMessageRouter.high(unreadableConsentMessage(consent.path, consent.reason), 'warning');
  }
  return startPass(options, lanScanGranted(consent));
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
