/**
 * A companion chat turn from a channel (the ntfy remote topic, Home Assistant
 * chat) that arrived while the daemon took no new work (a self-update's
 * restart). It is kept the way every other channel message is: a queued input
 * of the session broker with the wait mark, which survives the restart. The
 * broker's continuation runner finds the turn on the input's metadata after the
 * restart (or when admission reopens), runs it as the companion chat turn it
 * was, and the input is completed: one answer, after the restart.
 *
 * Cost: nothing while admission is open; during the hold, one binding upsert
 * and one broker save per message.
 */
import type { RouteBindingManager } from '../channels/index.js';
import type { SharedSessionBroker } from '../control-plane/session-broker.js';
import type { HomeAssistantSurfaceChatInput } from './surface-homeassistant-reply.js';

/** Input metadata carrying the held turn. */
export const HELD_COMPANION_TURN_KEY = 'heldCompanionTurn';

export interface HeldNtfyRemoteTurn {
  readonly topic: string;
  readonly body: string;
  readonly title?: string | undefined;
  readonly messageId?: string | undefined;
}

export type HeldCompanionTurn =
  | { readonly kind: 'ntfy-remote'; readonly input: HeldNtfyRemoteTurn }
  | { readonly kind: 'homeassistant'; readonly input: HomeAssistantSurfaceChatInput };

/** The held turn on an input's metadata, or null when there is none or it is not one this daemon wrote. */
export function readHeldCompanionTurn(metadata: Record<string, unknown> | undefined): HeldCompanionTurn | null {
  const value = metadata?.[HELD_COMPANION_TURN_KEY];
  if (typeof value !== 'object' || value === null) return null;
  const turn = value as { kind?: unknown; input?: unknown };
  if (typeof turn.input !== 'object' || turn.input === null) return null;
  const input = turn.input as Record<string, unknown>;
  if (turn.kind === 'ntfy-remote' && typeof input.topic === 'string' && typeof input.body === 'string') return turn as HeldCompanionTurn;
  if (turn.kind === 'homeassistant' && typeof input.body === 'string' && typeof input.conversationId === 'string'
    && typeof input.surfaceId === 'string' && typeof input.channelId === 'string' && typeof input.messageId === 'string') return turn as HeldCompanionTurn;
  return null;
}

/**
 * Save the turn as a queued broker input with the wait mark, in a session of
 * its own conversation. Null when the broker did not keep it (refused).
 */
export async function holdCompanionTurn(
  deps: { readonly routeBindings: RouteBindingManager; readonly sessionBroker: SharedSessionBroker },
  turn: HeldCompanionTurn,
): Promise<{ readonly sessionId: string; readonly inputId: string; readonly routeId: string } | null> {
  const ntfy = turn.kind === 'ntfy-remote';
  const surfaceKind = ntfy ? 'ntfy' as const : 'homeassistant' as const;
  // Its own conversation key, so a held turn never lands in an agent session of the same channel.
  const externalId = ntfy ? `held-companion:${turn.input.topic}` : `held-companion:${turn.input.surfaceId}:${turn.input.conversationId}`;
  await deps.routeBindings.start();
  const binding = await deps.routeBindings.upsertBinding({
    kind: 'channel', surfaceKind, surfaceId: `${surfaceKind}-held-companion`, externalId, channelId: externalId,
    title: ntfy ? turn.input.title ?? 'GoodVibes ntfy' : turn.input.title,
  });
  const providerMessageId = ntfy ? turn.input.messageId : turn.input.messageId;
  const submission = await deps.sessionBroker.submitMessage({
    routeId: binding.id,
    ...(providerMessageId ? { providerMessageId } : {}),
    surfaceKind,
    surfaceId: binding.surfaceId,
    externalId,
    threadId: externalId,
    ...(!ntfy && turn.input.userId ? { userId: turn.input.userId } : {}),
    displayName: ntfy ? 'ntfy' : turn.input.displayName ?? turn.input.userId ?? 'Home Assistant',
    title: binding.title ?? surfaceKind,
    body: turn.input.body,
    metadata: { [HELD_COMPANION_TURN_KEY]: turn },
  });
  if (submission.mode === 'rejected') return null;
  const waiting = await deps.sessionBroker.holdForCapacity(submission.session.id, submission.input.id);
  return waiting ? { sessionId: submission.session.id, inputId: submission.input.id, routeId: binding.id } : null;
}
