/**
 * native-work-session.ts, the one place the session a piece of work runs in is
 * formed and checked. Each piece of work has a session of its own: the session
 * that asked for it, then the work's own id (`<asking session>:<work id>`), so
 * an answer given "for this session" to one piece of work is never an answer
 * for another. The execution host forms it when it binds a run
 * (native-execution.ts) and the store checks every run's request against it
 * (knowledge/store-native-work-execution.ts): both call these, so they cannot
 * drift apart.
 */

/** The session a piece of work runs in: the asking session, then the work's id. */
export function nativeWorkSessionId(askingSession: string, workId: string): string {
  return `${askingSession}:${workId}`;
}

/**
 * Whether a run's request names the session `workId` runs in: exactly its own per-work session, or (a request kept
 * before each piece of work had one) the asking session itself. Any other session (another work's, another asking
 * session's) is not this work's.
 */
export function isNativeWorkSession(requestSession: string, askingSession: string, workId: string): boolean {
  return requestSession === nativeWorkSessionId(askingSession, workId) || requestSession === askingSession;
}
