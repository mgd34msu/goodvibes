/**
 * channel-profiles/intake.ts
 *
 * The bridge channel intake calls when it turns an inbound message into a
 * session: it resolves WHO the sender is (a named principal, via the principal
 * registry) and WHICH profile the originating channel binds (model/permission
 * defaults, via the channel-profile registry), and packages both into the two
 * things the origination path needs: session metadata (attribution) and the
 * permission posture. The model/provider are read from the registry again at
 * spawn time (see `channelProfileForSession`), so a profile change reaches the
 * next turn without a copy on every message.
 *
 * These are pure functions over the two registries so intake adopts them with a
 * single call before submitMessage/trySpawnAgent, without the SharedSessionBroker
 * needing to know about principals or channel profiles.
 */
import { ownerPrincipal, type PrincipalRegistry, type PrincipalResolution } from '../principals/index.js';
import type { ChannelProfileRegistry } from './registry.js';
import type { ChannelPermissionMode, ChannelProfileDefaults } from './types.js';
import type { ChannelPolicyManager } from '../channels/policy-manager.js';
import type { ChannelSurface } from '../channels/types.js';

/** Stable session-metadata keys the attribution stamps. */
export const ATTRIBUTED_PRINCIPAL_ID_KEY = 'attributedPrincipalId';
export const ATTRIBUTED_PRINCIPAL_NAME_KEY = 'attributedPrincipalName';
export const ATTRIBUTED_PRINCIPAL_KNOWN_KEY = 'attributedPrincipalKnown';

export interface InboundSender {
  /** The surface the message arrived on (e.g. 'slack'), used as the identity channel. */
  readonly surfaceKind: string;
  /** The sender's channel-specific id (a Slack user id, an address, a number). */
  readonly userId?: string | undefined;
  /** The channel/account within the surface, to scope the profile binding. */
  readonly channelId?: string | undefined;
}

/**
 * Resolve the sending principal for an inbound message and produce the session
 * metadata that attributes the originated session to it. An absent userId or an
 * unmapped identity attributes to the honest unknown principal (known:false),
 * never a guess.
 *
 * `channelPolicy`, when supplied, is the one exception to "never a guess": a
 * sender who is not in the named-principal registry but whom the channel's OWN
 * ingress policy already authorized as its owner (the per-surface allowlist
 * self-seeded from whoever pairs the channel first, see
 * `ChannelPolicyManager.evaluateIngress`) is attributed to the honest OWNER
 * principal, not the unknown one. Channel policy already decided this sender is
 * the owner in order to let the message through at all; attribution repeating
 * "unknown" for the person the platform just finished authorizing would be
 * dishonest, not cautious.
 */
export async function attributeInboundSession(
  principals: Pick<PrincipalRegistry, 'resolveByIdentity'>,
  sender: InboundSender,
  channelPolicy?: Pick<ChannelPolicyManager, 'getPolicy'> | undefined,
): Promise<{ readonly metadata: Record<string, unknown>; readonly resolution: PrincipalResolution | null }> {
  const value = sender.userId?.trim();
  if (!value) {
    return {
      metadata: { [ATTRIBUTED_PRINCIPAL_KNOWN_KEY]: false },
      resolution: null,
    };
  }
  const resolution = await principals.resolveByIdentity({ channel: sender.surfaceKind, value });
  if (!resolution.known && channelPolicy) {
    const policy = channelPolicy.getPolicy(sender.surfaceKind as ChannelSurface);
    if (policy.allowlistUserIds.includes(value)) {
      const owner = ownerPrincipal({ channel: sender.surfaceKind, value });
      const ownerResolution: PrincipalResolution = { principal: owner, known: true };
      return {
        metadata: {
          [ATTRIBUTED_PRINCIPAL_ID_KEY]: owner.id,
          [ATTRIBUTED_PRINCIPAL_NAME_KEY]: owner.name,
          [ATTRIBUTED_PRINCIPAL_KNOWN_KEY]: true,
        },
        resolution: ownerResolution,
      };
    }
  }
  return {
    metadata: {
      [ATTRIBUTED_PRINCIPAL_ID_KEY]: resolution.principal.id,
      [ATTRIBUTED_PRINCIPAL_NAME_KEY]: resolution.principal.name,
      [ATTRIBUTED_PRINCIPAL_KNOWN_KEY]: resolution.known,
    },
    resolution,
  };
}

/** Resolve the profile the originating channel binds, or null when none applies. */
export async function resolveOriginationProfile(
  channelProfiles: Pick<ChannelProfileRegistry, 'resolve'>,
  sender: Pick<InboundSender, 'surfaceKind' | 'channelId'>,
): Promise<ChannelProfileDefaults | null> {
  return channelProfiles.resolve(sender.surfaceKind, sender.channelId);
}

/**
 * Merge a channel profile's model/provider into a spawn input WITHOUT overriding
 * a model the caller already chose: a channel default fills a gap, it never
 * overrules an intent the intake path expressed. Model and provider travel
 * together: the profile's provider is applied only with the profile's model,
 * because a provider without a model is refused by agent routing and a profile
 * provider beside a caller's model could contradict it. Returns a new object.
 */
export function applyChannelProfileToSpawn<T extends { model?: string | undefined; provider?: string | undefined }>(
  spawnInput: T,
  defaults: ChannelProfileDefaults | null | undefined,
): T {
  if (!defaults || defaults.model === undefined || spawnInput.model !== undefined) return spawnInput;
  return {
    ...spawnInput,
    model: defaults.model,
    ...(spawnInput.provider === undefined && defaults.provider !== undefined ? { provider: defaults.provider } : {}),
  };
}

/** The complete enrichment for one inbound message: attribution + profile + posture. */
export interface InboundIntakeEnrichment {
  readonly sessionMetadata: Record<string, unknown>;
  readonly spawnOverrides: { readonly model?: string; readonly provider?: string };
  readonly permissionMode?: ChannelPermissionMode | undefined;
  readonly principal: PrincipalResolution | null;
}

/**
 * One call intake makes to enrich an origination: resolves the sending principal
 * and the channel's bound profile, returning the session metadata to stamp, the
 * spawn model/provider overrides to apply, and the permission posture to set.
 */
export async function buildInboundIntakeEnrichment(
  deps: {
    readonly principals: Pick<PrincipalRegistry, 'resolveByIdentity'>;
    readonly channelProfiles: Pick<ChannelProfileRegistry, 'resolve'>;
    readonly channelPolicy?: Pick<ChannelPolicyManager, 'getPolicy'> | undefined;
  },
  sender: InboundSender,
): Promise<InboundIntakeEnrichment> {
  const [attribution, profile] = await Promise.all([
    attributeInboundSession(deps.principals, sender, deps.channelPolicy),
    resolveOriginationProfile(deps.channelProfiles, sender),
  ]);
  return {
    sessionMetadata: attribution.metadata,
    spawnOverrides: {
      ...(profile?.model !== undefined ? { model: profile.model } : {}),
      ...(profile?.provider !== undefined ? { provider: profile.provider } : {}),
    },
    ...(profile?.permissionMode !== undefined ? { permissionMode: profile.permissionMode } : {}),
    principal: attribution.resolution,
  };
}
