/**
 * secure-address-words.ts, the words of the "Secure address" screen, defined
 * once: the web UI receives them in `secureAddress.get`, the terminal programs
 * show them as the settings' own descriptions (config/schema-domain-secure-address.ts).
 * Pure data: no imports, safe in the browser.
 *
 * Each choice says what it does, what it needs from the person, what the
 * phone gains, and what is sent where, so nothing is left to guess.
 */

/** Let's Encrypt's production ACME directory, the default of `secureAddress.acmeDirectory`. */
export const LETS_ENCRYPT_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory';

export type SecureAddressChoiceId = 'lets-encrypt' | 'own-files' | 'tailscale' | 'local-authority';

export interface SecureAddressChoiceWords {
  readonly id: SecureAddressChoiceId;
  readonly title: string;
  readonly does: string;
  readonly needs: string;
  readonly phoneGains: string;
  readonly sends: string;
  /** Anything else the person must know before choosing it (public logs, routers, untried on a phone). */
  readonly caution?: string | undefined;
  /** What differs on a machine that leads a group (its certificate is shared with the group's machines). */
  readonly onLead?: { readonly does?: string | undefined; readonly sends: string } | undefined;
}

/**
 * A certificate's end date as every Secure address screen and message writes
 * it: the local date, month in words ("February 22, 2027"). The web UI, the
 * terminal programs and the daemon's own words use this same form.
 */
export function secureAddressDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export const SECURE_ADDRESS_INTRO =
  'A phone that opens GoodVibes over plain http on your network gets the chat and little else: browsers keep the microphone, push notifications, installing the app, the camera and passkeys for https addresses. Pick one way to give GoodVibes an https address. The plain http address keeps working exactly as it does now, whichever you pick.';

export const SECURE_ADDRESS_CHOICES: readonly SecureAddressChoiceWords[] = [
  {
    id: 'lets-encrypt',
    title: 'A certificate for a domain you own (Let\'s Encrypt)',
    does: 'GoodVibes gets a free certificate from Let\'s Encrypt for a name under a domain you own (for example gv.example.com, and every name under it for the machines of your group) and renews it by itself about a month before it ends. It writes two kinds of DNS record through your DNS provider\'s API: a short-lived proof record (_acme-challenge.<name>, removed once Let\'s Encrypt has checked it) and an address record pointing the name at this computer\'s address on your network, corrected when that address changes. Phones then open https://<name>:<port>.',
    needs: 'The name, and an API token from your DNS provider (Cloudflare: a token with the permission Zone, DNS, Edit on the zone that holds the name), unless one is already stored. Nothing else: no account to make, no email, nothing to install on any phone. Choosing it agrees to Let\'s Encrypt\'s subscriber agreement.',
    phoneGains: 'Every phone, tablet and computer trusts the address at once: microphone, push notifications, installing the app, camera and passkeys all work, with nothing installed on the phone.',
    sends: 'To Let\'s Encrypt: the name and the public half of keys made on this computer (the private keys never leave it). To your DNS provider: the name, the proof value (a digest, no secret) and this computer\'s local network address, which becomes readable by anyone who looks the name up. Nothing goes to GoodVibes.',
    caution: 'Let\'s Encrypt publishes the name of every certificate it issues in public logs (Certificate Transparency) that anyone can search, so pick a name that says nothing about you or your home. Some home routers refuse DNS answers that point at a local address (DNS rebinding protection); GoodVibes looks the name up from this computer after writing it and tells you if that happens, and what to change on the router.',
    onLead: {
      sends: 'To Let\'s Encrypt: the name and the public half of keys made on this computer. To your DNS provider: the name, the proof value (a digest, no secret) and the local network address of this computer and of each machine in the group, which become readable by anyone who looks the names up. Because this computer leads a group, the certificate and its key are sent, sealed, to each machine in the group, so they serve the same certificate; they go nowhere else. Nothing goes to GoodVibes.',
    },
  },
  {
    id: 'own-files',
    title: 'A certificate you made',
    does: 'GoodVibes serves https with a certificate and key you already have (from your own certificate authority, a company one, or another ACME client). It checks them when you give them (the key must belong to the certificate; which names it covers; when it ends), reads the files again when they change, and tells you once, a fortnight before the certificate ends. It never renews it: that stays yours.',
    needs: 'The paths of two files on this computer: the certificate (with its chain) and its private key, unencrypted. The names it covers must be the names phones open.',
    phoneGains: 'The same as any https address, on every device that trusts whoever signed your certificate. A device that does not trust the signer shows a certificate warning.',
    sends: 'Nothing leaves this computer: the files are read here and used here.',
    onLead: {
      sends: 'The files are read here. Because this computer leads a group, the certificate and its key are sent, sealed, to each machine in the group that the certificate covers, so that machine serves the same certificate; they go nowhere else.',
    },
  },
  {
    id: 'tailscale',
    title: 'Tailscale',
    does: 'Tailscale serves this computer at its https name on your tailnet (https://<machine>.<tailnet>.ts.net) with a certificate Tailscale obtains, and forwards to GoodVibes. It is set up per machine and is not shared with the machines of a group.',
    needs: 'Tailscale installed and signed in on this computer and on each phone, and HTTPS turned on for your tailnet in the Tailscale admin page.',
    phoneGains: 'Everything an https address gives, on every phone signed in to your tailnet, from anywhere, not only at home.',
    sends: 'Tailscale\'s coordination servers learn this machine\'s tailnet name (the certificate for it is issued by Let\'s Encrypt and appears in its public logs under your tailnet\'s name); your traffic goes between your devices, encrypted by Tailscale.',
  },
  {
    id: 'local-authority',
    title: 'GoodVibes\' own certificate (no domain needed)',
    does: 'GoodVibes makes a certificate authority on this computer that can only vouch for this computer\'s own names and private network addresses, and serves https with a certificate it signs. It is made again at each start for the addresses the computer has then.',
    needs: 'On each phone, once: open the page /lan-https on this computer\'s plain address and install the GoodVibes certificate (the page says how on iPhone and Android, and how to remove it).',
    phoneGains: 'Everything an https address gives, on each phone that installed the certificate; a phone that did not shows a certificate warning.',
    sends: 'Nothing leaves this computer.',
    caution: 'Installing a certificate on a phone is the one step it needs, and it has not been tried yet on a real iPhone or Android phone.',
    onLead: {
      does: 'GoodVibes makes a certificate authority on this computer and serves https with a certificate it signs. Because this computer leads a group, that certificate covers the names and private network addresses of every machine in the group as well as this computer\'s own, so a phone that installed the authority once trusts them all. It is made again at each start for the addresses the machines have then, lasts 90 days and is renewed by itself a month before it ends, and a new one with a new key is made at once when a machine leaves the group or is removed.',
      sends: 'Because this computer leads a group, the certificate and its key are sent, sealed, to each machine in the group, so they serve the same certificate, with the authority\'s public certificate, so the page /lan-https on each of them offers phones this same authority; the certificate authority\'s own key never leaves this computer.',
    },
  },
];

/** The four ways as a machine shows them: on the lead of a group, what differs there (what it covers, what is sent where). */
export function secureAddressChoicesFor(leadsGroup: boolean): readonly SecureAddressChoiceWords[] {
  return SECURE_ADDRESS_CHOICES.map(({ onLead, ...choice }) => (leadsGroup && onLead
    ? { ...choice, does: onLead.does ?? choice.does, sends: onLead.sends }
    : choice));
}

/** The line every group screen shows: one certificate for the whole group. */
export const SECURE_ADDRESS_GROUP_LINE = 'Every machine in this group serves with the same certificate.';

/** What the lead's screen says when the group's nodes follow it. */
export const SECURE_ADDRESS_LEAD_LINE = 'The machines that joined this computer\'s group follow whatever is set up here: they get their https address from this computer.';

/** The lead's one action for a new certificate, and its one line (the web UI, the terminal app and the Agent show both). */
export const SECURE_ADDRESS_REISSUE_TITLE = 'Issue a new certificate now';
/**
 * The reissue action's one line, as true where it is shown: the group's
 * machines are named only on a machine that leads a group, and Let's Encrypt's
 * weekly limit only while Let's Encrypt is the certificate in force.
 */
export function secureAddressReissueLine(leadsGroup: boolean, certificate: 'local-authority' | 'own-files' | 'lets-encrypt'): string {
  // `leadsGroup`: machines follow this computer now (none following, there is no group's machine to name).
  const scope = leadsGroup ? ', for this computer and the machines of its group' : '';
  return certificate === 'lets-encrypt'
    ? `Gets a new certificate from Let's Encrypt with a new key at once${scope}; Let's Encrypt allows only five for the same name a week, so use it when a key may have been seen by someone else.`
    : `Makes a new certificate with a new key at once${scope}, signed by GoodVibes' own certificate authority, so phones that installed it trust the new one as before; use it when a key may have been seen by someone else.`;
}

/** What a member's screen says; `<lead>` is the lead's name. */
export function secureAddressNodeLine(lead: string): string {
  return `This machine is a member of ${lead}: its secure address comes from there.`;
}

/** The lead's action that ends a removed machine's trust on phones now, and its one line. */
export const SECURE_ADDRESS_REPLACE_AUTHORITY_TITLE = 'Replace the authority';
export const SECURE_ADDRESS_REPLACE_AUTHORITY_LINE =
  'Makes a new GoodVibes certificate authority and a new certificate signed by it, here and on every machine that follows this one. Every phone must then remove the old GoodVibes certificate and install the new one from the page /lan-https; until it does, it shows a warning for this address. Use it when a machine that left the group or was removed from it must stop being trusted now.';
/** The question it is put with (opening on No). */
export const SECURE_ADDRESS_REPLACE_AUTHORITY_QUESTION = 'Replace the authority? Every phone must remove the old GoodVibes certificate and install the new one.';

/**
 * What the lead's screen says of a machine that held the group's certificate and its key and stopped following (it
 * left, or was removed): until when it can present that certificate to a phone, and what the person can do, for each
 * kind of certificate. Dates as every Secure address screen writes them.
 */
export function secureAddressFormerHolderLine(holder: { readonly name: string; readonly at: number; readonly until: number; readonly source: 'local-authority' | 'own-files' | 'lets-encrypt' }): string {
  const gone = `${holder.name} stopped following this computer on ${secureAddressDate(holder.at)} (it left the group or was removed) and still holds the certificate it was given, with its key.`;
  if (holder.source === 'local-authority') {
    return `${gone} A phone that installed GoodVibes' own certificate from this computer trusts that copy until ${secureAddressDate(holder.until)}. This computer now serves a new certificate with a new key. To end that trust now, replace the authority (below): every phone then removes the old GoodVibes certificate and installs the new one.`;
  }
  if (holder.source === 'lets-encrypt') {
    return `${gone} It is a Let's Encrypt certificate for your name and every name under it, valid until ${secureAddressDate(holder.until)}: until then any phone trusts it for those names wherever it is presented, and GoodVibes does not revoke it. This computer got a new certificate with a new key from Let's Encrypt at once, and removed from your DNS the address it had written for ${holder.name}, so a phone no longer finds that machine under your name. That machine could still answer for your names on a network that sends them to it. To end that now, give this computer a different name here: its next certificate is for the new name, and the old copy is then good only for a name nothing uses.`;
  }
  return `${gone} It is a copy of the certificate you made, valid until ${secureAddressDate(holder.until)}, and GoodVibes cannot replace a certificate you made. To end it sooner, have whoever signed it revoke it, then give this computer a new certificate and key here.`;
}

/**
 * What the screen says when other machines are not served, so a phone cannot open the https address yet. `local`: the
 * daemon listens on this computer only; otherwise it listens on the network and answers this computer alone.
 */
export function secureAddressReachLine(local: boolean): string {
  return local
    ? 'Phones cannot open this address yet: this daemon listens only on this computer, so a phone on your network gets no answer at all. "Serve other machines" lets phones and your other machines reach it.'
    : 'Phones cannot open this address yet: this daemon answers only this computer, so a phone that opens it gets the certificate and then the refusal "This daemon serves only its own machine" (the page /lan-https is refused the same way). "Serve other machines" lets phones and your other machines reach it.';
}

/** The action that serves other machines, and its one line. */
export const SECURE_ADDRESS_SERVE_TITLE = 'Serve other machines';
export const SECURE_ADDRESS_SERVE_LINE = 'The daemon listens on your network and answers your other machines and phones, so phones can open the https address; each still needs its own pairing or sign-in.';

/** One choice's words as one paragraph, for a settings description. */
export function secureAddressChoiceParagraph(choice: SecureAddressChoiceWords): string {
  const lead = choice.onLead ? ` On a machine that leads a group: ${choice.onLead.does ? `${choice.onLead.does} ` : ''}Sent: ${choice.onLead.sends}` : '';
  return `${choice.title}: ${choice.does} Needs: ${choice.needs} The phone gains: ${choice.phoneGains} Sent: ${choice.sends}${choice.caution ? ` Before you choose: ${choice.caution}` : ''}${lead}`;
}
