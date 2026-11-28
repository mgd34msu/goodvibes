/**
 * owner-channel-conversation.ts, whether one channel turn is the owner's own message.
 *
 * As released (v3.5.0), the owner's own message on a channel they set up is the owner's turn, in any conversation of that
 * channel (security/turn-input-party.ts `turnInputParty`: a stranger's or a guest's message always runs as a guest's); a
 * change it asks for is put to the owner as a channel request (gate/classify.ts `channel-request`: one call, nothing
 * remembered; held in Just vibes; refused in plan; asked in YOLO too).
 *
 * What this file answers is the narrower question a turn named by its session alone asks (a piece of work or an automatic
 * project a channel conversation caused): whether the whole session is the channel owner's own one-to-one conversation
 * (channels/own-messages-proof.ts: never ntfy, a webhook, a phone number, WhatsApp or a bridged iMessage; owner-alert.ts
 * `isOwnerConversation`), never a group, a shared channel or a thread. Read from the session and its channel route, never
 * from a message's words.
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
    .filter((kind): kind is NonNullable<typeof kind> => kind !== undefined && isChannelSurfaceKind(kind)));
  return channels.size === 1 ? [...channels][0] : undefined;
}

/**
 * The reader security/turn-input-party.ts asks (`setOwnerChannelConversationReader`). A channel whose owner is not yet
 * known (`ownerId` unset) has no owner's own message: the sender must be the channel's owner.
 */
export function createOwnerChannelConversationReader(deps: OwnerChannelConversationDeps): (turn: TurnContext) => boolean {
  return (turn) => {
    // A turn named by its session alone (a piece of work a channel conversation caused): the channel is that session's
    // one channel; a session on none, or on more than one, is nobody's alone.
    const named = turn.surface ?? channelOfSession(deps, turn.sessionId ?? turn.ownerSessionId);
    if (named === undefined) return false;
    const surface = normalizeSurfaceId(named);
    if (!isChannelSurfaceKind(surface)) return false;
    // A kind whose sender nothing proves is never the owner's own message.
    if (!ownMessagesQualifies(surface)) return false;
    const policy = deps.channelPolicy.getPolicy(surface as ChannelSurface);
    // A turn whose sender the channel named is the owner's only when that sender is the channel's owner.
    const actor = turn.actor?.agentFor ?? turn.actor;
    if (actor !== undefined && (actor.class !== 'owner' || (policy.ownerId !== undefined && actor.id !== `channel:${surface}:${policy.ownerId}`))) return false;
    const sessionId = turn.sessionId ?? turn.ownerSessionId;
    const session = sessionId ? deps.sessions.getSession(sessionId) : undefined;
    if (!session) return false;
    const bindings = session.routeIds.map((id) => deps.routeBindings.getBinding(id)).filter((binding): binding is AutomationRouteBinding => binding !== undefined && binding.surfaceKind === surface);
    // Every route of the session on this channel must be the owner's alone: a session that also carries a group is not.
    return bindings.length > 0 && bindings.every((binding) => isOwnersAloneConversation(binding, policy.ownerId));
  };
}
