/**
 * family-remote.ts, the connected-host route of the verb families the daemon
 * owns (the owner profile, occasions), for an Agent turn whose own process
 * does not serve them: the Agent process's connected host, or, in a turn the
 * daemon hosts, the daemon itself through its own request path
 * (in-process-host.ts). One route for both, so a hosted call presents the
 * credentials the Agent's call presents:
 * - an ordinary call carries the Agent's ordinary credential for the host;
 * - a call made on the owner's behalf (`lifetime.delegation`) carries the
 *   Agent's delegated credential (agent-delegation-credential.ts). The daemon
 *   authenticates it as the Agent's pairing (credential kind `agent`), grants
 *   that pairing's scopes and gives the handler that pairing's native
 *   authority, so a profile or occasions write the Agent makes for the owner
 *   is admitted, judged and recorded exactly as the paired Agent's is.
 *
 * The credential is resolved once per call into a value and verified there;
 * the caller's check runs once more immediately before the request leaves.
 * A write is never retried.
 */
import type { OperatorMethodId } from '@goodvibes-jev/engine/platform/contracts';
import { delegatedOperatorConnection, forgetDelegatedCredential, type DelegatedOperatorConnection } from './agent-delegation-credential.js';
import { createConnectedHost, isHostFailure, type ConnectedHostConfigReader } from './connected-host-client.js';
import { operatorRouteLabel, type FamilyGatewayRemote, type FamilyGatewayResult } from './family-gateway.js';
import type { AgentInProcessHost } from './in-process-host.js';
import { captureOperatorConnection } from './operator-connection-owner.js';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';

export interface ConnectedHostFamilyRemoteOptions {
  /** Settings naming the connected host (`controlPlane.*`), read when the call is made. */
  readonly configManager: ConnectedHostConfigReader;
  /** The home whose Agent credential stores the call uses. */
  readonly homeDirectory: string;
  /** The daemon hosting this turn, reached through its own request path; absent in the Agent's own process. */
  readonly inProcess?: AgentInProcessHost | undefined;
}

function failureText(methodId: OperatorMethodId, kind: string, route: string, baseUrl: string, message: string): string {
  return [
    `Connected-host call failed: ${methodId} (${kind})`,
    `  route ${route}`,
    baseUrl ? `  connected host ${baseUrl}` : '',
    `  ${message}`,
  ].filter(Boolean).join('\n');
}

/** The connected-host route of the profile and occasions families, in the Agent's process and in a turn the daemon hosts. */
export function connectedHostFamilyRemote(options: ConnectedHostFamilyRemoteOptions): FamilyGatewayRemote {
  return async (methodId, body, lifetime, assertCurrent) => {
    const ordinary = captureOperatorConnection(options, options.configManager, assertCurrent, options.inProcess);
    let delegated: DelegatedOperatorConnection | undefined;
    if (lifetime.delegation) {
      try { delegated = await delegatedOperatorConnection(ordinary, options.homeDirectory, lifetime.signal); }
      catch (error) {
        lifetime.signal?.throwIfAborted();
        return { ok: false, data: null, error: summarizeError(error), route: 'connected-host' };
      }
    }
    const connection = delegated ?? ordinary;
    lifetime.signal?.throwIfAborted();
    connection.assertCurrent();
    const host = createConnectedHost(() => ({
      baseUrl: connection.baseUrl,
      token: connection.token,
      credential: connection.tokenPath,
      ...(connection.source === undefined ? {} : { source: connection.source }),
      ...(connection.unavailable === undefined ? {} : { unavailable: connection.unavailable }),
      ...(connection.fetch === undefined ? {} : { fetch: connection.fetch }),
    }));
    // Settle the typed result before it is awaited: awaiting a still-generic
    // operator output makes TypeScript expand every method's output.
    return host.invoke(methodId, body, { signal: lifetime.signal }).then(
      (data): FamilyGatewayResult => ({ ok: true, data, route: 'connected-host' }),
      async (error: unknown): Promise<FamilyGatewayResult> => {
        if (!isHostFailure(error)) {
          return { ok: false, data: null, route: 'connected-host',
            error: failureText(methodId, 'connected_host_error', operatorRouteLabel(methodId), connection.baseUrl, error instanceof Error ? error.message : String(error)) };
        }
        // A delegated credential the host no longer accepts is forgotten; the next call makes a new one.
        if (delegated && error.refusal.code === 'auth_rejected') await forgetDelegatedCredential(delegated);
        return { ok: false, data: null, route: 'connected-host', error: failureText(methodId, error.kind, error.route, error.baseUrl, error.message) };
      },
    );
  };
}
