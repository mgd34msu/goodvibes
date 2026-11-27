/**
 * owner-channel-conversation.ts, "Treat my own messages here as me" read for one turn.
 *
 * A message on a chat channel is someone else's input (security/turn-input-party.ts), also when it comes from the
 * owner's own verified account: an account can be taken over, a phone left unlocked, a message forwarded. The owner may
 * turn that off for one channel (channels/types.ts `ownMessagesAsOwner`, off by default, set in Mail, calendar and
 * channels on the channel's row). It applies only to a conversation proven to be his alone: the channel's owner in a
 * one-to-one conversation with the assistant (owner-alert.ts `isOwnerConversation`, the same proof an owner alert and an
 * approval answer rest on), never a group, a shared channel or a thread. Home Assistant the same: its conversation is
 * his alone only when it came with Home Assistant's user id of the channel's owner and is direct (a voice pipeline that
 * names no user is never his alone).
 *
 * Read from the turn's session and that session's channel route, never from a message's words.
 */
import type { AutomationRouteBinding } from '../automation/routes.js';
import type { ChannelPolicyRecord, ChannelSurface } from '../channels/types.js';
import { isChannelSurfaceKind } from '../../events/surfaces.js';
import { normalizeSurfaceId } from '../gate/surface-authority.js';
import type { TurnContext } from '../security/turn-boundary.js';
import { isOwnerConversation } from './owner-alert.js';
import { ownMessagesQualifies } from '../channels/own-messages-proof.js';

export interface OwnerChannelConversationDeps {
  readonly sessions: { getSession(sessionId: string): { readonly routeIds: readonly string[] } | null | undefined };
  readonly routeBindings: { getBinding(bindingId: string): AutomationRouteBinding | undefined };
  readonly channelPolicy: { getPolicy(surface: ChannelSurface): ChannelPolicyRecord };
}

function metadataText(binding: AutomationRouteBinding, key: string): string | undefined {
  const value = (binding.metadata as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The conversation is the channel owner's alone (see the module header). Only on a channel kind whose sender the
 * channel itself authenticates and whose direct conversation it marks (channels/own-messages-proof.ts): ntfy (no
 * sender), a webhook (the caller describes itself) and the rest never are, whatever an owner alert's own reading says.
 */
export function isOwnersAloneConversation(binding: AutomationRouteBinding, owner: string | undefined): boolean {
  if (!ownMessagesQualifies(binding.surfaceKind)) return false;
  // A sender is needed: a conversation with no sender the channel named is nobody's alone.
  if (owner === undefined) return false;
  if (binding.surfaceKind === 'homeassistant') {
    return owner !== undefined && metadataText(binding, 'userId') === owner && metadataText(binding, 'conversationKind') === 'direct';
  }
  return isOwnerConversation(binding, owner);
}

/** The one channel a session's routes are on, or undefined (none, or more than one). */
function channelOfSession(deps: OwnerChannelConversationDeps, sessionId: string | null | undefined): string | undefined {
  const session = sessionId ? deps.sessions.getSession(sessionId) : undefined;
  if (!session) return undefined;
  const channels = new Set(session.routeIds.map((id) => deps.routeBindings.getBinding(id)?.surfaceKind)
    .filter((kind): kind is string => kind !== undefined && isChannelSurfaceKind(kind)));
  return channels.size === 1 ? [...channels][0] : undefined;
}

/** The reader security/turn-input-party.ts asks (`setOwnerChannelConversationReader`). */
export function createOwnerChannelConversationReader(deps: OwnerChannelConversationDeps): (turn: TurnContext) => boolean {
  return (turn) => {
    // A turn named by its session alone (a piece of work a channel conversation caused): the channel is that session's
    // one channel; a session on none, or on more than one, is nobody's alone.
    const named = turn.surface ?? channelOfSession(deps, turn.sessionId ?? turn.ownerSessionId);
    if (named === undefined) return false;
    const surface = normalizeSurfaceId(named);
    if (!isChannelSurfaceKind(surface)) return false;
    // A kind the switch does not exist for ignores it, even when a policy file holds it on.
    if (!ownMessagesQualifies(surface)) return false;
    const policy = deps.channelPolicy.getPolicy(surface as ChannelSurface);
    if (policy.ownMessagesAsOwner !== true) return false;
    // A turn whose sender the channel named is his only when that sender is the channel's owner.
    const actor = turn.actor?.agentFor ?? turn.actor;
    if (actor !== undefined && (actor.class !== 'owner' || (policy.ownerId !== undefined && actor.id !== `channel:${surface}:${policy.ownerId}`))) return false;
    const sessionId = turn.sessionId ?? turn.ownerSessionId;
    const session = sessionId ? deps.sessions.getSession(sessionId) : undefined;
    if (!session) return false;
    const bindings = session.routeIds.map((id) => deps.routeBindings.getBinding(id)).filter((binding): binding is AutomationRouteBinding => binding !== undefined && binding.surfaceKind === surface);
    // Every route of the session on this channel must be his alone: a session that also carries a group is not.
    return bindings.length > 0 && bindings.every((binding) => isOwnersAloneConversation(binding, policy.ownerId));
  };
}
