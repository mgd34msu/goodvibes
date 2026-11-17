/**
 * The profile `channels.routing.assign` gave a channel, applied to an agent the
 * daemon starts for a message from that channel.
 *
 * The routing table (channels/host-routing) owns which profile a channel is
 * answered as; the profile store (profiles/manager.ts) owns what that profile
 * says. Nothing is copied: both are read when an agent starts, so a changed
 * assignment or profile reaches the next message. A channel profile's own
 * model (channel-profiles) is applied first and wins; an assigned profile fills
 * only what the caller and the channel profile left unset.
 *
 * Cost: one in-memory routing lookup per channel spawn, and one profile file
 * read when an assignment applies.
 */
import type { ProfileManager } from '../profiles/manager.js';
import type { SharedSessionRecord } from '../control-plane/session-types.js';
import { isChannelSurfaceKind } from '../../events/surfaces.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** The routing table's resolver: exact (surface and conversation), then surface, then `any`. */
export type ChannelProfileIdResolver = (surfaceKind: string, routeId?: string) => string | null;

/** What an assigned profile sets on a spawn. */
export interface AssignedChannelProfile {
  readonly profileId: string;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/**
 * The profile assigned to the channel `session` came from, or null when the
 * session is not from a channel, nothing is assigned, or the profile cannot be
 * read (logged, so the owner can see why the default model answered).
 */
export function assignedChannelProfile(
  deps: { readonly resolveProfileId?: ChannelProfileIdResolver | undefined; readonly profiles: Pick<ProfileManager, 'load'> },
  session: Pick<SharedSessionRecord, 'id' | 'participants'>,
): AssignedChannelProfile | null {
  const resolve = deps.resolveProfileId;
  if (!resolve) return null;
  const origin = session.participants.find((participant) => isChannelSurfaceKind(participant.surfaceKind));
  if (!origin) return null;
  let profileId: string | null;
  try {
    profileId = resolve(origin.surfaceKind, origin.externalId);
  } catch (error) {
    logger.warn('Channel profile assignments could not be read; this agent starts on the default model', {
      sessionId: session.id, surface: origin.surfaceKind, error: summarizeError(error),
    });
    return null;
  }
  if (!profileId) return null;
  try {
    const provider = deps.profiles.load(profileId).data.provider;
    return {
      profileId,
      ...(typeof provider?.model === 'string' && provider.model.trim() ? { model: provider.model.trim() } : {}),
      ...(typeof provider?.reasoningEffort === 'string' && provider.reasoningEffort.trim() ? { reasoningEffort: provider.reasoningEffort.trim() } : {}),
    };
  } catch (error) {
    logger.warn('The profile assigned to this channel could not be read; this agent starts on the default model', {
      sessionId: session.id, surface: origin.surfaceKind, profileId, error: summarizeError(error),
      action: 'save the profile under this name, or assign the channel another profile',
    });
    return null;
  }
}

/** Whether a spawn has left its model open, so an assigned profile may fill it. */
export function spawnModelOpen(spawnInput: { readonly model?: string | undefined; readonly provider?: string | undefined }): boolean {
  return spawnInput.model === undefined && spawnInput.provider === undefined;
}

/**
 * Fill a spawn's model, and with it the profile's reasoning effort, from an
 * assigned profile, never overruling what the caller or the channel profile
 * chose. A profile model is provider-qualified, so it is applied only when no
 * provider was chosen either; the effort belongs to that model, so it comes
 * only with it.
 */
export function applyAssignedChannelProfile<T extends { model?: string | undefined; provider?: string | undefined; reasoningEffort?: string | undefined }>(
  spawnInput: T,
  assigned: AssignedChannelProfile | null,
): T {
  if (!assigned || assigned.model === undefined || !spawnModelOpen(spawnInput)) return spawnInput;
  return {
    ...spawnInput,
    model: assigned.model,
    ...(assigned.reasoningEffort !== undefined && spawnInput.reasoningEffort === undefined ? { reasoningEffort: assigned.reasoningEffort } : {}),
  };
}
