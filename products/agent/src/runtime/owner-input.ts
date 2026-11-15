import type { OrchestratorUserInputOptions } from '@goodvibes-jev/engine/platform/platform/core';

/**
 * The one path by which "the owner said this" becomes a turn: native intake,
 * the same routing decision (the connected host's loop or this process), and
 * the intake's turn-finished signal. The composer binds it once the shell is up;
 * companion messages and an activated plan send through it, so a message from
 * the phone and a plan's first turn run on the same loop as a typed one.
 */
export type OwnerInputRoute = (text: string, options?: OrchestratorUserInputOptions) => void;

/** Keyed by the session's orchestrator: one route per running conversation. */
const routes = new WeakMap<object, OwnerInputRoute>();

/** Bind the conversation's owner-input route. Returns the unbind. */
export function bindOwnerInput(conversationOwner: object, route: OwnerInputRoute): () => void {
  routes.set(conversationOwner, route);
  return () => { if (routes.get(conversationOwner) === route) routes.delete(conversationOwner); };
}

/** The bound route, or null before the shell has bound one (boot, headless runs). */
export function ownerInputFor(conversationOwner: object): OwnerInputRoute | null {
  return routes.get(conversationOwner) ?? null;
}
