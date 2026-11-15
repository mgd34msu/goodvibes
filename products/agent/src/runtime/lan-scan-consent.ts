/**
 * LAN-scan consent gate.
 *
 * The platform's provider start-up pass (`startBackgroundProviderDiscovery` in
 * `@goodvibes-jev/engine/platform/platform/runtime`) does three things: it registers
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import {
  startBackgroundProviderRegistration,
  type BackgroundProviderDiscoveryOptions,
  type BackgroundRuntimeTaskHandle,
  type HostSystemMessageSink,
  type ShellPathService,
} from '@/runtime/index.ts';
import type { ProviderDiscoveryReporter } from '@goodvibes-jev/engine/platform/platform/runtime/bootstrap';

export type LanScanDecision = 'granted' | 'declined';

export interface LanScanConsentState {
  readonly decision: LanScanDecision;
  readonly decidedAt: string;
}

type ConsentRoots = Pick<ShellPathService, 'resolveUserPath'>;

const CONSENT_FILE_NAME = 'network-discovery-consent.json';
const DISCOVERED_PROVIDERS_FILE = 'discovered-providers.json';

function consentFilePath(roots: ConsentRoots, surfaceRoot: string): string {
  return roots.resolveUserPath(surfaceRoot, CONSENT_FILE_NAME);
}

/**
 * The path the platform persists discovered servers to, for display in user-facing
 * copy (this module does not read or write that file, the platform owns it).
 */
export function discoveredProvidersFilePath(roots: ConsentRoots, surfaceRoot: string): string {
  return roots.resolveUserPath(surfaceRoot, DISCOVERED_PROVIDERS_FILE);
}

/**
 * Load the persisted LAN-scan consent decision.
 * Returns undefined when no decision has ever been recorded (true first run).
 */
export function loadLanScanConsent(roots: ConsentRoots, surfaceRoot: string): LanScanConsentState | undefined {
  const path = consentFilePath(roots, surfaceRoot);
  try {
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LanScanConsentState> | null;
    if (!parsed || (parsed.decision !== 'granted' && parsed.decision !== 'declined')) {
      logger.warn('[LanScanConsent] ignoring invalid consent file', { path });
      return undefined;
    }
    return {
      decision: parsed.decision,
      decidedAt: typeof parsed.decidedAt === 'string' ? parsed.decidedAt : new Date(0).toISOString(),
    };
  } catch (err) {
    logger.warn('[LanScanConsent] load failed; treating as undecided', { path, error: summarizeError(err) });
    return undefined;
  }
}

/** Persist the user's LAN-scan consent decision (explicit grant, decline, or the first-run default). */
export function saveLanScanConsent(roots: ConsentRoots, surfaceRoot: string, decision: LanScanDecision): void {
  const path = consentFilePath(roots, surfaceRoot);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const state: LanScanConsentState = { decision, decidedAt: new Date().toISOString() };
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  } catch (err) {
    logger.warn('[LanScanConsent] save failed; decision will not persist', { path, error: summarizeError(err) });
  }
}

// ── Wording ──────────────────────────────────────────────────────────────

export const NETWORK_SCAN_ENABLE_COMMAND = '/network-scan on';
export const NETWORK_SCAN_DISABLE_COMMAND = '/network-scan off';
export const NETWORK_SCAN_STATUS_COMMAND = '/network-scan';

/** Shown exactly once, the very first time the Agent starts and no decision has been recorded yet. */
export function firstRunConsentMessage(roots: ConsentRoots, surfaceRoot: string): string {
  const storePath = discoveredProvidersFilePath(roots, surfaceRoot);
  return (
    '[Scan] Model servers on this computer (such as Ollama or LM Studio) are found at each start. ' +
    'Scanning the local network for model servers on other devices is off by default. ' +
    'If turned on, it checks other devices on this computer\'s local network (your subnet only, nothing beyond it) ' +
    'so the servers it finds can be added as chat providers. ' +
    `Servers found are saved to ${storePath}. ` +
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
    scanned({ found, kept, unregisteredNetwork }) {
      if (found.length > 0) router.low(`[Scan] Discovered ${servers(found.length)} ${networkScan ? 'on this computer and its network' : 'on this computer'}, run /provider to see them.`);
      if (kept.length > 0) router.low(`[Scan] ${servers(kept.length)} saved earlier did not answer this scan; ${kept.length === 1 ? 'it is' : 'they are'} kept.`);
      if (unregisteredNetwork.length > 0) router.low(`[Scan] ${servers(unregisteredNetwork.length)} on the network ${unregisteredNetwork.length === 1 ? 'was' : 'were'} not registered.`);
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
    systemMessageRouter.low(firstRunConsentMessage(shellPaths, surfaceRoot));
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
