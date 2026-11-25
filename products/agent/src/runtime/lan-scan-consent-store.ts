/**
 * Which saved scanned servers the Agent registers by itself, kept apart from
 * the start-up pass (lan-scan-consent.ts) so a one-shot command can apply the
 * rule without loading the runtime. The network-scan decision is the daemon's
 * (platform discovery/network-scan.ts); a 3.5.0 Agent's own decision file is
 * read only until the daemon has carried it, and never written here.
 */
import { isScannedServerOnThisComputer } from '@goodvibes/engine/platform/platform/discovery/persisted-providers';
import { networkScanGranted, peekNetworkScanConsent } from '@goodvibes/engine/platform/platform/discovery/network-scan';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell-paths';
import type { DiscoveredServer } from '@goodvibes/engine/platform/platform/discovery';

export type ConsentRoots = Pick<ShellPathService, 'resolveUserPath'>;

const DISCOVERED_PROVIDERS_FILE = 'discovered-providers.json';

/**
 * The path the platform persists discovered servers to, for display in user-facing
 * copy (this module does not read or write that file, the platform owns it).
 */
export function discoveredProvidersFilePath(roots: ConsentRoots, surfaceRoot: string): string {
  return roots.resolveUserPath(surfaceRoot, DISCOVERED_PROVIDERS_FILE);
}

/**
 * Which saved scanned servers the Agent registers outside its start-up pass
 * (one-shot commands, `run`): a server on this computer always, one on the
 * network only while the network-scan decision is on.
 */
export function agentTrustsScannedServer(server: DiscoveredServer, roots: Pick<ShellPathService, 'homeDirectory'>, _surfaceRoot: string): boolean {
  return isScannedServerOnThisComputer(server) || networkScanGranted(peekNetworkScanConsent(roots.homeDirectory));
}
