/**
 * entry-policy.ts, where card details may be TYPED, which is a different
 * question from where a purchase may be APPROVED.
 *
 * ══ Attribution, stated precisely ═════════════════════════════════════════
 *
 * Owner rulings and coordinator decisions are different weights. An earlier
 * version of this file collapsed them and relayed a coordinator decision as an
 * owner ruling; the correction is kept visible rather than tidied away.
 *
 * OWNER, verbatim, on the TUI and the agent:
 *
 *   "i need to be able to enter payment details (card info and shipping/billing
 *    address etc) in the tui too"
 *   "and in the agent - basically ui should expose it in both."
 *
 * OWNER, verbatim, on the webui, asked directly after the above, given a
 * two-option choice with the exposure stated (PAN on a browser page, form
 * autofill, password managers, browser history, XSS in our own UI). The owner
 * selected the option labelled:
 *
 *   "Card entry in webui too"
 *
 * and then wrote:
 *
 *   "so is the webui getting card input? i said yes..."
 *
 * The option the owner selected carried the browser-side conditions in
 * `WEBUI_CARD_ENTRY_CONDITIONS` below. Those conditions are part of what the
 * owner chose, not a gloss added afterwards.
 *
 * COORDINATOR ruling, that card details are refused on remote messaging
 * surfaces, with the reasoning below. Recorded as the coordinator's because no
 * verbatim owner wording exists for it.
 *
 * ══ The two axes look alike and must never be merged ══════════════════════
 *
 * A later reader will notice two channel classifications here and try to unify
 * them. They answer different questions:
 *
 *   ANSWERING , may this surface say yes or no to a purchase?
 *                YES for Telegram and every other live channel. That IS the
 *                owner's explicit ruling and it stays. See types.ts,
 *                `CommandAuthorityChannel`.
 *
 *   ENTERING  , may card details be typed into this surface?
 *                The TUI, the agent's own terminal, and the webui. Not any
 *                remote messaging surface.
 *
 * Remote channels have authority to decide about a purchase. They have no path
 * for entering the instrument.
 *
 * ══ Why entering is stricter than answering ═══════════════════════════════
 *
 * A card number typed into Telegram is stored on Telegram's servers, in message
 * history nobody here controls or can erase, and it travelled through their
 * infrastructure before it ever reached us. The same is true of every hosted
 * chat channel.
 *
 * Encryption at rest is irrelevant to a value that was already copied somewhere
 * else on its way in. That is the whole argument: the damage is done before any
 * storage decision of ours applies.
 *
 * An "approve" typed into Telegram carries no such residue, it is one word
 * about one purchase, it expires, and it authorizes nothing on its own.
 *
 * ══ The prompt is itself the harm ═════════════════════════════════════════
 *
 * There is deliberately no card-entry flow that can be STARTED from a
 * non-entry surface. Prompting for a card number where the answer cannot be
 * accepted is an invitation to type it there, and the invitation is what puts
 * the number on someone else's server. Refusing the answer afterwards is too
 * late.
 */
import { TRANSPORT_SURFACE_KINDS } from '../../events/surfaces.js';

/**
 * Surfaces where card details may be typed.
 *
 * The webui is here by the owner's direct ruling, and it arrives with
 * conditions the other two do not carry, see `WEBUI_CARD_ENTRY_CONDITIONS`.
 * A browser is more exposed than a terminal, which is exactly why they came
 * attached to the ruling rather than after it.
 */
export type CardEntrySurface = 'tui' | 'agent-terminal' | 'webui';

const CARD_ENTRY_SURFACES: readonly string[] = ['tui', 'agent-terminal', 'webui'];

/**
 * The conditions the owner attached to webui card entry.
 *
 * Exported so a surface cannot quietly implement a weaker version, and so a
 * reviewer has the list without going back to a transcript. Each is a
 * requirement with a test, not a recommendation.
 *
 * They exist because a browser adds attack surface a terminal does not: a URL
 * reaches history, referrers and server logs; a rendered response reaches the
 * DOM and anything reading it; a password manager copies the value somewhere
 * this system does not control; and state that survives navigation survives
 * longer than the submit that needed it.
 */
export const WEBUI_CARD_ENTRY_CONDITIONS: readonly string[] = [
  'Card fields are posted over the authenticated daemon channel, the same path as any other secret.',
  'Card values never appear in a URL, not a query parameter, not a fragment, not a path segment.',
  'Card values are never rendered back after entry: no response returns them and no field is repopulated from the server.',
  'Every card field carries autocomplete="off".',
  'Card fields must not present as ones a password manager offers to save.',
  'No card value is retained in DOM state, cleared from component state after submit, never left in a store, a form-library cache, or state that survives navigation.',
];

/**
 * Route surfaces that are GoodVibes' own HTTP and service routes rather than a
 * messaging service with servers of its own; a refusal does not name them.
 */
const OWN_ROUTE_SURFACES: readonly string[] = ['web', 'service'];

/**
 * May card details be typed on this surface?
 *
 * An ALLOWLIST, deliberately. A denylist ships every channel added after it was
 * written, and the direction to fail for card material is closed.
 */
export function mayEnterCardDetails(surface: string): boolean {
  return CARD_ENTRY_SURFACES.includes(surface.trim().toLowerCase());
}

/**
 * Is this a remote messaging surface, named so a refusal can say which one it
 * refused? Every route surface (TRANSPORT_SURFACE_KINDS) that is neither a card
 * entry surface nor one of GoodVibes' own routes. A courtesy for the message,
 * not the defence: `mayEnterCardDetails` allows only the entry surfaces.
 */
export function isRemoteMessageSurface(surface: string): boolean {
  const kind = surface.trim().toLowerCase();
  return (TRANSPORT_SURFACE_KINDS as readonly string[]).includes(kind) && !CARD_ENTRY_SURFACES.includes(kind) && !OWN_ROUTE_SURFACES.includes(kind);
}

/**
 * The reply the owner gets when card details arrive somewhere they cannot be accepted.
 *
 * Built from the surface name and the matched SHAPES only. It never quotes,
 * echoes, partially masks or summarizes the value it just refused, a masked
 * echo is still an echo, and the message it appears in is stored on the same
 * server the refusal is about.
 */
export function describeCardEntryRefusal(surface: string): string {
  const where = isRemoteMessageSurface(surface) ? surface : 'this channel';
  return [
    `I can't take card details over ${where}, so I have not stored anything from that message.`,
    `Anything typed here is kept on ${where}'s servers, in history I can't reach or delete,`,
    'and it passed through their systems before it ever got to me, encrypting it on my end afterwards',
    'would not undo that.',
    '',
    'Enter the card at a terminal instead: the TUI, the agent terminal, or the web UI.',
    '',
    'Please also delete the message you just sent, and if that was a real card number, treat it as exposed.',
  ].join(' ').replace(/ {2,}/g, ' ');
}

/**
 * May a card-entry FLOW be offered here?
 *
 * Separate from `evaluateCardEntry` because the prompt is the harm: a surface
 * that cannot accept the answer must never ask the question.
 */
export function mayOfferCardEntryFlow(surface: string): boolean {
  return mayEnterCardDetails(surface);
}

/** How a request reached the daemon (runtime/network/request-transport.ts `RequestTransport`). */
export type CardEntryTransport = 'loopback' | 'tls' | 'tailnet' | 'plain-network';

/** The links a card number or security code may cross: this machine, TLS, or the tailnet's own encryption. */
export function mayCrossWithCardDetails(transport: CardEntryTransport | undefined): boolean {
  return transport === 'loopback' || transport === 'tls' || transport === 'tailnet';
}

/**
 * Why a card or its security code is not taken over this connection, and
 * where it can be: the daemon refuses `card.enter` over a plain network (or a
 * request whose route it cannot name), and the web UI shows the same words
 * instead of the form.
 */
export function describeCardTransportRefusal(): string {
  return 'Card details are not taken over this connection: it reaches the daemon unencrypted over the network, '
    + 'so the card number would cross it in the clear. Nothing was sent or stored. '
    + 'Enter the card on the daemon\'s own machine (the terminal app, the Agent, or the web UI at localhost), '
    + 'over https (controlPlane.tls), or over the machine\'s Tailscale address.';
}
