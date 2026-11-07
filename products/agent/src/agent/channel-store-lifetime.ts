import { isDeepStrictEqual } from 'node:util';
import { readFileObservation } from '@goodvibes-jev/engine/sdk/platform/utils';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { DaemonInvokeOptions, DaemonOperatorInvoke } from './daemon-operator-client.ts';

export interface ChannelStoreEffectOptions extends DaemonInvokeOptions {
  readonly invoke?: DaemonOperatorInvoke;
  /** Validate exact planned bytes, then adopt only this writer's actual atomic publication. */
  readonly preparePublication?: ((path: string, contents: string) => () => void) | undefined;
}

/** Retain the complete read-modify-write source across the daemon await. */
export function retainChannelStoreSource(path: string, options: ChannelStoreEffectOptions): () => void {
  const current = options.assertCurrent, signal = options.signal, prepare = options.preparePublication;
  const revision = () => {
    try { return readFileObservation(path); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw new ToolInputProjectionError('held');
    }
  };
  signal?.throwIfAborted(); current?.();
  const source = current ? revision() : undefined;
  return () => {
    signal?.throwIfAborted(); current?.();
    if (options.assertCurrent !== current || options.signal !== signal || options.preparePublication !== prepare
      || current && !isDeepStrictEqual(revision(), source)) throw new ToolInputProjectionError('stale');
    signal?.throwIfAborted();
  };
}
