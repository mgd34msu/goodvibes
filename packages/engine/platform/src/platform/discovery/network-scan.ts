/**
 * Scanning your local network for model servers: one decision, held by the
 * daemon, and one scan, run by the daemon. Model servers on this computer are
 * found by each program at its start and need no decision; probing the other
 * devices on the local network (your subnet only) does, and is off until the
 * owner turns it on.
 *
 * The decision is `~/.goodvibes/daemon/network-discovery-consent.json`. A 3.5.0
 * install kept it in the Agent's folder (`~/.goodvibes/agent/...`): the first
 * read here with no decision of the daemon's carries the Agent's once (the same
 * decision and time), and leaves the Agent's file as it is, so a 3.5.0 Agent
 * after a rollback reads the decision it had. The servers the daemon's scan
 * finds are kept in `~/.goodvibes/daemon/discovered-providers.json` and
 * registered with the daemon's providers; each program reads them from the
 * daemon (`network-scan.status`).
 */
import { readFileSync } from 'node:fs';
import { resolveSurfaceDirectory } from '../runtime/surface-root.js';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { summarizeError } from '../utils/native-error-summary.js';
import { noteListChanged } from '../runtime/list-changes.js';
import type { DiscoveredServer } from './scanner.js';

export type NetworkScanDecision = 'granted' | 'declined';

/** What the decision file says: none yet, a decision (and whether it was carried from the Agent's), or unreadable. */
export type NetworkScanConsent =
  | { readonly kind: 'absent' }
  | { readonly kind: 'recorded'; readonly decision: NetworkScanDecision; readonly decidedAt: string; readonly carried?: true | undefined }
  | { readonly kind: 'unreadable'; readonly path: string; readonly reason: string };

const CONSENT_FILE = 'network-discovery-consent.json';
/** The daemon's folder for these files (its surface root). */
export const NETWORK_SCAN_SURFACE_ROOT = 'daemon';

export function networkScanConsentPath(homeDirectory: string): string {
  return resolveSurfaceDirectory(homeDirectory, NETWORK_SCAN_SURFACE_ROOT, CONSENT_FILE);
}

/** Where a 3.5.0 Agent kept its decision: read once to carry it, never written. */
function agentConsentPath(homeDirectory: string): string {
  return resolveSurfaceDirectory(homeDirectory, 'agent', CONSENT_FILE);
}

function readFile(path: string): NetworkScanConsent {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unreadable', path, reason: summarizeError(error) };
  }
  let parsed: { decision?: unknown; decidedAt?: unknown } | null;
  try { parsed = JSON.parse(raw) as typeof parsed; } catch (error) { return { kind: 'unreadable', path, reason: `not valid JSON (${summarizeError(error)})` }; }
  if (!parsed || (parsed.decision !== 'granted' && parsed.decision !== 'declined')) return { kind: 'unreadable', path, reason: 'it holds no "granted" or "declined" decision' };
  return { kind: 'recorded', decision: parsed.decision, decidedAt: typeof parsed.decidedAt === 'string' ? parsed.decidedAt : new Date(0).toISOString() };
}

/**
 * The daemon's decision. With none of its own, a decision the Agent kept is carried once into the daemon's file (the
 * Agent's file is left as it is); a daemon file that cannot be read is never overwritten by the carry.
 */
export function readNetworkScanConsent(homeDirectory: string): NetworkScanConsent {
  const own = readFile(networkScanConsentPath(homeDirectory));
  if (own.kind !== 'absent') return own;
  const agent = readFile(agentConsentPath(homeDirectory));
  if (agent.kind !== 'recorded') return own;
  writeJsonFileAtomic(networkScanConsentPath(homeDirectory), { decision: agent.decision, decidedAt: agent.decidedAt, carriedFrom: 'agent' });
  return { ...agent, carried: true };
}

/**
 * The decision as a terminal program reads it on this machine, writing nothing: the daemon's, else (before the daemon
 * carried it) the one a 3.5.0 Agent kept. Only to decide which saved servers a program registers by itself.
 */
export function peekNetworkScanConsent(homeDirectory: string): NetworkScanConsent {
  const own = readFile(networkScanConsentPath(homeDirectory));
  return own.kind !== 'absent' ? own : readFile(agentConsentPath(homeDirectory));
}

/** Record the owner's decision; a failed write throws and leaves the earlier one. */
export function saveNetworkScanConsent(homeDirectory: string, decision: NetworkScanDecision): void {
  writeJsonFileAtomic(networkScanConsentPath(homeDirectory), { decision, decidedAt: new Date().toISOString() });
  noteListChanged({ list: 'network-scan', change: 'changed' });
}

/** Whether the network may be scanned: only a recorded grant. */
export function networkScanGranted(consent: NetworkScanConsent): boolean {
  return consent.kind === 'recorded' && consent.decision === 'granted';
}

/** What the daemon's scan needs: the sweep, where it keeps what it found, and the providers it registers them with. */
export interface NetworkScanHost {
  readonly homeDirectory: string;
  readonly scan: () => Promise<{ readonly servers: DiscoveredServer[] }>;
  readonly persist: (servers: DiscoveredServer[]) => void;
  readonly register: (servers: DiscoveredServer[]) => void;
}

let running: Promise<void> | undefined;
let lastScan: { readonly at: string; readonly found: number; readonly failed?: string | undefined } | undefined;

/**
 * Scan the network now, in the daemon, unless a scan is already running; what it finds is kept and registered, and
 * the place is told when it finishes. Returns whether a new scan started.
 */
export function startNetworkScan(host: NetworkScanHost): boolean {
  if (running) return false;
  running = (async () => {
    try {
      const result = await host.scan();
      if (result.servers.length > 0) {
        host.persist(result.servers);
        host.register(result.servers);
      }
      lastScan = { at: new Date().toISOString(), found: result.servers.length };
    } catch (error) {
      lastScan = { at: new Date().toISOString(), found: 0, failed: summarizeError(error) };
    } finally {
      running = undefined;
      noteListChanged({ list: 'network-scan', change: 'changed' });
    }
  })();
  return true;
}

/** Whether the daemon is scanning now, and how its last scan in this run of the daemon went. */
export function networkScanProgress(): { readonly scanning: boolean; readonly last?: typeof lastScan } {
  return { scanning: running !== undefined, ...(lastScan ? { last: lastScan } : {}) };
}
