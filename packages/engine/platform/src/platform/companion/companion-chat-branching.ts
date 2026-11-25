/**
 * companion-chat-branching.ts
 *
 * The honest-lineage core for the two conversation-forking operations the chat
 * web UI needs: regenerate a response, and edit an earlier message and branch
 * from it. Split out of companion-chat-manager.ts (see CHANGELOG) so the manager
 * stays under the hand-authored file-size cap.
 *
 * THE HONESTY CONTRACT (this is the whole point of the module):
 * neither operation ever deletes or overwrites message history. A regenerate or
 * an edit marks the affected messages as SUPERSEDED, they stay in the message
 * list and on disk, flagged with `supersededAt`/`supersededReason`, and then a
 * fresh turn runs from the fork point. The "active" conversation is the chain of
 * messages WITHOUT a `supersededAt`; everything behind a fork remains
 * retrievable. Nothing is silently lost, mirroring the delete-means-delete
 * discipline: a regenerate is a new turn, an edit is a new branch, and the old
 * branch is kept as visible history rather than thrown away.
 *
 * These functions mutate the passed session's `messages` array in place and
 * return a plan; the caller (the manager) is responsible for rebuilding the
 * LLM-facing conversation from the active chain, persisting, and running the new
 * turn. Errors are thrown with `{ code, status }` so the route layer maps them
 * to honest machine codes.
 */

import { randomUUID } from 'node:crypto';
import type {
  CompanionChatMessage,
  CompanionChatSupersededReason,
  EditCompanionChatMessageInput,
} from './companion-chat-types.js';
import {
  resolveAttachments,
  type CompanionChatArtifactStore,
} from './companion-chat-attachments.js';

/** The mutable session shape these helpers operate on (subset of the manager's InternalSession). */
export interface BranchingSession {
  messages: CompanionChatMessage[];
  lastActivityAt: number;
}

/** Build a `{ code, status }`-carrying error the route layer turns into a machine code. */
function branchError(message: string, code: string, status: number): Error {
  return Object.assign(new Error(message), { code, status });
}

/**
 * Mark messages[fromIndex..] as superseded in place, returning the ids touched.
 * A message `spare` accepts stays active.
 */
function supersedeFrom(
  session: BranchingSession,
  fromIndex: number,
  reason: CompanionChatSupersededReason,
  now: number,
  spare: (message: CompanionChatMessage) => boolean = () => false,
): string[] {
  const superseded: string[] = [];
  for (let i = fromIndex; i < session.messages.length; i++) {
    const msg = session.messages[i]!;
    if (msg.supersededAt !== undefined) continue; // already retained history, leave as-is
    if (spare(msg)) continue;
    session.messages[i] = { ...msg, supersededAt: now, supersededReason: reason };
    superseded.push(msg.id);
  }
  return superseded;
}

/** The active (non-superseded) messages, in order, the live conversation chain. */
export function activeMessages(messages: readonly CompanionChatMessage[]): CompanionChatMessage[] {
  return messages.filter((m) => m.supersededAt === undefined);
}

export interface RegeneratePlan {
  /** The superseded reply the new turn replaces; absent when the exchange had no reply (a stop before any text). */
  readonly regeneratedFrom?: string | undefined;
  readonly supersededMessageIds: readonly string[];
  /** The user message the re-run turn is anchored on. */
  readonly anchorUserMessageId: string;
}

/**
 * Plan a regenerate. Without an id the anchor is the LAST active user message
 * and whatever follows it (its reply, a failed reply, or nothing) is
 * superseded, so a regenerate whose new turn failed is retried by the identical
 * call instead of rewinding the chat by one exchange. A reply to an EARLIER
 * active user message stored after the anchor (a message sent while that reply
 * was running) is not part of the exchange and stays active. With an id, that active
 * assistant message and everything after it are superseded and the nearest
 * active user message before it is the anchor.
 *
 * Throws when an explicit id is unknown, superseded or not an assistant
 * message, or when there is no user message to answer again.
 */
export function planRegenerate(
  session: BranchingSession,
  targetMessageId: string | undefined,
  now: number,
): RegeneratePlan {
  const messages = session.messages;

  let fromIndex: number;
  let anchorIndex = -1;
  if (targetMessageId !== undefined) {
    fromIndex = messages.findIndex((m) => m.id === targetMessageId);
    if (fromIndex === -1) {
      throw branchError(`Message not found: ${targetMessageId}`, 'MESSAGE_NOT_FOUND', 404);
    }
    const target = messages[fromIndex]!;
    if (target.supersededAt !== undefined) {
      throw branchError(
        'That message is already superseded history; regenerate the active response instead.',
        'MESSAGE_SUPERSEDED',
        409,
      );
    }
    if (target.role !== 'assistant') {
      throw branchError(
        'Only an assistant message can be regenerated; edit a user message to branch instead.',
        'NOT_AN_ASSISTANT_MESSAGE',
        400,
      );
    }
    // The message it answers when the link is there, else the nearest active user message before it.
    const linked = target.inReplyTo === undefined ? -1 : messages.findIndex((m) => m.id === target.inReplyTo && m.supersededAt === undefined);
    anchorIndex = linked;
    for (let i = fromIndex - 1; anchorIndex === -1 && i >= 0; i--) {
      const m = messages[i]!;
      if (m.supersededAt === undefined && m.role === 'user') anchorIndex = i;
    }
  } else {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.supersededAt === undefined && m.role === 'user' && m.deliveryState !== 'queued' && m.deliveryState !== 'unanswered') {
        anchorIndex = i;
        break;
      }
    }
    fromIndex = anchorIndex + 1;
  }
  if (anchorIndex === -1) {
    throw branchError(
      targetMessageId === undefined ? 'There is no message to answer again yet.' : 'No user message precedes that response to regenerate from.',
      'NO_ANCHOR_MESSAGE',
      409,
    );
  }

  const anchorUserMessageId = messages[anchorIndex]!.id;
  // Without an id: a reply that answers an earlier active user message belongs to that exchange.
  const earlierUserIds = targetMessageId === undefined
    ? new Set(messages.slice(0, anchorIndex).filter((m) => m.supersededAt === undefined && m.role === 'user').map((m) => m.id))
    : new Set<string>();
  const spare = (m: CompanionChatMessage): boolean => m.role === 'assistant' && m.inReplyTo !== undefined && earlierUserIds.has(m.inReplyTo);
  const regeneratedFrom = messages.slice(fromIndex).find((m) => m.supersededAt === undefined && m.role === 'assistant' && !spare(m))?.id;
  const supersededMessageIds = supersedeFrom(session, fromIndex, 'regenerate', now, spare);
  session.lastActivityAt = now;
  return { ...(regeneratedFrom !== undefined ? { regeneratedFrom } : {}), supersededMessageIds, anchorUserMessageId };
}

export interface BranchSwitchPlan {
  /** The message that heads the version now on the conversation. */
  readonly messageId: string;
  /** False when that version was already the one on the conversation (nothing changed). */
  readonly switched: boolean;
  /** The messages of the version left, now retained history (one fork time, so the way back is the same call). */
  readonly supersededMessageIds: readonly string[];
  /** The messages of the version returned to, active again. */
  readonly restoredMessageIds: readonly string[];
}

/**
 * Switch a turn that has versions (an edited message, or a regenerated reply) to
 * another of its versions. The versions of a turn are the messages that head
 * one fork each: a user message and the edits linked to it by `revisionOf`, or
 * the replies to one user message (`inReplyTo`). A version is the run one fork
 * marked superseded at one time, so the target must be the first message of its
 * run. The version on the conversation now (the turn's active message and
 * everything after it, except a reply to an earlier message) is marked
 * superseded at one new time, and the target's run is made active again.
 * Nothing is deleted; switching back is the same call on the other version.
 */
export function planBranchSwitch(
  session: BranchingSession,
  targetMessageId: string,
  now: number,
): BranchSwitchPlan {
  const messages = session.messages;
  const target = messages.find((m) => m.id === targetMessageId);
  if (!target) throw branchError(`Message not found: ${targetMessageId}`, 'MESSAGE_NOT_FOUND', 404);
  if (target.supersededAt === undefined) {
    return { messageId: target.id, switched: false, supersededMessageIds: [], restoredMessageIds: [] };
  }
  const forkTime = target.supersededAt;
  const run = messages.filter((m) => m.supersededAt === forkTime);
  if (run[0]?.id !== target.id) {
    throw branchError('That message does not start another version of a message in this chat.', 'NOT_A_BRANCH', 409);
  }

  // The turn's version on the conversation now, and the message the turn starts after.
  let currentIndex = -1;
  let turnStart = -1;
  if (target.role === 'user') {
    const family = new Set<string>([target.id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const m of messages) {
        if (m.role !== 'user') continue;
        const linked = family.has(m.id) || (m.revisionOf !== undefined && family.has(m.revisionOf));
        if (!linked) continue;
        for (const id of [m.id, m.revisionOf]) if (id !== undefined && !family.has(id)) { family.add(id); grew = true; }
      }
    }
    currentIndex = messages.findIndex((m) => m.role === 'user' && m.supersededAt === undefined && family.has(m.id));
    turnStart = currentIndex;
  } else if (target.inReplyTo !== undefined) {
    const anchorIndex = messages.findIndex((m) => m.id === target.inReplyTo && m.supersededAt === undefined);
    if (anchorIndex !== -1) {
      currentIndex = messages.findIndex((m) => m.role === 'assistant' && m.supersededAt === undefined && m.inReplyTo === target.inReplyTo);
      turnStart = anchorIndex;
    }
  }
  if (currentIndex === -1) {
    throw branchError('That version belongs to a message that is not on the conversation now; switch the earlier message first.', 'NOT_A_BRANCH', 409);
  }

  // A reply to a message before the turn stays where it is (it is not part of this turn's versions).
  const earlierUserIds = new Set(messages.slice(0, turnStart).filter((m) => m.supersededAt === undefined && m.role === 'user').map((m) => m.id));
  const spare = (m: CompanionChatMessage): boolean => m.role === 'assistant' && m.inReplyTo !== undefined && earlierUserIds.has(m.inReplyTo);
  // One new fork time, later than any in the chat, so the version left is one run of its own.
  const latest = messages.reduce((max, m) => Math.max(max, m.supersededAt ?? 0), 0);
  const switchTime = Math.max(now, latest + 1);
  const reason: CompanionChatSupersededReason = target.supersededReason ?? (target.role === 'user' ? 'edit' : 'regenerate');
  const supersededMessageIds = supersedeFrom(session, currentIndex, reason, switchTime, spare);
  const restoredMessageIds: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.supersededAt !== forkTime) continue;
    const { supersededAt: _at, supersededReason: _reason, ...active } = m;
    messages[i] = active;
    restoredMessageIds.push(m.id);
  }
  session.lastActivityAt = now;
  return { messageId: target.id, switched: true, supersededMessageIds, restoredMessageIds };
}

export interface EditBranchPlan {
  readonly editedFrom: string;
  readonly newMessageId: string;
  readonly supersededMessageIds: readonly string[];
}

/**
 * Apply an edit-and-branch: the target must be an active user message. It and
 * everything after it are superseded (retained), then a new user message with
 * the edited content, carrying `revisionOf` back to the original, is appended.
 * The caller then rebuilds the conversation from the active chain and runs a
 * turn.
 *
 * Throws when the target id is unknown, is not a user message, is already
 * superseded history, or the edited message has neither content nor attachments.
 */
export function applyEditBranch(
  session: BranchingSession,
  sessionId: string,
  input: EditCompanionChatMessageInput,
  artifactStore: CompanionChatArtifactStore | null,
  now: number,
): EditBranchPlan {
  const attachments = resolveAttachments(input.attachments ?? [], artifactStore);
  if (!input.content.trim() && attachments.length === 0) {
    throw branchError('content or attachments are required', 'INVALID_ARGUMENT', 400);
  }

  const targetIndex = session.messages.findIndex((m) => m.id === input.messageId);
  if (targetIndex === -1) {
    throw branchError(`Message not found: ${input.messageId}`, 'MESSAGE_NOT_FOUND', 404);
  }
  const target = session.messages[targetIndex]!;
  if (target.supersededAt !== undefined) {
    throw branchError(
      'That message is already superseded history; edit the active message instead.',
      'MESSAGE_SUPERSEDED',
      409,
    );
  }
  if (target.role !== 'user') {
    throw branchError(
      'Only a user message can be edited and branched from.',
      'NOT_A_USER_MESSAGE',
      400,
    );
  }

  const supersededMessageIds = supersedeFrom(session, targetIndex, 'edit', now);
  const replacement: CompanionChatMessage = {
    id: randomUUID(),
    sessionId,
    role: 'user',
    content: input.content,
    attachments,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    createdAt: now,
    revisionOf: input.messageId,
  };
  session.messages.push(replacement);
  session.lastActivityAt = now;
  return { editedFrom: input.messageId, newMessageId: replacement.id, supersededMessageIds };
}
