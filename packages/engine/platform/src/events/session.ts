/**
 * SessionEvent, discriminated union covering all session lifecycle events.
 *
 * Covers session lifecycle events for the runtime event bus.
 */

export type SessionEvent =
  /** A new session has been created and is initialising. */
  | { type: 'SESSION_STARTED'; sessionId: string; profileId: string; workingDir: string }
  /** A previously saved session is being resumed. */
  | { type: 'SESSION_RESUMED'; sessionId: string; turnCount: number }
  /** Session is fully loaded and ready for input. */
  | { type: 'SESSION_READY'; sessionId: string }
  /** Session recovery has failed unrecoverably. */
  | { type: 'SESSION_RECOVERY_FAILED'; sessionId: string; error: string }
  /**
   * Every session the health system tracks failed to recover. Published by the
   * session-unrecoverable health rule, with the playbooks that diagnose it.
   */
  | { type: 'SESSION_UNRECOVERABLE'; sessionId: string; ruleId: string; reason?: string | undefined; playbooks: readonly string[] }
  /** The pending mid-turn message queue changed (enqueued/edited/deleted/delivered). */
  | {
    type: 'QUEUED_MESSAGES_CHANGED';
    sessionId: string;
    action: 'enqueued' | 'edited' | 'deleted' | 'delivered';
    messageId: string;
    pendingCount: number;
  };

/** All session event type literals as a union. */
export type SessionEventType = SessionEvent['type'];
