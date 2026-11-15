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
  /** The pending mid-turn message queue changed (enqueued/edited/deleted/delivered). */
  | {
    type: 'QUEUED_MESSAGES_CHANGED';
    sessionId: string;
    action: 'enqueued' | 'edited' | 'deleted' | 'delivered';
    messageId: string;
    pendingCount: number;
  }
  /** A companion-app follow-up message was received for the session. */
  | {
    type: 'COMPANION_MESSAGE_RECEIVED';
    sessionId: string;
    messageId: string;
    body: string;
    source: string;
    timestamp: number;
    metadata?: Readonly<Record<string, unknown>> | undefined;
  };

/** All session event type literals as a union. */
export type SessionEventType = SessionEvent['type'];
