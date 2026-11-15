/**
 * keep-awake-remote.ts, forward the owner keep-awake toggle from a surface (the
 * TUI, the Agent) to an adopted EXTERNAL daemon over `power.keepAwake.set`.
 *
 * In the adopted-daemon topology the daemon is the owner of keep-awake: its
 * hold outlives a surface closing, and `power.keepAwake` is a surface-local
 * config key that does not reach the daemon's own config. Each surface still
 * holds a local inhibitor of its own, so keep-awake works with no daemon at
 * all; every change made in the surface is forwarded to the daemon, and the
 * CURRENT value, on or off, is sent again each time the daemon becomes
 * reachable, so a change made while it was away (a restart, a blip) reaches it.
 *
 * This file is the one forwarder both products use: the raw-REST request
 * (`postPowerKeepAwakeSet`, version tolerant, with the shared failure
 * classification), the reachability-gated send, the owner notice, the ordered
 * queue, and `createKeepAwakeForwarder`, which composes them for a surface that
 * brings its own transport.
 */
import { logger } from '../utils/logger.js';

export type PowerKeepAwakeRemoteFailureKind =
  | 'auth_required'
  | 'connected_host_unavailable'
  | 'connected_host_route_unavailable'
  | 'connected_host_error';

export interface PowerKeepAwakeRemoteConnection {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly tokenPath?: string;
}

export const POWER_KEEP_AWAKE_SET_PATH = '/api/power/keep-awake';
/** Best-effort background forward; short so it never blocks a settings-modal apply. */
export const POWER_KEEP_AWAKE_SET_TIMEOUT_MS = 1500;

export interface PowerKeepAwakeRemoteSuccess {
  readonly ok: true;
  /**
   * What the daemon says keep-awake is doing after the request ('off', 'held',
   * 'held-partial' or 'refused' when the OS denied the inhibitor); absent when
   * the daemon's answer did not carry it. `ok` only means the request was
   * accepted, so a surface must not call the host held unless this says so.
   */
  readonly keepAwakeState?: string;
}

export interface PowerKeepAwakeRemoteFailure {
  readonly ok: false;
  readonly kind: PowerKeepAwakeRemoteFailureKind;
  readonly status?: number;
  readonly error: string;
}

export type PowerKeepAwakeRemoteResult = PowerKeepAwakeRemoteSuccess | PowerKeepAwakeRemoteFailure;

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** What a served power state says keep-awake is doing ('off', 'held', 'held-partial', 'refused'), when it says. */
export function readServedKeepAwakeState(body: unknown): string | undefined {
  const served = isRecord(body) && isRecord(body.keepAwake) ? body.keepAwake.state : undefined;
  return typeof served === 'string' ? served : undefined;
}

/** Identical failure classification to the platform's other raw-REST wire mirrors. */
function classifyHttpFailure(status: number, body: unknown): PowerKeepAwakeRemoteFailure {
  const detail = isRecord(body) && typeof body.error === 'string' ? body.error : '';
  return {
    ok: false,
    status,
    kind: status === 401 || status === 403
      ? 'auth_required'
      : status === 404
        ? 'connected_host_route_unavailable'
        : 'connected_host_error',
    error: `HTTP ${status}${detail ? `: ${detail}` : ''}`,
  };
}

/**
 * Forward the owner keep-awake toggle to the adopted daemon's gateway. Never
 * throws, every failure mode (no token on disk, network down, an
 * incompatible/pre-power-verb daemon, a real server error) returns a
 * discriminated failure the caller logs and degrades from; the caller decides
 * whether to also apply locally.
 */
export async function postPowerKeepAwakeSet(
  connection: PowerKeepAwakeRemoteConnection,
  enabled: boolean,
  options: { readonly timeoutMs?: number } = {},
): Promise<PowerKeepAwakeRemoteResult> {
  if (!connection.token) {
    return {
      ok: false,
      kind: 'auth_required',
      error: connection.tokenPath
        ? `no connected-host operator token found at ${connection.tokenPath}`
        : 'no connected-host operator token found',
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? POWER_KEEP_AWAKE_SET_TIMEOUT_MS);
  try {
    const response = await fetch(`${connection.baseUrl}${POWER_KEEP_AWAKE_SET_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ enabled }),
      signal: controller.signal,
    });
    const body = await readResponseBody(response);
    if (!response.ok) return classifyHttpFailure(response.status, body);
    const served = readServedKeepAwakeState(body);
    return served !== undefined ? { ok: true, keepAwakeState: served } : { ok: true };
  } catch (error) {
    return { ok: false, kind: 'connected_host_unavailable', error: summarizeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

export interface ForwardKeepAwakeDeps {
  /** The existing daemon-adoption signal, reuse a session-spine client's probeReachability() in production. */
  readonly probeReachability: () => Promise<'unknown' | 'online' | 'offline'>;
  readonly resolveConnection: () => PowerKeepAwakeRemoteConnection;
  readonly post?: typeof postPowerKeepAwakeSet;
}

export type ForwardKeepAwakeOutcome =
  | { readonly attempted: false }
  | { readonly attempted: true; readonly result: PowerKeepAwakeRemoteResult };

/**
 * Forward power.keepAwake to the adopted daemon ONLY when a daemon is
 * actually reachable right now; otherwise it is a no-op (`attempted: false`)
 * rather than a wasted network call, and the re-send when the daemon next
 * becomes reachable delivers the value. Never throws: a reachability probe
 * rejection is treated the same as "not reachable" (a live keep-awake apply
 * must never take down the settings-modal apply path it is called from).
 */
export async function forwardKeepAwakeToAdoptedDaemon(
  enabled: boolean,
  deps: ForwardKeepAwakeDeps,
): Promise<ForwardKeepAwakeOutcome> {
  const post = deps.post ?? postPowerKeepAwakeSet;
  let reachable: 'unknown' | 'online' | 'offline';
  try {
    reachable = await deps.probeReachability();
  } catch {
    reachable = 'offline';
  }
  if (reachable !== 'online') return { attempted: false };
  const result = await post(deps.resolveConnection(), enabled);
  return { attempted: true, result };
}

/**
 * The one line the owner reads when the daemon did not take, or could not act
 * on, a keep-awake change; null when the daemon holds it as asked. `where` names
 * the surface ("this process", "this terminal").
 */
export function describeKeepAwakeOutcome(enabled: boolean, outcome: ForwardKeepAwakeOutcome, where = 'this process'): string | null {
  if (!outcome.attempted) {
    return enabled
      ? `Keep-awake is on in ${where} only: no daemon is reachable right now. It is sent to the daemon when ${where} reaches it again; until then the hold ends when ${where} exits.`
      : `Keep-awake is off in ${where}, but no daemon is reachable right now, so a daemon holding keep-awake keeps the host awake until ${where} reaches it again.`;
  }
  if (!outcome.result.ok) {
    return enabled
      ? `Keep-awake is on in ${where} only; the daemon did not take it (${outcome.result.error}). It is sent again the next time ${where} attaches to the daemon; until then the hold ends when ${where} exits.`
      : `Keep-awake is off in ${where}, but the daemon did not take it (${outcome.result.error}), so the daemon may still hold the host awake. It is sent again the next time ${where} attaches to the daemon.`;
  }
  if (enabled && outcome.result.keepAwakeState === 'refused') {
    return 'The daemon accepted keep-awake but the system refused to hold the host awake, so the machine can still sleep.';
  }
  return null;
}

export interface KeepAwakeNoticeDeps {
  /** Deliver the value to the daemon; `attempted: false` when no daemon is reachable. Never throws. */
  readonly send: (enabled: boolean) => Promise<ForwardKeepAwakeOutcome>;
  /** Shown to the owner. Absent: the outcome is logged only. */
  readonly notify?: ((text: string) => void) | undefined;
  /** Whether an unreachable daemon is worth a notice (a toggle: yes; a re-send on attach: no). */
  readonly tellWhenUnreachable?: boolean | undefined;
  /** The surface named in the notice; default "this process". */
  readonly where?: string | undefined;
}

/** Send one keep-awake value to the daemon and tell the owner when it did not hold. Never throws. */
export async function forwardKeepAwakeWithNotice(enabled: boolean, deps: KeepAwakeNoticeDeps): Promise<void> {
  try {
    const outcome = await deps.send(enabled);
    if (!outcome.attempted && deps.tellWhenUnreachable === false) return;
    const line = describeKeepAwakeOutcome(enabled, outcome, deps.where);
    if (line === null) return;
    logger.warn('[power] keep-awake daemon forward did not hold', { enabled, attempted: outcome.attempted });
    deps.notify?.(line);
  } catch (error) {
    logger.warn('[power] keep-awake daemon forward failed', { error: summarizeError(error) });
  }
}

/**
 * Runs keep-awake forwards one after another, in the order they were asked, so
 * a slow re-send can never reach the daemon after a newer change. A step that
 * fails does not stop the ones behind it.
 */
export function createKeepAwakeForwardQueue(): { run<T>(step: () => Promise<T>): Promise<T> } {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(step: () => Promise<T>): Promise<T> {
      const result = tail.then(step);
      tail = result.catch(() => {});
      return result;
    },
  };
}

export interface KeepAwakeForwarderDeps extends Omit<KeepAwakeNoticeDeps, 'tellWhenUnreachable'> {
  /** The surface's current keep-awake value, read when a re-send's turn comes. */
  readonly readKeepAwake: () => boolean;
}

export interface KeepAwakeForwarder {
  /** Forward a change the owner made in this surface. */
  set(enabled: boolean): Promise<void>;
  /** The daemon became reachable: send the current value, on or off. */
  attached(): Promise<void>;
  /** Report each daemon reachability reading; a change to reachable sends the current value. */
  reachable(isReachable: boolean): void;
}

/**
 * The forwarder a surface wires once: changes and re-sends go through one
 * ordered queue, and a re-send reads the value at its own turn, so an "off" set
 * meanwhile is never followed by a late "on".
 */
export function createKeepAwakeForwarder(deps: KeepAwakeForwarderDeps): KeepAwakeForwarder {
  const queue = createKeepAwakeForwardQueue();
  let wasReachable = false;
  const attached = (): Promise<void> => queue.run(() => forwardKeepAwakeWithNotice(deps.readKeepAwake(), { ...deps, tellWhenUnreachable: false }));
  return {
    set: (enabled) => queue.run(() => forwardKeepAwakeWithNotice(enabled, deps)),
    attached,
    reachable(isReachable) {
      if (isReachable && !wasReachable) void attached();
      wasReachable = isReachable;
    },
  };
}
