/** Selected-command network ownership; never install or mutate global trust. */
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { applyOutboundTlsToFetchInit, createNetworkFetch } from '@goodvibes-jev/engine/platform/platform/runtime/transport';
import type { DaemonWebSocketFactory } from '@goodvibes-jev/engine/terminal-shell';

/**
 * Everything a command needs to reach a daemon: one fetch and one socket
 * factory, both carrying the configured outbound TLS trust. Every remote
 * command receives this one object, so none can open a connection without it.
 */
export interface DaemonCommandRemote {
  readonly configManager: ConfigManager;
  readonly daemonHomeDir: string;
  /** Where the daemon writes its own lifecycle/receipt files, for the local-only lines. */
  readonly controlPlaneConfigDir: string;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly socketFactory: DaemonWebSocketFactory;
}

export function createDaemonCommandRemote(input: {
  readonly configManager: ConfigManager;
  readonly daemonHomeDir: string;
  readonly controlPlaneConfigDir: string;
}): DaemonCommandRemote {
  return Object.freeze({
    ...input,
    fetchImpl: createNetworkFetch(globalThis.fetch, input.configManager),
    socketFactory: createDaemonCommandSocketFactory(input),
  });
}

/** Bun uses the same TLS options for HTTPS requests and WSS upgrades. */
function createDaemonCommandSocketFactory(
  input: { readonly configManager: Pick<ConfigManager, 'get'>; readonly controlPlaneConfigDir: string },
): DaemonWebSocketFactory {
  const config = {
    get: (path: string) => input.configManager.get(path as Parameters<typeof input.configManager.get>[0]),
    getControlPlaneConfigDir: () => input.controlPlaneConfigDir,
  };
  return (url, init) => {
    const request = applyOutboundTlsToFetchInit(url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'), init, config);
    return new WebSocket(url, request as unknown as string[]) as unknown as ReturnType<DaemonWebSocketFactory>;
  };
}
