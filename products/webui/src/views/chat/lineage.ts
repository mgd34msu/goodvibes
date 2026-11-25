/**
 * lineage.ts, the honest-lineage view model for companion chat.
 *
 * The daemon never deletes conversation history. When a response is regenerated or a
 * message is edited and the conversation branches, the affected messages are marked
 * SUPERSEDED (a `supersededAt` timestamp + a `supersededReason`) and RETAINED in the
 * message list, `companion.chat.messages.list` returns them alongside the active chain.
 * A replacement user message also carries `revisionOf` back to the original it
 * was edited from.
 *
 * This module turns that flat, server-authoritative list into a render model that keeps
 * the promise the platform makes: the active conversation reads cleanly, and every superseded
 * message stays VIEWABLE as retained history rather than silently vanishing. Because the
 * model is derived purely from the server list (not from ephemeral client state), it
 * survives reloads and reflects exactly what the daemon retained.
 *
 * Grouping rule: a superseded message is a fork's old branch. A contiguous run of
 * superseded messages is attached to the next ACTIVE message that follows it, that
 * active message is the fork's new branch head (the regenerated response, or the edited
 * user message). The UI renders the active message normally and offers to reveal the
 * attached retained history inline.
 */

import { messageCreatedAt, messageTone } from './message-utils';
import { asRecord, bestId, firstString } from '../../lib/object';
import type { ChatMessage } from './types';

export type SupersededReason = 'regenerate' | 'edit' | 'unknown';

/** True when a message is retained history behind a fork (has a supersededAt marker). */
export function isSuperseded(message: unknown): boolean {
  const value = asRecord(message).supersededAt;
  if (typeof value === 'number') return value > 0;
  // Some wire encodings send an ISO string; any non-empty string counts as "present".
  return typeof value === 'string' && value.trim().length > 0;
}

/** Why a message was superseded, read defensively from the wire record. */
export function supersededReason(message: unknown): SupersededReason {
  const raw = firstString(message, ['supersededReason']).toLowerCase();
  if (raw === 'regenerate') return 'regenerate';
  if (raw === 'edit') return 'edit';
  return 'unknown';
}

/** The id of the message this one was edited from (the forward lineage link), if any. */
export function revisionOf(message: unknown): string {
  return firstString(message, ['revisionOf']);
}

/**
 * Where a turn that has versions stands: this version's place among them (1-based),
 * how many there are, and the first message of the version before and after it.
 */
export interface BranchChoice {
  readonly position: number;
  readonly count: number;
  readonly previousId?: string;
  readonly nextId?: string;
}

/**
 * One rendered node of the active conversation: an active message plus any retained
 * history attached to it (the superseded run immediately preceding it in the list).
 */
export interface LineageNode {
  /** The active (non-superseded) message to render as the live conversation. */
  readonly message: ChatMessage;
  /** Superseded messages retained behind the fork this node heads, oldest first. */
  readonly priorMessages: readonly ChatMessage[];
  /** Why the attached run was superseded ('regenerate' | 'edit'); undefined when none. */
  readonly reason?: SupersededReason;
  /** The original message id when this node's message replaced an edited one. */
  readonly revisionOf?: string;
  /** When this message's turn has other versions (edits, or regenerated replies): the switcher's place. */
  readonly branches?: BranchChoice;
}

/** The fork time a superseded message carries, as a key ('' for an active message). */
function forkKey(message: ChatMessage): string {
  const value = asRecord(message).supersededAt;
  return typeof value === 'number' || typeof value === 'string' ? String(value) : '';
}

/**
 * The versions of each turn, read from the whole list the daemon returned (the same
 * rule as companion.chat.branches.switch). A version is the run one fork marked
 * superseded at one time, headed by its first message; the versions of a turn are
 * a user message and its edits (linked by `revisionOf`), or the replies to one user
 * message (`inReplyTo`). Returns each active message's choice, and the fork times
 * of every run that is a version of some turn: those are reached by switching
 * (the turn's switcher, or an earlier one's first), never shown as retained history.
 */
function branchChoices(messages: readonly ChatMessage[]): { choices: Map<string, BranchChoice>; linked: Set<string> } {
  const firstOfRun = new Map<string, ChatMessage>();
  for (const message of messages) {
    const key = forkKey(message);
    if (key && !firstOfRun.has(key)) firstOfRun.set(key, message);
  }
  const heads = messages.filter((message) => {
    const key = forkKey(message);
    return bestId(message) !== '' && (!key || firstOfRun.get(key) === message);
  });

  // Edits: user messages joined through revisionOf.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  for (const message of messages) {
    if (messageTone(message) !== 'user') continue;
    const id = bestId(message);
    const from = revisionOf(message);
    if (!id) continue;
    if (!parent.has(id)) parent.set(id, id);
    if (from) {
      if (!parent.has(from)) parent.set(from, from);
      parent.set(find(id), find(from));
    }
  }
  const families = new Map<string, ChatMessage[]>();
  for (const message of heads) {
    const tone = messageTone(message);
    const group = tone === 'user'
      ? `user:${find(bestId(message))}`
      : tone === 'assistant' && firstString(message, ['inReplyTo'])
        ? `reply:${firstString(message, ['inReplyTo'])}`
        : '';
    if (!group) continue;
    const list = families.get(group) ?? [];
    list.push(message);
    families.set(group, list);
  }

  // A run headed by a user message or a reply that names the message it answers is a version of some
  // turn: reached by that turn's switcher, or, when the turn sits inside another version, by
  // switching to that version first. Only a run with neither link is shown as retained history.
  const linked = new Set<string>();
  for (const [key, head] of firstOfRun) {
    const tone = messageTone(head);
    if (tone === 'user' || (tone === 'assistant' && firstString(head, ['inReplyTo']))) linked.add(key);
  }
  const choices = new Map<string, BranchChoice>();
  for (const family of families.values()) {
    if (family.length < 2) continue;
    const ordered = sortByCreatedAt(family);
    const at = ordered.findIndex((message) => !isSuperseded(message));
    if (at === -1) continue; // this turn is inside another version, not on the conversation now
    choices.set(bestId(ordered[at]!), {
      position: at + 1,
      count: ordered.length,
      ...(at > 0 ? { previousId: bestId(ordered[at - 1]!) } : {}),
      ...(at < ordered.length - 1 ? { nextId: bestId(ordered[at + 1]!) } : {}),
    });
  }
  return { choices, linked };
}

/**
 * Build the honest-lineage render model from a server-ordered message list.
 *
 * Active messages become top-level nodes in order. A contiguous run of superseded
 * messages is buffered and attached as `priorMessages` to the next active node (the fork
 * head). A trailing superseded run with no following active message, which the daemon
 * should not produce, since a fork always ends with a new active branch, but which is
 * handled here so history is never dropped, is attached to the last active node, or, if
 * there is none, surfaced as its own history-only node so it stays viewable.
 */
export function buildLineage(messages: readonly ChatMessage[]): LineageNode[] {
  const nodes: LineageNode[] = [];
  let pending: ChatMessage[] = [];
  let pendingReason: SupersededReason | undefined;
  const { choices, linked } = branchChoices(messages);

  for (const message of messages) {
    if (isSuperseded(message)) {
      // A version of a turn is reached with that turn's switcher, not shown as retained history.
      if (linked.has(forkKey(message))) continue;
      pending.push(message);
      // The reason of the run is taken from its members (they share one fork reason).
      const reason = supersededReason(message);
      if (reason !== 'unknown') pendingReason = reason;
      continue;
    }
    const branches = choices.get(bestId(message));
    nodes.push({
      message,
      priorMessages: pending,
      reason: pending.length ? (pendingReason ?? 'unknown') : undefined,
      revisionOf: revisionOf(message) || undefined,
      ...(branches ? { branches } : {}),
    });
    pending = [];
    pendingReason = undefined;
  }

  if (pending.length) {
    const last = nodes.at(-1);
    if (last) {
      // Merge the trailing run into the last active node so nothing is lost.
      nodes[nodes.length - 1] = {
        ...last,
        priorMessages: [...last.priorMessages, ...pending],
        reason: last.reason ?? pendingReason ?? 'unknown',
      };
    } else {
      // No active message at all, surface the retained history as its own node.
      nodes.push({
        message: pending.at(-1)!,
        priorMessages: pending.slice(0, -1),
        reason: pendingReason ?? 'unknown',
      });
    }
  }

  return nodes;
}

/**
 * Stable key for a lineage node, the message's real id alone when present, so the node
 * does NOT remount (losing any open <details> disclosure, retained-history reveal, the
 * compaction-handoff fold, or a folded tool-activity group) if the list re-renders with
 * the same message at a different array position (an optimistic-to-fetched merge can do
 * this). Falls back to an ordinal-based key, clearly shaped so it can never collide with
 * a real id, only when the message truly has none.
 */
export function lineageNodeKey(node: LineageNode, index: number): string {
  return bestId(node.message) || `node-${index}`;
}

/** A human, honest label for a retained-history run given its reason and size. */
export function retainedHistoryLabel(reason: SupersededReason | undefined, count: number): string {
  const plural = count === 1 ? '' : 's';
  if (reason === 'edit') return count <= 1 ? 'Edited: view original' : `Edited: view ${count} retained message${plural}`;
  if (reason === 'regenerate') {
    return count <= 1 ? 'Regenerated: view previous response' : `Regenerated: view ${count} previous message${plural}`;
  }
  return `View ${count} retained message${plural}`;
}

/** Order a run oldest-first defensively, in case the server list is not pre-sorted. */
export function sortByCreatedAt(messages: readonly ChatMessage[]): ChatMessage[] {
  return [...messages].sort((left, right) => messageCreatedAt(left) - messageCreatedAt(right));
}
