/**
 * The Agent's LAN-scan consent decision on disk, and its rule for which saved
 * scanned servers are registered. Kept apart from the start-up pass
 * (lan-scan-consent.ts) so a one-shot command can apply the rule without
 * loading the runtime.
 */
import { readFileSync } from 'node:fs';
import { writeStoreJson } from '@goodvibes/engine/terminal-shell/agent-turn/store-file';
import { logger } from '@goodvibes/engine/platform/platform/utils';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { isScannedServerOnThisComputer } from '@goodvibes/engine/platform/platform/discovery/persisted-providers';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell-paths';
import type { DiscoveredServer } from '@goodvibes/engine/platform/platform/discovery';

export type LanScanDecision = 'granted' | 'declined';

export interface LanScanConsentState {
  readonly decision: LanScanDecision;
  readonly decidedAt: string;
}

export type ConsentRoots = Pick<ShellPathService, 'resolveUserPath'>;

const CONSENT_FILE_NAME = 'network-discovery-consent.json';
const DISCOVERED_PROVIDERS_FILE = 'discovered-providers.json';

export function consentFilePath(roots: ConsentRoots, surfaceRoot: string): string {
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
 * What the consent file says: no decision recorded yet (no file), a recorded
 * decision, or a file that exists but cannot be read or does not hold a
 * decision. Only `absent` is a first run; an unreadable file is the owner's to
 * fix or overwrite, and scanning stays off while it is.
 */
export type LanScanConsentRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'recorded'; readonly state: LanScanConsentState }
  | { readonly kind: 'unreadable'; readonly path: string; readonly reason: string };

/** Read the persisted LAN-scan consent decision. */
export function readLanScanConsent(roots: ConsentRoots, surfaceRoot: string): LanScanConsentRead {
  const path = consentFilePath(roots, surfaceRoot);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { kind: 'absent' };
    const reason = summarizeError(err);
    logger.warn('[LanScanConsent] consent file could not be read; network scanning stays off', { path, error: reason });
    return { kind: 'unreadable', path, reason };
  }
  let parsed: Partial<LanScanConsentState> | null;
  try {
    parsed = JSON.parse(raw) as Partial<LanScanConsentState> | null;
  } catch (err) {
    const reason = `not valid JSON (${summarizeError(err)})`;
    logger.warn('[LanScanConsent] consent file could not be read; network scanning stays off', { path, error: reason });
    return { kind: 'unreadable', path, reason };
  }
  if (!parsed || (parsed.decision !== 'granted' && parsed.decision !== 'declined')) {
    const reason = 'it holds no "granted" or "declined" decision';
    logger.warn('[LanScanConsent] consent file could not be read; network scanning stays off', { path, error: reason });
    return { kind: 'unreadable', path, reason };
  }
  return {
    kind: 'recorded',
    state: {
      decision: parsed.decision,
      decidedAt: typeof parsed.decidedAt === 'string' ? parsed.decidedAt : new Date(0).toISOString(),
    },
  };
}

/** True only for a recorded grant: an absent or unreadable file means scanning is off. */
export function lanScanGranted(read: LanScanConsentRead): boolean {
  return read.kind === 'recorded' && read.state.decision === 'granted';
}

/**
 * Persist the owner's LAN-scan consent decision (explicit grant, decline, or
 * the first-run default) through the atomic store writer: private temp file,
 * fsync, rename, so a reader never sees a partial file. A failed write throws
 * and leaves the earlier decision on disk.
 */
export function saveLanScanConsent(roots: ConsentRoots, surfaceRoot: string, decision: LanScanDecision): void {
  const state: LanScanConsentState = { decision, decidedAt: new Date().toISOString() };
  writeStoreJson(consentFilePath(roots, surfaceRoot), state);
}

/**
 * Which saved scanned servers the Agent registers outside its start-up pass
 * (one-shot commands, `run`): a server on this computer always, one on the
 * network only while network scanning is on, the same rule as that pass.
 */
export function agentTrustsScannedServer(server: DiscoveredServer, roots: ConsentRoots, surfaceRoot: string): boolean {
  return isScannedServerOnThisComputer(server) || lanScanGranted(readLanScanConsent(roots, surfaceRoot));
}

