/**
 * in-process-host.ts, the connected host of an Agent turn the daemon hosts:
 * the daemon itself.
 *
 * The Agent's operator tools reach their host through the connected-host
 * client. In a turn the daemon hosts, that host is the daemon, so a request
 * goes through the daemon's own request path (`HostedDaemonRequestPath`): the
 * same authentication, access gate and handlers as a request that came over
 * the network, without a socket. The daemon serves it as a request from its
 * own machine, which it is.
 *
 * The credentials are the ones the Agent presents to a daemon on the same
 * machine, with the Agent's one precedence, so every call is admitted and
 * judged as it is in the Agent's own process. Both ordinary credentials carry
 * full operator authority, which is why the daemon creates an Agent session
 * only for a caller that holds admin (sessions.hosted.create):
 * - an ordinary call carries the Agent's pairing with this daemon when there is
 *   one (credential kind `device-token`), otherwise the daemon's operator
 *   credential (credential kind `local`, as the Agent's operator token file
 *   read on this machine is);
 * - a call the Agent makes on the owner's behalf is switched by the tool to the
 *   Agent's delegated credential (credential kind `agent`,
 *   agent-delegation-credential.ts), minted over this same path and kept in the
 *   same delegation store under this daemon's address, so the daemon judges it
 *   as the Agent's.
 */
import type { OperatorMethodId, OperatorMethodInput } from '@goodvibes-jev/engine/platform/contracts';
import type { HostedDaemonRequestPath } from '@goodvibes-jev/engine/platform/platform/hosted-sessions';
import type { DaemonVerbCaller } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { readConnectedHostPairing } from './connected-host-auth.js';
import { describeUnreadableAgentHostPairing } from './connected-host-pairing-store.js';
import { createConnectedHost, type ConnectedHostConnection } from './connected-host-client.js';

/** The daemon hosting this Agent turn, as the connected-host client reaches it. */
export interface AgentInProcessHost {
  /** The connection the next call uses: this daemon in process, with the Agent's ordinary credential for it. Never throws. */
  connection(): ConnectedHostConnection;
}

export interface AgentInProcessHostOptions {
  /** The daemon's own request path and operator credential. */
  readonly requests: HostedDaemonRequestPath;
  /** The daemon's address as the Agent dials it: requests are built on it, and it keys the Agent's pairing and delegated credential. */
  readonly baseUrl: string;
  /** The home whose Agent stores keep those credentials (the daemon's, the owner's). */
  readonly homeDirectory: string;
}

const PAIRING_CREDENTIAL = 'Agent host-bound pairing store';
const OPERATOR_CREDENTIAL = 'the daemon\'s operator credential, presented in process';

export function createAgentInProcessHost(options: AgentInProcessHostOptions): AgentInProcessHost {
  // One transport for the host's life: the operator client built on it (and its
  // schema table) is cached per transport, so every call reuses it.
  const serve = ((input: string | URL | Request, init?: RequestInit) => options.requests.serve(
    input instanceof Request ? new Request(input, init) : new Request(input instanceof URL ? input.href : input, init),
  )) as typeof fetch;
  const operator = { baseUrl: options.baseUrl, source: 'in-process' as const, credential: OPERATOR_CREDENTIAL, fetch: serve };
  const paired = { baseUrl: options.baseUrl, source: 'pairing' as const, credential: PAIRING_CREDENTIAL, fetch: serve };
  const connection = (): ConnectedHostConnection => {
    // The Agent's precedence: its pairing with this host first, then the operator credential.
    const pairing = readConnectedHostPairing(options.homeDirectory, options.baseUrl);
    if (pairing.status === 'paired') {
      return { ...paired, token: pairing.token, expectedPrincipalId: `pairing:${pairing.tokenId}` };
    }
    if (pairing.status === 'unknown') {
      return { ...paired, token: null, unavailable: {
        code: 'credential_unreadable',
        reason: 'the reply to this Agent\'s pairing request with this daemon was lost',
        next: ['run goodvibes-agent setup pair to repeat the same request (the daemon answers it with the credential it made), then retry'],
      } };
    }
    if (pairing.status === 'unavailable') {
      return { ...paired, token: null, unavailable: {
        code: 'credential_unreadable',
        reason: describeUnreadableAgentHostPairing(pairing),
        next: ['repair or remove the saved pairing under ~/.goodvibes/agent/connected-host-pairings, then retry'],
      } };
    }
    // Read live: a rotated operator token is used from the next call on.
    const token = options.requests.operatorToken();
    if (token) return { ...operator, token };
    return {
      ...operator, token: null,
      unavailable: {
        code: 'no_credential',
        reason: 'this daemon signs in with login sessions only, so it has no operator credential, and the Agent is not paired with it; nothing was sent',
        next: ['pair the GoodVibes Agent with this daemon (goodvibes-agent setup pair), then retry'],
      },
    };
  };
  return { connection };
}

/**
 * The verb caller the platform's client seams take, over the daemon hosting
 * this turn: a verb goes through the daemon's own request path with the
 * Agent's ordinary credential for it. A refusal is the host's answer (a
 * `HostFailure` with its status); without a credential, `probe` says so and
 * nothing is sent.
 */
export function inProcessVerbCaller(host: AgentInProcessHost): Pick<DaemonVerbCaller, 'probe' | 'invoke'> {
  const client = createConnectedHost(() => host.connection(), { validateResponses: false });
  return {
    probe: () => {
      const connection = host.connection();
      return connection.token ? { available: true } : { available: false, reason: connection.unavailable?.reason ?? 'the Agent has no credential for this daemon' };
    },
    // The seam names verbs by id; the contract's typed input is the caller's to keep.
    invoke: async <T = unknown>(methodId: string, input?: unknown): Promise<T> => {
      const output: unknown = await client.invoke(methodId as OperatorMethodId, (input ?? {}) as OperatorMethodInput<OperatorMethodId>);
      return output as T;
    },
  };
}
