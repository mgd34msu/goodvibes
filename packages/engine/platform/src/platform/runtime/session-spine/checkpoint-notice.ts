/**
 * checkpoint-notice.ts, telling the adopted daemon that this terminal program
 * made, pruned or removed a workspace checkpoint.
 *
 * The terminal app and the Agent run their own checkpoint manager on the
 * project's store; its writes announce `LIST_CHANGED` (`checkpoints`) only in
 * this process. A client subscribed to the daemon (the web app) hears of them
 * only through the daemon, so each one is passed on as `sessions.checkpoints.changed`
 * for this program's session.
 *
 * Sent only while the session spine is live and online and the daemon holds this
 * session (it was registered there): a program with no daemon sends nothing, and
 * a send never waits in the write's path (fire and forget; a lost notice only
 * means a client reads the list on its next change).
 */
import { onListChanged, type ListChange } from '../list-changes.js';
import type { SessionSpineClient } from './client.js';
import type { SessionSpineRestConnection } from './rest-transport.js';

/**
 * POST `sessions.checkpoints.changed` through the generic method-invoke route; never throws.
 * No limit: nothing waits on it (the forwarder does not await it), so a slow daemon is never a
 * reason to abandon it.
 */
export async function postSessionCheckpointNotice(
  connection: SessionSpineRestConnection,
  sessionId: string,
  change: ListChange,
): Promise<boolean> {
  if (connection.unavailable !== undefined || !connection.token) return false;
  try {
    const response = await fetch(`${connection.baseUrl}/api/control-plane/methods/sessions.checkpoints.changed/invoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: { sessionId, change: change.change, ...(change.id ? { checkpointId: change.id } : {}) } }),
    });
    await response.arrayBuffer().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

export interface CheckpointNoticeForwarderOptions {
  /** The session spine: only a live, online spine that holds the session sends. */
  readonly spine: Pick<SessionSpineClient, 'active' | 'status' | 'mirroredSessionIds' | 'onRegistered'>;
  /** This program's current session. */
  readonly sessionId: () => string | undefined;
  /** The daemon connection to send on; called only when a notice is sent. */
  readonly connection: () => SessionSpineRestConnection | null;
}

/**
 * Pass this process's checkpoint list changes on to the adopted daemon. A change made before
 * the daemon holds this session (the start-of-session checkpoint, made while the connection
 * comes up) is kept, and announced once the daemon registers the session: one notice however
 * many changes waited, since a client only reads the list again. Returns the unsubscribe.
 */
export function forwardCheckpointChangesToDaemon(options: CheckpointNoticeForwarderOptions): () => void {
  let waiting: ListChange | null = null;
  const send = (sessionId: string, change: ListChange): boolean => {
    if (!options.spine.active || options.spine.status() !== 'online') return false;
    if (!options.spine.mirroredSessionIds.has(sessionId)) return false;
    const connection = options.connection();
    if (connection === null) return false;
    void postSessionCheckpointNotice(connection, sessionId, change);
    return true;
  };
  const stopChanges = onListChanged((change) => {
    if (change.list !== 'checkpoints') return;
    const sessionId = options.sessionId();
    if (sessionId && send(sessionId, change)) {
      waiting = null;
      return;
    }
    // Several changes waiting are one notice that the list changed.
    waiting = waiting === null ? change : { list: 'checkpoints', change: 'changed' };
  });
  const stopRegistered = options.spine.onRegistered((sessionId) => {
    if (waiting === null || sessionId !== options.sessionId()) return;
    if (send(sessionId, waiting)) waiting = null;
  });
  return () => {
    stopChanges();
    stopRegistered();
  };
}
