import { randomUUID } from 'node:crypto';
import { isNativePairedPrincipal } from '@goodvibes/engine/terminal-shell/native-paired-principal';
import { createOperatorApiClient } from '@goodvibes/engine/operator-client';
import { GoodVibesError } from '@goodvibes/engine/errors';
import { resolveDaemonEnabled } from '@goodvibes/engine/platform/platform/config';
import { resolveTuiHostOrigin, type NativeHostCredentialOptions } from './client/native-host-credential.ts';
import { beginTuiHostPairing, clearTuiHostPairingAttempt, completeTuiHostPairing, readTuiHostPairing, removeTuiHostPairing, type RemoveTuiHostPairingResult } from './tui-host-credential-store.ts';

export interface TuiHostPairingResult {
  readonly status: 'blocked' | 'already-paired' | 'cancelled' | 'changed' | 'unknown' | 'cleared' | 'paired' | 'credential-rejected';
  readonly message: string;
  readonly host?: string;
  readonly name?: string;
}
export interface TuiHostPairingOptions extends NativeHostCredentialOptions {
  readonly fetchImpl?: typeof fetch;
}
const unavailable = (): TuiHostPairingResult => ({ status: 'blocked', message: 'Pairing could not be verified. Check the selected host and safe local credential store, then pair again.' });
/** Pairing this terminal with its daemon, as the place's control names it. */
export const PAIR_HOST_CONTROL = 'Devices and network, Pair something, This program with its daemon';
const unknown = (host: string): TuiHostPairingResult => ({ status: 'unknown', host, message: 'The reply to an earlier pairing request was lost, so this terminal does not know whether the host made its credential. A credential made for it was never received, so it cannot sign in and lapses within 15 minutes. Run goodvibes host unpair to forget that attempt, then pair with a sign-in code.' });
const changed = (): TuiHostPairingResult => ({ status: 'changed', message: 'The selected host, home or local pairing state changed while pairing. Nothing was kept; pair again.' });
const cancelled = (): TuiHostPairingResult => ({ status: 'cancelled', message: 'Pairing cancelled. Nothing was changed.' });

/** What forgetting a stored credential did. The token stays valid on the host until it is revoked there. */
function forgotten(result: RemoveTuiHostPairingResult, host: string, tokenId: string): TuiHostPairingResult {
  if (result.status === 'unavailable') return { status: 'blocked', host, message: `${result.reason} Nothing was forgotten.` };
  if (result.status === 'conflict') return changed();
  return { status: 'cleared', host, message: `The stored device credential (token ${tokenId}) was forgotten. It stays valid on the host until it is revoked there. Pair again: ${PAIR_HOST_CONTROL}, with the sign-in code your own screen shows.` };
}

/**
 * `/devices unpair-host` and `goodvibes host unpair`: forget this terminal's stored device credential for the selected
 * host, or an earlier attempt whose reply was lost. Local only; nothing is sent, nothing is asked: the command is the
 * owner's instruction.
 */
export async function unpairTuiHost(options: NativeHostCredentialOptions): Promise<TuiHostPairingResult> {
  const home = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
  const host = resolveTuiHostOrigin(options.configManager);
  if (!host) return { status: 'blocked', message: 'No host is selected, so there is no credential to forget. Set controlPlane.publicBaseUrl (or pass --url) to name the host.' };
  const state = readTuiHostPairing(home, host);
  if (state.status === 'unavailable') return { status: 'blocked', host, message: `${state.reason} Nothing was forgotten.` };
  if (state.status === 'missing') return { status: 'blocked', host, message: 'No device credential is stored for this host; nothing to forget.' };
  if (state.status === 'unknown') {
    const cleared = await clearTuiHostPairingAttempt(home, host, state.attemptId);
    if (cleared.status === 'cleared') return { status: 'cleared', host, message: 'The earlier attempt whose reply was lost was forgotten; anything the host made for it was never received and lapses unused. Pair with a sign-in code.' };
    return cleared.status === 'conflict' ? changed() : unavailable();
  }
  return forgotten(await removeTuiHostPairing(home, host, state.tokenId), host, state.tokenId);
}

/**
 * Pair this terminal as the owner's own device with the sign-in code their own screen showed: the one way a device becomes
 * theirs (Devices and network, Pair something, This program with its daemon). They start it in person where they are
 * signed in as themselves (the web UI, or their own program on the daemon's machine: Pair something, A phone or another
 * device, "Show the sign-in code once"), and type that code here. The code IS the device's key, made by them
 * (`pairing.handoff.create` from their own session records it as their device): this terminal keeps it for the selected host once the host confirms
 * it as a device. Nothing is minted for whoever asks, and no operator token is read.
 */
export async function pairTuiHostWithCode(options: TuiHostPairingOptions, code: string, name = 'GoodVibes TUI', signal?: AbortSignal): Promise<TuiHostPairingResult> {
  const trimmed = code.trim();
  if (!/^gvp_[A-Za-z0-9_-]{16,}$/.test(trimmed)) return { status: 'blocked', message: 'That is not a sign-in code the daemon makes. Where you are signed in as yourself: Devices and network, Pair something, A phone or another device, "Show the sign-in code once"; type that code here. Nothing was changed.' };
  if (!name.trim() || name.length > 80 || /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/u.test(name)) return { status: 'blocked', message: 'Use a nonempty device name of at most 80 characters without control characters.' };
  try {
    const home = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
    const host = resolveTuiHostOrigin(options.configManager);
    if (!host || !resolveDaemonEnabled(options.configManager)) return unavailable();
    const state = readTuiHostPairing(home, host);
    if (state.status === 'unavailable') return { status: 'blocked', host, message: `${state.reason} Nothing was changed.` };
    if (state.status === 'paired') return { status: 'already-paired', host, message: 'This terminal already keeps a device credential for this host. To use the new code instead, forget it first (Devices and network, Paired tab, Forget its daemon pairing); the code stays unused and stops working within 15 minutes.' };
    if (state.status === 'unknown') return { ...unknown(host), message: `${unknown(host).message} Nothing was changed.` };
    const client = createOperatorApiClient({ baseUrl: host, authToken: trimmed, fetchImpl: (input, init) => (options.fetchImpl ?? fetch)(input, { ...init, redirect: 'error' }) });
    let auth;
    try {
      auth = await client.invoke('control.auth.current', {}, { signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]) });
    } catch (error) {
      if (signal?.aborted) return cancelled();
      return error instanceof GoodVibesError && error.kind === 'auth'
        ? { status: 'credential-rejected', host, message: 'The host did not accept that code (it was already used, it is older than 15 minutes, or it was never one). Make a new one on your own screen, then pair again. Nothing was changed.' }
        : { status: 'blocked', host, message: `The host at ${host} could not be asked about that code just now. Check that it runs, then pair again. Nothing was changed.` };
    } finally { client.dispose(); }
    if (!isNativePairedPrincipal(auth)) return { status: 'blocked', host, message: 'The host took that code, but not as a device. Make a new one on your own screen (Pair something, A phone or another device), then pair again. Nothing was kept.' };
    const tokenId = auth.principalId.slice('pairing:'.length);
    const attemptId = randomUUID();
    const begun = await beginTuiHostPairing(home, host, { attemptId, name: name.trim(), startedAt: Date.now() }, {}, () => !signal?.aborted);
    if (begun.status !== 'begun') return begun.status === 'cancelled' ? cancelled() : begun.status === 'conflict' ? changed() : unavailable();
    const complete = await completeTuiHostPairing(home, host, attemptId, { token: trimmed, tokenId, name: name.trim(), createdAt: Date.now() });
    if (complete.status !== 'paired') return unknown(host);
    return { status: 'paired', host, message: 'Paired with the code your own screen showed: this terminal keeps its own key for the host, and the host confirmed it as a device. If you made the code where you are signed in as yourself, it is your own device: it runs your turns under your mode and answers questions other callers raised; its own risky acts are decided under your permission mode, as anyone\'s are.' };
  } catch { return signal?.aborted ? cancelled() : unavailable(); }
}

export function formatTuiHostPairing(result: TuiHostPairingResult): string {
  return [`TUI host pairing: ${result.status}`, ...(result.host ? [`  Host: ${result.host}`] : []), ...(result.name ? [`  Device name: ${result.name}`] : []), `  ${result.message}`].join('\n');
}
