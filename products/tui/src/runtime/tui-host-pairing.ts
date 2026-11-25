import { randomBytes, randomUUID } from 'node:crypto';
import { isHostPairingBootstrapPrincipal, isNativePairedPrincipal, parseMintedPairingToken, readHostPairingResponse } from '@goodvibes/engine/terminal-shell/native-paired-principal';
import { createOperatorApiClient } from '@goodvibes/engine/operator-client';
import { GoodVibesError } from '@goodvibes/engine/errors';
import { resolveDaemonEnabled } from '@goodvibes/engine/platform/platform/config';
import { resolveNativeHostCredential, resolveTuiHostOrigin, type NativeHostCredentialOptions } from './client/native-host-credential.ts';
import { readTuiLegacyPairingBootstrap } from './tui-host-pairing-bootstrap.ts';
import { beginTuiHostPairing, clearTuiHostPairingAttempt, completeTuiHostPairing, readTuiHostPairing, removeTuiHostPairing, type RemoveTuiHostPairingResult } from './tui-host-credential-store.ts';

export interface TuiHostPairingResult {
  readonly status: 'preview' | 'blocked' | 'already-paired' | 'cancelled' | 'changed' | 'unknown' | 'cleared' | 'paired' | 'paired-unverified' | 'credential-rejected';
  readonly message: string;
  readonly host?: string;
  readonly name?: string;
  readonly confirmation?: string;
  /** What typing the confirmation does; the controller says so when it asks. */
  readonly confirmationPrompt?: string;
  readonly scopeDisclosure?: string;
}
export interface TuiHostPairingPreview {
  readonly result: TuiHostPairingResult;
  /** Only the standalone or interactive owner-terminal prompt calls this one-shot capability. */
  readonly confirm?: (answer: string, signal?: AbortSignal) => Promise<TuiHostPairingResult>;
}
export interface TuiHostPairingOptions extends NativeHostCredentialOptions {
  /** Explicit opt-in, never inferred from missing native credentials. */
  readonly bootstrapShared?: boolean;
  readonly fetchImpl?: typeof fetch;
}
const unavailable = (): TuiHostPairingResult => ({ status: 'blocked', message: 'Pairing could not be verified. Check the selected host and safe local credential store, then preview again.' });
/** How a lost pairing reply is repeated: the same request again, from the shared token (the place's Pair something form). */
export const REPEAT_LOST_REQUEST = 'In Devices and network, press Pair something, This program with its daemon, with Shared token set to Yes, to repeat the same request: the host answers it with the credential it made, never a second one.';
/** Pairing this terminal with its daemon, as the place's control names it. */
export const PAIR_HOST_CONTROL = 'Devices and network, Pair something, This program with its daemon';
const unknown = (host: string): TuiHostPairingResult => ({ status: 'unknown', host, message: `The reply to a pairing request was lost, so this terminal does not know whether the host created its credential. ${REPEAT_LOST_REQUEST} (Opening /work on this machine repeats it too.)` });
const refused = (host: string, status: number): TuiHostPairingResult => ({ status: 'blocked', host, message: `The host refused the pairing request (HTTP ${status}), so no credential was created and nothing was saved. Preview again to retry.` });
const changed = (): TuiHostPairingResult => ({ status: 'changed', message: 'The selected host, home, bootstrap credential, authority or local pairing state changed. Preview again before confirming.' });
const cancelled = (): TuiHostPairingResult => ({ status: 'cancelled', message: 'Pairing cancelled before the migration request.' });
const unverified = (host: string): TuiHostPairingResult => ({ status: 'paired-unverified', host, message: 'The credential is saved for its original host, but current native authority is unverified. Inspect goodvibes host pair again; do not remint.' });

/**
 * An unresolved attempt that could not be repeated (no bootstrap selected, or
 * the host still did not answer). Clearing it is an owner-terminal action: it
 * only deletes the local marker. A credential the host minted for it was an
 * offer nobody received, so it never authenticates and lapses unused.
 */
function clearPreview(home: string, host: string, attemptId: string): TuiHostPairingPreview {
  const confirmation = `CLEAR ${randomBytes(6).toString('hex')}`;
  let consumed = false;
  return {
    result: {
      ...unknown(host),
      confirmation,
      confirmationPrompt: 'forget this unresolved attempt',
      message: `${unknown(host).message} Or confirm here to forget the attempt and pair from scratch; a credential the host made for it was never received, so it cannot sign in and lapses within 15 minutes.`,
    },
    async confirm(answer) {
      if (consumed || answer !== confirmation) return cancelled();
      consumed = true;
      const cleared = await clearTuiHostPairingAttempt(home, host, attemptId);
      if (cleared.status === 'cleared') return { status: 'cleared', host, message: 'The unresolved attempt was forgotten. Preview again to pair.' };
      return cleared.status === 'conflict' ? changed() : unavailable();
    },
  };
}

type MintOutcome =
  | { readonly status: 'paired'; readonly token: string; readonly tokenId: string }
  | { readonly status: 'refused'; readonly httpStatus: number }
  | { readonly status: 'unknown' | 'changed' | 'cancelled' | 'unavailable' };

/**
 * The one migration request: a durable "attempt begun" marker, one POST of
 * `pairing.tokens.migrate` with the bootstrap token and the attempt id, then the
 * minted device credential saved for this origin. A refusal (4xx other than 408)
 * releases the marker; a lost or failed reply after the request leaves it,
 * because the host may have minted. Passing `repeat` (the stored unresolved
 * attempt) sends that attempt again under its own id: the host answers it with
 * the offer it already made (same token id, new secret) while that offer is
 * unused, so a lost reply is settled without a second credential.
 */
async function mintTuiDevicePairing(input: {
  readonly home: string; readonly host: string; readonly token: string; readonly name: string;
  readonly repeat?: { readonly attemptId: string } | undefined;
  readonly current: () => boolean; readonly fetchImpl?: typeof fetch | undefined; readonly signal?: AbortSignal | undefined;
}): Promise<MintOutcome> {
  const { home, host, token, name, current, signal, repeat } = input;
  const attemptId = repeat?.attemptId ?? randomUUID();
  if (!repeat) {
    const begin = await beginTuiHostPairing(home, host, { attemptId, name, startedAt: Date.now() }, {}, () => !signal?.aborted && current());
    if (begin.status !== 'begun') return { status: begin.status === 'cancelled' ? signal?.aborted ? 'cancelled' : 'changed' : begin.status === 'conflict' ? 'changed' : 'unavailable' };
  }
  try {
    // Durable uncertainty precedes the only request: begin published the marker durably. Cancellation never clears it.
    if (signal?.aborted || !current()) {
      // An earlier send of a repeated attempt may have minted, so its marker stays.
      if (repeat) return { status: 'unknown' };
      // No request was sent, so nothing can have been minted: release the marker so pairing can be previewed again.
      const released = await clearTuiHostPairingAttempt(home, host, attemptId);
      if (released.status !== 'cleared') return { status: 'unknown' };
      return { status: signal?.aborted ? 'cancelled' : 'changed' };
    }
    const response = await (input.fetchImpl ?? fetch)(`${host}/api/control-plane/methods/pairing.tokens.migrate/invoke`, {
      method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: { name, attemptId } }), signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) {
      // A 4xx is the host refusing the request, so no credential was created and the marker is released. A timeout answer (408), a 5xx or a lost response may have followed a mint and stays unknown.
      if (response.status >= 400 && response.status < 500 && response.status !== 408) {
        const released = await clearTuiHostPairingAttempt(home, host, attemptId);
        if (released.status === 'cleared') return { status: 'refused', httpStatus: response.status };
      }
      return { status: 'unknown' };
    }
    const minted = parseMintedPairingToken(await readHostPairingResponse(response), name);
    if (!minted) return { status: 'unknown' };
    const complete = await completeTuiHostPairing(home, host, attemptId, { token: minted.token, tokenId: minted.id, name, createdAt: minted.createdAt });
    if (complete.status !== 'paired') return { status: 'unknown' };
    return { status: 'paired', token: minted.token, tokenId: minted.id };
  } catch { return { status: 'unknown' }; }
}

/** What forgetting a stored credential did. The token stays valid on the host until it is revoked there. */
function forgotten(result: RemoveTuiHostPairingResult, host: string, tokenId: string): TuiHostPairingResult {
  if (result.status === 'unavailable') return { status: 'blocked', host, message: `${result.reason} Nothing was forgotten.` };
  if (result.status === 'conflict') return changed();
  return { status: 'cleared', host, message: `The stored device credential (token ${tokenId}) was forgotten. It stays valid on the host until it is revoked there. Pair again with ${PAIR_HOST_CONTROL}, Shared token: Yes, Apply: Review and confirm it.` };
}

/**
 * The host answered 401 or 403 to the stored credential: it was revoked or
 * the daemon there was reset. Forgetting it locally is offered so the terminal
 * can pair again; the owner confirms with a fresh phrase.
 */
function forgetPreview(home: string, host: string, tokenId: string): TuiHostPairingPreview {
  const confirmation = `FORGET ${randomBytes(6).toString('hex')}`;
  let consumed = false;
  return {
    result: {
      status: 'credential-rejected', host, confirmation,
      confirmationPrompt: 'forget the stored credential so this terminal can pair again',
      message: `The host at ${host} no longer accepts the stored device credential (it was revoked, or the daemon there was reset). Use ${PAIR_HOST_CONTROL} with Apply: Review and confirm it, and confirm, to forget it; then pair again the same way with Shared token: Yes.`,
    },
    async confirm(answer) {
      if (consumed || answer !== confirmation) return cancelled();
      consumed = true;
      return forgotten(await removeTuiHostPairing(home, host, tokenId), host, tokenId);
    },
  };
}

/**
 * `/devices unpair-host` and `goodvibes host unpair`: forget this terminal's stored
 * device credential for the selected host. Local only; nothing is sent.
 */
export async function unpairTuiHost(options: NativeHostCredentialOptions): Promise<TuiHostPairingResult> {
  const home = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
  const host = resolveTuiHostOrigin(options.configManager);
  if (!host) return { status: 'blocked', message: 'No host is selected, so there is no credential to forget. Set controlPlane.publicBaseUrl (or pass --url) to name the host.' };
  const state = readTuiHostPairing(home, host);
  if (state.status === 'unavailable') return { status: 'blocked', host, message: `${state.reason} Nothing was forgotten.` };
  if (state.status === 'missing') return { status: 'blocked', host, message: 'No device credential is stored for this host; nothing to forget.' };
  if (state.status === 'unknown') return { ...unknown(host), message: `${unknown(host).message} Use ${PAIR_HOST_CONTROL} with Apply: Review and confirm it, to review the unresolved attempt and forget it.` };
  return forgotten(await removeTuiHostPairing(home, host, state.tokenId), host, state.tokenId);
}

/** Read-only preview, except that an attempt the owner already confirmed and
 * whose reply was lost is repeated under its own id when the bootstrap is
 * selected. Source credentials are used only after explicit bootstrap
 * selection; no generic command, startup or native operation can confirm a new migration.
 * The interactive shell holds its capability privately across the owner gesture. Secrets and remote errors never enter presentation data.
 */
export async function previewTuiHostPairing(options: TuiHostPairingOptions, name = 'GoodVibes TUI', signal?: AbortSignal): Promise<TuiHostPairingPreview> {
  try {
    if (signal?.aborted) return { result: cancelled() };
    if (!name.trim() || name.length > 80 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name)) return { result: { status: 'blocked', message: 'Use a nonempty device name of at most 80 characters without control characters.' } };
    name = name.trim();
    const homeNow = () => typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
    const home = homeNow(); const host = resolveTuiHostOrigin(options.configManager);
    if (!host || !resolveDaemonEnabled(options.configManager)) return { result: unavailable() };
    const state = readTuiHostPairing(home, host);
    if (state.status === 'unavailable') return { result: { status: 'blocked', host, message: `${state.reason} Then use ${PAIR_HOST_CONTROL} again.` } };
    const sameSelection = () => homeNow() === home && resolveDaemonEnabled(options.configManager) && resolveTuiHostOrigin(options.configManager) === host;
    // The flow carries the record it read; the store's compare-and-swap on begin
    // and complete refuses a record another process changed meanwhile.
    const auth = async (token: string, requestSignal?: AbortSignal, sourceCurrent: () => boolean = sameSelection) => {
      const client = createOperatorApiClient({ baseUrl: host, authToken: token, fetchImpl: (input, init) => {
        // Client setup may await before dispatch: a token is sent only to the origin still selected.
        if (requestSignal?.aborted || !sourceCurrent()) throw new Error('Pairing selection changed');
        return (options.fetchImpl ?? fetch)(input, { ...init, redirect: 'error' });
      } });
      const assertCurrent = () => {
        requestSignal?.throwIfAborted();
        if (!sourceCurrent()) throw new Error('Pairing selection changed');
      };
      try {
        for (let attempt = 0; ; attempt++) {
          assertCurrent();
          const deadline = AbortSignal.timeout(1500);
          try {
            const live = await client.invoke('control.auth.current', {}, {
              signal: AbortSignal.any([deadline, ...(requestSignal ? [requestSignal] : [])]),
            });
            assertCurrent();
            return live;
          } catch (error) {
            assertCurrent();
            // A fresh read can recover an interrupted or empty host response.
            // Both attempts validate fully; migration remains a single POST.
            if (attempt !== 0 || (!deadline.aborted && !(error instanceof GoodVibesError
              && (error.kind === 'network' || error.kind === 'contract')))) throw error;
          }
        }
      }
      finally { client.dispose(); }
    };
    // A freshly saved credential counts as paired only once the host verifies it as this device.
    const verifyMinted = async (minted: { readonly token: string; readonly tokenId: string }, verifySignal?: AbortSignal): Promise<TuiHostPairingResult> => {
      if (verifySignal?.aborted || !sameSelection()) return unverified(host);
      let verified;
      try { verified = await auth(minted.token, verifySignal); } catch { return unverified(host); }
      const effective = resolveNativeHostCredential(options);
      if (verifySignal?.aborted || !sameSelection() || !isNativePairedPrincipal(verified, `pairing:${minted.tokenId}`) || !effective.available || effective.baseUrl !== host || effective.token !== minted.token) return unverified(host);
      return { status: 'paired', host, message: 'TUI pairing is saved and the selected host verified its native authority. Provider, workspace, Jev and execution readiness remain separate checks.' };
    };
    if (state.status === 'unknown') {
      // The owner confirmed this attempt when it was first sent. With the bootstrap
      // selected again it is repeated under its own id, which the host answers with
      // the credential it already made (or a first one), never a second.
      const token = options.bootstrapShared ? readTuiLegacyPairingBootstrap(home) : null;
      if (!token) return clearPreview(home, host, state.attemptId);
      const current = () => sameSelection() && readTuiLegacyPairingBootstrap(home) === token;
      const outcome = await mintTuiDevicePairing({ home, host, token, name: state.name, repeat: { attemptId: state.attemptId }, current, fetchImpl: options.fetchImpl, signal });
      switch (outcome.status) {
        case 'paired': return { result: await verifyMinted(outcome, signal) };
        case 'unknown': return clearPreview(home, host, state.attemptId);
        case 'refused': return { result: { status: 'blocked', host, message: `The host refused the repeated pairing request (HTTP ${outcome.httpStatus}), so the unresolved attempt was forgotten; anything the host made for it was never received and lapses unused. Preview again to pair.` } };
        case 'changed': return { result: changed() };
        case 'cancelled': return { result: cancelled() };
        default: return { result: unavailable() };
      }
    }
    if (state.status === 'paired') {
      let live: Awaited<ReturnType<typeof auth>>;
      try { live = await auth(state.token, signal); } catch (error) {
        if (!signal?.aborted && error instanceof GoodVibesError && error.kind === 'auth') return forgetPreview(home, host, state.tokenId);
        return { result: unverified(host) };
      }
      if (signal?.aborted || !sameSelection() || !isNativePairedPrincipal(live, `pairing:${state.tokenId}`)) return { result: unverified(host) };
      return { result: { status: 'already-paired', host, message: 'This TUI host credential is saved and its expected native principal is verified. No credential will be minted or replaced. To forget it: Devices and network, Paired tab, Forget its daemon pairing.' } };
    }
    if (!options.bootstrapShared) return { result: { status: 'blocked', host, message: 'No device credential is bound to this origin. For the daemon on this machine, /work creates one on first use. Set Shared token to Yes to create it now with the daemon operator token.' } };
    const token = readTuiLegacyPairingBootstrap(home);
    if (!token) return { result: { status: 'blocked', host, message: 'The selected legacy bootstrap is missing or unsafe. It must be an owned, private regular daemon operator-tokens.json file; this command never creates or repairs it.' } };
    const current = () => sameSelection() && readTuiLegacyPairingBootstrap(home) === token;
    const live = await auth(token, signal, current);
    if (signal?.aborted) return { result: cancelled() };
    if (!current()) return { result: changed() };
    if (!isHostPairingBootstrapPrincipal(live)) return { result: { status: 'blocked', host, message: 'This host must verify the explicitly selected bootstrap as its legacy shared operator token with write:control-plane. No credential was created.' } };
    const confirmation = `PAIR ${randomBytes(6).toString('hex')}`;
    let consumed = false;
    return { result: {
      status: 'preview', host, name, confirmation,
      scopeDisclosure: 'This creates a persistent administrative per-device credential on the displayed GoodVibes host, including native work and fleet execution authority. The bootstrap is the existing daemon-global operator token. The new secret is stored only in this TUI home, bound to this exact origin. The shared token remains active; nothing is revoked.',
      message: 'Preview only. Confirm the fresh phrase in this owner terminal to make one migration request.',
    }, async confirm(answer, actionSignal) {
      if (consumed) return cancelled(); consumed = true;
      if (answer !== confirmation || actionSignal?.aborted) return cancelled();
      let attempted = false;
      try {
        if (!current()) return changed();
        const revalidated = await auth(token, actionSignal, current);
        if (actionSignal?.aborted) return cancelled();
        if (!current() || !isHostPairingBootstrapPrincipal(revalidated)) return changed();
        const outcome = await mintTuiDevicePairing({ home, host, token, name, current, fetchImpl: options.fetchImpl, signal: actionSignal });
        attempted = true;
        if (outcome.status === 'refused') return refused(host, outcome.httpStatus);
        if (outcome.status === 'cancelled') return cancelled();
        if (outcome.status === 'changed') return changed();
        if (outcome.status === 'unavailable') return unavailable();
        if (outcome.status !== 'paired') return unknown(host);
        // The only copy was saved before verification. Late responses may preserve the
        // original host's recovery state, never create a replacement or revoke it.
        return await verifyMinted(outcome, actionSignal);
      } catch { return attempted ? unknown(host) : actionSignal?.aborted ? cancelled() : unavailable(); }
    } };
  } catch { return { result: signal?.aborted ? cancelled() : unavailable() }; }
}

export function formatTuiHostPairing(result: TuiHostPairingResult): string {
  return [`TUI host pairing: ${result.status}`, ...(result.host ? [`  Host: ${result.host}`] : []), ...(result.name ? [`  Device name: ${result.name}`] : []),
    ...(result.scopeDisclosure ? [`  Access: ${result.scopeDisclosure}`] : []), `  ${result.message}`].join('\n');
}
