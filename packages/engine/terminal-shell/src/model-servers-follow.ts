/**
 * model-servers-follow.ts: a terminal program follows the model servers the
 * daemon finds on this computer.
 *
 * "Find model servers on this computer" (capability `models.scan`) runs in the
 * daemon: it adds each server to the daemon's providers, keeps them in the
 * daemon's saved scan (`~/.goodvibes/tui/discovered-providers.json`) and
 * announces LIST_CHANGED `models`. On that notice, and each time the daemon's
 * event stream opens again after it was lost (a notice may have been missed),
 * this program reads the saved scan and adds the servers on this computer it
 * does not have yet (or whose models changed) to its own provider registry, so
 * its model picker and its next turn can use them with no restart. Servers it
 * found some other way (a network scan it was allowed) are kept. Nothing here
 * waits on a clock.
 */
import { subscribeDaemonEventFrames } from '@goodvibes/engine/platform/platform/runtime/client';
import type { DiscoveredServer } from '@goodvibes/engine/platform/platform/discovery';
import { isScannedServerOnThisComputer, loadPersistedProviders } from '@goodvibes/engine/platform/platform/discovery/persisted-providers';
import { DAEMON_STATE_SURFACE_ROOT } from '@goodvibes/engine/platform/platform/daemon/lifecycle-marker';
import { resolveGoodVibesHome } from '@goodvibes/engine/platform/platform/config/goodvibes-home';

/** The slice of this program's provider registry the follow reads and writes. */
export interface ModelServersRegistry {
  listDiscoveredServers(): readonly DiscoveredServer[];
  registerDiscoveredProviders(servers: DiscoveredServer[]): void;
}

export interface ModelServersFollowOptions {
  /** The daemon's address and credential for its event stream, or why there is none. */
  readonly daemonEndpoint: () => Promise<{ readonly baseUrl: string; readonly token: string | null } | { readonly unavailable: string }>;
  /** Told each time this program's daemon connection comes back; returns the stop. */
  readonly onDaemonBack: (listener: () => void) => () => void;
  readonly registry: ModelServersRegistry;
  /** The daemon's saved scan; default: the file under this home (GOODVIBES_HOME, else HOME). */
  readonly readSaved?: (() => readonly DiscoveredServer[]) | undefined;
}

const address = (server: Pick<DiscoveredServer, 'host' | 'port'>): string => `${server.host}:${server.port}`;
const same = (left: readonly DiscoveredServer[], right: readonly DiscoveredServer[]): boolean => JSON.stringify(left) === JSON.stringify(right);

/** The daemon's saved model servers on this computer, as this program reads them (nothing on another machine). */
function savedOnThisComputer(): readonly DiscoveredServer[] {
  return loadPersistedProviders({ homeDirectory: resolveGoodVibesHome(), surfaceRoot: DAEMON_STATE_SURFACE_ROOT }).filter(isScannedServerOnThisComputer);
}

/** Add the daemon's saved servers to this program's registry; true when something changed. */
export function takeDaemonModelServers(registry: ModelServersRegistry, readSaved: () => readonly DiscoveredServer[] = savedOnThisComputer): boolean {
  let saved: readonly DiscoveredServer[];
  try { saved = readSaved(); } catch { return false; }
  if (saved.length === 0) return false;
  const current = registry.listDiscoveredServers();
  const savedAt = new Set(saved.map(address));
  const next = [...current.filter((server) => !savedAt.has(address(server))), ...saved];
  const before = [...current].sort((left, right) => address(left).localeCompare(address(right)));
  const after = [...next].sort((left, right) => address(left).localeCompare(address(right)));
  if (same(before, after)) return false;
  registry.registerDiscoveredProviders([...next]);
  return true;
}

/** Follow the daemon's model servers for this program's registry; returns the stop. */
export function followDaemonModelServers(options: ModelServersFollowOptions): () => void {
  let stopped = false;
  let stopStream: (() => void) | null = null;
  const take = (): void => { if (!stopped) takeDaemonModelServers(options.registry, options.readSaved); };
  const open = (): void => {
    stopStream?.();
    stopStream = null;
    void options.daemonEndpoint().then((endpoint) => {
      if (stopped || 'unavailable' in endpoint) return;
      stopStream = subscribeDaemonEventFrames(
        { baseUrl: endpoint.baseUrl, getAuthToken: () => endpoint.token },
        { domains: ['workspace'], events: [], lists: ['models'] },
        take,
      );
    }, () => { /* No daemon yet: opened when this program's daemon connection is back. */ });
  };
  open();
  const stopBack = options.onDaemonBack(() => {
    if (stopped) return;
    take();
    open();
  });
  return () => {
    stopped = true;
    stopBack();
    stopStream?.();
    stopStream = null;
  };
}
