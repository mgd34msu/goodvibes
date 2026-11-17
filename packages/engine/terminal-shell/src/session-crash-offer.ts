/**
 * What opening a session does when that session has a crash snapshot newer
 * than its saved copy.
 *
 * Every way of opening a saved session runs the one resume routine
 * (session-resume.ts `resumeSessionCore`), and that routine asks here, once per
 * open, whether the session left a crash snapshot. The app that owns the
 * conversation registers what it does with one: an interactive app tells the
 * person and offers the restore (the TUI's modal, the Agent's Ctrl+R line), a
 * headless resume applies it, since its caller's `--resume` / `--continue` is
 * the ask. The check is the same one the start-up offer makes, so a crash found
 * at start-up and a crash found when the session is loaded later are offered
 * the same way.
 */
import type { SessionCrashSnapshot } from '@goodvibes-jev/engine/platform/platform/runtime/operations';

/**
 * What the app did with a crash snapshot found while opening its session:
 * `applied` (the conversation now holds it), `offered` (the person was told and
 * asked; the restore happens on their answer), `declined` (nothing was done).
 */
export type CrashSnapshotHandling = 'applied' | 'offered' | 'declined';

/** Runs when a session being opened in `conversation` has a crash snapshot newer than its saved copy. */
export type CrashSnapshotHandler = (found: SessionCrashSnapshot) => CrashSnapshotHandling;

const handlers = new WeakMap<object, CrashSnapshotHandler>();

/**
 * Register what opening a session into `conversation` does with a crash
 * snapshot it finds. One handler per conversation; registering again replaces
 * it. Returns the unregister function. A conversation with none registered
 * never looks for a snapshot when a session is opened (a test harness, a host
 * that has no one to tell).
 */
export function whenCrashSnapshotFound(conversation: object, handler: CrashSnapshotHandler): () => void {
  handlers.set(conversation, handler);
  return () => {
    if (handlers.get(conversation) === handler) handlers.delete(conversation);
  };
}

/** The handler registered for `conversation`, if any. */
export function crashSnapshotHandlerFor(conversation: object): CrashSnapshotHandler | undefined {
  return handlers.get(conversation);
}
