import { randomUUID } from 'node:crypto';
import { resolveConnectedHostDialEnabled } from '@goodvibes/engine/platform/platform/config';
import { resolveConnectedHostAddress } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-dial';
import { createConnectedHost, isHostFailure, resolveConnectedHost, type ConnectedHostConnection } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-client';
import type { AgentDaemonVerbCallerOptions } from './client/daemon-verbs.ts';
import { isNativePairedPrincipal } from './native-paired-principal.ts';
import { agentHostPairingStorePath, beginAgentHostPairing, canonicalizePairingHost, clearAgentHostPairingAttempt, completeAgentHostPairing, readAgentHostPairing, removeAgentHostPairing, type RemoveAgentHostPairingResult } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-pairing-store';

export interface AgentHostPairingResult {
  readonly status:
    | 'blocked' | 'already-paired' | 'cancelled' | 'changed' | 'unknown' | 'cleared' | 'paired'
    // Why pairing could not start or finish, from local facts and the host's status code:
    | 'no-host-configured' | 'pairing-store-unreadable' | 'credential-rejected'
    | 'host-unreachable' | 'host-timeout' | 'host-lacks-pairing' | 'host-error';
  readonly message: string;
  readonly host?: string;
  readonly name?: string;
}

/** How long one auth check against the host may take. */
export const PAIRING_AUTH_DEADLINE_MS = 5_000;

/** The store's own refusal (cause, path, fix) when it gave one; otherwise the store path and the usual fixes. */
const storeUnreadable = (home: string, refusal?: { readonly status: string; readonly reason?: string }): AgentHostPairingResult => ({
  status: 'pairing-store-unreadable',
  message: refusal?.status === 'unavailable' && refusal.reason
    ? `${refusal.reason} Nothing was created.`
    : `The pairing file at ${agentHostPairingStorePath(home)} cannot be read or written. Fix its permissions or move the damaged file aside, then pair again. Nothing was created.`,
});
/** Where pairing is done: the place's control in the Agent, the CLI verb in a script. */
const PAIR = 'Devices and network, Pair something (or goodvibes-agent setup pair --with-code in a shell)';
const unknown = (host: string): AgentHostPairingResult => ({ status: 'unknown', host, message: `The host's answer to an earlier pairing request was lost, so this Agent does not know whether the host made its access key; a key made for it was never received, so it cannot sign in and stops working within 15 minutes. Run goodvibes-agent setup unpair to forget that attempt, then pair with a sign-in code (${PAIR}).` });
const changed = (): AgentHostPairingResult => ({ status: 'changed', message: 'The host, this Agent home or its pairing changed while pairing. Nothing was kept; pair again.' });
const cancelled = (): AgentHostPairingResult => ({ status: 'cancelled', message: 'Pairing cancelled. Nothing was sent to the host and nothing was changed.' });

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
      return { status: 'credential-rejected', host, message: `The host at ${host} did not accept that key (HTTP ${status ?? 401}). Make a new sign-in code on your own screen, then pair again. Nothing was created.` };
    case 'incompatible':
      return { status: 'host-lacks-pairing', host, message: `The GoodVibes on the host at ${host} is older than this Agent and cannot pair (HTTP 404). Update GoodVibes on the host, then pair again. Nothing was created.` };
    default:
      return { status: 'host-error', host, message: `The host at ${host} failed when this Agent checked its access${status === undefined ? '' : ` (HTTP ${status})`}. Read the daemon log on the host, then pair again. Nothing was created.` };
  }
}

/** What forgetting a stored credential did. The token stays valid on the host until it is revoked there. */
function forgotten(result: RemoveAgentHostPairingResult, host: string, tokenId: string): AgentHostPairingResult {
  if (result.status === 'unavailable') return { status: 'pairing-store-unreadable', host, message: `${result.reason} Nothing was forgotten.` };
  if (result.status === 'removed') return { status: 'cleared', host, message: `This Agent forgot its key for the host (key ${tokenId}). The host still accepts that key until you revoke it there, in its paired devices. To pair again: ${PAIR}.` };
  return changed();
}

/**
 * `goodvibes-agent setup unpair` and Devices and network's unpair control: forget this Agent's stored device credential
 * for the selected host, or an earlier attempt whose reply was lost. Local only; nothing is sent, nothing is asked: the
 * command is the owner's instruction.
 */
export async function unpairAgentHost(options: Pick<AgentDaemonVerbCallerOptions, 'configManager' | 'homeDirectory'>): Promise<AgentHostPairingResult> {
  const home = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
  const configured = resolveConnectedHostAddress(options.configManager).baseUrl;
  const host = canonicalizePairingHost(configured);
  if (!host) return { status: 'no-host-configured', message: `The host address (${configured}) is not a usable http:// or https:// address, so there is no key to forget. Set daemon.connectedHost.url to name the host.` };
  const state = readAgentHostPairing(home, host);
  if (state.status === 'unavailable') return { status: 'pairing-store-unreadable', host, message: `${state.reason} Nothing was forgotten.` };
  if (state.status === 'missing') return { status: 'blocked', host, message: 'This Agent keeps no key for this host; nothing to forget.' };
  if (state.status === 'unknown') {
    const cleared = await clearAgentHostPairingAttempt(home, host, state.attemptId);
    if (cleared.status === 'cleared') return { status: 'cleared', host, message: `The earlier attempt whose reply was lost was forgotten; anything the host made for it was never received and lapses unused. To pair: ${PAIR}.` };
    return cleared.status === 'conflict' ? changed() : storeUnreadable(home, cleared);
  }
  return forgotten(await removeAgentHostPairing(home, host, state.tokenId), host, state.tokenId);
}

/**
 * Pair this Agent as the owner's own device with the sign-in code their own screen showed (gate-review-6 G1): they start
 * the pairing in person, in their signed-in session (the web UI: Devices and network, Pair something; "Show the sign-in
 * code once") or their verified program, and type or paste that code here. The code IS the device's key, made by them
 * (`pairing.handoff.create` from their own session records it as their device): this Agent keeps it and the host confirms
 * it as this device. Nothing is put to the owner a second time, and no key of the operator token's is asked for.
 *
 * What it then is, on a computer that cannot prove its programs to the daemon: the owner's device. It runs the owner's
 * turns (the daemon's native work) under their mode; it answers a question another caller raised; its own risky acts at
 * the daemon are decided under their permission mode like anyone's; it is never the owner in person (no Agent credential is
 * made for it, nothing it says it decided is believed).
 */
export async function pairAgentHostWithCode(options: AgentDaemonVerbCallerOptions, code: string, name = 'GoodVibes Agent', signal?: AbortSignal): Promise<AgentHostPairingResult> {
  const trimmed = code.trim();
  if (!/^gvp_[A-Za-z0-9_-]{16,}$/.test(trimmed)) return { status: 'cancelled', message: `That is not a sign-in code the daemon makes. In your signed-in web UI: Devices and network, Pair something, then "Show the sign-in code once"; type that code here. Nothing was changed.` };
  if (!resolveConnectedHostDialEnabled(options.configManager)) return { status: 'blocked', message: 'This Agent is set not to reach its daemon (daemon.connectedHost.enabled is false). Turn it on in settings, then pair again. Nothing was sent.' };
  const home = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
  const address = resolveConnectedHostAddress(options.configManager);
  if (address.refusal) return { status: 'no-host-configured', message: `${address.refusal} Then pair again. Nothing was sent.` };
  const host = canonicalizePairingHost(address.baseUrl);
  if (!host) return { status: 'no-host-configured', message: `The host address (${address.baseUrl}) is not a usable http:// or https:// address. Set daemon.connectedHost.url to the GoodVibes daemon, then pair again.` };
  const state = readAgentHostPairing(home, host);
  if (state.status === 'unavailable') return storeUnreadable(home, state);
  if (state.status === 'paired') return { status: 'already-paired', host, message: 'This Agent is already paired with this host. To use the new code instead, run setup unpair first; the code stays unused and stops working within 15 minutes.' };
  if (state.status === 'unknown') return { ...unknown(host), message: `${unknown(host).message} Nothing was changed.` };
  const selected = resolveConnectedHost({ configManager: options.configManager, homeDirectory: options.homeDirectory });
  const connection: ConnectedHostConnection = { baseUrl: host, token: trimmed, credential: selected.credential };
  let auth;
  try {
    auth = await createConnectedHost(() => connection, options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
      .invoke('control.auth.current', {}, { signal, deadlineMs: PAIRING_AUTH_DEADLINE_MS });
  } catch (error) {
    const failed = authCheckFailed(error, host, Boolean(signal?.aborted));
    return failed.status === 'credential-rejected'
      ? { status: 'credential-rejected', host, message: 'The host did not accept that code (it was already used, it is older than 15 minutes, or it was never one). Make a new one in your signed-in web UI, then pair again. Nothing was changed.' }
      : failed;
  }
  if (!isNativePairedPrincipal(auth)) return { status: 'blocked', host, message: 'The host took that code, but not as a device of yours. Make a new one in your signed-in web UI (Devices and network, Pair something), then pair again. Nothing was kept.' };
  const tokenId = auth.principalId.slice('pairing:'.length);
  const attemptId = randomUUID();
  const begun = await beginAgentHostPairing(home, host, { attemptId, name, startedAt: Date.now() }, {}, () => !signal?.aborted);
  if (begun.status !== 'begun') return begun.status === 'cancelled' ? cancelled() : begun.status === 'conflict' ? changed() : storeUnreadable(home, begun);
  const complete = await completeAgentHostPairing(home, host, attemptId, { token: trimmed, tokenId, name, createdAt: Date.now() });
  if (complete.status !== 'paired') return unknown(host);
  return { status: 'paired', host, message: 'Paired as your own device, with the code your screen showed: this Agent has its own key for the host, and the host confirmed it. It runs your turns under your mode and answers questions other callers raised; its own risky acts are decided under your permission mode, as anyone\'s are.' };
}
