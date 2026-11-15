import { persistProviders, scan, type DiscoveredServer, type ScanResult } from '@goodvibes-jev/engine/platform/platform/discovery';
import { isLoopbackHost } from '@goodvibes-jev/engine/platform/platform/pairing';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';

/**
 * A daemon registers and remembers only servers on its own computer: whatever
 * answers on a well-known port of another machine must not become a provider
 * that prompts (and their contents) are sent to.
 */
export function onlyLoopbackServers(servers: readonly DiscoveredServer[]): DiscoveredServer[] {
  return servers.filter((server) => isLoopbackHost(server.host));
}

/** Production uses the canonical scanner/cache; tests supply synthetic boundaries. */
export interface DaemonProviderDiscoveryDependencies {
  readonly scan?: (signal: AbortSignal) => Promise<ScanResult>;
  readonly persist?: (roots: Parameters<typeof persistProviders>[0], servers: DiscoveredServer[]) => void | Promise<void>;
}

/** One owned startup scan, without TUI model selection or cache-removal policy. */
export function createDaemonProviderDiscovery(
  roots: Parameters<typeof persistProviders>[0],
  register: (servers: DiscoveredServer[]) => void,
  dependencies: DaemonProviderDiscoveryDependencies = {},
) {
  let closed = false;
  const lifetime = new AbortController();
  let work: Promise<void> | undefined;
  function start(): void {
    if (closed || work) return;
    work = Promise.resolve().then(async () => {
      if (closed) return;
      const result = await (dependencies.scan ? dependencies.scan(lifetime.signal) : scan(undefined, lifetime.signal));
      if (closed) return;
      const servers = onlyLoopbackServers(result.servers);
      const skipped = result.servers.length - servers.length;
      if (skipped > 0) logger.info(`Daemon provider discovery found ${skipped} model server(s) on the network and did not register them`);
      if (servers.length === 0) return;
      register(servers);
      // A synchronous callback can reenter host.close(). Fence persistence too.
      if (closed) return;
      await (dependencies.persist ?? persistProviders)(roots, servers);
    }).catch(() => {
      if (closed) return;
      // Never inspect or retain scanner/provider/filesystem rejection values.
      try { logger.warn('Daemon background provider discovery failed'); } catch { /* Logging is best effort. */ }
    });
  }
  function close(): Promise<void> {
    closed = true;
    lifetime.abort();
    // Cancel admitted scan requests before awaiting their complete settlement.
    // Persistence already admitted remains owned until its promise settles.
    return work ?? Promise.resolve();
  }
  return { start, close };
}
