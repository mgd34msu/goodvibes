/**
 * personal-capture/authority.ts
 *
 * Decides whether the turn now being answered may write to the owner's profile.
 *
 * ## Why this file exists
 *
 * The owner profile takes a write only from `owner-direct` authority
 * (owner-profile/trust.ts, layer 1). Every other authority, `web-page`,
 * `email`, `channel-message`, `document`, is refused by construction, because
 * text the owner did not write must never be able to edit what the system
 * believes about them.
 *
 * That rule is right, and it left a real gap: the owner talking to their own
 * assistant over their own Telegram bot is not a stranger, but the message
 * arrives on a channel, and "arrived on a channel" was the whole test. So the
 * owner pasted a flight itinerary, nothing was recorded, and when they asked
 * whether their trip was being tracked the honest answer was no.
 *
 * The fix is more precision, not a softer tier, which is the standing
 * instruction in security/untrusted-content.ts. The precision available is
 * WHICH channel: the owner has already named, in settings, the channels that
 * reach them privately. A message arriving on one of those is the owner. A
 * message arriving anywhere else is not, and is refused exactly as before.
 *
 * ## What counts as one of the owner's channels
 *
 * `profile.ownerChannels`, and nothing else. Empty means no channel counts as
 * the owner, as that setting's description says. `occasions.nudgeChannel` is
 * where reminders are sent, not a grant: a destination the owner chose for
 * outbound reminders says nothing about who else can write on it (a group the
 * bot sits in, a second allow-listed sender). A refusal names
 * `profile.ownerChannels`, the one setting that changes the answer.
 *
 * A turn with no channel at all is a local surface, the owner typed it
 * directly into the TUI, the agent or the web UI, and it carries their
 * authority directly.
 */
import { parseChannelDeliveryTarget } from '../channels/delivery/types.js';
import type { AuthoritySurface } from '../security/untrusted-content.js';
import type { ProfileSurface } from '../owner-profile/types.js';

/** Where the turn arrived from, as the shared-session record describes it. */
export interface CaptureChannelIdentity {
  /** The surface the message landed on, e.g. `telegram`. Absent ⇒ a local surface. */
  readonly surfaceKind?: string | undefined;
  /** The account/chat within that surface, when the record carries one. */
  readonly address?: string | undefined;
  /**
   * True when the turn came in over a configured route, i.e. it is a channel
   * turn whatever else the record says.
   *
   * Without this, a channel message that arrived with its `surfaceKind` missing
   * would be indistinguishable from the owner typing at their own keyboard, and
   * would be handed their authority by default. That is the wrong way for this to
   * fail: an absent surface on a routed turn means "I do not know where this
   * came from", and not knowing is a refusal.
   */
  readonly routed?: boolean | undefined;
  /**
   * The sender is admitted by the channel but is not its owner. Nothing they
   * say is the owner speaking, whatever `profile.ownerChannels` lists.
   */
  readonly guest?: boolean | undefined;
}

export interface CaptureAuthorityInput {
  readonly channel?: CaptureChannelIdentity | undefined;
  /** `profile.ownerChannels`, verbatim. Empty ⇒ no channel carries the owner's authority. */
  readonly ownerChannels?: string | undefined;
}

/** Which setting decided this, so a refusal can name the thing to change. */
export type CaptureAuthoritySource =
  | 'local-surface'
  | 'profile.ownerChannels'
  | 'unlisted-channel';

export interface CaptureAuthorityDecision {
  /** What to pass to the profile write gate. Only `owner-direct` is accepted by it. */
  readonly authority: AuthoritySurface;
  /** The provenance surface recorded against the line. */
  readonly surface: ProfileSurface;
  /** True when this turn may write. */
  readonly canCapture: boolean;
  readonly source: CaptureAuthoritySource;
  /** One plain sentence: why it may write, or why it may not and what to change. */
  readonly reason: string;
}

/**
 * Split a comma-separated channel list into targets. Same grammar as
 * `occasions.nudgeChannel`: `surfaceKind` or `surfaceKind:address`, so a value
 * copied from one setting to the other means the same thing in both.
 */
export function parseOwnerChannelList(
  value: string | undefined,
): readonly { readonly surfaceKind: string; readonly address: string }[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const target = parseChannelDeliveryTarget(entry);
      return {
        surfaceKind: String(target.surfaceKind).trim().toLowerCase(),
        address: (target.address ?? '').trim().toLowerCase(),
      };
    })
    .filter((target) => target.surfaceKind.length > 0);
}

/**
 * True when `channel` is named by `list`. An entry with no address matches
 * every address on that surface: `telegram` means "Telegram", not "Telegram
 * only when I happen to know the chat id".
 */
function listNames(
  list: readonly { readonly surfaceKind: string; readonly address: string }[],
  channel: CaptureChannelIdentity,
): boolean {
  const kind = (channel.surfaceKind ?? '').trim().toLowerCase();
  if (kind.length === 0) return false;
  const address = (channel.address ?? '').trim().toLowerCase();
  return list.some((target) => (
    target.surfaceKind === kind
    && (target.address.length === 0 || target.address === address)
  ));
}

/**
 * Resolve the authority for one conversational turn.
 *
 * Never throws and never guesses upward: anything it cannot place is
 * `channel-message`, which the profile write gate refuses.
 */
export function resolveCaptureAuthority(
  input: CaptureAuthorityInput,
): CaptureAuthorityDecision {
  const kind = (input.channel?.surfaceKind ?? '').trim();

  // A routed turn whose surface did not come through. Refused rather than
  // waved through as a local surface, see CaptureChannelIdentity.routed.
  if (kind.length === 0 && input.channel?.routed === true) {
    return {
      authority: 'channel-message',
      surface: 'agent',
      canCapture: false,
      source: 'unlisted-channel',
      reason: 'This message came in over a channel but did not say which one, so I cannot tell '
        + 'whether it is you. Nothing was recorded to your profile.',
    };
  }

  // No channel: the owner typed this directly on a surface they are sitting at.
  if (kind.length === 0) {
    return {
      authority: 'owner-direct',
      surface: 'agent',
      canCapture: true,
      source: 'local-surface',
      reason: 'This turn came from a surface you are using directly, so it carries your authority.',
    };
  }

  if (input.channel?.guest === true) {
    return {
      authority: 'channel-message',
      surface: 'agent',
      canCapture: false,
      source: 'unlisted-channel',
      reason: `This message came from someone on ${kind} who is not the channel's owner, so nothing was recorded to your profile.`,
    };
  }

  const declared = parseOwnerChannelList(input.ownerChannels);
  if (declared.length > 0) {
    if (listNames(declared, input.channel ?? {})) {
      return {
        authority: 'owner-direct',
        surface: 'agent',
        canCapture: true,
        source: 'profile.ownerChannels',
        reason: `${kind} is listed in profile.ownerChannels, so messages on it are treated as you speaking.`,
      };
    }
    return {
      authority: 'channel-message',
      surface: 'agent',
      canCapture: false,
      source: 'unlisted-channel',
      reason: `${kind} is not listed in profile.ownerChannels, so I cannot record anything to your profile from it. `
        + `Add ${kind} to profile.ownerChannels if messages there are from you.`,
    };
  }

  return {
    authority: 'channel-message',
    surface: 'agent',
    canCapture: false,
    source: 'unlisted-channel',
    reason: `I do not have ${kind} listed as one of your own channels, so I cannot record anything to your profile from it. `
      + `Add ${kind} to profile.ownerChannels if messages there are from you.`,
  };
}
