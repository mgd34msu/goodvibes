import type { SessionEvent } from '@goodvibes/engine/platform/events/session';
import type { OrchestratorUserInputOptions } from '@goodvibes/engine/platform/platform/core';
export type CompanionMessagePayload = Extract<SessionEvent, { type: 'COMPANION_MESSAGE_RECEIVED' }>;
export function companionMessageToOrchestratorInputOptions(payload: CompanionMessagePayload): OrchestratorUserInputOptions {
  const metadata = payload.metadata;
  const surface = typeof metadata?.surface === 'string' ? metadata.surface : undefined;
  const topic = typeof metadata?.topic === 'string' ? metadata.topic : undefined;

  return {
    origin: {
      source: payload.source,
      messageId: payload.messageId,
      ...(surface ? { surface } : {}),
      ...(topic ? { topic } : {}),
      ...(metadata ? { metadata } : {}),
    },
  };
}

/**
 * The one path by which "the owner said this" becomes a turn in a terminal app.
 * The composer binds it once the shell is up; companion messages and an
 * activated plan send through it, so a message from the phone and a plan's first
 * turn start on the same path as a typed one (in the Agent: native intake and
 * the same routing decision, the connected host's loop or this process).
 */
export type OwnerInputRoute = (text: string, options?: OrchestratorUserInputOptions) => void;

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
