import { canonicalizePairingHost } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-pairing-store';
import { createConnectedHost, isHostFailure, resolveConnectedHost, type ConnectedHostConnection } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-client';
import type { AgentDaemonVerbCallerOptions } from './client/daemon-verbs.ts';
import { isNativeOwnerPrincipal } from './native-paired-principal.ts';

export interface ConnectedHostReadiness {
  readonly status: 'ready' | 'disabled' | 'missing-credential' | 'unavailable' | 'unsupported-principal' | 'changed';
  readonly detail: string;
}

/** How long `setup status` and the setup tool wait for the host's answer. */
export const CONNECTED_HOST_READINESS_DEADLINE_MS = 5_000;

const sameConnection = (a: ConnectedHostConnection, b: ConnectedHostConnection): boolean =>
  a.baseUrl === b.baseUrl && a.token === b.token && a.expectedPrincipalId === b.expectedPrincipalId;

/**
 * The cause of a failed probe, worded here from the failure's code and status.
 * The host's own error text is never repeated: it can carry anything.
 */
function failureDetail(error: unknown, baseUrl: string, deadlineMs: number): string {
  if (!isHostFailure(error)) return `The auth check against ${baseUrl} failed before it was sent. Rerun setup status.`;
  const { code, status } = error.refusal;
  switch (code) {
    case 'host_timeout':
      return status === undefined
        ? `The host at ${baseUrl} did not answer within ${deadlineMs / 1000} s. Check that the daemon there is running and reachable from this machine, then rerun setup status.`
        : `The host at ${baseUrl} timed out (HTTP ${status}). Rerun setup status.`;
    case 'host_unreachable':
      return `Nothing answered at ${baseUrl}. Start the GoodVibes daemon there or correct controlPlane.host and controlPlane.port, then rerun setup status.`;
    case 'auth_rejected':
      return `The host at ${baseUrl} rejected the current credential (HTTP ${status ?? 401}). Pair again with setup pair, then rerun setup status.`;
    case 'forbidden':
      return `The host at ${baseUrl} accepted the credential but refused the auth check (HTTP ${status ?? 403}). Use a paired owner credential, then rerun setup status.`;
    case 'incompatible':
      return `The GoodVibes host at ${baseUrl} does not serve the auth check (HTTP 404); it is older than this Agent. Update GoodVibes on the host, then rerun setup status.`;
    case 'route_unavailable':
      return `Nothing at ${baseUrl} answered as a GoodVibes daemon (HTTP 404). Check controlPlane.host and controlPlane.port, then rerun setup status.`;
    case 'response_invalid':
      return `The host at ${baseUrl} answered the auth check in a shape this Agent cannot read. Run the same GoodVibes version on the host and here, then rerun setup status.`;
    case 'cancelled':
      return 'The auth check was cancelled before the host answered.';
    default:
      return `The host at ${baseUrl} failed the auth check${status === undefined ? '' : ` (HTTP ${status})`}. Read the daemon log on the host, then rerun setup status.`;
  }
}

/**
 * Read-only evidence for the host and effective credential native intake uses:
 * one connection resolution, one request, one comparison after the reply (the
 * `changed` status). Never returns a credential or the host's error text.
 */
export async function readConnectedHostReadiness(options: AgentDaemonVerbCallerOptions, ownership: { readonly signal?: AbortSignal | undefined; readonly assertCurrent?: (() => void) | undefined; readonly deadlineMs?: number | undefined } = {}): Promise<ConnectedHostReadiness> {
  ownership.assertCurrent?.();
  const selection = { configManager: options.configManager, homeDirectory: options.homeDirectory };
  const selected = resolveConnectedHost(selection);
  if (selected.unavailable?.code === 'dial_disabled') {
    return { status: 'disabled', detail: 'Connected-host dialing is disabled (daemon.connectedHost.enabled is false); no auth check was made.' };
  }
  if (!canonicalizePairingHost(selected.baseUrl)) {
    return { status: 'unavailable', detail: 'The configured host address is not a usable http(s) origin; no auth check was made. Correct controlPlane.host and controlPlane.port.' };
  }
  if (selected.token === null) {
    return { status: 'missing-credential', detail: `No effective connected-host credential: ${selected.unavailable?.reason ?? `nothing found in ${selected.credential}`}. Pair with setup pair, then rerun setup status.` };
  }
  const host = createConnectedHost(() => selected, { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  const deadlineMs = ownership.deadlineMs ?? CONNECTED_HOST_READINESS_DEADLINE_MS;
  let result: ConnectedHostReadiness;
  try {
    const auth = await host.invoke('control.auth.current', {}, { signal: ownership.signal, deadlineMs });
    result = isNativeOwnerPrincipal(auth, selected.expectedPrincipalId)
      ? { status: 'ready', detail: 'The selected host verified the current credential as the owner (this machine\'s operator token or a paired device) with native intake scopes.' }
      : { status: 'unsupported-principal', detail: 'The selected host did not verify the owner with read:work-ledger and write:work-ledger. From a machine other than the daemon\'s, the operator token is not enough; pair with setup pair.' };
  } catch (error) {
    result = { status: 'unavailable', detail: failureDetail(error, selected.baseUrl, deadlineMs) };
  }
  if (!sameConnection(resolveConnectedHost(selection), selected)) {
    return { status: 'changed', detail: 'The selected host or effective credential changed during verification. Rerun setup status.' };
  }
  return result;
}
