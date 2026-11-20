/**
 * session-spine-rest-transport.ts
 *
 * The REST transport, probe, and receipt consumer live in the platform itself
 * (`@goodvibes-jev/engine/platform/platform/runtime/session-spine`,
 * `rest-transport.ts`, adopted from this agent's own implementation
 * verbatim, per that module's "Hoist provenance" doc comment). Callers import
 * `createSessionSpineRestTransport` / `createSessionSpineRestProbe` /
 * `createSessionSpineReceiptConsumer` / `extractSessionSpineReceipts`
 * directly from there now.
 *
 * What stays here, per the platform module's own explicit carve-out ("Kept out of
 * this hoist: the agent's `createSpineConnectionResolver`... a consumer
 * trust-boundary concern the platform core deliberately never reaches into"):
 * building the daemon base URL from ConfigManager and the credential the one
 * daemon target resolver binds to that origin (never this machine's token for
 * a host elsewhere), with the connected-host dial switch read first. That is
 * agent-local trust-boundary wiring, not
 * transport logic, and it is exactly what every platform rest-transport factory's
 * `resolveConnection` option expects a consumer to supply.
 */

import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { formatRefusal } from '@goodvibes-jev/engine/errors';
import { readConnectedHostPairing } from '@goodvibes-jev/engine/terminal-shell/agent-turn/connected-host-auth';
import { connectedHostBaseUrl } from '@goodvibes-jev/engine/terminal-shell/agent-turn/connected-host-dial';
import { isThisMachineHost, resolveDaemonTarget } from '@goodvibes-jev/engine/platform/platform/runtime/client/daemon-target-resolver';
import { bearerFor } from '@goodvibes-jev/engine/platform/platform/runtime/client/daemon-target';
import { parseDaemonOrigin } from '@goodvibes-jev/engine/platform/platform/config/control-plane-base-url';

export interface SessionRegistrationConnection {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly tokenPath?: string;
  /** Set when this surface may not dial the daemon (the switch is off, or no credential is bound to it): nothing is sent. */
  readonly unavailable?: string | undefined;
}

/**
 * Builds a per-op connection resolver: the connected host (controlPlane.host
 * and port, default 127.0.0.1:3421) and the credential bound to that origin by
 * the one daemon target resolver: GOODVIBES_CONNECTED_HOST_TOKEN, this Agent's
 * pairing with that host, or this machine's daemon token only when the host
 * is this machine. With `daemon.connectedHost.enabled` off, or no credential
 * for the host, the connection is unavailable and no request (probe included)
 * is made. Re-read every op so a credential that appears after boot is picked up.
 */
export function createSpineConnectionResolver(
  configManager: Pick<ConfigManager, 'get'>,
  homeDirectory: string,
): () => SessionRegistrationConnection {
  return () => {
    const baseUrl = connectedHostBaseUrl(
      configManager.get('controlPlane.host'),
      configManager.get('controlPlane.port'),
    );
    if (configManager.get('daemon.connectedHost.enabled') === false) {
      return { baseUrl, token: null, unavailable: 'this surface is set not to dial a daemon (daemon.connectedHost.enabled is false)' };
    }
    const host = parseDaemonOrigin(baseUrl)?.host ?? '';
    const environment = process.env.GOODVIBES_CONNECTED_HOST_TOKEN?.trim()
      || (isThisMachineHost(host) ? process.env.GOODVIBES_DAEMON_TOKEN?.trim() : undefined);
    const resolution = resolveDaemonTarget({
      configManager,
      homeDirectory,
      explicit: { url: baseUrl, ...(environment ? { token: environment } : {}) },
      pairedToken: (origin) => {
        const pairing = readConnectedHostPairing(homeDirectory, origin.baseUrl);
        return pairing.status === 'paired' ? pairing.token : null;
      },
    });
    if (!resolution.ok) return { baseUrl, token: null, unavailable: formatRefusal(resolution.refusal) };
    const { origin, credential } = resolution.target;
    return { baseUrl: origin.baseUrl, token: credential ? bearerFor(credential, origin.baseUrl) : null };
  };
}
