import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isHostPairingBootstrapPrincipal, isNativePairedPrincipal, parseMintedPairingToken, readHostPairingResponse } from '@goodvibes-jev/engine/terminal-shell/native-paired-principal';
import { createOperatorApiClient } from '@goodvibes-jev/engine/operator-client';
import { GoodVibesError } from '@goodvibes-jev/engine/errors';
import { resolveDaemonEnabled } from '@goodvibes-jev/engine/platform/platform/config';
import { resolveNativeHostCredential, resolveTuiHostOrigin, type NativeHostCredentialOptions } from './client/native-host-credential.ts';
import { readTuiLegacyPairingBootstrap } from './tui-host-pairing-bootstrap.ts';
import { beginTuiHostPairing, clearTuiHostPairingAttempt, completeTuiHostPairing, readTuiHostPairing } from './tui-host-credential-store.ts';

export interface TuiHostPairingResult {
  readonly status: 'preview' | 'blocked' | 'already-paired' | 'cancelled' | 'changed' | 'unknown' | 'cleared' | 'paired' | 'paired-unverified';
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
const unknown = (host: string): TuiHostPairingResult => ({ status: 'unknown', host, message: 'A pairing attempt may already have created a credential. Review its outcome on this host; no automatic remint, reset or revoke is allowed.' });
const refused = (host: string, status: number): TuiHostPairingResult => ({ status: 'blocked', host, message: `The host refused the pairing request (HTTP ${status}), so no credential was created and nothing was saved. Preview again to retry.` });
const changed = (): TuiHostPairingResult => ({ status: 'changed', message: 'The selected host, home, bootstrap credential, authority or local pairing state changed. Preview again before confirming.' });
const cancelled = (): TuiHostPairingResult => ({ status: 'cancelled', message: 'Pairing cancelled before the migration request.' });
const unverified = (host: string): TuiHostPairingResult => ({ status: 'paired-unverified', host, message: 'The credential is saved for its original host, but current native authority is unverified. Inspect goodvibes host pair again; do not remint.' });

/**
 * An unresolved attempt blocks pairing until the owner has checked the host.
 * Clearing it is an owner-terminal action: it only deletes the local marker, so
 * it is offered with the warning that a credential the host did mint stays there.
 */
function clearPreview(home: string, host: string, attemptId: string): TuiHostPairingPreview {
  const confirmation = `CLEAR ${randomBytes(6).toString('hex')}`;
  let consumed = false;
  return {
    result: {
      ...unknown(host),
      confirmation,
      confirmationPrompt: 'forget this unresolved attempt',
      message: `${unknown(host).message} If the host shows no pairing token for this attempt, run /host pair --apply and confirm to forget it and pair again; a token that does exist stays valid until you revoke it on the host.`,
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

/** Read-only preview. Source credentials are used only after explicit bootstrap
 * selection; no generic command, startup or native operation can confirm a migration.
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
    if (state.status === 'unknown') return clearPreview(home, host, state.attemptId);
    if (state.status === 'unavailable') return { result: unavailable() };
    const sameSelection = () => homeNow() === home && resolveDaemonEnabled(options.configManager) && resolveTuiHostOrigin(options.configManager) === host;
    const auth = async (token: string, requestSignal?: AbortSignal, sourceCurrent: () => boolean = sameSelection) => {
      const expectedState = readTuiHostPairing(home, host);
      const client = createOperatorApiClient({ baseUrl: host, authToken: token, fetchImpl: (input, init) => {
        // platform setup and retries may await before dispatch. Recheck at the real
        // network boundary so a stale selection cannot send even a read.
        if (requestSignal?.aborted || !sourceCurrent() || !sameSelection() || !isDeepStrictEqual(readTuiHostPairing(home, host), expectedState)) throw new Error('Pairing selection changed');
        return (options.fetchImpl ?? fetch)(input, { ...init, redirect: 'error' });
      } });
      const method = client.getOperation('control.auth.current');
      const schema = method.outputSchema, originalMethod = JSON.stringify(method);
      const assertCurrent = () => {
        requestSignal?.throwIfAborted();
        if (!sourceCurrent() || !sameSelection() || !isDeepStrictEqual(readTuiHostPairing(home, host), expectedState)
          || client.getOperation('control.auth.current') !== method || method.outputSchema !== schema
          || JSON.stringify(method) !== originalMethod) throw new Error('Pairing authority source changed');
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
    if (state.status === 'paired') {
      try {
        const live = await auth(state.token, signal);
        if (signal?.aborted || !sameSelection() || !isDeepStrictEqual(readTuiHostPairing(home, host), state) || !isNativePairedPrincipal(live, `pairing:${state.tokenId}`)) return { result: unverified(host) };
        return { result: { status: 'already-paired', host, message: 'This TUI host credential is saved and its expected native principal is verified. No credential will be minted or replaced.' } };
      } catch { return { result: unverified(host) }; }
    }
    if (!options.bootstrapShared) return { result: { status: 'blocked', host, message: 'No TUI credential is bound to this origin. Explicitly select --bootstrap-shared to use the existing daemon-global token for this one-shot migration. Native work never uses that token as a fallback.' } };
    const token = readTuiLegacyPairingBootstrap(home);
    if (!token) return { result: { status: 'blocked', host, message: 'The selected legacy bootstrap is missing or unsafe. It must be an owned, private regular daemon operator-tokens.json file; this command never creates or repairs it.' } };
    const current = () => sameSelection() && readTuiLegacyPairingBootstrap(home) === token;
    const live = await auth(token, signal, current);
    if (signal?.aborted) return { result: cancelled() };
    if (!current() || !isDeepStrictEqual(readTuiHostPairing(home, host), state)) return { result: changed() };
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
        if (!current() || !isDeepStrictEqual(readTuiHostPairing(home, host), state)) return changed();
        const revalidated = await auth(token, actionSignal, current);
        if (actionSignal?.aborted) return cancelled();
        if (!current() || !isDeepStrictEqual(readTuiHostPairing(home, host), state) || !isHostPairingBootstrapPrincipal(revalidated)) return changed();
        const attemptId = randomUUID();
        const begin = await beginTuiHostPairing(home, host, { attemptId, name, startedAt: Date.now() }, {}, () => !actionSignal?.aborted && current());
        if (begin.status !== 'begun') return begin.status === 'cancelled' ? actionSignal?.aborted ? cancelled() : changed() : begin.status === 'conflict' ? changed() : unavailable();
        attempted = true;
        // Durable uncertainty precedes the only request. Cancellation never clears it.
        const pending = readTuiHostPairing(home, host);
        if (pending.status !== 'unknown' || pending.attemptId !== attemptId || pending.name !== name) return unknown(host);
        if (actionSignal?.aborted || !current()) {
          // No request was sent, so nothing can have been minted: release the marker so pairing can be previewed again.
          const released = await clearTuiHostPairingAttempt(home, host, attemptId);
          if (released.status !== 'cleared') return unknown(host);
          return actionSignal?.aborted ? cancelled() : changed();
        }
        const response = await (options.fetchImpl ?? fetch)(`${host}/api/control-plane/methods/pairing.tokens.migrate/invoke`, {
          method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ body: { name } }), signal: AbortSignal.any([AbortSignal.timeout(5000), ...(actionSignal ? [actionSignal] : [])]),
        });
        if (!response.ok) {
          // A 4xx is the host refusing the request, so no credential was created and the marker is released. A timeout answer (408), a 5xx or a lost response may have followed a mint and stays unknown.
          if (response.status >= 400 && response.status < 500 && response.status !== 408) {
            const released = await clearTuiHostPairingAttempt(home, host, attemptId);
            if (released.status === 'cleared') return refused(host, response.status);
          }
          return unknown(host);
        }
        const payload = await readHostPairingResponse(response);
        const minted = parseMintedPairingToken(payload, name);
        if (!minted) return unknown(host);
        const complete = await completeTuiHostPairing(home, host, attemptId, { token: minted.token, tokenId: minted.id, name, createdAt: minted.createdAt });
        if (complete.status !== 'paired') return unknown(host);
        // Save the only copy before verification. Late responses may preserve the
        // original host's recovery state, never create a replacement or revoke it.
        if (actionSignal?.aborted || !sameSelection()) return unverified(host);
        let verified;
        try { verified = await auth(minted.token, actionSignal); } catch { return unverified(host); }
        const effective = resolveNativeHostCredential(options);
        if (actionSignal?.aborted || !sameSelection() || !isNativePairedPrincipal(verified, `pairing:${minted.id}`) || !effective.available || effective.baseUrl !== host || effective.token !== minted.token) return unverified(host);
        return { status: 'paired', host, message: 'TUI pairing is saved and the selected host verified its native authority. Provider, workspace, Jev and execution readiness remain separate checks.' };
      } catch { return attempted ? unknown(host) : actionSignal?.aborted ? cancelled() : unavailable(); }
    } };
  } catch { return { result: signal?.aborted ? cancelled() : unavailable() }; }
}

export function formatTuiHostPairing(result: TuiHostPairingResult): string {
  return [`TUI host pairing: ${result.status}`, ...(result.host ? [`  Host: ${result.host}`] : []), ...(result.name ? [`  Device name: ${result.name}`] : []),
    ...(result.scopeDisclosure ? [`  Access: ${result.scopeDisclosure}`] : []), `  ${result.message}`].join('\n');
}
