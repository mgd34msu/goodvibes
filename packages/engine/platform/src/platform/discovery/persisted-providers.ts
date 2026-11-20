/**
 * The local servers a scan saved (`discovered-providers.json` under the
 * surface root), read without the scanner's network code, so a command that
 * only names the saved servers (`status`) does not load the scanner.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isLoopbackHost } from '@goodvibes-jev/engine/transport-http/paths';
import type { ShellPathService } from '../runtime/shell-paths.js';
import { resolveSurfaceDirectory } from '../runtime/surface-root.js';
import { logger } from '../utils/logger.js';
import { capturePersistedProviders } from './persisted-cache.js';
import type { DiscoveredServer } from './scanner.js';

export type DiscoveryRoots = Pick<ShellPathService, 'homeDirectory'> & {
  readonly surfaceRoot: string;
};

/** Where the saved scan lives for one product. */
export function getPersistedProvidersPath(roots: DiscoveryRoots): string {
  return resolveSurfaceDirectory(roots.homeDirectory, roots.surfaceRoot, 'discovered-providers.json');
}

/** Load previously discovered providers from disk. Returns empty array if file doesn't exist. */
export function loadPersistedProviders(roots: DiscoveryRoots): DiscoveredServer[] {
  const persistedPath = getPersistedProvidersPath(roots);
  try {
    if (!existsSync(persistedPath)) return [];
    const raw = readFileSync(persistedPath, 'utf-8');
    const captured = capturePersistedProviders(JSON.parse(raw) as unknown);
    if (captured.invalid) {
      logger.warn('[Scanner] loadPersistedProviders ignored invalid discovery cache');
    }
    return captured.servers;
  } catch {
    // JSON parse and filesystem errors can include private cache bytes or paths.
    logger.warn('[Scanner] loadPersistedProviders failed; using empty discovery cache');
    return [];
  }
}

/** The default rule for a saved scanned server: one on this computer. */
export function isScannedServerOnThisComputer(server: Pick<DiscoveredServer, 'host'>): boolean {
  return isLoopbackHost(server.host);
}
