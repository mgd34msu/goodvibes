/** platform-owned platform module. This implementation is maintained in goodvibes-platform. */

type Listener = () => void;

export interface UiReadModel<TSnapshot> {
  getSnapshot(): TSnapshot;
  /** Calls `listener` when the snapshot may have changed. Never fires for a model marked `pollOnly`. */
  subscribe(listener: Listener): () => void;
  /**
   * True when nothing announces changes to this model's state (it lives on disk or in a
   * service with no change event): `subscribe` is accepted but never calls the listener,
   * so a consumer must call `getSnapshot()` again to see new state.
   */
  readonly pollOnly?: true;
}
