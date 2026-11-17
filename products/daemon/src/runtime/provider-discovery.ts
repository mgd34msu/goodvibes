import { persistProviders, scanLocalhost, type DiscoveredServer, type ScanResult } from '@goodvibes-jev/engine/platform/platform/discovery';
import { isLoopbackHost } from '@goodvibes-jev/engine/platform/platform/pairing';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';

/**
 * A daemon registers and remembers only servers on its own computer: whatever
 * answers on a well-known port of another machine must not become a provider
 * that prompts (and their contents) are sent to. The daemon's own scan probes
 * only this computer; this filter is for the shared discovery cache, which the
 * terminal app's explicit network scan also writes.
 */
export function onlyLoopbackServers(servers: readonly DiscoveredServer[]): DiscoveredServer[] {
  return servers.filter((server) => isLoopbackHost(server.host));
}

/** Production uses the canonical scanner/cache; tests supply synthetic boundaries. */
export interface DaemonProviderDiscoveryDependencies {
  readonly scan?: (signal: AbortSignal) => Promise<ScanResult>;
  readonly persist?: (roots: Parameters<typeof persistProviders>[0], servers: DiscoveredServer[]) => void | Promise<void>;
}

/**
 * Scans of this computer's servers, without TUI model selection or
 * cache-removal policy. `start()` runs a scan unless one is already running,
 * so the host scans at start and again on wake from sleep: a local model
 * server started after the daemon is found without a restart.
 */
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
    const scan: Promise<void> = Promise.resolve().then(async () => {
      if (closed) return;
      const { servers, skipped } = await (dependencies.scan ?? scanLocalhost)(lifetime.signal);
      if (closed) return;
      for (const server of skipped) {
        logger.warn('A model server on this computer answered but was left out of the scan', {
          host: server.host, port: server.port, reason: server.reason,
        });
      }
      if (servers.length === 0) return;
      register(servers);
      // A synchronous callback can reenter host.close(). Fence persistence too.
      if (closed) return;
      await (dependencies.persist ?? persistProviders)(roots, servers);
    }).catch((error: unknown) => {
      if (closed) return;
      // The name and errno-style code say why; the message can carry a server's reply and stays out.
      try {
        const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
        logger.warn('Daemon background provider discovery failed', {
          name: error instanceof Error ? error.name : typeof error, ...(code === undefined ? {} : { code }),
        });
      } catch { /* Logging is best effort. */ }
    }).finally(() => { if (work === scan) work = undefined; });
    work = scan;
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
