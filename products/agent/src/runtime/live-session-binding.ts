/**
 * Everything in this process that is keyed to "the session in use", moved
 * together whenever the session id changes (a resume or a fork assigns
 * `runtime.sessionId`). Keeping the moves in one place is what stops a resume
 * from leaving the anchor, checkpoint, hosting and rewind seams on the boot id.
 * Anything else that needs the id reads `runtime.sessionId` when it runs
 * instead of holding a copy.
 */
export interface LiveSessionBindingDeps<Conversation> {
  readonly ref: { value: string };
  readonly hostedSessions: {
    release(sessionId: string): void;
    adopt(sessionId: string): void;
  };
  readonly conversation: Conversation;
  readonly registerConversation: (sessionId: string, conversation: Conversation) => void;
  readonly unregisterConversation: (sessionId: string) => void;
  readonly rewindHost: { start(sessionId: string): void };
  /** Closes the previous id on the daemon and reopens the next one, in that order. */
  readonly spine: { move(previousId: string, input: { sessionId: string; project: string }): unknown };
  readonly project: string;
  /** Makes sure the session register holds a record for `sessionId` (idempotent). */
  readonly openSessionRecord: (sessionId: string) => void;
}

/** Moves every session-keyed seam from the current id to `next`; a repeated id is a no-op. */
export function moveLiveSession<Conversation>(deps: LiveSessionBindingDeps<Conversation>, next: string): void {
  const previous = deps.ref.value;
  if (next === previous) return;
  deps.ref.value = next;
  // Release before adopt: with two hosted ids the registry cannot attribute a
  // turn that carries no envelope session id.
  deps.hostedSessions.release(previous);
  deps.hostedSessions.adopt(next);
  deps.unregisterConversation(previous);
  deps.registerConversation(next, deps.conversation);
  deps.rewindHost.start(next);
  deps.spine.move(previous, { sessionId: next, project: deps.project });
  deps.openSessionRecord(next);
}
