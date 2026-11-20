import { assertCurrentToolEffect } from '@goodvibes/engine/platform/platform/tools';
import type { Tool } from '@goodvibes/engine/platform/platform/types';
import { lstatSync } from 'node:fs';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { connectedHostOperatorTokenPath } from './connected-host-auth.js';
import { agentHostPairingStorePath } from './connected-host-pairing-store.js';
import { resolveConnectedHost, type ConnectedHostConfigReader as AgentConnectedHostConfigReader, type ConnectedHostSource, type ConnectedHostUnavailable } from './connected-host-client.js';
import type { AgentInProcessHost } from './in-process-host.js';

/** File identity, size and change time; `absent` when there is no file, `symlink` for a link. One `lstat`. */
function credentialStamp(path: string): string {
  try {
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!stat) return 'absent';
    return stat.isSymbolicLink() ? 'symlink' : `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch {
    return 'unreadable';
  }
}

function credentialFile(source: ConnectedHostSource | undefined, homeDirectory: string): string | undefined {
  if (source === 'pairing') return agentHostPairingStorePath(homeDirectory);
  if (source === 'operator-file') return connectedHostOperatorTokenPath(homeDirectory);
  // The environment, and the operator credential of the daemon hosting this turn (read live from it), have no file.
  return undefined;
}

export interface CapturedOperatorConnection {
  readonly baseUrl: string;
  readonly token: string | null;
  /** Where the credential was looked for, safe to show. */
  readonly tokenPath: string;
  readonly source?: ConnectedHostSource;
  readonly unavailable?: ConnectedHostUnavailable;
  /** How the request reaches the host: absent, the network; in a daemon-hosted turn, the daemon's own request path. */
  readonly fetch?: typeof fetch | undefined;
  /**
   * The caller's own check, then one `lstat` of the credential file compared
   * with the one this connection was resolved from. Run it once, immediately
   * before the request leaves; a response cannot be un-sent, so nothing is
   * checked after it, and the host authenticates the token it is sent anyway.
   */
  readonly assertCurrent: () => void;
}

/**
 * Resolve the connected host and its credential once, into a value, with the
 * Agent's one precedence (connected-host-client.ts). This owner does not mint
 * admission; its check only restricts the current invocation.
 */
export function captureOperatorConnection(shellPaths: Pick<ShellPathService, 'homeDirectory'>, reader: AgentConnectedHostConfigReader,
  assertInvocation: () => void, inProcess?: AgentInProcessHost): CapturedOperatorConnection {
  const home = shellPaths.homeDirectory;
  const resolved = resolveConnectedHost({ configManager: reader, homeDirectory: home, ...(inProcess ? { inProcess } : {}) });
  const file = resolved.token ? credentialFile(resolved.source, home) : undefined;
  const stamp = file === undefined ? undefined : credentialStamp(file);
  return {
    baseUrl: resolved.baseUrl,
    token: resolved.token,
    tokenPath: resolved.credential,
    ...(resolved.source === undefined ? {} : { source: resolved.source }),
    ...(resolved.unavailable === undefined ? {} : { unavailable: resolved.unavailable }),
    ...(resolved.fetch === undefined ? {} : { fetch: resolved.fetch }),
    assertCurrent: () => {
      assertInvocation();
      if (stamp === 'symlink') {
        // A link would send whatever file it points at as the bearer credential.
        throw new Error(`The connected-host credential ${resolved.credential} is a symbolic link, so it was not sent. Replace the link with the credential file itself.`);
      }
      if (file !== undefined && credentialStamp(file) !== stamp) {
        throw new Error(`The connected-host credential (${resolved.credential}) changed after this call was prepared, so it was not sent. Retry to use the current credential.`);
      }
    },
  };
}

export function assertOperatorEffect(args: Record<string, unknown>, options: Parameters<Tool['execute']>[1],
  outward = false): void {
  if (!assertCurrentToolEffect(args, options, 'write') || (outward && !assertCurrentToolEffect(args, options, 'send'))) {
    throw new Error('Connected operator effects require current recorded effect admission.');
  }
  options?.signal?.throwIfAborted();
}
