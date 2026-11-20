import {
  createKeepAwakeForwarder,
  forwardKeepAwakeToAdoptedDaemon,
  readPowerKeepAwakeEnabled,
  type ForwardKeepAwakeDeps,
  type KeepAwakeForwarder,
} from '@goodvibes/engine/platform/platform/power';

export interface AgentKeepAwakeForwarderDeps {
  /** The current `power.keepAwake` value, read when a re-send's turn comes. */
  readonly readKeepAwake: () => boolean;
  /**
   * Whether a daemon is adopted right now: the adoption reconciler's fact
   * (`memorySpineClient.active`), read instead of another `/status` probe. A
   * toggle sent to a daemon that has just gone away fails and says so, and the
   * re-send on the next attach delivers the value.
   */
  readonly isAdopted: () => boolean;
  readonly resolveConnection: ForwardKeepAwakeDeps['resolveConnection'];
  /** Test seam for the HTTP post. */
  readonly post?: ForwardKeepAwakeDeps['post'];
  /** Write the daemon's value into this process's `power.keepAwake` on attach when nothing here is undelivered. */
  readonly adoptKeepAwake?: ((enabled: boolean) => void) | undefined;
  /** Test seam for the daemon read; default `GET /api/power/status`. */
  readonly readDaemonKeepAwake?: (() => Promise<boolean | undefined>) | undefined;
  /** Shown to the owner. Absent: the outcome is logged only. */
  readonly notify?: ((text: string) => void) | undefined;
}

/**
 * The Agent's keep-awake forwarder: the engine's one forwarder (ordered queue,
 * notice, re-send rule) bound to the adopted daemon. `set` on a toggle,
 * `attached` on the adoption edge: a change the daemon has not taken is sent
 * again, otherwise this process takes the daemon's value.
 */
export function createAgentKeepAwakeForwarder(deps: AgentKeepAwakeForwarderDeps): KeepAwakeForwarder {
  const send: ForwardKeepAwakeDeps = {
    probeReachability: () => Promise.resolve(deps.isAdopted() ? 'online' : 'offline'),
    resolveConnection: deps.resolveConnection,
    ...(deps.post ? { post: deps.post } : {}),
  };
  return createKeepAwakeForwarder({
    readKeepAwake: deps.readKeepAwake,
    notify: deps.notify,
    adoptKeepAwake: deps.adoptKeepAwake,
    readDaemonKeepAwake: deps.readDaemonKeepAwake
      ?? (() => deps.isAdopted() ? readPowerKeepAwakeEnabled(deps.resolveConnection()) : Promise.resolve(undefined)),
    send: (enabled) => forwardKeepAwakeToAdoptedDaemon(enabled, send),
  });
}
