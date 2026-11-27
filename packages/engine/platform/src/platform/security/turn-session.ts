/**
 * turn-session.ts, whose turn a call of one of the daemon's own turns belongs to: the ONE reader every daemon-turn tool
 * uses to name the conversation it came from (the session `capabilities.run` and every method call of a turn name, so
 * a memory record's provenance and an approval name it; the key an action's preview is kept under; the maker of a file
 * the turn makes, daemon/facade-composition.ts).
 *
 * A web chat's turn (companion/companion-chat-manager.ts) runs in no turn record of its own: its tool calls run inside
 * their chat's scope, set around every batch of them (companion/companion-chat-turn-execution.ts). Every other daemon turn
 * (a hosted session, a schedule's or a trigger's run, an agent of planned work) runs inside its turn record
 * (security/turn-boundary.ts): its session, else the agent whose run it is. A turn record entered inside a chat's tool
 * call (an agent the chat started) is that turn's own, not the chat's.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { agentActor, localOwnerActor, type Actor } from '@goodvibes/engine/daemon-api/http-policy';
import { currentTurn, type TurnContext } from './turn-boundary.js';

interface ChatToolCalls {
  readonly sessionId: string;
  readonly turnId: string;
  /** Who made the chat: its model acts for that one (absent: a chat of the owner's). */
  readonly maker: Actor | undefined;
  /** The turn record in scope when the chat's calls began (none for a web chat): one entered later is another turn. */
  readonly outer: TurnContext | undefined;
}

const chatToolCalls = new AsyncLocalStorage<ChatToolCalls>();

/**
 * Runs a web chat's tool calls (`fn`) as that chat's turn `turnId`. `maker`: whoever made the chat (a member, a device,
 * the owner): the chat's model acts for that one, whoever sent the message (companion-chat-manager.ts `makerActorOf`).
 */
export function withChatToolCalls<T>(sessionId: string, turnId: string, fn: () => T, maker?: Actor | undefined): T {
  return chatToolCalls.run(Object.freeze({ sessionId, turnId, maker, outer: currentTurn() }), fn);
}

/** The web chat whose tool calls run in this async context, if any. */
export function chatToolCallSession(): string | undefined {
  return chatToolCalls.getStore()?.sessionId;
}

/** Whose turn a call belongs to: the conversation (`sessionId`) and the turn (`turnId`); empty outside every turn. */
export interface WhoseTurn {
  readonly sessionId?: string | undefined;
  readonly turnId?: string | undefined;
  /** Whom the turn's model acts for: a chat's maker, else the turn record's actor; absent when neither names one. */
  readonly actor?: Actor | undefined;
}

/** See the module header. */
export function whoseTurn(): WhoseTurn {
  const chat = chatToolCalls.getStore();
  const turn = currentTurn();
  if (chat && turn === chat.outer) return { sessionId: chat.sessionId, turnId: chat.turnId, ...(chat.maker ? { actor: chat.maker } : {}) };
  if (!turn) return {};
  const sessionId = turn.sessionId ?? turn.callerAgentId ?? undefined;
  return { ...(sessionId ? { sessionId } : {}), turnId: turn.turnId, ...(turn.actor ? { actor: turn.actor } : {}) };
}

/**
 * The record of the turn a call belongs to, as an object that lives exactly as long as that turn's scope (a web chat's
 * batch of tool calls, else the turn record): what is kept for one turn (an action's preview) is kept on it and goes
 * when the turn ends. Undefined outside every turn.
 */
export function turnRecordOf(): object | undefined {
  const chat = chatToolCalls.getStore();
  const turn = currentTurn();
  if (chat && turn === chat.outer) return chat;
  return turn;
}

/**
 * The actor a turn's model calls as: the model acting for whose turn it is (a member's or a device's chat: theirs; a
 * guest's turn: the guest's), the local owner when nothing names one (their own program's turn, a chat of theirs).
 */
export function turnModelActor(): Actor {
  return agentActor(whoseTurn().actor ?? localOwnerActor());
}
