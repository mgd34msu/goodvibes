/**
 * turn-boundary.ts, when the untrusted-content window resets.
 *
 * ── The bug this exists to fix ────────────────────────────────────────────
 *
 * `UntrustedContentLedger.startTurn()` had no production caller anywhere,
 * not in the platform, not in any product, only tests. So "this turn" silently
 * meant "everything since the process started", bounded only by the ledger's
 * retention cap, and the corpus grew with uptime.
 *
 * That was harmless while the ledger drove a DISCLOSURE: a longer list of
 * origins on a receipt is noise, not a fault. It has teeth now that the ledger
 * drives a REFUSAL. A daemon up for a week would carry a week of strangers'
 * text as evidence against every outward action, and the first legitimate send
 * that happened to echo any of it would be refused for no reason a person
 * could reconstruct.
 *
 * ── What a turn is bound to, and why ──────────────────────────────────────
 *
 * A turn begins when the owner makes a fresh request, `explicitUserRequest`,
 * the one signal that honestly means "a person asked for this, now". Anything
 * the runtime then reads and does belongs to that turn.
 *
 * Automated work deliberately does NOT start a turn. A schedule, a trigger or
 * a channel-driven call leaves the window open, so its exposure accumulates
 * rather than clearing. That asymmetry is the safe direction and it is the
 * point: if automated work reset the window, content that had just been read
 * could arrange for the record of itself to be erased before the send it was
 * trying to cause.
 *
 * A daemon-hosted session is not the owner at a terminal, so its input never
 * passes `inputOriginIsOwnerDirect`. Each one runs in its own scope instead
 * (`session:<id>`, hosted-sessions/session-runtime.ts), which opens empty when
 * its loop is built and starts a new turn on input an authenticated operator
 * sent; channel and automation input leaves it open. A gateway call outside
 * any session keeps the window of its principal (or of its connection), so a
 * fresh request there cannot clear what a session's running turn just read.
 * Mail read by background work lands in a window of its own (the daemon's mail
 * composition), so it does not count against sessions that never read it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { getProcessUntrustedContentLedger, type UntrustedContentLedger } from './untrusted-content.js';
import type { TurnInputOrigin } from '../../events/turn.js';
import { guestSurfaceId, normalizeSurfaceId } from '../gate/surface-authority.js';
import { actorFromChannelSender, type Actor } from '@goodvibes/engine/daemon-api/http-policy';

/**
 * Reset the untrusted-content window if, and only if, this invocation is a
 * fresh owner request.
 *
 * Returns whether a turn was started, so a caller can log or test it without
 * reaching into the ledger.
 */
export function startTurnForOwnerRequest(
  explicitUserRequest: boolean | undefined,
  ledger: UntrustedContentLedger = getProcessUntrustedContentLedger(),
): boolean {
  if (explicitUserRequest !== true) return false;
  ledger.startTurn();
  return true;
}

/**
 * Message sources that mean "the human typed this, here, now".
 *
 * `operator` is the only source in `MessageSource` whose own definition says
 * so, "human typed in the TUI prompt". Everything else in that union is a
 * companion, a channel, or the runtime talking to itself.
 *
 * Deliberately NOT in this list: `companion-followup`. It reads like the owner
 * and sometimes is, but the same emit path serves anything that can inject into
 * the operator's live conversation, and a source that is sometimes the owner is
 * not evidence that this one was. A surface that CAN establish it is the human
 * says so with `ownerDirect: true` rather than by being on a list of names.
 */
export const OWNER_DIRECT_INPUT_SOURCES: readonly string[] = ['operator'];

/**
 * Did this input come from the owner, directly?
 *
 * Three ways to be true, and the default for everything else is false:
 *
 *  1. **No origin at all.** The surface process took this text off its own
 *     input widget; nothing routed it in. That is the keyboard.
 *  2. **`ownerDirect: true`.** An explicit attestation from a transport that
 *     can honestly make it, it authenticated the owner, or it read a local
 *     terminal. It is a claim about the CALLER, made by code, and no message
 *     body can set it, because message bodies do not construct these records.
 *  3. **A source on the list above.**
 *
 * Unknown sources are false. This is the asymmetry the module header describes
 * and it only works in one direction: failing to reset the window costs some
 * friction on a legitimate action, while resetting it wrongly lets content that
 * was just read arrange for the record of itself to be erased before the send
 * it was trying to cause.
 */
export function inputOriginIsOwnerDirect(origin: TurnInputOrigin | undefined): boolean {
  if (origin === undefined) return true;
  if (origin.ownerDirect === true) return true;
  if (origin.ownerDirect === false) return false;
  return typeof origin.source === 'string' && OWNER_DIRECT_INPUT_SOURCES.includes(origin.source);
}

/**
 * Start a turn for a message entering the conversation, if the owner sent it.
 *
 * This is the boundary the module header describes and the one that had no
 * caller: `startTurnForOwnerRequest` existed, the daemon's gateway dispatch
 * used it, and the CONVERSATION, where a person actually speaks to the agent,
 * did not. So in the agent and the TUI the window opened once at process start
 * and never again: one mailbox read on Monday refused every send until the
 * process was restarted, which is why the refusal the owner met said "earlier
 * in this session" rather than "in this turn". It was telling the truth about
 * a scope that should never have been that wide.
 *
 * Returns whether a turn was started.
 */
export function startTurnForOwnerInput(
  origin: TurnInputOrigin | undefined,
  ledger: UntrustedContentLedger = getProcessUntrustedContentLedger(),
): boolean {
  if (!inputOriginIsOwnerDirect(origin)) return false;
  ledger.startTurn();
  return true;
}

/**
 * Everything one turn knows about itself, held in the turn's async scope so
 * concurrent turns in one process (a daemon serving several sessions) never
 * see each other's facts, and no later writer (a queued message, another
 * session) can change them while the turn runs. Read with {@link currentTurn};
 * outside any scoped turn there is none and the call is the local owner's.
 */
export interface TurnContext {
  /** The turn's id; fresh for a scope opened without one. */
  readonly turnId: string;
  /** The session the turn runs in, when the host knows it. */
  readonly sessionId: string | null;
  /** The surface the turn's input came from; undefined for owner-direct input (what {@link turnSurfaceOf} gives). */
  readonly surface: string | undefined;
  /**
   * Whose turn it is, when the host knows a person other than the local owner:
   * the chat sender a channel admitted (`actorFromChannelSender`), set by the
   * daemon from the sender the adapter verified, never by message content. A
   * guest's turn is a model acting for that guest (`agentActor(actor)`), so
   * its calls are admitted as the guest's, never the owner's. Absent: the
   * local owner's own session, or a surface with no sender identity.
   */
  readonly actor?: Actor | undefined;
  readonly origin: TurnInputOrigin | undefined;
  /**
   * The host established that the owner himself gave this turn's input (his keyboard, an operator input marked owner-
   * direct): the one positive fact a turn with no surface is the owner's by (security/turn-input-party.ts). Absent: no
   * host said so, and such a turn is someone else's.
   */
  readonly ownerInput?: true | undefined;
  /** The message this turn answers. */
  readonly requestText: string | null;
  /** The same text when an authenticated operator sent it, else null. */
  readonly ownerRequestText: string | null;
  /** Set by the host when a tool call runs inside an agent; never by the model. */
  readonly callerAgentId: string | null;
  /** The session whose tools this turn may name. */
  readonly ownerSessionId: string | null;
}

const turnScope = new AsyncLocalStorage<TurnContext>();

function freshTurnId(): string {
  return `turn-${randomUUID()}`;
}

/** The surface a turn origin names, or undefined when the owner gave the input directly. */
export function turnSurfaceOf(origin: TurnInputOrigin | undefined): string | undefined {
  return inputOriginIsOwnerDirect(origin) ? undefined : (origin?.surface ?? origin?.source ?? 'unknown');
}

/**
 * The surface the gate's surface table reads for a turn: its surface, in its
 * guest form (`guest:<surface>`, surface-authority.ts) when the turn's actor is
 * a guest, so a guest's turn carries no command authority on any surface.
 * Derived from the actor; nothing stores the guest form.
 */
export function turnAuthoritySurface(turn: Pick<TurnContext, 'surface' | 'actor'> | undefined): string | undefined {
  if (turn?.surface === undefined) return undefined;
  return turn.actor?.class === 'guest' ? guestSurfaceId(turn.surface) : turn.surface;
}

/** {@link turnAuthoritySurface} of the turn in scope. */
export function currentTurnAuthoritySurface(): string | undefined {
  return turnAuthoritySurface(currentTurn());
}

/** The channel of the guest whose turn is in scope, or undefined when the turn is not a guest's. */
export function currentGuestChannel(): string | undefined {
  const turn = currentTurn();
  return turn?.actor?.class === 'guest' && turn.surface !== undefined ? normalizeSurfaceId(turn.surface) : undefined;
}

/** Runs one turn's work with its whole record in scope. */
export function withTurn<T>(context: TurnContext, fn: () => Promise<T>): Promise<T> {
  return turnScope.run(Object.freeze({ ...context }), fn);
}

/** The current turn's record; undefined outside a scoped turn. */
export function currentTurn(): TurnContext | undefined {
  return turnScope.getStore();
}

/**
 * Runs work that outlives the call (an agent spawned for a channel message) with
 * the surface it was triggered from in scope, so its tool calls meet the gate's
 * surface-authority check instead of being taken for the local owner's. It is
 * a turn of its own: it carries the surface and whose turn started it (a
 * guest stays a guest), and nothing else of that turn (not its request text,
 * not its owner's authority). `sessionId`: the channel conversation it was
 * started for, so "Treat my own messages here as me" can read whose it is
 * (security/turn-input-party.ts); never a grant by itself.
 */
export function withTurnSurfaceId<T>(surface: string | undefined, fn: () => T, actor?: Actor | undefined, sessionId?: string | undefined): T {
  return turnScope.run(Object.freeze({
    turnId: freshTurnId(),
    sessionId: sessionId ?? null,
    surface,
    ...(actor !== undefined ? { actor } : {}),
    origin: undefined,
    requestText: null,
    ownerRequestText: null,
    callerAgentId: null,
    ownerSessionId: null,
  }), fn);
}

/**
 * Runs one run of an agent as a turn of its own: the agent's id as the caller
 * (so the agent tool names it as the parent of what it spawns, never a value
 * the model wrote), the surface and actor it was started for, its session, and
 * the request of the turn that started it. Not that turn's owner authority:
 * an agent's tools never pass as the owner's own message.
 */
export function withAgentTurn<T>(agent: {
  readonly agentId: string;
  readonly surface: string | undefined;
  readonly actor?: Actor | undefined;
  readonly sessionId: string | null;
  readonly requestText: string | null;
}, fn: () => T): T {
  return turnScope.run(Object.freeze({
    turnId: freshTurnId(),
    sessionId: agent.sessionId,
    surface: agent.surface,
    ...(agent.actor !== undefined ? { actor: agent.actor } : {}),
    origin: undefined,
    requestText: agent.requestText,
    ownerRequestText: null,
    callerAgentId: agent.agentId,
    ownerSessionId: agent.sessionId,
  }), fn);
}

/**
 * Runs `fn` as the turn of a channel sender who is not the channel's owner:
 * the turn's actor is that guest (`actorFromChannelSender`), so its tool calls
 * may read and answer and every change is put to the owner (the gate reads
 * the guest from the actor, {@link turnAuthoritySurface}). The daemon sets it
 * from the sender the adapter verified. The rest of the turn in scope, if
 * any, is kept; only who the turn is for narrows, and no owner request text
 * survives into a guest's turn.
 */
export function withGuestTurn<T>(surface: string, fn: () => T, userId?: string | undefined): T {
  const outer = currentTurn();
  const channel = normalizeSurfaceId(surface);
  return turnScope.run(Object.freeze({
    turnId: outer?.turnId ?? freshTurnId(),
    sessionId: outer?.sessionId ?? null,
    surface: channel,
    // A guest whose id the caller did not hand over is still a guest: `isChannelOwner: false` decides it.
    actor: actorFromChannelSender({ surface: channel, userId: userId ?? 'guest', isChannelOwner: false }),
    origin: outer?.origin,
    requestText: outer?.requestText ?? null,
    ownerRequestText: null,
    callerAgentId: outer?.callerAgentId ?? null,
    ownerSessionId: outer?.ownerSessionId ?? null,
  }), fn);
}

/**
 * The scope a channel spawn runs under: a guest turn already in scope (the
 * conversation gate started it for a non-owner sender) is kept, surface and
 * guest together, so starting the agent cannot hand a guest's message the
 * channel's own authority.
 */
export function channelTurnScope(surface: string | undefined): { readonly surface: string | undefined; readonly actor?: Actor | undefined } {
  const scoped = currentTurn();
  return scoped?.actor?.class === 'guest' ? { surface: scoped.surface, actor: scoped.actor } : { surface };
}

/**
 * Who is acting in the current turn, for recording an approval the turn made:
 * `owner` for owner-direct input (and outside a turn, the owner's own process),
 * else `surface:<id>` for the surface the turn's input arrived on. It comes
 * from the transport that received the input, never from tool arguments the
 * model writes.
 */
export function currentTurnActor(): string {
  const surface = currentTurnAuthoritySurface();
  return surface === undefined ? 'owner' : `surface:${surface}`;
}
