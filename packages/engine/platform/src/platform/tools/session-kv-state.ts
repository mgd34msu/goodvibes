import { KVState, type KVStateOptions } from '../state/kv-state.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export interface SessionBoundKvState {
  /** Behaves as a KVState, but follows the host's current session id. */
  readonly state: KVState;
  /** The instance currently bound, for registering with an exit hook. */
  current(): KVState;
  /** Flushes and releases the bound instance. */
  dispose(): Promise<void>;
}

/**
 * A KVState that follows the host's session id. Resuming or forking a session reassigns the host's
 * id after the tool registry was built, so state written afterwards must land under the new id for
 * the next resume of that session to read it back. When the id changes, the previous instance is
 * flushed under its own file name before the new one takes over.
 *
 * Without a resolver the id never changes and this is one plain KVState.
 */
export function createSessionBoundKvState(
  options: Omit<KVStateOptions, 'sessionId'>,
  resolveSessionId: (() => string) | undefined,
  hooks: { readonly onBind?: ((state: KVState) => void) | undefined; readonly onRelease?: ((state: KVState) => void) | undefined } = {},
): SessionBoundKvState {
  const idOf = (): string | undefined => {
    const id = resolveSessionId?.();
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  };
  let boundId = idOf();
  let active = new KVState({ ...options, ...(boundId ? { sessionId: boundId } : {}) });
  hooks.onBind?.(active);

  const current = (): KVState => {
    const id = idOf();
    if (id !== undefined && id !== boundId) {
      const previous = active;
      boundId = id;
      active = new KVState({ ...options, sessionId: id });
      hooks.onRelease?.(previous);
      hooks.onBind?.(active);
      // Its pending write belongs to the old session's file; flush it there.
      previous.dispose().catch((error: unknown) => {
        logger.warn('[state] flushing the previous session state failed', { error: summarizeError(error) });
      });
    }
    return active;
  };

  const state = resolveSessionId === undefined
    ? active
    : new Proxy(active, {
      get(_target, property) {
        const live = current();
        const value = Reflect.get(live, property, live) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(live) : value;
      },
    });

  return {
    state,
    current,
    async dispose(): Promise<void> {
      const live = current();
      hooks.onRelease?.(live);
      await live.dispose();
    },
  };
}

/** A `session-<id>` state file whose name carries a hash of an unsafe id: the saved conversation's file name cannot be derived from it. */
const HASHED_KEYED_TOKEN = /-[0-9a-f]{16}$/;

/**
 * Whether the keyed state file for `sessionToken` may be reclaimed. Only the
 * host that owns the sessions knows whether one is still resumable (a hosted
 * session's conversation lives in the hosted store, not as a `.jsonl` file),
 * so without an owner's `isResumable` nothing is reclaimed. A token that
 * cannot be mapped back to a session id is never reclaimed either, so a
 * resumable session never loses its state to a wrong guess.
 */
export function createKeyedStateReclaimCheck(
  isResumable: ((sessionToken: string) => boolean) | undefined,
): ((sessionToken: string) => boolean) | undefined {
  if (isResumable === undefined) return undefined;
  return (sessionToken) => !HASHED_KEYED_TOKEN.test(sessionToken) && !isResumable(sessionToken);
}
