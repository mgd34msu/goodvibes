import type { DaemonInvokeOptions, DaemonOperatorInvoke } from './daemon-operator-client.ts';

export interface ChannelStoreEffectOptions extends DaemonInvokeOptions {
  readonly invoke?: DaemonOperatorInvoke;
  /** Validate exact planned bytes, then adopt only this writer's actual atomic publication. */
  readonly preparePublication?: ((path: string, contents: string) => () => void) | undefined;
}

/**
 * The store operation's one currency check, run before each step that cannot be
 * undone (the request leaving, the rename): the call is still wanted (its
 * signal) and the caller's own check still passes. Nothing re-reads the store:
 * every write merges into the file as it is under the store lock.
 */
export function retainChannelStoreSource(_path: string, options: ChannelStoreEffectOptions): () => void {
  const current = options.assertCurrent, signal = options.signal;
  return () => { signal?.throwIfAborted(); current?.(); };
}
