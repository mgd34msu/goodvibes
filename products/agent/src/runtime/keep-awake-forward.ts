import {
  createKeepAwakeForwardQueue,
  describeKeepAwakeOutcome,
  forwardKeepAwakeToAdoptedDaemon,
  forwardKeepAwakeWithNotice as forwardWithNotice,
  type ForwardKeepAwakeDeps,
} from '@goodvibes-jev/engine/platform/platform/power';

// The engine owns the forwarder (queue, notice, re-send rule); this file binds
// it to the Agent's transport: a reachability probe and a raw-REST post.
export { createKeepAwakeForwardQueue, describeKeepAwakeOutcome };

export interface KeepAwakeForwardDeps extends ForwardKeepAwakeDeps {
  /** Shown to the owner. Absent: the outcome is logged only. */
  readonly notify?: ((text: string) => void) | undefined;
  /** Whether an unreachable daemon is worth a notice (a toggle: yes; a re-send on attach: it is online by definition). */
  readonly tellWhenUnreachable?: boolean;
}

/** Forward a keep-awake change to the adopted daemon and report what the daemon did. Never throws. */
export function forwardKeepAwakeWithNotice(enabled: boolean, deps: KeepAwakeForwardDeps): Promise<void> {
  return forwardWithNotice(enabled, {
    send: (value) => forwardKeepAwakeToAdoptedDaemon(value, deps),
    notify: deps.notify,
    tellWhenUnreachable: deps.tellWhenUnreachable,
  });
}

/**
 * The re-send done once per attach: the CURRENT value, on or off, so a change
 * made while the daemon was unreachable reaches it. Queued behind any toggle
 * already on its way, and the setting is read when its turn comes, so an "off"
 * set meanwhile is never followed by a late "on".
 */
export function queueKeepAwakeResend(
  queue: { run<T>(step: () => Promise<T>): Promise<T> },
  readKeepAwake: () => boolean,
  deps: KeepAwakeForwardDeps,
): Promise<void> {
  return queue.run(() => forwardKeepAwakeWithNotice(readKeepAwake(), { ...deps, tellWhenUnreachable: false }));
}
