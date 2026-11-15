import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { resolveConnectedHostDialEnabled } from '@goodvibes-jev/engine/platform/platform/config';
import { resolveConnectedHostBaseUrl } from '../config/connected-host-dial.ts';
import { createConnectedHost, isHostFailure, resolveConnectedHost, type ConnectedHostConnection } from '../agent/connected-host-client.ts';
import type { AgentDaemonVerbCallerOptions } from './client/daemon-verbs.ts';
import { readConnectedHostOperatorToken } from './connected-host-auth.ts';
import { isHostPairingBootstrapPrincipal, isNativePairedPrincipal, parseMintedPairingToken, readHostPairingResponse } from './native-paired-principal.ts';
import { agentHostPairingStorePath, beginAgentHostPairing, canonicalizePairingHost, clearAgentHostPairingAttempt, completeAgentHostPairing, readAgentHostPairing } from './connected-host-pairing-store.ts';

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

const storeUnreadable = (home: string): AgentHostPairingResult => ({ status: 'pairing-store-unreadable', message: `The pairing store at ${agentHostPairingStorePath(home)} cannot be read or written. Fix its permissions or move the damaged file aside, then preview again. Nothing was created.` });
const unknown = (host: string): AgentHostPairingResult => ({ status: 'unknown', host, message: 'A pairing attempt may already have created a credential. Its outcome must be reviewed on this host; no automatic remint or revoke is allowed.' });
const rejected = (host: string, status: number): AgentHostPairingResult => ({ status: 'rejected', host, message: `The host refused the pairing request (HTTP ${status}); nothing was created. Check that this host allows pairing, then preview again.` });
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
const changed = (): AgentHostPairingResult => ({ status: 'changed', message: 'The selected host, effective credential or local pairing state changed. Preview again before confirming.' });
const cancelled = (): AgentHostPairingResult => ({ status: 'cancelled', message: 'Pairing cancelled before the migration request.' });
const envOverride = (): boolean => Boolean(process.env.GOODVIBES_CONNECTED_HOST_TOKEN?.trim() || process.env.GOODVIBES_DAEMON_TOKEN?.trim());

/**
 * A failed auth check, worded from the failure's code and status. The host's own
 * error text is never repeated.
 */
function authCheckFailed(error: unknown, host: string, aborted: boolean): AgentHostPairingResult {
  if (aborted) return cancelled();
  if (!isHostFailure(error)) return { status: 'host-error', host, message: `The auth check against ${host} could not be made. Preview again; nothing was created.` };
  const { code, status } = error.refusal;
  switch (code) {
    case 'cancelled': return cancelled();
    case 'host_timeout':
      return { status: 'host-timeout', host, message: `The host at ${host} did not answer within ${PAIRING_AUTH_DEADLINE_MS / 1000} s. Check that the daemon there is running and reachable from this machine, then preview again. Nothing was created.` };
    case 'host_unreachable':
    case 'route_unavailable':
      return { status: 'host-unreachable', host, message: `No GoodVibes daemon answered at ${host}. Start the daemon there or correct controlPlane.host and controlPlane.port, then preview again. Nothing was created.` };
    case 'auth_rejected':
    case 'forbidden':
      return { status: 'credential-rejected', host, message: `The host at ${host} did not accept the current credential (HTTP ${status ?? 401}). Provision the host's operator token for this Agent, then preview again. Nothing was created.` };
    case 'incompatible':
      return { status: 'host-lacks-pairing', host, message: `The GoodVibes host at ${host} is older than this Agent and cannot verify a pairing (HTTP 404). Update GoodVibes on the host, then preview again. Nothing was created.` };
    default:
      return { status: 'host-error', host, message: `The host at ${host} failed the auth check${status === undefined ? '' : ` (HTTP ${status})`}. Read the daemon log on the host, then preview again. Nothing was created.` };
  }
}

/** Preview is read-only. The returned one-shot capability binds the exact host,
 * source credential, name and store state to a fresh terminal confirmation.
 * No raw token, credential digest or remote error leaves this module.
 */
/**
 * An unresolved attempt blocks pairing until the owner has checked the host.
 * Clearing it is an owner-terminal action: it only deletes the local marker, so
 * it is offered with the warning that a credential the host did mint stays there.
 */
function clearPreview(home: string, host: string, attemptId: string): AgentHostPairingPreview {
  const confirmation = `CLEAR ${randomBytes(6).toString('hex')}`;
  let consumed = false;
  return {
    result: {
      ...unknown(host),
      confirmation,
      confirmationPrompt: 'forget this unresolved attempt',
      message: `${unknown(host).message} If the host shows no pairing token for this attempt, confirm below to forget it and pair again; a token that does exist stays valid until you revoke it on the host.`,
    },
    async confirm(answer) {
      if (consumed || answer !== confirmation) return cancelled();
      consumed = true;
      const cleared = await clearAgentHostPairingAttempt(home, host, attemptId);
      if (cleared.status === 'cleared') return { status: 'cleared', host, message: 'The unresolved attempt was forgotten. Preview again to pair.' };
      return cleared.status === 'conflict' ? changed() : storeUnreadable(home);
    },
  };
}

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
    if (!resolveConnectedHostDialEnabled(options.configManager)) return { result: { status: 'blocked', message: 'Connected-host dialing is disabled (daemon.connectedHost.enabled is false). Turn it on in settings, then preview again. No pairing request was made.' } };
    const home = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
    const configured = resolveConnectedHostBaseUrl(options.configManager);
    host = canonicalizePairingHost(configured);
    if (!host) return { result: { status: 'no-host-configured', message: `The configured host address (${configured}) is not a usable http(s) origin. Set controlPlane.host and controlPlane.port to the GoodVibes daemon, then preview again.` } };
    const pairingHost = host;
    const state = readAgentHostPairing(home, pairingHost);
    if (state.status === 'unknown') return clearPreview(home, pairingHost, state.attemptId);
    if (state.status === 'unavailable') return { result: storeUnreadable(home) };
    const selection = { configManager: options.configManager, homeDirectory: options.homeDirectory };
    const selected = resolveConnectedHost(selection);
    if (selected.token === null) {
      return { result: { status: 'no-credential', host: pairingHost, message: `No credential to pair with: ${selected.unavailable?.reason ?? `nothing found in ${selected.credential}`}. Pairing starts from the host's shared operator token; provision it for this Agent, then preview again.` } };
    }
    const selectedToken = selected.token;
    const fetchOption = options.fetchImpl ? { fetchImpl: options.fetchImpl } : {};
    const verifyAs = (token: string, callSignal: AbortSignal | undefined) => {
      const connection: ConnectedHostConnection = { baseUrl: pairingHost, token, credential: selected.credential };
      return createConnectedHost(() => connection, fetchOption)
        .invoke('control.auth.current', {}, { signal: callSignal, deadlineMs: PAIRING_AUTH_DEADLINE_MS });
    };
    const current = (): boolean => {
      const nowHome = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
      const now = resolveConnectedHost(selection);
      return nowHome === home && now.baseUrl === selected.baseUrl && now.token === selectedToken;
    };
    let auth;
    try { auth = await verifyAs(selectedToken, signal); }
    catch (error) { return { result: authCheckFailed(error, pairingHost, Boolean(signal?.aborted)) }; }
    if (signal?.aborted) return { result: cancelled() };
    if (!current() || !isDeepStrictEqual(readAgentHostPairing(home, pairingHost), state)) return { result: changed() };
    if (state.status === 'paired' || isNativePairedPrincipal(auth)) {
      return { result: { status: 'already-paired', host: pairingHost, message: 'An existing paired credential is present. This route will not mint or replace it; use setup status to verify the effective credential.' } };
    }
    if (!isHostPairingBootstrapPrincipal(auth)) return { result: { status: 'blocked', host: pairingHost, message: 'Migration requires this host to verify the existing legacy shared operator token with write:control-plane. No credential was created.' } };
    const confirmation = `PAIR ${randomBytes(6).toString('hex')}`;
    let consumed = false;
    const result: AgentHostPairingResult = {
      status: 'preview', host: pairingHost, name, confirmation, environmentOverride: selected.source === 'environment',
      scopeDisclosure: 'This creates a persistent administrative per-device credential on the selected GoodVibes host. It can exercise operator authority, including native work and fleet execution. The secret is stored only in this Agent home, bound to this host. The legacy shared token remains active; no credential is revoked.',
      message: 'Preview only. No credential has been created or stored. Confirm the exact phrase at the owner-terminal prompt to make one migration request.',
    };
    return { result, async confirm(answer, actionSignal) {
      if (consumed || answer !== confirmation || actionSignal?.aborted) return cancelled();
      consumed = true;
      let attempted = false;
      let attemptId: string | undefined;
      try {
        // Authority can be revoked after preview without replacing the local token.
        let live;
        try { live = await verifyAs(selectedToken, actionSignal); }
        catch (error) { return authCheckFailed(error, pairingHost, Boolean(actionSignal?.aborted)); }
        if (actionSignal?.aborted) return cancelled();
        if (!current() || !isDeepStrictEqual(readAgentHostPairing(home, pairingHost), state)) return changed();
        if (!isHostPairingBootstrapPrincipal(live)) return changed();
        attemptId = randomUUID();
        const begin = await beginAgentHostPairing(home, pairingHost, { attemptId, name, startedAt: Date.now() });
        if (begin.status !== 'begun') return begin.status === 'conflict' ? changed() : storeUnreadable(home);
        // Once the durable marker exists, every interruption is conservatively
        // unknown until an exact successful response is safely stored.
        attempted = true;
        // The marker hides the host-bound credential, so the shared token is read without a host.
        const bootstrap = readConnectedHostOperatorToken(home);
        const nowHome = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
        if (actionSignal?.aborted || nowHome !== home || !resolveConnectedHostDialEnabled(options.configManager)
          || canonicalizePairingHost(resolveConnectedHostBaseUrl(options.configManager)) !== pairingHost || bootstrap.token !== selectedToken) return unknown(pairingHost);
        // `pairing.tokens.migrate` has no route of its own in the operator
        // contract, so it goes through the daemon's invoke-by-id route.
        const fetchImpl = options.fetchImpl ?? fetch;
        const response = await fetchImpl(`${pairingHost}/api/control-plane/methods/pairing.tokens.migrate/invoke`, {
          method: 'POST', redirect: 'error',
          headers: { authorization: `Bearer ${selectedToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ body: { name } }),
          signal: AbortSignal.any([AbortSignal.timeout(PAIRING_MINT_DEADLINE_MS), ...(actionSignal ? [actionSignal] : [])]),
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (!refusedWithoutMinting(response.status)) return unknown(pairingHost);
          if ((await clearAgentHostPairingAttempt(home, pairingHost, attemptId)).status !== 'cleared') return unknown(pairingHost);
          return response.status === 404
            ? { status: 'host-lacks-pairing', host: pairingHost, message: `The host at ${pairingHost} does not offer pairing (HTTP 404); it runs an older GoodVibes. Update GoodVibes on the host, then preview again. Nothing was created.` }
            : rejected(pairingHost, response.status);
        }
        const payload = await readHostPairingResponse(response);
        const minted = parseMintedPairingToken(payload, name);
        if (!minted) return unknown(pairingHost);
        const complete = await completeAgentHostPairing(home, pairingHost, attemptId, { token: minted.token, tokenId: minted.id, name, createdAt: minted.createdAt });
        if (complete.status !== 'paired') return unknown(pairingHost);
        // Persist before verifying: a lost verification reply must never lose
        // the only copy of the newly issued credential or cause another mint.
        if (actionSignal?.aborted) return { status: 'paired-unverified', host: pairingHost, message: 'Pairing credential stored for this host. Verification was interrupted; rerun setup status. No second credential will be created.' };
        let pairedAuth;
        try { pairedAuth = await verifyAs(minted.token, actionSignal); }
        catch (error) {
          const cause = authCheckFailed(error, pairingHost, Boolean(actionSignal?.aborted));
          return { status: 'paired-unverified', host: pairingHost, message: `Pairing credential stored for this host, but live verification failed (${cause.status}). Rerun setup status; do not remint.` };
        }
        if (!isNativePairedPrincipal(pairedAuth) || pairedAuth.principalId !== `pairing:${minted.id}`) return { status: 'paired-unverified', host: pairingHost, message: 'Pairing credential stored, but this host did not verify its expected native principal. Inspect the host; do not remint.' };
        const finalHome = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
        if (finalHome !== home || !resolveConnectedHostDialEnabled(options.configManager)
          || canonicalizePairingHost(resolveConnectedHostBaseUrl(options.configManager)) !== pairingHost
          || (envOverride() && readConnectedHostOperatorToken(home).token !== selectedToken)) return { status: 'paired-unverified', host: pairingHost, message: 'Pairing credential stored for the original host. Current host, home, dialing or environment credential changed; preview setup status again.' };
        if (envOverride()) return { status: 'paired-shadowed', host: pairingHost, message: 'Pairing credential stored for this host. An environment token still takes precedence. Review that override before rerunning setup status; no environment variable was changed.' };
        const effective = resolveConnectedHost(selection);
        if (canonicalizePairingHost(effective.baseUrl) !== pairingHost || effective.token !== minted.token) return { status: 'paired-unverified', host: pairingHost, message: 'Pairing credential stored for the original host. Current configuration or authority is unverified; rerun setup status before native work.' };
        return { status: 'paired', host: pairingHost, message: 'Agent pairing is stored and the selected host verified native intake authority. Provider, workspace, Jev and execution readiness remain separate checks.' };
      } catch (error) {
        if (attempted && attemptId && connectionRefused(error) && (await clearAgentHostPairingAttempt(home, pairingHost, attemptId)).status === 'cleared') {
          return { status: 'host-unreachable', host: pairingHost, message: `No GoodVibes daemon answered at ${pairingHost} when the pairing request was sent. Start the daemon there, then preview again. Nothing was created.` };
        }
        if (attempted) return unknown(pairingHost);
        if (actionSignal?.aborted) return cancelled();
        return { status: 'host-error', host: pairingHost, message: `Pairing stopped before any request was sent: ${error instanceof Error ? error.name : 'unexpected failure'}. Preview again; nothing was created.` };
      }
    } };
  } catch (error) {
    if (signal?.aborted) return { result: cancelled() };
    return { result: { status: 'host-error', ...(host ? { host } : {}), message: `Pairing preview stopped before any credential was requested: ${error instanceof Error ? error.name : 'unexpected failure'}. Preview again; nothing was created.` } };
  }
}
