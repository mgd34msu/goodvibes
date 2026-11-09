/** platform-owned platform module. This implementation is maintained in goodvibes-platform. */

type Listener = () => void;

export interface UiReadModel<TSnapshot> {
  getSnapshot(): TSnapshot;
  subscribe(listener: Listener): () => void;
}
