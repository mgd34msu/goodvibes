/**
 * turn-input-party.ts, whose input a turn is acting on: the owner's own, or someone else's.
 *
 * The ONE place this is decided, for every door a turn comes through. It decides how far a turn's commands and file
 * writes may reach (tools/exec/containment.ts `containmentForTurn`, `foreignInputWriteRefusal`):
 *
 *  - The OWNER's turn (his terminal conversation, his web chat, his schedule or trigger he set up, work he himself asked
 *    for or approved, a hosted session he typed into): commands run by the one rule every terminal conversation has, the shared sandbox
 *    setting and his mode; an ask nobody is present for waits for him in Waiting for you.
 *  - A turn driven by SOMEONE ELSE's input (a message that arrived on a channel, a guest the channel admitted, a paired
 *    device or signed-in person who is not the owner, a webhook, input an outside caller put into a hosted session, work
 *    anyone but the owner caused and he has not approved): it runs reads only (every other tool call is refused at
 *    admission, gate/classify.ts), no command outside a real sandbox and writes no file, whatever the mode
 *    (added after a daemon-hosted turn nobody watched reached the owner's tmux through an unsandboxed command).
 *
 * Read from what the transport established, never from anything a message or the model wrote:
 *  - the turn in scope (security/turn-boundary.ts): the channel surface a turn was started for, the guest or other
 *    person it acts for (`actor`), the origin a hosted session's input carries;
 *  - a host that runs its own turn loop without that scope (the web chat) marks a turn whose sender is not the owner
 *    with {@link withOtherPartyInput}, from the credential that sent the message (the chat's registrant).
 *
 * Unknown leans to someone else: a surface not named below as the owner's is someone else's.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { currentTurn, inputOriginIsOwnerDirect, type TurnContext } from './turn-boundary.js';
import { isGuestSurfaceId, normalizeSurfaceId } from '../gate/surface-authority.js';
import type { ActorClass } from '@goodvibes/engine/daemon-api/http-policy';

/** Whose input a turn is acting on. `who` names the other party for the refusal a person reads. */
export type TurnInputParty =
  | { readonly party: 'owner' }
  /**
   * `madeFor`: the principal whose own conversation the turn runs in, when the daemon recorded one (a member's web chat:
   * hers); what such a turn reaches of chats and sessions is what that principal made (control-plane/caller-reach.ts).
   */
  | {
    readonly party: 'other'; readonly who: string; readonly madeFor?: string | undefined;
    /**
     * Set only by {@link asCallOutsideTurn}: this is no turn but that caller's own request over the wire, already decided
     * at its door by the one owner decision (put to the owner, run under his rules for that caller, or refused). The act
     * its door runs for it as decided (`ToolRegistry.executeOwnerConfirmed`) is not refused as a turn on someone else's
     * input (permissions/manager.ts `callFacts`); every turn started from it reads as someone else's, as before, and the
     * mark is dropped wherever a turn takes its party from it (withInputParty, withOtherPartyInput).
     */
    readonly directCall?: true | undefined;
  };

const OWNER: TurnInputParty = Object.freeze({ party: 'owner' });

/**
 * Work that no turn and no mark names (a callback that lost its turn's scope, a queue drained by other code, a run no
 * host marked) is someone else's: unknown leans to someone else. A process whose unmarked work is the person at its own
 * keyboard (the terminal app, the Agent: `declareUnmarkedWorkIsOwners`) says so once at start; the daemon never does,
 * and marks every run of the owner's it starts (his schedules and triggers, his Work, his calls over the wire).
 */
const UNMARKED: TurnInputParty = Object.freeze({ party: 'other', who: 'work that no turn or mark names as the owner\'s' });
let unmarkedIsOwners = false;

/** The terminal programs: outside any turn, the work in this process is the owner's own at his keyboard. */
export function declareUnmarkedWorkIsOwners(): void {
  unmarkedIsOwners = true;
}

function unmarked(): TurnInputParty {
  return unmarkedIsOwners ? OWNER : UNMARKED;
}

/** The owner's own surfaces: his terminal programs, his web view, the daemon itself. (His schedules are marked as his.) */
const OWNER_SURFACES: ReadonlySet<string> = new Set(['tui', 'cli', 'terminal', 'agent', 'web', 'webui', 'daemon']);

/** People and programs whose turns are the owner's. */
const OWNER_ACTOR_CLASSES: ReadonlySet<ActorClass> = new Set(['owner', 'system']);

const marked = new AsyncLocalStorage<TurnInputParty>();

/**
 * Whether a channel turn is the owner's own message in a conversation proven to be his alone, on a channel where he
 * chose "Treat my own messages here as me" (channels/types.ts `ownMessagesAsOwner`, off by default). The host that runs
 * channel turns sets it (the daemon: daemon/owner-channel-conversation.ts), from the turn's session and its channel's
 * route and policy, never from anything a message wrote. Absent, or answering false: a channel message is someone else's.
 */
type OwnerChannelConversationReader = (turn: TurnContext) => boolean;
let ownerChannelConversation: OwnerChannelConversationReader | undefined;

/** Sets the reader above; returns its removal. */
export function setOwnerChannelConversationReader(reader: OwnerChannelConversationReader): () => void {
  ownerChannelConversation = reader;
  return () => { if (ownerChannelConversation === reader) ownerChannelConversation = undefined; };
}

function ownersChannelTurn(turn: TurnContext): boolean {
  try { return ownerChannelConversation?.(turn) === true; }
  catch { return false; }
}

/**
 * Whether a channel session is the owner's own conversation, his alone, on a channel where he chose "Treat my own
 * messages here as me": the same reader, asked for the session alone (its one channel read from its routes). A piece of
 * work such a conversation caused (his message there, agreed by him there) is his own (the daemon's Work runner asks).
 */
export function ownersChannelSession(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return ownersChannelTurn(Object.freeze({
    turnId: `session:${sessionId}`, sessionId, surface: undefined, origin: undefined, requestText: null, ownerRequestText: null,
    callerAgentId: null, ownerSessionId: null,
  }) as TurnContext);
}

/**
 * Runs `fn` as a turn driven by someone else's input, for a host whose turn loop has no turn scope of its own (the
 * web chat): `who` is how the refusal names them ("a guest of the web chat", "Home Assistant").
 */
export function withOtherPartyInput<T>(who: string, fn: () => T, madeFor?: string | undefined): T {
  return marked.run(Object.freeze({ party: 'other' as const, who, ...(madeFor ? { madeFor } : {}) }), fn);
}

/**
 * Runs `fn` as the owner's own turn, for the same hosts: a turn started from inside another one (the next queued
 * message of a chat, launched as the previous turn ends) does not inherit that one's party.
 */
export function withOwnerInput<T>(fn: () => T): T {
  return marked.run(OWNER, fn);
}

/**
 * Runs `fn` as a turn of `party`, whatever the scope it was started from: a piece of work's turns run as the party its
 * record names (work-plans.ts `WorkCause`), not as whoever happened to start or wake them.
 */
export function withInputParty<T>(party: TurnInputParty, fn: () => T): T {
  return party.party === 'owner' ? withOwnerInput(fn) : withOtherPartyInput(party.who, fn, party.madeFor);
}

/**
 * The party a caller marked this run with (withInputParty, from the cause the daemon recorded for the call), or
 * undefined when nothing marked it: never the default a turn with no scope reads as.
 */
export function markedInputParty(): TurnInputParty | undefined {
  return marked.getStore();
}

/** Runs `fn` with no party marked: a turn it starts is read from its own scope, never from the caller's mark. */
export function withoutInputMark<T>(fn: () => T): T {
  return marked.exit(fn);
}

/**
 * Runs `fn`, a caller's own call over the wire that no turn carries (a capability run, a method by its door), as a call
 * decided under the owner's gate: its caller's rights are the credential's (the owner decision, the reach and folder
 * checks), not a turn's. Only where nothing is marked and no turn is in scope: a turn's nested call keeps its party.
 * `party`: who caused it when the door knows (capabilities.run's `causeOfRun`), else decided as the owner's gate decides.
 */
export function asCallOutsideTurn<T>(fn: () => T, party: TurnInputParty = OWNER): T {
  if (marked.getStore() !== undefined || currentTurn() !== undefined) return fn();
  if (party.party === 'owner') return withOwnerInput(fn);
  // Someone else's own call (a paired device, a member, a script): its party, marked as that caller's own request.
  return marked.run(Object.freeze({ party: 'other' as const, who: party.who, ...(party.madeFor ? { madeFor: party.madeFor } : {}), directCall: true as const }), fn);
}

/**
 * Whether the work in scope is a caller's own request over the wire that its door decided (asCallOutsideTurn), with
 * no turn in scope: never a channel message, a member's web chat, a device's outside agent or runner, or any turn.
 */
export function inDirectCall(): boolean {
  const mark = marked.getStore();
  return mark?.party === 'other' && mark.directCall === true && currentTurn() === undefined;
}

/** Whose input `turn` (default: the turn in scope) is acting on. See the module header. */
export function turnInputParty(turn: TurnContext | undefined = currentTurn()): TurnInputParty {
  const mark = marked.getStore();
  if (mark) return mark;
  if (!turn) return unmarked();
  const actor = turn.actor?.agentFor ?? turn.actor;
  if (actor) {
    if (!OWNER_ACTOR_CLASSES.has(actor.class)) return { party: 'other', who: `${actor.class} ${actor.id}` };
    if (actor.via === 'channel') return ownersChannelTurn(turn) ? OWNER : { party: 'other', who: `a message on ${turn.surface ?? actor.id}` };
  }
  // A piece of work's turn is no exception by its source: the work's own record says whose it is (work-plans.ts
  // `WorkCause`), and its runner marks the turn with that party (withOwnerInput / withOtherPartyInput).
  if (turn.origin && inputOriginIsOwnerDirect(turn.origin)) return OWNER;
  const surface = turn.surface;
  // A turn with no surface is the owner's only when its host established that he gave its input (his keyboard); an
  // agent's turn is marked by the party that started it (tools/agent/manager.ts); anything else is someone else's.
  if (surface === undefined) return turn.ownerInput === true ? OWNER : unmarked();
  const normalized = normalizeSurfaceId(surface);
  if (isGuestSurfaceId(normalized)) return { party: 'other', who: `a guest on ${normalized.slice('guest:'.length)}` };
  if (OWNER_SURFACES.has(normalized)) return OWNER;
  // The owner's own message on a channel where he chose to be treated as himself, in a conversation proven his alone.
  if (ownersChannelTurn(turn)) return OWNER;
  return { party: 'other', who: normalized === 'service' ? 'input an outside caller sent' : `a message on ${normalized}` };
}
