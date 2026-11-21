import type { OrchestratorUserInputOptions } from '@goodvibes/engine/platform/platform/core';

/**
 * The one path by which "the owner said this" becomes a turn in a terminal app.
 * The composer binds it once the shell is up; companion messages and an
 * activated plan send through it, so a message from the phone and a plan's first
 * turn start on the same path as a typed one (in the Agent: native intake and
 * the same routing decision, the connected host's loop or this process).
 */
export type OwnerInputRoute = (text: string, options?: OrchestratorUserInputOptions, answered?: OwnerInputAnswered) => void;

/** How the turn a routed message became ended: its answer text and whether it completed. */
export interface OwnerInputAnswer {
  readonly answer: string;
  readonly status: 'completed' | 'failed' | 'cancelled';
}

/**
 * Told how the message's turn ended when it ran somewhere this process sees no
 * turn events for (the connected host's loop), or when it never became a turn
 * (refused, failed, possibly sent): the one who passed the message owes its
 * sender an answer either way. A turn run in this process is answered from its
 * own turn events instead.
 */
export type OwnerInputAnswered = (answer: OwnerInputAnswer) => void;

/** Keyed by the session's orchestrator: one route per running conversation. */
const ownerInputRoutes = new WeakMap<object, OwnerInputRoute>();

/** Bind the conversation's owner-input route. Returns the unbind. */
export function bindOwnerInput(conversationOwner: object, route: OwnerInputRoute): () => void {
  ownerInputRoutes.set(conversationOwner, route);
  return () => { if (ownerInputRoutes.get(conversationOwner) === route) ownerInputRoutes.delete(conversationOwner); };
}

/** The bound route, or null before the shell has bound one (boot, headless runs). */
export function ownerInputFor(conversationOwner: object): OwnerInputRoute | null {
  return ownerInputRoutes.get(conversationOwner) ?? null;
}
