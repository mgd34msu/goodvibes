/** Selected-command network ownership; never install or mutate global trust. */
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { createNetworkFetch } from '@goodvibes-jev/engine/platform/platform/runtime/network/outbound';

/**
 * Everything a command needs to reach a daemon: one fetch carrying the
 * configured outbound TLS trust. Every remote command receives this one
 * object, so none can open a connection without it.
 */
export interface DaemonCommandRemote {
  readonly configManager: ConfigManager;
  readonly daemonHomeDir: string;
  /** Where the daemon writes its own lifecycle/receipt files, for the local-only lines. */
  readonly controlPlaneConfigDir: string;
  readonly fetchImpl: typeof globalThis.fetch;
}

export function createDaemonCommandRemote(input: {
  readonly configManager: ConfigManager;
  readonly daemonHomeDir: string;
  readonly controlPlaneConfigDir: string;
}): DaemonCommandRemote {
  return Object.freeze({
    ...input,
    fetchImpl: createNetworkFetch(globalThis.fetch, input.configManager),
  });
}
