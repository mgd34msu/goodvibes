/**
 * in-process-host.ts, the connected host of an Agent turn the daemon hosts:
 * the daemon itself.
 *
 * The Agent's operator tools reach their host through the connected-host
 * client. In a turn the daemon hosts, that host is the daemon, so a request
 * goes through the daemon's own request path (`HostedDaemonRequestPath`): the
 * same authentication, access gate and handlers as a request that came over
 * the network, without a socket.
 *
 * Every request presents the Agent's own credential for this daemon, the
 * pairing the daemon marks as the Agent's (credential kind `agent`), so the
 * handlers judge each call as the Agent's exactly as they judge the paired
 * Agent's call over the wire. It is the credential the Agent process keeps for
 * the same host (agent-delegation-credential.ts): made once with the daemon's
 * operator credential, kept in the Agent's delegation store under this
 * daemon's address, forgotten when the daemon refuses it (it was revoked) and
 * made again for the next call.
 *
 * Resolving the connection reads the store once and never waits: while the
 * credential is being made, a call is refused with that said and nothing is
 * sent, instead of a request whose outcome would be unclear.
 */
import type { OperatorMethodId, OperatorMethodInput } from '@goodvibes-jev/engine/platform/contracts';
import type { HostedDaemonRequestPath } from '@goodvibes-jev/engine/platform/platform/hosted-sessions';
import type { DaemonVerbCaller } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { delegatedOperatorConnection, forgetDelegatedCredential, storedDelegatedCredential } from './agent-delegation-credential.js';
import { createConnectedHost, type ConnectedHostConnection } from './connected-host-client.js';

/** The daemon hosting this Agent turn, as the connected-host client reaches it. */
export interface AgentInProcessHost {
  /** The connection the next call uses: this daemon in process, with the Agent's credential for it. Never throws. */
  connection(): ConnectedHostConnection;
}

export interface AgentInProcessHostOptions {
  /** The daemon's own request path and operator credential. */
  readonly requests: HostedDaemonRequestPath;
  /** The daemon's address as the Agent dials it: requests are built on it, and it keys the Agent's credential. */
  readonly baseUrl: string;
  /** The home whose Agent delegation store keeps the credential (the daemon's, the owner's). */
  readonly homeDirectory: string;
}

/** Where the credential is, safe to show. */
const IN_PROCESS_CREDENTIAL = 'the Agent credential this daemon keeps for its own hosted Agent turns';

export function createAgentInProcessHost(options: AgentInProcessHostOptions): AgentInProcessHost {
  const serve = ((input: string | URL | Request, init?: RequestInit) => options.requests.serve(new Request(input, init))) as typeof fetch;
  let making: Promise<unknown> | null = null;

  /** Starts making the Agent's credential for this daemon, unless that is already under way. */
  const make = (): void => {
    if (making) return;
    const operatorToken = options.requests.operatorToken();
    making = delegatedOperatorConnection({
      baseUrl: options.baseUrl,
      token: operatorToken,
      tokenPath: 'the daemon operator credential',
      fetch: serve,
      assertCurrent: () => {},
    }, options.homeDirectory).catch((error: unknown) => {
      logger.warn('The Agent credential for hosted Agent turns was not made', { error: summarizeError(error) });
    }).finally(() => { making = null; });
  };

  const connection = (): ConnectedHostConnection => {
    const base = { baseUrl: options.baseUrl, source: 'in-process' as const, credential: IN_PROCESS_CREDENTIAL };
    const stored = storedDelegatedCredential(options.homeDirectory, options.baseUrl);
    if (stored.status === 'paired') {
      const { token, tokenId } = stored;
      const credentialed = (async (input: string | URL | Request, init?: RequestInit) => {
        const response = await options.requests.serve(new Request(input, init));
        // The daemon no longer accepts the credential (it was revoked): forget it, so the next call makes a new one.
        if (response.status === 401) {
          await forgetDelegatedCredential({
            baseUrl: options.baseUrl, token, tokenPath: IN_PROCESS_CREDENTIAL, assertCurrent: () => {},
            delegationTokenId: tokenId, delegationHost: options.baseUrl, homeDirectory: options.homeDirectory,
          }).catch(() => {});
        }
        return response;
      }) as typeof fetch;
      return { ...base, token, fetch: credentialed };
    }
    if (stored.status === 'unavailable') {
      return { ...base, token: null, unavailable: { code: 'credential_unreadable', reason: stored.reason,
        next: ['repair or remove the Agent delegation store the reason names, then retry'] } };
    }
    make();
    return {
      ...base, token: null,
      unavailable: {
        code: 'no_credential',
        reason: 'the Agent credential for this daemon is being made now, so nothing was sent',
        next: ['retry the call in a moment; if it keeps failing, read the daemon log for why the credential was not made'],
      },
    };
  };

  return { connection };
}

/**
 * The verb caller the platform's client seams take, over the daemon hosting
 * this turn: a verb goes through the daemon's own request path with the
 * Agent's credential. A refusal is the host's answer (a `HostFailure` with its
 * status); without a credential yet, `probe` says so and nothing is sent.
 */
export function inProcessVerbCaller(host: AgentInProcessHost): Pick<DaemonVerbCaller, 'probe' | 'invoke'> {
  const client = createConnectedHost(() => host.connection(), { validateResponses: false });
  return {
    probe: () => {
      const connection = host.connection();
      return connection.token ? { available: true } : { available: false, reason: connection.unavailable?.reason ?? 'the Agent has no credential for this daemon yet' };
    },
    // The seam names verbs by id; the contract's typed input is the caller's to keep.
    invoke: async <T = unknown>(methodId: string, input?: unknown): Promise<T> =>
      await client.invoke(methodId as OperatorMethodId, (input ?? {}) as OperatorMethodInput<OperatorMethodId>) as T,
  };
}
