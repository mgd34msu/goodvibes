/** Selected-command network ownership; never install or mutate global trust. */
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { createNetworkFetch } from '@goodvibes/engine/platform/platform/runtime/network/outbound';

/**
 * Everything a command needs to reach a daemon: one fetch carrying the
 * configured outbound TLS trust, and the one reader of this machine's operator
 * token. Every remote command receives this one object, so none can open a
 * connection without it or pick its local token another way.
 */
export interface DaemonCommandRemote {
  readonly configManager: ConfigManager;
  readonly daemonHomeDir: string;
  /** Where the daemon writes its own lifecycle/receipt files, for the local-only lines. */
  readonly controlPlaneConfigDir: string;
  readonly fetchImpl: typeof globalThis.fetch;
  /**
   * This machine's operator token as the daemon serves it: `GOODVIBES_DAEMON_TOKEN`
   * when set, else the daemon home's token file. Consulted only for this
   * machine's own daemon, so it never leaves the machine.
   */
  readonly readToken: (daemonHomeDir: string) => string | undefined;
}

export function createDaemonCommandRemote(input: {
  readonly configManager: ConfigManager;
  readonly daemonHomeDir: string;
  readonly controlPlaneConfigDir: string;
  readonly readToken: (daemonHomeDir: string) => string | undefined;
}): DaemonCommandRemote {
  return Object.freeze({
    ...input,
    fetchImpl: createNetworkFetch(globalThis.fetch, input.configManager),
  });
}
