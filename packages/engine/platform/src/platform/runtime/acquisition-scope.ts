import { createAsyncDisposalScope } from './async-disposal.js';

/** The disposal scope a runtime graph is built in: a registry plus provisional ownership. */
export interface RuntimeAcquisitionScope {
  readonly registry: {
    add(label: string, dispose: () => void | Promise<void>): void;
  };
  /**
   * Own a resource the moment it is constructed, before its final place in the
   * teardown order is known. A later `registry.add` with the same label takes
   * over: the provisional callback is dropped and the new entry runs instead.
   */
  ownUntilRegistered(label: string, dispose: () => void | Promise<void>): void;
  close(): Promise<void>;
  dispose(): void;
}

/**
 * Own a constructor's returned resource before later construction can fail.
 * The final all-required disposal registration may replace that provisional
 * callback once its dependency order is known. Only explicitly provisional
 * entries are replaced; ordinary equal labels still describe separate owners.
 */
export function createRuntimeAcquisitionScope(name: string): RuntimeAcquisitionScope {
  const scope = createAsyncDisposalScope(name);
  const provisional = new Map<string, { dispose: (() => void | Promise<void>) | undefined }>();
  const registry = {
    add(label: string, dispose: () => void | Promise<void>): void {
      const previous = provisional.get(label);
      if (previous) { previous.dispose = undefined; provisional.delete(label); }
      scope.registry.add(label, dispose);
    },
  };
  return {
    registry,
    close: scope.close,
    dispose: scope.dispose,
    ownUntilRegistered(label: string, dispose: () => void | Promise<void>): void {
      if (provisional.has(label)) throw new Error(`Runtime owner already acquired: ${label}`);
      const entry = { dispose: dispose as (() => void | Promise<void>) | undefined };
      provisional.set(label, entry);
      scope.registry.add(label, () => entry.dispose?.());
    },
  };
}
