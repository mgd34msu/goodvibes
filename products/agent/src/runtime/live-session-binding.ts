/**
 * Everything in this process that is keyed to "the session in use", moved
 * together whenever the session id changes (a resume or a fork assigns
 * `runtime.sessionId`). Keeping the moves in one place is what stops a resume
 * from leaving the anchor, checkpoint, hosting and rewind seams on the boot id.
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
  readonly spine: { reopen(input: { sessionId: string; project: string }): unknown };
  readonly project: string;
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
  deps.spine.reopen({ sessionId: next, project: deps.project });
}
