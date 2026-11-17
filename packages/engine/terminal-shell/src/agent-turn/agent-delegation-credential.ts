/**
 * The credential this Agent presents for the calls it makes on the owner's
 * behalf (a schedule it changes, a draft it saves, a profile fact it records):
 * a pairing the host marks as the Agent's (`client: "agent"`). The host reports
 * it as credential `agent` and judges every call made with it, so which lane a
 * call takes is the host's fact about who sent it, never a field this Agent
 * writes in the body.
 *
 * It is minted once per host with the Agent's ordinary credential (which
 * already has owner access, so there is no pairing step), kept in a file only
 * this user can read, and reused. The mint carries an attempt id saved before
 * the request leaves, so a lost reply is settled by repeating the same request,
 * never by minting a second credential. When the host no longer accepts the
 * stored credential (it was revoked), it is forgotten and the next call mints
 * a new one. Revoking the Agent's own pairing revokes this one with it.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { createHostPairingStore, type HostPairingAttempt } from '../host-pairing-store.js';
import { parseMintedPairingToken, readHostPairingResponse } from '../native/native-paired-principal.js';
import type { CapturedOperatorConnection } from './operator-connection-owner.js';

const DELEGATION_UNAVAILABLE_REASON = 'The Agent delegation credential store is unavailable.';
const store = createHostPairingStore({
  unavailableReason: DELEGATION_UNAVAILABLE_REASON,
  surfaceRoot: 'agent',
  directory: 'connected-host-pairings',
  filename: 'delegations.json',
  strictOrigin: false,
});
/** How long the one mint request may take before its outcome is unknown. */
const MINT_DEADLINE_MS = 10_000;
/** Mints in flight in this process, by home and host: concurrent calls share one. */
const minting = new Map<string, Promise<{ readonly token: string; readonly tokenId: string }>>();

/** A connection that presents the Agent's delegated credential instead of its ordinary one. */
export interface DelegatedOperatorConnection extends CapturedOperatorConnection {
  readonly token: string;
  /** The host's id for the delegated credential, to forget it when the host refuses it. */
  readonly delegationTokenId: string;
  readonly delegationHost: string;
  readonly homeDirectory: string;
}

/** The delegated credential's user-visible name on the host. */
function delegationName(): string {
  const machine = hostname().replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48);
  return machine ? `GoodVibes Agent acting for you on ${machine}` : 'GoodVibes Agent acting for you';
}

/** The path of the store, safe to show. */
export function agentDelegationStorePath(homeDirectory: string): string {
  return store.hostPairingStorePath(homeDirectory);
}

/**
 * The connection to use for a call this Agent makes on the owner's behalf:
 * the same host, the Agent's delegated credential. Throws an error naming the
 * state and the next step when the credential cannot be had; nothing is sent
 * then. Costs one read of a small file when the credential is stored, and one
 * mint request the first time for a host.
 */
export async function delegatedOperatorConnection(connection: CapturedOperatorConnection, homeDirectory: string,
  signal?: AbortSignal): Promise<DelegatedOperatorConnection> {
  signal?.throwIfAborted();
  const host = store.canonicalizePairingHost(connection.baseUrl);
  if (!host) {
    throw new Error(`The connected host address ${connection.baseUrl} is not an http(s) origin, so this Agent's delegated credential cannot be bound to it; nothing was sent. Correct controlPlane.host and controlPlane.port.`);
  }
  const stored = store.readHostPairing(homeDirectory, host);
  if (stored.status === 'unavailable') throw new Error(`${stored.reason} Nothing was sent.`);
  let credential: { readonly token: string; readonly tokenId: string };
  if (stored.status === 'paired') credential = { token: stored.token, tokenId: stored.tokenId };
  else {
    const key = `${homeDirectory}\n${host}`;
    let pending = minting.get(key);
    if (!pending) {
      pending = mintDelegation(connection, homeDirectory, host).finally(() => minting.delete(key));
      minting.set(key, pending);
    }
    credential = await pending;
  }
  signal?.throwIfAborted();
  return {
    ...connection,
    token: credential.token,
    tokenPath: agentDelegationStorePath(homeDirectory),
    delegationTokenId: credential.tokenId,
    delegationHost: host,
    homeDirectory,
  };
}

/**
 * The host refused the delegated credential (401): it was revoked or the host
 * was reset. Forget it so the next delegated call mints a new one. Local only.
 */
export async function forgetDelegatedCredential(connection: DelegatedOperatorConnection): Promise<void> {
  await store.removeHostPairing(connection.homeDirectory, connection.delegationHost, connection.delegationTokenId);
}

async function mintDelegation(connection: CapturedOperatorConnection, homeDirectory: string, host: string): Promise<{ readonly token: string; readonly tokenId: string }> {
  if (!connection.token) {
    throw new Error(`This Agent has no connected-host credential to mint its delegated credential with (${connection.unavailable?.reason ?? `nothing found in ${connection.tokenPath}`}); nothing was sent. Provision the connected-host token or pair this Agent, then retry.`);
  }
  let state = store.readHostPairing(homeDirectory, host);
  if (state.status === 'paired') return { token: state.token, tokenId: state.tokenId };
  if (state.status === 'unavailable') throw new Error(`${state.reason} Nothing was sent.`);
  let attempt: HostPairingAttempt;
  if (state.status === 'unknown') attempt = { attemptId: state.attemptId, name: state.name, startedAt: state.startedAt };
  else {
    attempt = { attemptId: randomUUID(), name: delegationName(), startedAt: Date.now() };
    const begun = await store.beginHostPairing(homeDirectory, host, attempt);
    if (begun.status === 'unavailable') throw new Error(`${begun.reason} Nothing was sent.`);
    if (begun.status === 'conflict') {
      // Another process of this Agent saved an attempt or a credential first.
      state = store.readHostPairing(homeDirectory, host);
      if (state.status === 'paired') return { token: state.token, tokenId: state.tokenId };
      if (state.status !== 'unknown') throw new Error('This Agent\'s delegated credential changed while it was being made; nothing was sent. Retry.');
      attempt = { attemptId: state.attemptId, name: state.name, startedAt: state.startedAt };
    }
  }
  let response: Response;
  try {
    // `pairing.tokens.create` has no route of its own in the operator contract.
    response = await fetch(`${host}/api/control-plane/methods/pairing.tokens.create/invoke`, {
      method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: { name: attempt.name, attemptId: attempt.attemptId, client: 'agent' } }),
      signal: AbortSignal.timeout(MINT_DEADLINE_MS),
    });
  } catch {
    throw new Error('The host did not answer the request for this Agent\'s delegated credential; nothing else was sent. Retry: the same request is repeated, and the host answers it with the credential it made, never a second one.');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    // A refusal before any minting (other than a timeout or a conflict) proves nothing was made.
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 409) {
      await store.clearHostPairingAttempt(homeDirectory, host, attempt.attemptId);
    }
    throw new Error(response.status === 404
      ? 'The host is older than this Agent and cannot make its delegated credential (HTTP 404); nothing else was sent. Update GoodVibes on the host.'
      : `The host refused to make this Agent's delegated credential (HTTP ${response.status}); nothing else was sent. Check that this Agent's credential has owner access (write:control-plane), then retry.`);
  }
  const minted = parseMintedPairingToken(await readHostPairingResponse(response), attempt.name);
  if (!minted) throw new Error('The host answered the request for this Agent\'s delegated credential in a shape this Agent cannot read; nothing else was sent. Run the same GoodVibes version on both, then retry.');
  const completed = await store.completeHostPairing(homeDirectory, host, attempt.attemptId,
    { token: minted.token, tokenId: minted.id, name: attempt.name, createdAt: minted.createdAt });
  if (completed.status === 'unavailable') throw new Error(`${completed.reason} The credential the host made was not kept; retry to have it made again.`);
  if (completed.status !== 'paired') throw new Error('This Agent\'s delegated credential changed while it was being saved; nothing else was sent. Retry.');
  return { token: minted.token, tokenId: minted.id };
}
