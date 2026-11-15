import { hostname } from 'node:os';
import { lstatSync } from 'node:fs';
import { resolveConnectedHostDialEnabled } from '@goodvibes-jev/engine/platform/platform/config';
import { isLoopbackHost } from '@goodvibes-jev/engine/platform/platform/pairing';
import { resolveConnectedHostBaseUrl } from '../config/connected-host-dial.ts';
import { resolveConnectedHostConnection, type AgentDaemonVerbCallerOptions } from './client/daemon-verbs.ts';
import { connectedHostOperatorTokenPath } from './connected-host-auth.ts';
import { canonicalizePairingHost, readAgentHostPairing } from './connected-host-pairing-store.ts';
import { previewAgentHostPairing, type AgentHostPairingResult } from './agent-host-pairing.ts';

type ConnectedHostConnection = ReturnType<typeof resolveConnectedHostConnection>;

const homeOf = (options: Pick<AgentDaemonVerbCallerOptions, 'homeDirectory'>): string =>
  typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;

/** The daemon's operator token file is this user's own, private and not a link. */
function ownsPrivateOperatorToken(home: string): boolean {
  try {
    if (typeof process.geteuid !== 'function') return false;
    const stat = lstatSync(connectedHostOperatorTokenPath(home));
    return stat.isFile() && stat.uid === process.geteuid() && stat.nlink === 1 && (stat.mode & 0o077) === 0;
  } catch { return false; }
}

/**
 * Native work on the owner's own machine needs no pairing step. When the
 * connected host is on loopback, this Agent holds no record for it, no
 * environment token was chosen, and the daemon's operator token is this user's
 * own private file, the Agent creates its device credential with that token
 * through the same preview and confirmation `goodvibes-agent setup pair` uses,
 * verifies it and uses it from then on. The device shows in the daemon's device
 * list and is revoked like any other. A host on another machine is never sent
 * the local token; it is paired with `goodvibes-agent setup pair`. An earlier
 * attempt whose reply was lost is repeated under its own id. Returns the outcome
 * when a request was made, otherwise null.
 */
export async function pairLocalAgentHostAutomatically(options: AgentDaemonVerbCallerOptions, signal?: AbortSignal): Promise<AgentHostPairingResult | null> {
  try {
    if (!resolveConnectedHostDialEnabled(options.configManager)) return null;
    if (process.env.GOODVIBES_CONNECTED_HOST_TOKEN?.trim() || process.env.GOODVIBES_DAEMON_TOKEN?.trim()) return null;
    const home = homeOf(options);
    const host = canonicalizePairingHost(resolveConnectedHostBaseUrl(options.configManager));
    if (!host || !isLoopbackHost(new URL(host).hostname)) return null;
    const state = readAgentHostPairing(home, host);
    if (state.status !== 'missing' && state.status !== 'unknown') return null;
    if (!ownsPrivateOperatorToken(home)) return null;
    const name = `GoodVibes Agent on ${hostname()}`.replace(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/gu, '').slice(0, 80).trim();
    const preview = await previewAgentHostPairing(options, name, signal);
    const { result } = preview;
    // Only a fresh migration is confirmed here; a lost-reply attempt is settled
    // inside the preview, and any other answer (forget, clear) stays the owner's.
    if (result.status === 'preview' && result.confirmation && preview.confirm) return await preview.confirm(result.confirmation, signal);
    if (result.status === 'already-paired' || result.confirmation) return null;
    return result;
  } catch { return null; }
}

/**
 * The connected host as native work sees it. Native routes accept only a
 * per-device credential, so the shared operator token is never presented: a
 * host reached only through it is unavailable until this Agent is paired, which
 * `prepare` does on its own for a daemon on this machine.
 */
export function createAgentNativeHostSelection(selection: AgentDaemonVerbCallerOptions): {
  readonly resolve: () => ConnectedHostConnection;
  readonly prepare: (signal?: AbortSignal) => Promise<void>;
} {
  // Why the automatic local pairing gave this Agent no credential, shown in
  // place of the generic reason until a credential exists.
  let localPairingReason = '';
  return {
    resolve() {
      const host = resolveConnectedHostConnection(selection);
      if ('reason' in host) return { reason: localPairingReason || host.reason };
      if (host.source === 'operator-file') {
        return { reason: localPairingReason || `This Agent has no device credential for ${host.baseUrl}. On this machine /work creates one on first use; for a daemon on another machine run goodvibes-agent setup pair.` };
      }
      localPairingReason = '';
      return host;
    },
    async prepare(signal) {
      const result = await pairLocalAgentHostAutomatically(selection, signal);
      localPairingReason = result && result.status !== 'paired' ? result.message : '';
    },
  };
}
