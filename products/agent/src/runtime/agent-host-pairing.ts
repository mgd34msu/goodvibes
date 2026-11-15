import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createOperatorApiClient } from '@goodvibes-jev/engine/operator-client';
import { resolveConnectedHostDialEnabled } from '@goodvibes-jev/engine/platform/platform/config';
import { resolveConnectedHostBaseUrl } from '../config/connected-host-dial.ts';
import { resolveConnectedHostConnection, type AgentDaemonVerbCallerOptions } from './client/daemon-verbs.ts';
import { readConnectedHostOperatorToken } from './connected-host-auth.ts';
import { isHostPairingBootstrapPrincipal, isNativePairedPrincipal, parseMintedPairingToken, readHostPairingResponse } from './native-paired-principal.ts';
import { beginAgentHostPairing, canonicalizePairingHost, clearAgentHostPairingAttempt, completeAgentHostPairing, readAgentHostPairing } from './connected-host-pairing-store.ts';

export interface AgentHostPairingResult {
  readonly status: 'preview' | 'blocked' | 'already-paired' | 'cancelled' | 'changed' | 'unknown' | 'rejected' | 'cleared' | 'paired' | 'paired-unverified' | 'paired-shadowed';
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

const unavailable = (): AgentHostPairingResult => ({ status: 'blocked', message: 'Pairing could not be verified. Check the selected host and local credential store, then preview again.' });
const unknown = (host: string): AgentHostPairingResult => ({ status: 'unknown', host, message: 'A pairing attempt may already have created a credential. Its outcome must be reviewed on this host; no automatic remint or revoke is allowed.' });
const rejected = (host: string): AgentHostPairingResult => ({ status: 'rejected', host, message: 'The host refused the request; nothing was created. Preview again.' });
// A refusal before any minting (a 4xx other than a timeout or a conflict, or a host that was not listening) proves no credential exists.
const refusedWithoutMinting = (status: number): boolean => status >= 400 && status < 500 && status !== 408 && status !== 409;
const connectionRefused = (error: unknown): boolean => (error as { cause?: { code?: unknown } } | null)?.cause?.code === 'ECONNREFUSED';
const changed = (): AgentHostPairingResult => ({ status: 'changed', message: 'The selected host, effective credential or local pairing state changed. Preview again before confirming.' });
const cancelled = (): AgentHostPairingResult => ({ status: 'cancelled', message: 'Pairing cancelled before the migration request.' });
const envOverride = (): boolean => Boolean(process.env.GOODVIBES_CONNECTED_HOST_TOKEN?.trim() || process.env.GOODVIBES_DAEMON_TOKEN?.trim());


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
      return cleared.status === 'conflict' ? changed() : unavailable();
    },
  };
}

export async function previewAgentHostPairing(
  options: AgentDaemonVerbCallerOptions,
  name = 'GoodVibes Agent',
  signal?: AbortSignal,
): Promise<AgentHostPairingPreview> {
  try {
    if (signal?.aborted) return { result: cancelled() };
    if (!name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) return { result: { status: 'blocked', message: 'Use a nonempty pairing name of at most 80 characters without control characters.' } };
    name = name.trim();
    if (!resolveConnectedHostDialEnabled(options.configManager)) return { result: { status: 'blocked', message: 'Connected-host dialing is disabled. No pairing request was made.' } };
    const home = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
    const host = canonicalizePairingHost(resolveConnectedHostBaseUrl(options.configManager));
    if (!host) return { result: unavailable() };
    const state = readAgentHostPairing(home, host);
    if (state.status === 'unknown') return clearPreview(home, host, state.attemptId);
    if (state.status === 'unavailable') return { result: unavailable() };
    const selected = resolveConnectedHostConnection(options);
    if ('reason' in selected) return { result: unavailable() };
    const current = (): boolean => {
      const nowHome = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
      const now = resolveConnectedHostConnection(options);
      return nowHome === home && !('reason' in now) && now.baseUrl === selected.baseUrl && now.token === selected.token;
    };
    const authClient = createOperatorApiClient({ baseUrl: host, authToken: selected.token, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
    let auth;
    try { auth = await authClient.invoke('control.auth.current', {}, { signal: AbortSignal.any([AbortSignal.timeout(1500), ...(signal ? [signal] : [])]) }); }
    finally { authClient.dispose(); }
    if (signal?.aborted) return { result: cancelled() };
    if (!current() || !isDeepStrictEqual(readAgentHostPairing(home, host), state)) return { result: changed() };
    if (state.status === 'paired' || isNativePairedPrincipal(auth)) {
      return { result: { status: 'already-paired', host, message: 'An existing paired credential is present. This route will not mint or replace it; use setup status to verify the effective credential.' } };
    }
    if (!isHostPairingBootstrapPrincipal(auth)) return { result: { status: 'blocked', host, message: 'Migration requires this host to verify the existing legacy shared operator token with write:control-plane. No credential was created.' } };
    const confirmation = `PAIR ${randomBytes(6).toString('hex')}`;
    let consumed = false;
    const result: AgentHostPairingResult = {
      status: 'preview', host, name, confirmation, environmentOverride: envOverride(),
      scopeDisclosure: 'This creates a persistent administrative per-device credential on the selected GoodVibes host. It can exercise operator authority, including native work and fleet execution. The secret is stored only in this Agent home, bound to this host. The legacy shared token remains active; no credential is revoked.',
      message: 'Preview only. No credential has been created or stored. Confirm the exact phrase at the owner-terminal prompt to make one migration request.',
    };
    return { result, async confirm(answer, actionSignal) {
      if (consumed || answer !== confirmation || actionSignal?.aborted) return cancelled();
      consumed = true;
      let attempted = false;
      let attemptId: string | undefined;
      try {
        if (!current() || !isDeepStrictEqual(readAgentHostPairing(home, host), state)) return changed();
        // Authority can be revoked after preview without replacing the local token.
        const verifier = createOperatorApiClient({ baseUrl: host, authToken: selected.token, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
        let live;
        try { live = await verifier.invoke('control.auth.current', {}, { signal: AbortSignal.any([AbortSignal.timeout(1500), ...(actionSignal ? [actionSignal] : [])]) }); }
        finally { verifier.dispose(); }
        if (actionSignal?.aborted) return cancelled();
        if (!current() || !isDeepStrictEqual(readAgentHostPairing(home, host), state)) return changed();
        if (!isHostPairingBootstrapPrincipal(live)) return changed();
        attemptId = randomUUID();
        const begin = await beginAgentHostPairing(home, host, { attemptId, name, startedAt: Date.now() });
        if (begin.status !== 'begun') return begin.status === 'conflict' ? changed() : unavailable();
        // Once the durable marker exists, every interruption is conservatively
        // unknown until an exact successful response is safely stored.
        attempted = true;
        const bootstrap = readConnectedHostOperatorToken(home);
        const nowHome = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
        if (actionSignal?.aborted || nowHome !== home || !resolveConnectedHostDialEnabled(options.configManager)
          || canonicalizePairingHost(resolveConnectedHostBaseUrl(options.configManager)) !== host || bootstrap.token !== selected.token) return unknown(host);
        const fetchImpl = options.fetchImpl ?? fetch;
        const response = await fetchImpl(`${host}/api/control-plane/methods/pairing.tokens.migrate/invoke`, {
          method: 'POST', redirect: 'error',
          headers: { authorization: `Bearer ${selected.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ body: { name } }),
          signal: AbortSignal.any([AbortSignal.timeout(5000), ...(actionSignal ? [actionSignal] : [])]),
        });
        if (!response.ok) {
          if (!refusedWithoutMinting(response.status)) return unknown(host);
          return (await clearAgentHostPairingAttempt(home, host, attemptId)).status === 'cleared' ? rejected(host) : unknown(host);
        }
        const payload = await readHostPairingResponse(response);
        const minted = parseMintedPairingToken(payload, name);
        if (!minted) return unknown(host);
        const complete = await completeAgentHostPairing(home, host, attemptId, { token: minted.token, tokenId: minted.id, name, createdAt: minted.createdAt });
        if (complete.status !== 'paired') return unknown(host);
        // Persist before verifying: a lost verification reply must never lose
        // the only copy of the newly issued credential or cause another mint.
        if (actionSignal?.aborted) return { status: 'paired-unverified', host, message: 'Pairing credential stored for this host. Verification was interrupted; rerun setup status. No second credential will be created.' };
        const pairedClient = createOperatorApiClient({ baseUrl: host, authToken: minted.token, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
        let pairedAuth;
        try { pairedAuth = await pairedClient.invoke('control.auth.current', {}, { signal: AbortSignal.any([AbortSignal.timeout(1500), ...(actionSignal ? [actionSignal] : [])]) }); }
        catch { return { status: 'paired-unverified', host, message: 'Pairing credential stored for this host, but live verification failed. Rerun setup status; do not remint.' }; }
        finally { pairedClient.dispose(); }
        if (!isNativePairedPrincipal(pairedAuth) || pairedAuth.principalId !== `pairing:${minted.id}`) return { status: 'paired-unverified', host, message: 'Pairing credential stored, but this host did not verify its expected native principal. Inspect the host; do not remint.' };
        const finalHome = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
        if (finalHome !== home || !resolveConnectedHostDialEnabled(options.configManager)
          || canonicalizePairingHost(resolveConnectedHostBaseUrl(options.configManager)) !== host
          || (envOverride() && readConnectedHostOperatorToken(home).token !== selected.token)) return { status: 'paired-unverified', host, message: 'Pairing credential stored for the original host. Current host, home, dialing or environment credential changed; preview setup status again.' };
        if (envOverride()) return { status: 'paired-shadowed', host, message: 'Pairing credential stored for this host. An environment token still takes precedence. Review that override before rerunning setup status; no environment variable was changed.' };
        const effective = resolveConnectedHostConnection(options);
        if ('reason' in effective || canonicalizePairingHost(effective.baseUrl) !== host || effective.token !== minted.token) return { status: 'paired-unverified', host, message: 'Pairing credential stored for the original host. Current configuration or authority is unverified; rerun setup status before native work.' };
        return { status: 'paired', host, message: 'Agent pairing is stored and the selected host verified native intake authority. Provider, workspace, Jev and execution readiness remain separate checks.' };
      } catch (error) {
        if (attempted && attemptId && connectionRefused(error) && (await clearAgentHostPairingAttempt(home, host, attemptId)).status === 'cleared') return rejected(host);
        return attempted ? unknown(host) : actionSignal?.aborted ? cancelled() : unavailable();
      }
    } };
  } catch { return { result: signal?.aborted ? cancelled() : unavailable() }; }
}
