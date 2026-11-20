/**
 * hosted-session-mirror.ts, putting a daemon-hosted conversation into the
 * agent's own session store.
 *
 * The gap this closes: an evening's conversation ran as a hosted session and
 * NEVER landed in `sessions/`. It existed only as a preview-grade recovery
 * journal (tool results truncated to ~100 characters) plus the daemon-side
 * record, and `sessions/last-session.json` still pointed at an OLDER local
 * session, so resuming would have opened the wrong conversation and the real
 * one was unreachable from the surface that started it.
 *
 * One record per conversation: a hosted turn's `TURN_COMPLETED` is bridged onto
 * the local bus (hosted-turn-bus-bridge.ts), and the local autosave skips it
 * (shell/startup-wiring.ts `isHostedTurn`), so the only stored copy of a hosted
 * conversation is this mirror, keyed by the hosted session id.
 *
 * Where the content comes from: the DAEMON's record is authoritative, not this
 * process's screen mirror. `sessions.hosted.attach` returns the transcript the
 * daemon actually holds, which is also the only source that still exists after
 * this process has crashed, which is exactly when the mirror matters most.
 * That makes one function serve both moments the brief names: completion (the
 * conversation is finished and belongs in the store) and reconnect (this
 * process died mid-turn and is now catching up on what happened without it).
 */
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { OwnerStamp } from '@goodvibes-jev/engine/platform/platform/utils';

/**
 * The stamp a mirror carries: the hosted session it copies and the host's
 * message count when copied. A mirror whose stamp no longer matches the host's
 * count is behind the host; a stored conversation without a stamp continued
 * here and is never overwritten by the host's copy.
 */
export function hostedMirrorStamp(sessionId: string, hostMessageCount: number): OwnerStamp {
  return { owner: `hosted-session:${sessionId}`, revision: String(hostMessageCount) };
}

/** The daemon's history row shape (platform/hosted-sessions HostedSessionHistoryMessage). */
export interface HostedHistoryMessage {
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
  readonly at?: number;
  /** The calls an assistant row made, when the host's history carries them. */
  readonly toolCalls?: ReadonlyArray<{ readonly id: string; readonly name: string; readonly arguments?: unknown }> | undefined;
  /** The call a tool row answers, when the host's history carries it. */
  readonly callId?: string | undefined;
}

/** The subset of the daemon's hosted record this mirror reads. */
export interface HostedAttachedSession {
  readonly id: string;
  readonly title?: string | undefined;
  readonly modelId?: string | undefined;
  readonly providerId?: string | undefined;
  readonly messageCount?: number | undefined;
}

/** `sessions.hosted.attach` reply. */
export interface HostedAttachReply {
  readonly session: HostedAttachedSession;
  readonly history: readonly HostedHistoryMessage[];
}

export interface HostedSessionMirrorDeps {
  readonly verbs: { invoke<T>(method: string, input?: unknown): Promise<T> };
  /** Identifies this surface to the daemon on attach. */
  readonly clientId: string;
  /**
   * Writes the conversation to the agent's session store AND moves
   * last-session.json onto it, the platform's `persistConversation`.
   */
  readonly persist: (
    sessionId: string,
    snapshot: { messages: Array<Record<string, unknown>>; timestamp?: number; title?: string; mirroredFrom?: OwnerStamp },
    model: string,
    provider: string,
    title?: string,
    /** False when the last-session pointer must stay where it is (a recovered conversation older than its target). */
    movePointer?: boolean,
  ) => void;
  readonly fallbackModel: string;
  readonly fallbackProvider: string;
  readonly now?: () => number;
}

export type HostedMirrorOutcome =
  | { readonly mirrored: true; readonly sessionId: string; readonly messageCount: number }
  | { readonly mirrored: false; readonly reason: string };

/**
 * Convert the daemon's history into the store's message shape.
 *
 * A tool result is stored as one only when the host's history names the call
 * it answers and that call is in an earlier assistant row: a provider refuses
 * a tool result with no matching call, so an invented id would make the
 * resumed conversation fail on its first message. A tool row the host gave
 * without its call is kept as an assistant line saying what the tool returned.
 */
export function hostedHistoryToStoreMessages(
  history: readonly HostedHistoryMessage[],
): Array<Record<string, unknown>> {
  const calls = new Set<string>();
  return history.map((message) => {
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      for (const call of message.toolCalls) calls.add(call.id);
      return { role: 'assistant', content: message.content, toolCalls: message.toolCalls.map((call) => ({ ...call })) };
    }
    if (message.role === 'tool') {
      if (message.callId !== undefined && calls.has(message.callId)) {
        return { role: 'tool', callId: message.callId, content: message.content };
      }
      return { role: 'assistant', content: `Tool result (the host did not record which call): ${message.content}` };
    }
    return { role: message.role, content: message.content };
  });
}

/**
 * Pull a hosted session's authoritative transcript and write it into the
 * agent's session store, moving the last-session pointer onto it.
 *
 * Never throws: this runs from a turn-completion callback and from boot, and
 * neither is a place where a mirroring failure may take down the surface. A
 * failure is logged and reported in the outcome so a caller can say so.
 */
export async function mirrorHostedSessionToStore(
  sessionId: string,
  deps: HostedSessionMirrorDeps,
  options: { readonly timestamp?: number; readonly movePointer?: boolean } = {},
): Promise<HostedMirrorOutcome> {
  let reply: HostedAttachReply;
  try {
    reply = await deps.verbs.invoke<HostedAttachReply>('sessions.hosted.attach', {
      sessionId,
      clientId: deps.clientId,
    });
  } catch (error) {
    const reason = `the connected host would not hand back hosted session ${sessionId}, ${summarizeError(error)}`;
    logger.warn('[hosted-mirror] could not read the hosted transcript to mirror it', { sessionId, error: summarizeError(error) });
    return { mirrored: false, reason };
  }

  const history = reply?.history ?? [];
  if (history.length === 0) {
    // Writing an empty conversation over the store would be worse than not
    // writing: it would move the last-session pointer onto nothing.
    return { mirrored: false, reason: `hosted session ${sessionId} has no transcript to mirror` };
  }

  const messages = hostedHistoryToStoreMessages(history);
  const title = reply.session?.title ?? '';
  try {
    deps.persist(
      sessionId,
      { messages, timestamp: options.timestamp ?? (deps.now ?? Date.now)(), ...(title ? { title } : {}),
        mirroredFrom: hostedMirrorStamp(sessionId, reply.session?.messageCount ?? history.length) },
      reply.session?.modelId ?? deps.fallbackModel,
      reply.session?.providerId ?? deps.fallbackProvider,
      title,
      options.movePointer ?? true,
    );
  } catch (error) {
    const reason = `writing hosted session ${sessionId} to the session store failed, ${summarizeError(error)}`;
    logger.warn('[hosted-mirror] persisting the mirrored hosted session failed', { sessionId, error: summarizeError(error) });
    return { mirrored: false, reason };
  }

  logger.info('[hosted-mirror] mirrored a hosted conversation into the session store', {
    sessionId,
    messageCount: messages.length,
  });
  return { mirrored: true, sessionId, messageCount: messages.length };
}

/** `sessions.hosted.list` reply. */
export interface HostedListReply {
  readonly sessions: readonly (HostedAttachedSession & {
    readonly workspaceRoot?: string | undefined;
    readonly updatedAt?: number | undefined;
    readonly status?: string | undefined;
    /** Set by the host for a conversation a terminal surface started (native intake); absent for a channel hand-off. */
    readonly nativeConversation?: true | undefined;
  })[];
}

export interface HostedRecoveryDeps extends HostedSessionMirrorDeps {
  /** Only sessions for the workspace this surface is working in are recovered. */
  readonly workspaceRoot: string;
  /** The sessions the agent's own store holds, by id, with the mirror stamp each carries (none: it continued here). */
  readonly knownSessions: () => ReadonlyMap<string, OwnerStamp | undefined>;
  /** Bound on how many orphans one boot will pull back. */
  readonly maxRecovered?: number;
  /** When the session the last-session pointer names was saved, or null when it names none; a recovered conversation older than it leaves the pointer alone. */
  readonly pointerTargetTimestamp?: () => number | null;
}

/** Default bound on a single boot's recovery pass. */
export const DEFAULT_MAX_RECOVERED_HOSTED_SESSIONS = 5;

/**
 * Boot-time recovery for the CRASH path.
 *
 * Completion-time mirroring cannot cover the case that actually lost the
 * conversation: the surface died mid-turn, so no completion was ever delivered
 * to it and no callback ran. On the next start the daemon still holds the
 * transcript, and this pass is what goes and gets it, any hosted session for
 * this workspace that the agent's own store has never heard of is pulled in and
 * becomes resumable, newest last so the last-session pointer ends up on the
 * most recent conversation.
 *
 * A session the daemon has already ended (a daemon restart or a lapsed
 * attachment lease under the `kill` detach policy) cannot be attached again, so
 * it is not recovered; the pass says how many it skipped so the loss is not
 * silent.
 *
 * Bounded and quiet: at most `maxRecovered` sessions per boot, sessions with no
 * transcript skipped, and every failure logged rather than thrown, a daemon
 * that is not reachable at boot must not stop the agent from starting.
 */
export async function recoverUnmirroredHostedSessions(
  deps: HostedRecoveryDeps,
): Promise<readonly HostedMirrorOutcome[]> {
  let reply: HostedListReply;
  try {
    reply = await deps.verbs.invoke<HostedListReply>('sessions.hosted.list', { includeTerminated: true });
  } catch (error) {
    logger.debug('[hosted-mirror] could not list hosted sessions at boot', { error: summarizeError(error) });
    return [];
  }

  const known = deps.knownSessions();
  // Not stored here, or stored as a mirror the host has moved past (a turn that
  // finished on the host after this process stopped). A stored copy without a
  // mirror stamp continued here and is left as it is.
  const behind = (session: HostedAttachedSession): boolean => {
    if (!known.has(session.id)) return true;
    const stamp = known.get(session.id);
    if (!stamp) return false;
    const host = hostedMirrorStamp(session.id, session.messageCount ?? 0);
    return stamp.owner === host.owner && stamp.revision !== host.revision;
  };
  const unknown = (reply?.sessions ?? []).filter((session) =>
    session.workspaceRoot === deps.workspaceRoot
    // Only conversations a terminal started: a channel conversation handed to
    // the host is not a crashed terminal session.
    && session.nativeConversation === true
    && behind(session)
    && (session.messageCount ?? 0) > 0);
  const ended = unknown.filter((session) => session.status === 'terminated');
  if (ended.length > 0) {
    logger.info('[hosted-mirror] hosted conversations the daemon already ended cannot be recovered', {
      skipped: ended.length,
    });
  }
  // Sorted here rather than trusting the wire order: the daemon lists newest
  // first, and the oldest-to-newest order below is what puts the last-session
  // pointer on the most recent conversation. The sort is stable, so sessions
  // without a timestamp keep the order they arrived in.
  const candidates = unknown
    .filter((session) => session.status !== 'terminated')
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
  if (candidates.length === 0) return [];

  const limit = deps.maxRecovered ?? DEFAULT_MAX_RECOVERED_HOSTED_SESSIONS;
  const selected = candidates.slice(-limit);
  const outcomes: HostedMirrorOutcome[] = [];
  let pointerAt = deps.pointerTargetTimestamp?.() ?? null;
  for (const session of selected) {
    const updatedAt = session.updatedAt ?? 0;
    const movePointer = pointerAt === null || updatedAt > pointerAt;
    const outcome = await mirrorHostedSessionToStore(session.id, deps, { ...(updatedAt > 0 ? { timestamp: updatedAt } : {}), movePointer });
    if (outcome.mirrored && movePointer) pointerAt = updatedAt;
    outcomes.push(outcome);
  }
  const recovered = outcomes.filter((outcome) => outcome.mirrored).length;
  if (recovered > 0) {
    // Disclose, never silent: these conversations appeared without the user
    // doing anything, and the reason is that a previous run did not survive.
    logger.info('[hosted-mirror] recovered hosted conversations a previous run never stored', {
      recovered,
      considered: candidates.length,
    });
  }
  return outcomes;
}
