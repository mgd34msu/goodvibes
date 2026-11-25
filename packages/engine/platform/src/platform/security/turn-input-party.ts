/**
 * turn-input-party.ts, whose input a turn is acting on: the owner's own, or someone else's.
 *
 * The ONE place this is decided, for every door a turn comes through. It decides how far a turn's commands and file
 * writes may reach (tools/exec/containment.ts `containmentForTurn`, `foreignInputWriteRefusal`):
 *
 *  - The OWNER's turn (his terminal conversation, his web chat, his schedule or trigger he set up, his approved work, a
 *    hosted session he typed into): commands run by the one rule every terminal conversation has, the shared sandbox
 *    setting and his mode; an ask nobody is present for waits for him in Waiting for you.
 *  - A turn driven by SOMEONE ELSE's input (a message that arrived on a channel, a guest the channel admitted, a paired
 *    device or signed-in person who is not the owner, a webhook, input an outside caller put into a hosted session):
 *    it runs no command outside a real sandbox and writes no file, whatever the mode (hosted-sessions/exec-posture.ts
 *    records why that boundary was added).
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
  | { readonly party: 'other'; readonly who: string };

const OWNER: TurnInputParty = Object.freeze({ party: 'owner' });

/** The owner's own surfaces: his terminal programs, his web view, the daemon itself. (His schedules run with none.) */
const OWNER_SURFACES: ReadonlySet<string> = new Set(['tui', 'cli', 'terminal', 'agent', 'web', 'webui', 'daemon']);

/** Input sources that are the owner's own work although they arrive on the service surface: work he planned and approved. */
const OWNER_WORK_SOURCES: ReadonlySet<string> = new Set(['native-work']);

/** People and programs whose turns are the owner's. */
const OWNER_ACTOR_CLASSES: ReadonlySet<ActorClass> = new Set(['owner', 'system']);

const marked = new AsyncLocalStorage<TurnInputParty>();

/**
 * Runs `fn` as a turn driven by someone else's input, for a host whose turn loop has no turn scope of its own (the
 * web chat): `who` is how the refusal names them ("a guest of the web chat", "Home Assistant").
 */
export function withOtherPartyInput<T>(who: string, fn: () => T): T {
  return marked.run(Object.freeze({ party: 'other', who }), fn);
}

/**
 * Runs `fn` as the owner's own turn, for the same hosts: a turn started from inside another one (the next queued
 * message of a chat, launched as the previous turn ends) does not inherit that one's party.
 */
export function withOwnerInput<T>(fn: () => T): T {
  return marked.run(OWNER, fn);
}

/** Whose input `turn` (default: the turn in scope) is acting on. See the module header. */
export function turnInputParty(turn: TurnContext | undefined = currentTurn()): TurnInputParty {
  const mark = marked.getStore();
  if (mark) return mark;
  if (!turn) return OWNER;
  const actor = turn.actor?.agentFor ?? turn.actor;
  if (actor) {
    if (!OWNER_ACTOR_CLASSES.has(actor.class)) return { party: 'other', who: `${actor.class} ${actor.id}` };
    if (actor.via === 'channel') return { party: 'other', who: `a message on ${turn.surface ?? actor.id}` };
  }
  if (turn.origin && inputOriginIsOwnerDirect(turn.origin)) return OWNER;
  const source = turn.origin?.source;
  if (typeof source === 'string' && OWNER_WORK_SOURCES.has(source)) return OWNER;
  const surface = turn.surface;
  if (surface === undefined) return OWNER;
  const normalized = normalizeSurfaceId(surface);
  if (isGuestSurfaceId(normalized)) return { party: 'other', who: `a guest on ${normalized.slice('guest:'.length)}` };
  if (OWNER_SURFACES.has(normalized)) return OWNER;
  return { party: 'other', who: normalized === 'service' ? 'input an outside caller sent' : `a message on ${normalized}` };
}
