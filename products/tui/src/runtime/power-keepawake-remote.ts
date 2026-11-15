// ---------------------------------------------------------------------------
// power-keepawake-remote.ts, forward the keep-awake toggle to an adopted
// EXTERNAL daemon over the power.keepAwake.set operator verb.
//
// In the external/adopted-daemon topology the in-process PowerManager is NOT
// the daemon's, so a keep-awake toggle applied only locally dies when the TUI
// closes. The owner ruling is that keep-awake is daemon-held: it must survive
// the TUI closing. The config file does NOT carry it across (power.keepAwake is
// not a cross-surface shared key), so the toggle is forwarded to the daemon
// over the verb instead, best-effort, gated on reachability. Mirrors the
// agent's own power-keep-awake-remote seam.
//
// A single config subscriber carries ALL THREE toggle paths (/power, Alt+A, the
// settings modal): each lands on the power.keepAwake config key, the local
// PowerManager persists it on set, and the settings modal writes it directly,
// so subscribing to that one key catches every origin. When there is no adopted
// external daemon (`isExternalDaemon()` false), this is a no-op: there is nothing
// to forward to.
// ---------------------------------------------------------------------------

import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { PowerState } from '@goodvibes-jev/engine/platform/platform/power';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { resolveOperatorRpc } from '../input/commands/operator-rpc.ts';

export interface KeepAwakeRemoteDeps {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
  /** True only in the external/adopted-daemon topology (the local manager is not the daemon's). */
  readonly isExternalDaemon: () => boolean;
  /** Injectable rpc resolution (tests); defaults to the shared resolveOperatorRpc. */
  readonly resolveRpc?: typeof resolveOperatorRpc;
  /** One line shown to the owner when the daemon did not take the toggle. */
  readonly notify?: ((text: string) => void) | undefined;
}

/**
 * Best-effort forward of the keep-awake toggle to the adopted external daemon so
 * the DAEMON holds the inhibitor (surviving the TUI closing). A no-op in the
 * embedded topology. A daemon that cannot be reached never breaks the local
 * toggle, but the owner is told the daemon did not take it, because only the
 * daemon's hold outlives this terminal.
 */
export async function forwardKeepAwakeToDaemon(enabled: boolean, deps: KeepAwakeRemoteDeps): Promise<void> {
  if (!deps.isExternalDaemon()) return;
  const rpc = (deps.resolveRpc ?? resolveOperatorRpc)({ configManager: deps.configManager, homeDirectory: deps.homeDirectory });
  const tell = (reason: string): void => {
    const line = `Keep-awake is ${enabled ? 'on' : 'off'} in this terminal only; the daemon did not take it (${reason}), so it will not outlive this terminal.`;
    logger.warn('keep-awake forward failed', { enabled, reason });
    deps.notify?.(line);
  };
  if (!rpc.available) {
    tell(rpc.reason);
    return;
  }
  try {
    const served = await rpc.platformClient.operator.invoke('power.keepAwake.set', { enabled });
    // The request being accepted does not mean the host is held: the OS can
    // still refuse the inhibitor, and the daemon says so in the state it serves.
    if (enabled && servedKeepAwakeState(served) === 'refused') {
      const line = 'The daemon accepted keep-awake but the system refused to hold the host awake, so the machine can still sleep.';
      logger.warn('keep-awake refused by the daemon host', { enabled });
      deps.notify?.(line);
    }
  } catch (error) {
    // The local toggle already applied; the daemon's did not.
    tell(summarizeError(error));
  }
}

function servedKeepAwakeState(served: unknown): string | undefined {
  if (typeof served !== 'object' || served === null) return undefined;
  const keepAwake = (served as { keepAwake?: unknown }).keepAwake;
  if (typeof keepAwake !== 'object' || keepAwake === null) return undefined;
  const state = (keepAwake as { state?: unknown }).state;
  return typeof state === 'string' ? state : undefined;
}

// One queue per config manager, so a re-send after a reconnect and a toggle
// reach the daemon in the order they happened.
const forwardChains = new WeakMap<object, Promise<void>>();

function enqueueForward(deps: KeepAwakeRemoteDeps, enabled: boolean): void {
  const previous = forwardChains.get(deps.configManager) ?? Promise.resolve();
  forwardChains.set(deps.configManager, previous.then(() => forwardKeepAwakeToDaemon(enabled, deps)).catch(() => {}));
}

/**
 * Install a config subscriber that forwards every power.keepAwake change to the
 * adopted external daemon. Returns an unsubscribe handle. Because all three
 * toggle origins land on the same config key, this one seam carries them all.
 */
export function installKeepAwakeRemoteForward(deps: KeepAwakeRemoteDeps): () => void {
  // Forwards run one after another in toggle order: two quick toggles are two
  // unordered requests otherwise, and the daemon could settle on the older one.
  return deps.configManager.subscribe('power.keepAwake', (newValue) => {
    enqueueForward(deps, newValue === true);
  });
}

/**
 * Wrap the daemon-state poll so that keep-awake that is on here is re-sent each
 * time the daemon turns reachable (including the first poll at startup). A
 * daemon that started or restarted after the toggle holds nothing until told,
 * and only its hold outlives this terminal. Only "on" is re-sent: the daemon
 * defaults to off, and another surface may have turned it off on purpose.
 */
export function resendKeepAwakeOnReconnect(
  deps: KeepAwakeRemoteDeps,
  fetchState: () => Promise<PowerState | null>,
): () => Promise<PowerState | null> {
  let wasReachable = false;
  return async () => {
    const state = await fetchState();
    const reachable = state !== null;
    if (reachable && !wasReachable && deps.configManager.get('power.keepAwake') === true) {
      enqueueForward(deps, true);
    }
    wasReachable = reachable;
    return state;
  };
}

/**
 * Fetch the adopted DAEMON's power.status.get (null when unreachable or not in
 * the external topology). The chip's external-mode poll source, the adopted
 * wire is plain HTTP with no event bridge, so the chip syncs by polling.
 */
export async function fetchDaemonPowerState(deps: KeepAwakeRemoteDeps): Promise<PowerState | null> {
  if (!deps.isExternalDaemon()) return null;
  const rpc = (deps.resolveRpc ?? resolveOperatorRpc)({ configManager: deps.configManager, homeDirectory: deps.homeDirectory });
  if (!rpc.available) return null;
  try {
    return await rpc.platformClient.operator.invoke('power.status.get', {}) as unknown as PowerState;
  } catch {
    return null;
  }
}
