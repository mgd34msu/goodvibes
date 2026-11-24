import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { resolveConnectedHostDialEnabled } from '@goodvibes/engine/platform/platform/config';
import { resolveConnectedHostAddress } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-dial';
import { createConnectedHost, isHostFailure, resolveConnectedHost, type ConnectedHostConnection } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-client';
import type { AgentDaemonVerbCallerOptions } from './client/daemon-verbs.ts';
import { environmentConnectedHostToken, readConnectedHostBootstrapToken } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-auth';
import { isHostPairingBootstrapPrincipal, isNativePairedPrincipal, parseMintedPairingToken, readHostPairingResponse } from './native-paired-principal.ts';
import { agentHostPairingStorePath, beginAgentHostPairing, canonicalizePairingHost, clearAgentHostPairingAttempt, completeAgentHostPairing, readAgentHostPairing, removeAgentHostPairing, type RemoveAgentHostPairingResult } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-pairing-store';

export interface AgentHostPairingResult {
  readonly status:
    | 'preview' | 'blocked' | 'already-paired' | 'cancelled' | 'changed' | 'unknown' | 'rejected' | 'cleared'
    | 'paired' | 'paired-unverified' | 'paired-shadowed'
    // Why pairing could not start or finish, from local facts and the host's status code:
    | 'no-host-configured' | 'pairing-store-unreadable' | 'no-credential' | 'credential-rejected'
    | 'host-unreachable' | 'host-timeout' | 'host-lacks-pairing' | 'host-error';
  readonly message: string;
  readonly host?: string;
  readonly name?: string;
  readonly confirmation?: string;
  /** What typing the confirmation does, when it is not creating the credential. */
  readonly confirmationPrompt?: string;
  readonly scopeDisclosure?: string;
  readonly environmentOverride?: boolean;
}

export interface AgentHostPairingPreview {
  readonly result: AgentHostPairingResult;
  /** Only a live owner-terminal pairing controller may call this one-shot capability. */
  readonly confirm?: (answer: string, signal?: AbortSignal) => Promise<AgentHostPairingResult>;
}

/** How long one auth check against the host may take. */
export const PAIRING_AUTH_DEADLINE_MS = 5_000;
/** How long the mint request may take before its outcome is unknown. */
const PAIRING_MINT_DEADLINE_MS = 5_000;

/** The store's own refusal (cause, path, fix) when it gave one; otherwise the store path and the usual fixes. */
const storeUnreadable = (home: string, refusal?: { readonly status: string; readonly reason?: string }): AgentHostPairingResult => ({
  status: 'pairing-store-unreadable',
  message: refusal?.status === 'unavailable' && refusal.reason
    ? `${refusal.reason} Nothing was created.`
    : `The pairing file at ${agentHostPairingStorePath(home)} cannot be read or written. Fix its permissions or move the damaged file aside, then pair again. Nothing was created.`,
});
const unknown = (host: string): AgentHostPairingResult => ({ status: 'unknown', host, message: 'The host\'s answer to the pairing request was lost, so this Agent does not know whether the host made its access key. Run setup pair again: the host answers the same request with the same key, never a second one.' });
const rejected = (host: string, status: number, repeat: boolean): AgentHostPairingResult => ({
  status: 'rejected', host,
  message: repeat
    ? `The host refused the repeated pairing request (HTTP ${status}), so this Agent forgot the unfinished attempt; a key the host made for it was never received and cannot be used. Check that this host allows pairing, then pair again.`
    : `The host refused to pair (HTTP ${status}); nothing was created. Check that this host allows pairing, then pair again.`,
});
// A refusal before any minting (a 4xx other than a timeout or a conflict, or a host that was not listening) proves no credential exists.
const refusedWithoutMinting = (status: number): boolean => status >= 400 && status < 500 && status !== 408 && status !== 409;
const connectionRefused = (error: unknown): boolean => {
  for (const value of [error, (error as { cause?: unknown } | null)?.cause]) {
    const code = (value as { code?: unknown } | null)?.code;
    // Node names it by errno, Bun by `ConnectionRefused`.
    if (code === 'ECONNREFUSED' || code === 'ConnectionRefused') return true;
  }
  return false;
};
const changed = (): AgentHostPairingResult => ({ status: 'changed', message: 'The host, the key this Agent uses for it, or this Agent\'s pairing changed after the summary was shown. Nothing was sent. Pair again to see the new summary before you confirm.' });
const cancelled = (): AgentHostPairingResult => ({ status: 'cancelled', message: 'Pairing cancelled. Nothing was sent to the host and nothing was changed.' });
/** An answer that is not the code shown: a cancel, said as what happened. Each code works once, so a new one is needed. */
const notTheCode = (answer: string): AgentHostPairingResult => (answer.trim() === ''
  ? cancelled()
  : { status: 'cancelled', message: 'That is not the code shown, so nothing was sent to the host and nothing was changed. Run setup pair again for a new code.' });
/** Whether an environment token outranks the pairing for `host` (this machine's daemon token only for this machine). */
const envOverride = (host: string): boolean => environmentConnectedHostToken(host) !== null;

/**
 * A failed auth check, worded from the failure's code and status. The host's own
 * error text is never repeated.
 */
function authCheckFailed(error: unknown, host: string, aborted: boolean): AgentHostPairingResult {
  if (aborted) return cancelled();
  if (!isHostFailure(error)) return { status: 'host-error', host, message: `This Agent could not check its access to ${host}. Pair again; nothing was created.` };
  const { code, status } = error.refusal;
  switch (code) {
    case 'cancelled': return cancelled();
    case 'host_timeout':
      return { status: 'host-timeout', host, message: `The host at ${host} did not answer within ${PAIRING_AUTH_DEADLINE_MS / 1000} s. Check that the daemon there is running and reachable from this computer, then pair again. Nothing was created.` };
    case 'host_unreachable':
    case 'route_unavailable':
      return { status: 'host-unreachable', host, message: `No GoodVibes daemon answered at ${host}. Start the daemon there or correct daemon.connectedHost.url, then pair again. Nothing was created.` };
    case 'auth_rejected':
    case 'forbidden':
      return { status: 'credential-rejected', host, message: `The host at ${host} did not accept the key this Agent has for it (HTTP ${status ?? 401}). Give this Agent the host's operator token, then pair again. Nothing was created.` };
    case 'incompatible':
      return { status: 'host-lacks-pairing', host, message: `The GoodVibes on the host at ${host} is older than this Agent and cannot pair (HTTP 404). Update GoodVibes on the host, then pair again. Nothing was created.` };
    default:
      return { status: 'host-error', host, message: `The host at ${host} failed when this Agent checked its access${status === undefined ? '' : ` (HTTP ${status})`}. Read the daemon log on the host, then pair again. Nothing was created.` };
  }
}

/**
 * An unresolved attempt that could not be repeated (no credential to send, or
 * the host still did not answer). Clearing it is an owner-terminal action: it
 * only deletes the local marker. A credential the host minted for it was an
 * offer nobody received, so it never authenticates and lapses unused.
 */
function clearPreview(home: string, host: string, attemptId: string, notRepeated?: string): AgentHostPairingPreview {
  const confirmation = `CLEAR ${randomBytes(6).toString('hex')}`;
  let consumed = false;
  return {
    result: {
      ...unknown(host),
      confirmation,
      confirmationPrompt: 'forget the unfinished attempt and pair from scratch',
      message: `${unknown(host).message}${notRepeated ? ` It was not repeated now: ${notRepeated}` : ''} Or confirm below to forget the attempt and pair from scratch; a key the host made for it was never received, so it cannot sign in and stops working within 15 minutes.`,
    },
    async confirm(answer) {
      if (consumed) return cancelled();
      if (answer !== confirmation) return notTheCode(answer);
      consumed = true;
      const cleared = await clearAgentHostPairingAttempt(home, host, attemptId);
      if (cleared.status === 'cleared') return { status: 'cleared', host, message: 'The unfinished attempt was forgotten. Run setup pair to pair.' };
      return cleared.status === 'conflict' ? changed() : storeUnreadable(home, cleared);
    },
  };
}

/** What forgetting a stored credential did. The token stays valid on the host until it is revoked there. */
function forgotten(result: RemoveAgentHostPairingResult, host: string, tokenId: string): AgentHostPairingResult {
  if (result.status === 'unavailable') return { status: 'pairing-store-unreadable', host, message: `${result.reason} Nothing was forgotten.` };
  if (result.status === 'removed') return { status: 'cleared', host, message: `This Agent forgot its key for the host (key ${tokenId}). The host still accepts that key until you revoke it there, in its paired devices. Run setup pair to pair again.` };
  return changed();
}

/**
 * The host answered 401 or 403 to the stored device credential: it was revoked
 * or the daemon there was reset. Forgetting it locally is offered so this Agent
 * can pair again; the owner confirms with a fresh phrase.
 */
function forgetPreview(home: string, host: string, tokenId: string): AgentHostPairingPreview {
  const confirmation = `FORGET ${randomBytes(6).toString('hex')}`;
  let consumed = false;
  return {
    result: {
      status: 'credential-rejected', host, confirmation,
      confirmationPrompt: 'forget the key this Agent keeps for the host, so it can pair again',
      message: `The host at ${host} no longer accepts the key this Agent keeps for it (it was revoked, or the daemon there was reset). Confirm below to forget it, then run setup pair to pair again.`,
    },
    async confirm(answer) {
      if (consumed) return cancelled();
      if (answer !== confirmation) return notTheCode(answer);
      consumed = true;
      return forgotten(await removeAgentHostPairing(home, host, tokenId), host, tokenId);
    },
  };
}

/**
 * `goodvibes-agent setup unpair` and `/setup unpair`: forget this Agent's
 * stored device credential for the selected host. Local only; nothing is sent.
 */
export async function unpairAgentHost(options: Pick<AgentDaemonVerbCallerOptions, 'configManager' | 'homeDirectory'>): Promise<AgentHostPairingResult> {
  const home = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
  const configured = resolveConnectedHostAddress(options.configManager).baseUrl;
  const host = canonicalizePairingHost(configured);
  if (!host) return { status: 'no-host-configured', message: `The host address (${configured}) is not a usable http:// or https:// address, so there is no key to forget. Set daemon.connectedHost.url to name the host.` };
  const state = readAgentHostPairing(home, host);
  if (state.status === 'unavailable') return { status: 'pairing-store-unreadable', host, message: `${state.reason} Nothing was forgotten.` };
  if (state.status === 'missing') return { status: 'blocked', host, message: 'This Agent keeps no key for this host; nothing to forget.' };
  if (state.status === 'unknown') return { ...unknown(host), message: `${unknown(host).message} Or run setup pair to look at the unfinished attempt and forget it.` };
  return forgotten(await removeAgentHostPairing(home, host, state.tokenId), host, state.tokenId);
}

type MigrationOutcome =
  | { readonly status: 'paired'; readonly token: string; readonly tokenId: string }
  | { readonly status: 'settled'; readonly result: AgentHostPairingResult };

/**
 * One `pairing.tokens.migrate` request for the attempt whose marker stands,
 * then the minted credential stored for this host. The attempt id goes with
 * it: sending the same attempt again after a lost reply is answered with the
 * offer the host already made (same token id, new secret) while it is unused,
 * so a repeat never adds a credential. A refusal before minting releases the
 * marker; a lost or failed reply leaves it, because the host may have minted.
 */
async function sendAgentMigration(input: {
  readonly home: string; readonly host: string; readonly token: string; readonly name: string; readonly attemptId: string;
  /** This attempt was sent before, so an unreachable host proves nothing about it. */
  readonly repeat: boolean;
  readonly fetchImpl?: typeof fetch | undefined; readonly signal?: AbortSignal | undefined;
}): Promise<MigrationOutcome> {
  const { home, host, name, attemptId, signal } = input;
  const settled = (result: AgentHostPairingResult): MigrationOutcome => ({ status: 'settled', result });
  try {
    // `pairing.tokens.migrate` has no route of its own in the operator
    // contract, so it goes through the daemon's invoke-by-id route.
    const response = await (input.fetchImpl ?? fetch)(`${host}/api/control-plane/methods/pairing.tokens.migrate/invoke`, {
      method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: { name, attemptId } }),
      signal: AbortSignal.any([AbortSignal.timeout(PAIRING_MINT_DEADLINE_MS), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (!refusedWithoutMinting(response.status)) return settled(unknown(host));
      if ((await clearAgentHostPairingAttempt(home, host, attemptId)).status !== 'cleared') return settled(unknown(host));
      return settled(response.status === 404
        ? { status: 'host-lacks-pairing', host, message: `The host at ${host} does not offer pairing (HTTP 404); it runs an older GoodVibes. Update GoodVibes on the host, then pair again. Nothing was created.` }
        : rejected(host, response.status, input.repeat));
    }
    const minted = parseMintedPairingToken(await readHostPairingResponse(response), name);
    if (!minted) return settled(unknown(host));
    const complete = await completeAgentHostPairing(home, host, attemptId, { token: minted.token, tokenId: minted.id, name, createdAt: minted.createdAt });
    if (complete.status !== 'paired') return settled(unknown(host));
    return { status: 'paired', token: minted.token, tokenId: minted.id };
  } catch (error) {
    if (!input.repeat && connectionRefused(error) && (await clearAgentHostPairingAttempt(home, host, attemptId)).status === 'cleared') {
      return settled({ status: 'host-unreachable', host, message: `No GoodVibes daemon answered at ${host} when the pairing request was sent. Start the daemon there, then pair again. Nothing was created.` });
    }
    return settled(unknown(host));
  }
}

/** Preview is read-only, except that an attempt the owner already confirmed
 * and whose reply was lost is repeated under its own id. The returned one-shot
 * capability binds the exact host, source credential, name and store state to
 * a fresh terminal confirmation. No raw token, credential digest or remote
 * error leaves this module.
 */
export async function previewAgentHostPairing(
  options: AgentDaemonVerbCallerOptions,
  name = 'GoodVibes Agent',
  signal?: AbortSignal,
): Promise<AgentHostPairingPreview> {
  let host: string | null = null;
  try {
    if (signal?.aborted) return { result: cancelled() };
    if (!name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) return { result: { status: 'blocked', message: 'Use a nonempty pairing name of at most 80 characters without control characters.' } };
    name = name.trim();
    if (!resolveConnectedHostDialEnabled(options.configManager)) return { result: { status: 'blocked', message: 'This Agent is set not to reach its daemon (daemon.connectedHost.enabled is false). Turn it on in settings, then pair again. Nothing was sent.' } };
    const home = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
    const address = resolveConnectedHostAddress(options.configManager);
    if (address.refusal) return { result: { status: 'no-host-configured', message: `${address.refusal} Then pair again. Nothing was sent.` } };
    const configured = address.baseUrl;
    host = canonicalizePairingHost(configured);
    if (!host) return { result: { status: 'no-host-configured', message: `The host address (${configured}) is not a usable http:// or https:// address. Set daemon.connectedHost.url to the GoodVibes daemon, then pair again.` } };
    const pairingHost = host;
    const state = readAgentHostPairing(home, pairingHost);
    if (state.status === 'unavailable') return { result: storeUnreadable(home, state) };
    const selection = { configManager: options.configManager, homeDirectory: options.homeDirectory };
    const selectedHostNow = (): string | null => {
      const now = resolveConnectedHostAddress(options.configManager);
      return now.refusal ? null : canonicalizePairingHost(now.baseUrl);
    };
    const selected = resolveConnectedHost(selection);
    const fetchOption = options.fetchImpl ? { fetchImpl: options.fetchImpl } : {};
    const verifyAs = (token: string, callSignal: AbortSignal | undefined) => {
      const connection: ConnectedHostConnection = { baseUrl: pairingHost, token, credential: selected.credential };
      return createConnectedHost(() => connection, fetchOption)
        .invoke('control.auth.current', {}, { signal: callSignal, deadlineMs: PAIRING_AUTH_DEADLINE_MS });
    };
    // A freshly stored credential counts as paired only once the host verifies it as this device
    // and it is what this Agent will present. `sourceToken` is the credential that asked for it.
    const verifyStored = async (minted: { readonly token: string; readonly tokenId: string }, sourceToken: string, verifySignal: AbortSignal | undefined): Promise<AgentHostPairingResult> => {
      // Persist before verifying: a lost verification reply must never lose
      // the only copy of the newly issued credential or cause another mint.
      if (verifySignal?.aborted) return { status: 'paired-unverified', host: pairingHost, message: 'This Agent kept its new key for this host, but checking it was interrupted. Run setup status to check it; pairing again is not needed and would not make a second key.' };
      let pairedAuth;
      try { pairedAuth = await verifyAs(minted.token, verifySignal); }
      catch (error) {
        const cause = authCheckFailed(error, pairingHost, Boolean(verifySignal?.aborted));
        return { status: 'paired-unverified', host: pairingHost, message: `This Agent kept its new key for this host, but the host could not confirm it just now (${cause.status}). Run setup status to check again; do not pair again yet.` };
      }
      if (!isNativePairedPrincipal(pairedAuth) || pairedAuth.principalId !== `pairing:${minted.tokenId}`) return { status: 'paired-unverified', host: pairingHost, message: 'This computer is paired, but the host did not confirm the new key as this device. Open the host and check its paired devices; do not pair again yet.' };
      const finalHome = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
      if (finalHome !== home || !resolveConnectedHostDialEnabled(options.configManager)
        || selectedHostNow() !== pairingHost
        || (envOverride(pairingHost) && readConnectedHostBootstrapToken(home, pairingHost).token !== sourceToken)) return { status: 'paired-unverified', host: pairingHost, message: 'This Agent kept its new key for the host it paired with, but the host, the Agent home, the connection switch or a key in the environment changed meanwhile. Run setup status to check.' };
      if (envOverride(pairingHost)) return { status: 'paired-shadowed', host: pairingHost, message: 'This Agent kept its new key for this host, but a key set in the environment is still used first. Review that environment variable, then run setup status; nothing in the environment was changed.' };
      const effective = resolveConnectedHost(selection);
      if (canonicalizePairingHost(effective.baseUrl) !== pairingHost || effective.token !== minted.token) return { status: 'paired-unverified', host: pairingHost, message: 'This Agent kept its new key for the host it paired with, but which host and key it uses now could not be confirmed. Run setup status before starting work on the host.' };
      return { status: 'paired', host: pairingHost, message: 'Paired: this Agent has its own key for the host, and the host confirmed it. Models, the workspace and the decision model are checked separately (setup status).' };
    };
    if (state.status === 'unknown') {
      // The owner confirmed this attempt when it was first sent; it is repeated
      // under its own id, which the host answers with the credential it already
      // made (or a first one), never a second. The marker hides the host-bound
      // credential, so the request goes with the bootstrap credential for this
      // host: an environment token, or this machine's daemon token only when the
      // host is this machine.
      const bootstrapCredential = readConnectedHostBootstrapToken(home, pairingHost);
      const bootstrap = bootstrapCredential.token;
      if (!bootstrap) return clearPreview(home, pairingHost, state.attemptId, bootstrapCredential.error);
      const outcome = await sendAgentMigration({ home, host: pairingHost, token: bootstrap, name: state.name, attemptId: state.attemptId, repeat: true, fetchImpl: options.fetchImpl, signal });
      if (outcome.status === 'paired') return { result: await verifyStored(outcome, bootstrap, signal) };
      if (outcome.result.status === 'unknown') return clearPreview(home, pairingHost, state.attemptId);
      return { result: outcome.result };
    }
    if (selected.token === null) {
      return { result: { status: 'no-credential', host: pairingHost, message: `No key to pair with: ${selected.unavailable?.reason ?? `nothing found in ${selected.credential}`}. Pairing starts from the host's shared operator token: give it to this Agent, then pair again.` } };
    }
    const selectedToken = selected.token;
    const current = (): boolean => {
      const nowHome = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
      const now = resolveConnectedHost(selection);
      return nowHome === home && now.baseUrl === selected.baseUrl && now.token === selectedToken;
    };
    let auth;
    try { auth = await verifyAs(selectedToken, signal); }
    catch (error) {
      // Only the stored device credential itself being refused is offered for
      // forgetting; a rejected environment or shared token is not this store's.
      if (!signal?.aborted && state.status === 'paired' && selectedToken === state.token && isHostFailure(error)
        && (error.refusal.code === 'auth_rejected' || error.refusal.code === 'forbidden')) return forgetPreview(home, pairingHost, state.tokenId);
      return { result: authCheckFailed(error, pairingHost, Boolean(signal?.aborted)) };
    }
    if (signal?.aborted) return { result: cancelled() };
    if (!current() || !isDeepStrictEqual(readAgentHostPairing(home, pairingHost), state)) return { result: changed() };
    if (state.status === 'paired' || isNativePairedPrincipal(auth)) {
      return { result: { status: 'already-paired', host: pairingHost, message: 'This Agent is already paired with this host. Pairing again would not make or replace its key; run setup status to check it, or setup unpair to forget it.' } };
    }
    if (!isHostPairingBootstrapPrincipal(auth)) return { result: { status: 'blocked', host: pairingHost, message: 'To pair, the host must accept the shared operator token this Agent has, with permission to change the host; it did not. No key was created.' } };
    const confirmation = `PAIR ${randomBytes(6).toString('hex')}`;
    let consumed = false;
    const result: AgentHostPairingResult = {
      status: 'preview', host: pairingHost, name, confirmation, confirmationPrompt: 'give this Agent its own administrator key for this host', environmentOverride: selected.source === 'environment',
      scopeDisclosure: 'Pairing gives this Agent its own lasting administrator key for this host: it can do anything an operator can there, including starting work and running agents. The key is kept only in this Agent home and works only with this host. The shared operator token keeps working; nothing is revoked.',
      message: 'Nothing has been created yet. Confirming sends one pairing request to the host. You type the code shown, not just y, because this access lasts until you revoke it: a y pressed by habit can never grant it.',
    };
    return { result, async confirm(answer, actionSignal) {
      if (consumed || actionSignal?.aborted) return cancelled();
      if (answer !== confirmation) { consumed = true; return notTheCode(answer); }
      consumed = true;
      let attempted = false;
      try {
        // Authority can be revoked after preview without replacing the local token.
        let live;
        try { live = await verifyAs(selectedToken, actionSignal); }
        catch (error) { return authCheckFailed(error, pairingHost, Boolean(actionSignal?.aborted)); }
        if (actionSignal?.aborted) return cancelled();
        if (!current() || !isDeepStrictEqual(readAgentHostPairing(home, pairingHost), state)) return changed();
        if (!isHostPairingBootstrapPrincipal(live)) return changed();
        const attemptId = randomUUID();
        // Checked under the store lock just before the marker is published: a
        // cancel or a change of host or credential while the lock is awaited
        // creates no attempt.
        const begin = await beginAgentHostPairing(home, pairingHost, { attemptId, name, startedAt: Date.now() }, {},
          () => !actionSignal?.aborted && current() && resolveConnectedHostDialEnabled(options.configManager) && selectedHostNow() === pairingHost);
        if (begin.status === 'cancelled') return actionSignal?.aborted ? cancelled() : changed();
        if (begin.status !== 'begun') return begin.status === 'conflict' ? changed() : storeUnreadable(home, begin);
        // While the durable marker stands, a failure is conservatively unknown
        // until an exact successful response is safely stored or the marker is released.
        attempted = true;
        // The marker now hides the host-bound credential, so the credential the
        // request goes with is read as a bootstrap for this host.
        const bootstrap = readConnectedHostBootstrapToken(home, pairingHost);
        const nowHome = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
        if (actionSignal?.aborted || nowHome !== home || !resolveConnectedHostDialEnabled(options.configManager)
          || selectedHostNow() !== pairingHost || bootstrap.token !== selectedToken) {
          // Nothing was sent, so nothing can have been minted: release the marker so pairing can be previewed again.
          const released = await clearAgentHostPairingAttempt(home, pairingHost, attemptId);
          if (released.status !== 'cleared') return unknown(pairingHost);
          return actionSignal?.aborted ? cancelled() : changed();
        }
        const outcome = await sendAgentMigration({ home, host: pairingHost, token: selectedToken, name, attemptId, repeat: false, fetchImpl: options.fetchImpl, signal: actionSignal });
        if (outcome.status !== 'paired') return outcome.result;
        return await verifyStored(outcome, selectedToken, actionSignal);
      } catch (error) {
        if (attempted) return unknown(pairingHost);
        if (actionSignal?.aborted) return cancelled();
        return { status: 'host-error', host: pairingHost, message: `Pairing stopped before anything was sent to the host: ${error instanceof Error ? error.name : 'unexpected failure'}. Pair again; nothing was created.` };
      }
    } };
  } catch (error) {
    if (signal?.aborted) return { result: cancelled() };
    return { result: { status: 'host-error', ...(host ? { host } : {}), message: `Pairing stopped before anything was sent to the host: ${error instanceof Error ? error.name : 'unexpected failure'}. Pair again; nothing was created.` } };
  }
}
