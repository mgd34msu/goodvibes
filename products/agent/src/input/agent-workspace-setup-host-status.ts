/**
 * The connected host's setup state, from one bounded probe.
 *
 * The setup view is built synchronously, and a synchronous build cannot tell
 * whether the host answers or whether this Agent's credential is accepted. So
 * the workspace starts one probe of the host's `/status` route when it opens
 * (the route needs the `read:control-plane` scope, so an answer proves both the
 * host and the credential), keeps the answer for the session with the time it
 * was taken, and the checklist reads it from here. Until the first answer the
 * two host steps say "checking". Ctrl+R in the workspace takes a new reading.
 * A reading is held per host address and credential file, the two facts it is
 * about.
 *
 * With no credential there is nothing to send to `/status`, so one request to
 * the host's public auth route says whether a host is there at all.
 *
 * Cost: one request with a 3 s deadline when the workspace opens, for a host on
 * this computer or another (none if a reading for that host younger than
 * `freshMs` is held), one on Ctrl+R; nothing per repaint, nothing on a timer.
 */
import type { CommandContext } from './command-registry.ts';
import { readConnectedHostMethod, resolveConnectedHostConnection } from './connected-host-routes.ts';

const HOST_PROBE_DEADLINE_MS = 3_000;

export type AgentWorkspaceHostSetupReading =
  | { readonly state: 'checking' }
  | {
    readonly state: 'checked';
    readonly checkedAt: number;
    /** The host answered (any HTTP answer, including a refusal of the credential). */
    readonly reachable: boolean;
    /**
     * The host accepted this Agent's credential for a scoped read (true), refused
     * it (false), or answered with something that does not decide it (null: a
     * version mismatch, a server error, a cancelled read).
     */
    readonly credentialAccepted: boolean | null;
    /** A credential file exists for this host. */
    readonly credentialPresent: boolean;
    readonly detail: string;
  };

interface HeldReading {
  reading?: CheckedReading;
  pending?: Promise<CheckedReading> | undefined;
}

/** One reading per host address and credential file for the life of the process. */
const readings = new Map<string, HeldReading>();

function readingKey(baseUrl: string, credentialPath: string): string {
  return `${baseUrl}\u0000${credentialPath}`;
}

/** The held reading for a host and credential file; `checking` when none has been taken yet. */
export function agentWorkspaceHostSetupReading(baseUrl: string, credentialPath: string): AgentWorkspaceHostSetupReading {
  return readings.get(readingKey(baseUrl, credentialPath))?.reading ?? { state: 'checking' };
}

/**
 * Take a reading of the connected host unless one is held (or `force`). Never
 * throws: every failure is a reading that says what happened.
 */
export function checkAgentWorkspaceHostSetup(
  context: CommandContext,
  options: { readonly force?: boolean; readonly freshMs?: number } = {},
): Promise<Extract<AgentWorkspaceHostSetupReading, { state: 'checked' }>> {
  const connection = resolveConnectedHostConnection(context);
  const key = readingKey(connection.baseUrl, connection.tokenPath);
  const held = readings.get(key) ?? {};
  readings.set(key, held);
  if (held.pending) return held.pending;
  const fresh = held.reading !== undefined && (options.freshMs === undefined || Date.now() - held.reading.checkedAt <= options.freshMs);
  if (held.reading && fresh && options.force !== true) return Promise.resolve(held.reading);
  const credentialPresent = Boolean(connection.token);
  const pending = (credentialPresent ? probeWithCredential(context, connection.baseUrl) : probeWithoutCredential(connection.baseUrl))
    .then((reading) => {
      held.reading = reading;
      return reading;
    }).finally(() => {
      held.pending = undefined;
    });
  held.pending = pending;
  return pending;
}

type CheckedReading = Extract<AgentWorkspaceHostSetupReading, { state: 'checked' }>;

/** With no credential there is nothing to send to `/status`; the public auth route says whether a host is there at all. */
async function probeWithoutCredential(baseUrl: string): Promise<CheckedReading> {
  const checkedAt = Date.now();
  try {
    await fetch(`${baseUrl}/api/control-plane/auth`, { redirect: 'error', signal: AbortSignal.timeout(HOST_PROBE_DEADLINE_MS) });
    return { state: 'checked', checkedAt, reachable: true, credentialAccepted: false, credentialPresent: false, detail: `A host answers at ${baseUrl}, and this Agent holds no credential for it.` };
  } catch {
    return { state: 'checked', checkedAt, reachable: false, credentialAccepted: false, credentialPresent: false, detail: `No connected host answered at ${baseUrl}; the Agent works on its own without one.` };
  }
}

function probeWithCredential(context: CommandContext, baseUrl: string): Promise<CheckedReading> {
  return readConnectedHostMethod(context, 'control.status', {}, { timeoutMs: HOST_PROBE_DEADLINE_MS }).then((result): CheckedReading => {
    const checkedAt = Date.now();
    if (result.ok) {
      return { state: 'checked', checkedAt, reachable: true, credentialAccepted: true, credentialPresent: true, detail: `The host at ${baseUrl} answered and accepted this Agent's credential.` };
    }
    if (result.kind === 'auth_required') {
      return { state: 'checked', checkedAt, reachable: true, credentialAccepted: false, credentialPresent: true, detail: `The host at ${baseUrl} refused this Agent's credential (${result.message}).` };
    }
    // Only an answer or a refusal of the credential decides it. Nothing answering at
    // the address (or something other than a GoodVibes host answering) is unreachable;
    // any other failure is a host that answered without deciding the credential.
    return {
      state: 'checked',
      checkedAt,
      reachable: result.kind !== 'connected_host_unavailable' && result.kind !== 'connected_host_route_unavailable',
      credentialAccepted: null,
      credentialPresent: true,
      detail: `The host at ${baseUrl} did not answer the status read: ${result.message}.`,
    };
  });
}
