/**
 * daemon-verbs.ts, this product's plug into the platform's client seams.
 *
 * ── What is here and what deliberately is not ─────────────────────────────
 *
 * The POLICY for every seam this agent crosses, raising an approval, writing a
 * daemon-owned setting, storing a credential, receiving inbound session work,
 * answering a conversation-rewind question, reaching a paired phone, lives in
 * `@goodvibes-jev/engine/platform/platform/runtime/client`. Each of those modules takes
 * one thing: a `DaemonVerbCaller`, two methods.
 *
 * This file is that one thing, for this product. Resolving WHICH host this
 * agent talks to is a consumer trust-boundary concern the platform core deliberately
 * never reaches into (the carve-out recorded beside the spine transports), and
 * this agent already had the resolution, `createSpineConnectionResolver` plus
 * the connected-host operator token. So the resolution stays here and the seams
 * are shared, which is the split that lets both surface products use one
 * implementation of each policy without either handing its trust decisions to
 * the other.
 *
 * ── Why one route rather than two ─────────────────────────────────────────
 *
 * Every catalogued verb is served over the generic gateway-method route
 * regardless of the transport it DECLARES, and most of what this agent needs is
 * declared `ws` with no REST path of its own: `approvals.raise`,
 * `credentials.set`/`delete`, `rewind.conversation.*`, the `devices.*` family.
 * A typed-client-first path would therefore fall through to this route for the
 * majority of calls anyway, so this uses it for all of them: one code path, one
 * failure mode, and no verb that works only because it happened to have a REST
 * binding.
 *
 * ── Refusals are values; failures are throws ──────────────────────────────
 *
 * `probe()` answers with the honest reason rather than throwing it, because
 * callers use it to degrade or to print a line instead of crashing a turn. Once
 * a request is actually made, a non-2xx throws, including the 404 that means
 * "this host has not wired that verb", which is a real answer about the host
 * and must never be laundered into an empty result.
 */
import { statSync } from 'node:fs';
import { OwnedSelectionObservation, captureRemoteSettingsPrecondition } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { assertProjectionCurrent } from '@goodvibes-jev/engine/platform/platform/tools';
import { agentHostPairingStorePath } from '../connected-host-pairing-store.ts';
import { connectedHostOperatorTokenPath } from '../connected-host-auth.ts';
import { resolveConnectedHostDialEnabled, captureRemoteSettingsImportPrecondition, observeImportFile,
  assertImportFileCurrent } from '@goodvibes-jev/engine/platform/platform/config';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { DaemonReachability, DaemonVerbCaller } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { readConnectedHostOperatorToken, connectedHostTokenRequiredMessage, type ConnectedHostCredentialSource } from '../connected-host-auth.ts';
import { resolveConnectedHostBaseUrl } from '../../config/connected-host-dial.ts';

export interface AgentDaemonVerbCallerOptions {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
  /** Kept by the actual operation when it constructs fresh option views. */
  readonly observation?: OwnedSelectionObservation;
  /** Injectable for tests, so a seam under test never reaches a real port. */
  readonly fetchImpl?: typeof fetch;
  /**
   * How long one verb call may take before it is abandoned. Default 2 minutes,
   * long enough for `sessions.hosted.create`. A daemon that accepts the
   * connection and never answers would otherwise hang the caller forever.
   */
  readonly invokeTimeoutMs?: number;
  /** Test seam: the signal that bounds one verb call. Overrides `invokeTimeoutMs`. */
  readonly invokeSignal?: () => AbortSignal;
  /**
   * Why the attached host may not be used, when it was judged too old for this
   * build (runtime/daemon-build-compatibility.ts). Every call and stream that
   * resolves through here refuses with that sentence instead of reaching a
   * host that would answer 404.
   */
  readonly hostRefusal?: () => string | undefined;
}

const DEFAULT_INVOKE_TIMEOUT_MS = 120_000;

interface ResolvedConnection {
  readonly baseUrl: string;
  readonly token: string;
  readonly selectionIdentity: string;
  readonly expectedPrincipalId?: string;
  /** Where the token came from: native work presents only a pairing or an environment token. */
  readonly source: ConnectedHostCredentialSource;
}

// A retained options object identifies the caller's live connection, not a
// credential or a persisted owner. Explicit observers also support new option
// views within the same operation; unrelated callers cannot replace its frame.
const connectionObservations = new WeakMap<AgentDaemonVerbCallerOptions, OwnedSelectionObservation>();

/** Resolve the connected host, or a refusal naming what is missing. */
function resolveConnection(options: AgentDaemonVerbCallerOptions): ResolvedConnection | { readonly reason: string } {
  let observation = options.observation ?? connectionObservations.get(options);
  const unavailable = (reason: string) => { observation?.retire(); return { reason }; };
  try {
    const { configManager } = options;
    // A context whose config manager cannot answer (a narrow embed, a partially
    // wired test double) is one more case of "no host can be resolved", never an
    // exception to raise from a probe.
    if (typeof (configManager as { get?: unknown } | null)?.get !== 'function') {
      return unavailable('no config manager is wired here, so no connected host can be resolved.');
    }
    // `daemon.connectedHost.enabled`, NOT `daemon.enabled`.
    //
    // `daemon.enabled` answers whether this surface ADOPTS a session daemon of
    // its own. It is the wrong question here, and asking it was a real defect:
    // on a machine with `daemon.enabled: false` and a connected host that was
    // live and answering, this gate refused every call through this caller, the
    // session-inputs poll (every two seconds, thousands of log lines an hour),
    // the conversation-rewind host registration, the approvals update stream and
    // the hosted-conversation handoff, while the session spine, the memory
    // spine and the operator tools dialed the SAME host without trouble, because
    // none of them read the flag. Half the product believed there was no daemon.
    //
    // The two meanings are now two settings. This one is the dial permission.
    if (!resolveConnectedHostDialEnabled(configManager)) {
      return unavailable('this surface is set not to dial a connected host (daemon.connectedHost.enabled=false), '
        + 'nothing to reach. Set it to true in settings, then retry.');
    }
    const refusal = options.hostRefusal?.();
    if (refusal) return unavailable(refusal);
    const homeDirectory = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
    const baseUrl = resolveConnectedHostBaseUrl(configManager);
    if (!observation) {
      observation = new OwnedSelectionObservation();
      connectionObservations.set(options, observation);
    }
    const token = readConnectedHostOperatorToken(homeDirectory, baseUrl, observation, configManager);
    if (!token.token) {
      return unavailable(token.error ?? connectedHostTokenRequiredMessage(token.path));
    }
    return { baseUrl, token: token.token, selectionIdentity: token.selectionIdentity, source: token.source,
      ...(token.expectedPrincipalId === undefined ? {} : { expectedPrincipalId: token.expectedPrincipalId }) };
  } catch (error) { observation?.retire(); throw error; }
}

/**
 * The same host resolution the verb caller uses, for the ONE consumer that
 * needs the address rather than a call: the `control.approval_update` stream.
 *
 * A stream is not a verb, it is a long-lived GET on the control plane's event
 * endpoint, so it cannot go through `invoke`. It must still reach exactly the
 * host `invoke` reaches, with exactly the token `invoke` sends, or the approvals list
 * would end up polling one daemon and streaming from another. Exporting the
 * resolution (rather than duplicating it) is what guarantees that.
 *
 * Returns the honest reason instead of throwing, same as `probe()`: a caller
 * that cannot open a stream keeps whatever fallback it had.
 */
export function resolveConnectedHostConnection(
  options: AgentDaemonVerbCallerOptions,
): ResolvedConnection | { readonly reason: string } {
  return resolveConnection(options);
}

/** A non-2xx from the host, carrying the status and the host's code so callers can classify it. */
export class ConnectedHostVerbError extends Error {
  readonly status: number;
  /** The code the host's error body named, when it named one. */
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ConnectedHostVerbError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Whether the host positively refused the call (a 4xx other than a request
 * timeout). Anything else, a dropped connection, a timeout, a 5xx, leaves it
 * unknown whether the host already acted, so a caller must not redo the work
 * somewhere else as if nothing had happened.
 */
export function isDefiniteHostRefusal(error: unknown): boolean {
  return error instanceof ConnectedHostVerbError && error.status >= 400 && error.status < 500 && error.status !== 408;
}

/**
 * Render a thrown verb error honestly: a 404 means this host has not wired a
 * handler for the verb (a live host that simply does not implement it yet),
 * never "no result" or a fabricated empty state.
 */
export function describeConnectedHostVerbError(error: unknown): string {
  if (error instanceof ConnectedHostVerbError) {
    if (error.status === 404) {
      return 'the connected host returned 404, this verb is not wired up on that host yet.';
    }
    if (error.status === 401 || error.status === 403) {
      return `the connected host rejected the request (${error.status}): ${error.message}`;
    }
    return `the request failed (${error.status}): ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build the verb caller every client seam in this product is handed.
 *
 * The connection is re-resolved per call rather than captured once: the token
 * file is written by a pairing step that may land after this process started,
 * and a caller that captured an absent token at boot would keep refusing for
 * the life of the process.
 */
export function createAgentDaemonVerbCaller(options: AgentDaemonVerbCallerOptions): DaemonVerbCaller {
  const fetchImpl = options.fetchImpl ?? fetch;

  const probe = (): DaemonReachability => {
    const resolved = resolveConnection(options);
    return 'reason' in resolved ? { available: false, reason: resolved.reason } : { available: true };
  };

  return {
    probe,
    captureSettingsImportPrecondition: async (request, restriction) => {
      const signal = restriction?.signal, restrictCurrent = restriction?.assertCurrent;
      const manager = options.configManager, get = manager.get, homeSelection = options.homeDirectory;
      const home = typeof homeSelection === 'function' ? homeSelection() : homeSelection;
      const sources = [connectedHostOperatorTokenPath(home), agentHostPairingStorePath(home)]
        .map(path => ({ path, observation: observeImportFile(path) }));
      const resolved = resolveConnection(options);
      if ('reason' in resolved) throw new Error('Settings connection owner unavailable.');
      const assertCurrent = () => {
        if (restriction?.signal !== signal || restriction?.assertCurrent !== restrictCurrent) throw new Error('Settings connection restriction changed.');
        signal?.throwIfAborted(); assertProjectionCurrent(restrictCurrent);
        if (options.configManager !== manager || manager.get !== get || options.homeDirectory !== homeSelection
          || (typeof homeSelection === 'function' ? homeSelection() : homeSelection) !== home) throw new Error('Settings connection owner changed.');
        for (const source of sources) assertImportFileCurrent(source.path, source.observation);
        const current = resolveConnection(options);
        if ('reason' in current || current.baseUrl !== resolved.baseUrl || current.token !== resolved.token
          || current.selectionIdentity !== resolved.selectionIdentity || current.expectedPrincipalId !== resolved.expectedPrincipalId) throw new Error('Settings connection owner changed.');
      };
      // The registry/native settings plan owns config incarnation. This source
      // binds the actual endpoint selection and its complete physical credentials.
      assertCurrent();
      return await captureRemoteSettingsImportPrecondition({ baseUrl: resolved.baseUrl, token: resolved.token, source: 'installed connected host' }, request,
        { fetchImpl, ...(signal ? { signal } : {}), assertCurrent });
    },
    captureSettingsPrecondition: async (request) => {
      const manager = options.configManager;
      // An unversioned embed cannot prove connection ABA, so it must not offer
      // a prepared write. Ordinary read/manual verb behavior stays unchanged.
      if (typeof manager.getConfigurationIncarnation !== 'function') throw new Error('Settings connection owner unavailable.');
      const incarnation = manager.getConfigurationIncarnation();
      const home = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
      const credentialStamp = (): string => {
        // File incarnation, not credential bytes. Even replacement with the same
        // token retires the capture; no credential or hash enters public facts.
        return [connectedHostOperatorTokenPath(home), agentHostPairingStorePath(home)].map(path => {
          try { const stat = statSync(path, { bigint: true }); return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'; throw new Error('Settings connection owner unavailable.'); }
        }).join('|');
      };
      const stamp = credentialStamp();
      const resolved = resolveConnection(options);
      if ('reason' in resolved) throw new Error('Settings connection owner unavailable.');
      const assertCurrent = () => {
        if (options.configManager !== manager || manager.getConfigurationIncarnation() !== incarnation
          || (typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory) !== home
          || credentialStamp() !== stamp) throw new Error('Settings connection owner changed.');
        const current = resolveConnection(options);
        if ('reason' in current || current.baseUrl !== resolved.baseUrl || current.token !== resolved.token
          || current.selectionIdentity !== resolved.selectionIdentity) throw new Error('Settings connection owner changed.');
      };
      assertCurrent();
      return await captureRemoteSettingsPrecondition({ baseUrl: resolved.baseUrl, token: resolved.token, source: 'installed connected host' },
        request, { fetchImpl, assertCurrent });
    },
    invoke: async <T,>(methodId: string, input?: unknown): Promise<T> => {
      const resolved = resolveConnection(options);
      if ('reason' in resolved) throw new Error(`cannot invoke '${methodId}': ${resolved.reason}`);
      const timeoutMs = options.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
      const signal = options.invokeSignal ? options.invokeSignal() : AbortSignal.timeout(timeoutMs);
      let response: Response;
      let payload: unknown;
      try {
        response = await fetchImpl(
          `${resolved.baseUrl}/api/control-plane/methods/${encodeURIComponent(methodId)}/invoke`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${resolved.token}`, 'Content-Type': 'application/json' },
            // The envelope the route requires: `body` must be PRESENT even when
            // empty, or the route refuses with a 400 naming the shape it wanted.
            body: JSON.stringify({ body: input ?? {} }),
            signal,
          },
        );
        payload = await response.json().catch(() => null) as unknown;
        // A stalled body surfaces as a swallowed parse failure; the abort is the
        // truth, and a null payload must not pass as a successful empty answer.
        if (signal.aborted) throw new Error('aborted while reading the response body');
      } catch (error) {
        if (signal.aborted) {
          // Named TimeoutError so callers that must not repeat a call the host may
          // have run (speech-to-text routing) can recognise the unknown outcome.
          const timeout = new Error(
            `'${methodId}' got no answer from the connected host within ${Math.round(timeoutMs / 1000)}s, `
            + 'so the call was abandoned. The host may be hung or unreachable; the result of the call is unknown.',
          );
          timeout.name = 'TimeoutError';
          throw timeout;
        }
        throw error;
      }
      if (!response.ok) {
        const body = payload && typeof payload === 'object' ? payload as { error?: unknown; code?: unknown } : undefined;
        const described = body && 'error' in body ? String(body.error) : `HTTP ${response.status}`;
        const code = typeof body?.code === 'string' && body.code.length > 0 ? body.code : undefined;
        throw new ConnectedHostVerbError(`'${methodId}' failed: ${described}`, response.status, code);
      }
      return payload as T;
    },
  };
}
