import { isLoopbackHost } from '@goodvibes-jev/engine/platform/platform/pairing';
import { resolveConnectedHostConnection, type AgentDaemonVerbCallerOptions } from './client/daemon-verbs.ts';

type ConnectedHostConnection = ReturnType<typeof resolveConnectedHostConnection>;

/** A daemon origin on this machine. */
function isLocalOrigin(baseUrl: string): boolean {
  try { return isLoopbackHost(new URL(baseUrl).hostname); } catch { return false; }
}

/**
 * The connected host as native work sees it. On the daemon's own machine the
 * Agent presents the credential it already has (the daemon's operator token
 * file); the daemon treats it as the owner's own machine, so there is no
 * pairing step. A daemon on another machine is never sent that token for
 * native work: it is paired with `goodvibes-agent setup pair`.
 */
export function createAgentNativeHostSelection(selection: AgentDaemonVerbCallerOptions): {
  readonly resolve: () => ConnectedHostConnection;
} {
  return {
    resolve() {
      const host = resolveConnectedHostConnection(selection);
      if ('reason' in host) return host;
      if (host.source === 'operator-file' && !isLocalOrigin(host.baseUrl)) {
        return { reason: `This Agent has no device credential for ${host.baseUrl}, a daemon on another machine; pair it with goodvibes-agent setup pair.` };
      }
      return host;
    },
  };
}
