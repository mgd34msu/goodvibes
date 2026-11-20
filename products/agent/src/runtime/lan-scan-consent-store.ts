/**
 * The Agent's LAN-scan consent decision on disk, and its rule for which saved
 * scanned servers are registered. Kept apart from the start-up pass
 * (lan-scan-consent.ts) so a one-shot command can apply the rule without
 * loading the runtime.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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

/**
 * Which saved scanned servers the Agent registers outside its start-up pass
 * (one-shot commands, `run`): a server on this computer always, one on the
 * network only while network scanning is on, the same rule as that pass.
 */
export function agentTrustsScannedServer(server: DiscoveredServer, roots: ConsentRoots, surfaceRoot: string): boolean {
  return isScannedServerOnThisComputer(server) || loadLanScanConsent(roots, surfaceRoot)?.decision === 'granted';
}

