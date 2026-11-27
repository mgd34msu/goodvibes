/**
 * own-messages-proof.ts, the channel kinds "Treat my own messages here as me" (channels/types.ts `ownMessagesAsOwner`)
 * exists for: a kind whose messages carry a sender the channel itself authenticates (never a name the message or a
 * caller writes), and where a conversation can be proven the owner's alone (the channel says a message is a direct
 * message, never a group, a channel or a thread). Any other kind never offers the switch, refuses it when it is
 * turned on through any door, and ignores it when a policy file holds it anyway (daemon/owner-channel-conversation.ts).
 *
 * One table, read by the channel route that writes the switch (every door: the capability, the method, the REST route),
 * by the reader that applies it, and by the capability's own words.
 */
import type { ChannelSurface } from './types.js';

/** What proves a channel's sender and conversation, and whether that is enough for the switch. */
export interface OwnMessagesProof {
  readonly qualifies: boolean;
  /** What proves who sent a message, in words (or why nothing does). */
  readonly sender: string;
  /** What proves the conversation is the owner's alone, in words (or why nothing does). */
  readonly alone: string;
}

/** Every channel kind, exhaustive by type: a kind added to ChannelSurface fails to compile here until it is judged. */
export const OWN_MESSAGES_PROOF: Readonly<Record<ChannelSurface, OwnMessagesProof>> = {
  slack: { qualifies: true, sender: 'the user id Slack puts on an event whose request Slack signed with the app\'s signing secret', alone: 'Slack marks a direct message (an im channel)' },
  discord: { qualifies: true, sender: 'the user id Discord puts on a message its gateway delivers to the bot, or on an interaction Discord signed', alone: 'Discord marks a direct message (no server, a DM channel)' },
  telegram: { qualifies: true, sender: 'the from id Telegram puts on an update the bot fetched with its own token (or that came with the webhook\'s secret)', alone: 'Telegram marks a private chat' },
  'google-chat': { qualifies: true, sender: 'the user Google puts on an event sent with the app\'s verification token', alone: 'Google Chat marks a direct-message space' },
  signal: { qualifies: true, sender: 'the number Signal\'s own protocol proves, as the owner\'s Signal bridge reports it', alone: 'a message with no group and no thread' },
  mattermost: { qualifies: true, sender: 'the user id the Mattermost server puts on a post the bot reads with its own token', alone: 'Mattermost marks a direct channel' },
  matrix: { qualifies: true, sender: 'the user id the homeserver authenticated for the event', alone: 'a room marked direct, with no thread' },
  msteams: { qualifies: true, sender: 'the Azure AD object id Microsoft puts on an activity, relayed with the relay\'s secret', alone: 'Teams marks a personal conversation' },
  bluebubbles: { qualifies: true, sender: 'the handle Apple\'s iMessage proves, as the owner\'s BlueBubbles server (with its password) reports it', alone: 'a chat that is not a group (BlueBubbles marks groups)' },
  homeassistant: { qualifies: true, sender: 'the Home Assistant user id the owner\'s Home Assistant puts on the call, sent with its webhook secret', alone: 'a conversation Home Assistant marks direct with that user (a voice pipeline that names no user never is)' },
  ntfy: { qualifies: false, sender: 'nothing: an ntfy message carries no sender, and anyone who knows the topic can publish to it', alone: 'nothing: a topic is a shared channel' },
  webhook: { qualifies: false, sender: 'nothing: the caller describes itself (its user id and conversation kind are whatever it sent)', alone: 'nothing: the caller says what kind of conversation it is' },
  telephony: { qualifies: false, sender: 'nothing that cannot be faked: a text\'s or a call\'s number can be spoofed', alone: 'a phone number is not proof of who holds the phone' },
  whatsapp: { qualifies: false, sender: 'the number WhatsApp reports', alone: 'nothing: every message is read as direct, a bridged group\'s messages included, so a conversation cannot be proven the owner\'s alone' },
  imessage: { qualifies: false, sender: 'nothing proven: the bridge reports the chat, not the person who wrote in it', alone: 'nothing: a group chat is read as direct' },
  tui: { qualifies: false, sender: 'not a channel: the terminal app is the owner\'s own program', alone: 'not a channel' },
  web: { qualifies: false, sender: 'not a channel: the web UI signs in with the owner\'s own credential', alone: 'not a channel' },
};

/** The channel kinds the switch exists for (a place offers it only on their rows). */
export const OWN_MESSAGES_CHANNELS: readonly string[] = Object.entries(OWN_MESSAGES_PROOF)
  .filter(([, proof]) => proof.qualifies).map(([surface]) => surface);

/** Whether "Treat my own messages here as me" exists for this channel kind. */
export function ownMessagesQualifies(surface: string): boolean {
  return Object.hasOwn(OWN_MESSAGES_PROOF, surface) && OWN_MESSAGES_PROOF[surface as ChannelSurface].qualifies;
}

/** Why the switch does not exist for this channel kind, in words; undefined when it does. */
export function ownMessagesRefusal(surface: string): string | undefined {
  if (ownMessagesQualifies(surface)) return undefined;
  const proof = Object.hasOwn(OWN_MESSAGES_PROOF, surface) ? OWN_MESSAGES_PROOF[surface as ChannelSurface] : undefined;
  return proof
    ? `"Treat my own messages here as me" does not exist for ${surface}: what proves the sender is ${proof.sender}; what proves the conversation is yours alone is ${proof.alone}`
    : `"Treat my own messages here as me" does not exist for ${surface}: it is not a channel this daemon knows`;
}
