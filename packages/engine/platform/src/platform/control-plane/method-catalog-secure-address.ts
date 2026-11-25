/**
 * method-catalog-secure-address.ts, the "Secure address" screen's three verbs
 * (handlers: routes/secure-address.ts, registered by the daemon facade over
 * its https listener). Served through the generic
 * `/api/control-plane/methods/{id}/invoke` endpoint, like the Tailscale verbs.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import type { ContractErrorCode } from '../types/foundation-contract.js';
import { BOOLEAN_SCHEMA, NUMBER_SCHEMA, STRING_SCHEMA, arraySchema, methodDescriptor, objectSchema, stringEnumSchema } from './method-catalog-shared.js';

const SOURCE = stringEnumSchema(['local-authority', 'own-files', 'lets-encrypt']);
const STRINGS = arraySchema(STRING_SCHEMA);

const CHOICE_SCHEMA = objectSchema({
  id: stringEnumSchema(['lets-encrypt', 'own-files', 'tailscale', 'local-authority']),
  title: STRING_SCHEMA, does: STRING_SCHEMA, needs: STRING_SCHEMA, phoneGains: STRING_SCHEMA, sends: STRING_SCHEMA, caution: STRING_SCHEMA,
}, ['id', 'title', 'does', 'needs', 'phoneGains', 'sends']);

const STATUS_SCHEMA = objectSchema({
  notice: STRING_SCHEMA,
  intro: STRING_SCHEMA,
  choices: arraySchema(CHOICE_SCHEMA),
  groupLines: STRINGS,
  node: BOOLEAN_SCHEMA,
  inForce: objectSchema({
    on: BOOLEAN_SCHEMA, certificate: SOURCE, servedToNetwork: BOOLEAN_SCHEMA, serving: BOOLEAN_SCHEMA, port: NUMBER_SCHEMA,
    address: STRING_SCHEMA, names: STRINGS, notAfter: NUMBER_SCHEMA, problem: STRING_SCHEMA,
    from: stringEnumSchema(['this-machine', 'group']), servedSource: SOURCE, reach: STRING_SCHEMA,
  }, ['on', 'certificate', 'servedToNetwork', 'serving']),
  letsEncrypt: objectSchema({
    domain: STRING_SCHEMA, tokenStored: BOOLEAN_SCHEMA, tokenUnreadable: STRING_SCHEMA, issuing: BOOLEAN_SCHEMA,
    certificate: objectSchema({ names: STRINGS, notAfter: NUMBER_SCHEMA, issuedAt: NUMBER_SCHEMA }, ['names', 'notAfter', 'issuedAt']),
    lastAttempt: objectSchema({ at: NUMBER_SCHEMA, ok: BOOLEAN_SCHEMA, words: STRING_SCHEMA }, ['at', 'ok', 'words']),
    addressProblem: STRING_SCHEMA,
    routerCheck: objectSchema({ name: STRING_SCHEMA, ok: BOOLEAN_SCHEMA, words: STRING_SCHEMA }, ['name', 'ok', 'words']),
    addressRecords: { type: 'object', additionalProperties: STRING_SCHEMA },
  }, ['domain', 'tokenStored', 'issuing', 'addressRecords']),
  ownFiles: objectSchema({
    certFile: STRING_SCHEMA, keyFile: STRING_SCHEMA,
    check: objectSchema({ ok: BOOLEAN_SCHEMA, problem: STRING_SCHEMA, names: STRINGS, notAfter: NUMBER_SCHEMA }, ['ok', 'names']),
  }, ['certFile', 'keyFile']),
  localAuthority: objectSchema({ made: BOOLEAN_SCHEMA, fingerprint: STRING_SCHEMA, page: STRING_SCHEMA }, ['made']),
  tailscale: objectSchema({ address: STRING_SCHEMA }, []),
  group: objectSchema({
    following: objectSchema({ nodeId: STRING_SCHEMA, name: STRING_SCHEMA }, ['nodeId', 'name']),
    received: objectSchema({ leadName: STRING_SCHEMA, names: STRINGS, notAfter: NUMBER_SCHEMA, receivedAt: NUMBER_SCHEMA, source: SOURCE }, ['leadName', 'names', 'notAfter', 'receivedAt', 'source']),
    followers: arraySchema(objectSchema({ name: STRING_SCHEMA, address: STRING_SCHEMA, port: NUMBER_SCHEMA, covered: BOOLEAN_SCHEMA, needs: STRING_SCHEMA }, ['name', 'address', 'covered'])),
    formerHolders: arraySchema(objectSchema({ name: STRING_SCHEMA, at: NUMBER_SCHEMA, until: NUMBER_SCHEMA, source: SOURCE }, ['name', 'at', 'until', 'source'])),
  }, ['followers']),
  reissue: objectSchema({ title: STRING_SCHEMA, line: STRING_SCHEMA, available: BOOLEAN_SCHEMA }, ['title', 'line', 'available']),
  replaceAuthority: objectSchema({ title: STRING_SCHEMA, line: STRING_SCHEMA, question: STRING_SCHEMA, available: BOOLEAN_SCHEMA }, ['title', 'line', 'question', 'available']),
  serve: objectSchema({ title: STRING_SCHEMA, line: STRING_SCHEMA, available: BOOLEAN_SCHEMA }, ['title', 'line', 'available']),
}, ['intro', 'choices', 'groupLines', 'node', 'inForce', 'letsEncrypt', 'ownFiles', 'localAuthority', 'tailscale', 'group', 'reissue']);

const INVALID: ContractErrorCode = { code: 'SECURE_ADDRESS_INVALID', status: 400, meaning: 'The change could not be made as given (a name that is not a domain name, a token Cloudflare refused for the name\'s zone, certificate files that are not a valid pair in force); the message says what to change, and nothing was written.' };
const UNAVAILABLE: ContractErrorCode = { code: 'SECURE_ADDRESS_UNAVAILABLE', status: 409, meaning: 'There is no certificate GoodVibes can issue here now: the https address is off, or it serves a certificate the person made (they renew it themselves); nothing changed.' };
const NODE: ContractErrorCode ={ code: 'SECURE_ADDRESS_NODE', status: 409, meaning: 'This machine is a member of a group whose lead has a secure address: it comes from the lead, and nothing is set here.' };

export const builtinGatewaySecureAddressMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'secureAddress.get',
    title: 'Read The Secure Address',
    description: 'What the Secure address screen shows: the four ways to give the daemon an https address for phones (Let\'s Encrypt for a domain you own, a certificate you made, Tailscale, GoodVibes\' own certificate), each with what it does, what it needs from the person, what the phone gains and what is sent where; which one is in force and what the https listener serves now (address, names, end date, or why it does not serve); Let\'s Encrypt\'s last attempt, the address records written and this machine\'s own lookup of the name (a router that refuses local answers is named, with what to change); the own files\' check; the local authority\'s fingerprint and the page a phone installs it from; the Tailscale address while one is served; and the group: on a lead, the machines that follow it and the line that every machine serves with the same certificate; on a node, the line that its secure address comes from the lead and what it received. On a lead the ways say what differs there (GoodVibes\' own certificate covers the group\'s machines; a certificate you made and GoodVibes\' own are sent, sealed, with their key to the group\'s machines). `letsEncrypt.tokenUnreadable` says, with the cause, that the secret store on this computer could not be read when no token was read (the token is then not asked for again). `notice` is a notice no owner channel carried (a node\'s own certificate authority set aside while it follows its lead), shown at the top of the screen; returning it here marks it given. No key or token is ever returned. Needs read:remote, an owner-private read scope: a user without the admin role is not granted it.',
    category: 'remote-access',
    effects: ['remote.read'],
    transport: ['ws'],
    inputSchema: objectSchema({}, []),
    outputSchema: STATUS_SCHEMA,
  }),
  methodDescriptor({
    id: 'secureAddress.set',
    repeat: 'safe',
    title: 'Set Up The Secure Address',
    description: 'The Secure address screen\'s change. certificate lets-encrypt (domain, and cloudflareToken when none is stored: a token with Zone, DNS, Edit on the zone that holds the name, stored in the secret store only once Cloudflare accepted it; never returned), own-files (certFile and keyFile, paths on the daemon\'s machine, checked first: the key must belong to the certificate and it must be in force), local-authority (GoodVibes\' own certificate), or off (the https listener stops; plain http is unchanged). Refused 400 SECURE_ADDRESS_INVALID with words and nothing written when the input cannot work; refused 409 SECURE_ADDRESS_NODE on a node of a group, whose secure address comes from its lead. Otherwise the web UI is served to the network when it is not yet (what goodvibes-daemon webui enable --lan writes), secureAddress.* and controlPlane.lanHttps.enabled are written, and the answer (the same as secureAddress.get) comes once the https listener has synced and, for Let\'s Encrypt, once the order has an outcome: issued, or the authority\'s refusal in plain words.',
    category: 'remote-access',
    effects: ['control-plane.administer', 'secret.write', 'model.refused'],
    transport: ['ws'],
    inputSchema: objectSchema({
      certificate: stringEnumSchema(['lets-encrypt', 'own-files', 'local-authority', 'off']),
      domain: STRING_SCHEMA,
      cloudflareToken: STRING_SCHEMA,
      certFile: STRING_SCHEMA,
      keyFile: STRING_SCHEMA,
    }, ['certificate']),
    outputSchema: STATUS_SCHEMA,
    errorCodes: [INVALID, NODE],
  }),
  methodDescriptor({
    id: 'secureAddress.reissue',
    repeat: 'unsafe',
    title: 'Issue A New Secure Address Certificate',
    description: 'The Secure address screen\'s "Issue a new certificate now", on the machine that set the secure address up (a group\'s lead, or a machine of its own): a new certificate with a new key at once, served by the https listener and sent, sealed, to the machines that follow it. With Let\'s Encrypt a new order is placed (an order already running finishes first); Let\'s Encrypt allows only five certificates for the same names a week, so a repeat spends one more of them. With GoodVibes\' own certificate a new server certificate is made under the same authority, so phones that installed it need nothing. No input. The answer is ok, one line of words (issued with its end date, or the authority\'s refusal in plain words) and the screen as secureAddress.get returns it; never a key or a token. Refused 409 SECURE_ADDRESS_NODE on a node (its certificate comes from the lead), and 409 SECURE_ADDRESS_UNAVAILABLE with words when https is off or the certificate is one the person made (they renew it themselves); nothing changes then. A certificate is also issued again by itself when it is due and when a machine that held it leaves or is removed from the group.',
    category: 'remote-access',
    // No credential comes from the caller: the daemon makes the new key and stores it as at a renewal, so the model
    // may call it (through the permission gate, under the mode in force), unlike secureAddress.set's token.
    effects: ['control-plane.administer'],
    transport: ['ws'],
    inputSchema: objectSchema({}, []),
    outputSchema: objectSchema({ ok: BOOLEAN_SCHEMA, words: STRING_SCHEMA, status: STATUS_SCHEMA }, ['ok', 'words', 'status']),
    errorCodes: [UNAVAILABLE, NODE],
  }),
  methodDescriptor({
    id: 'secureAddress.replaceAuthority',
    repeat: 'unsafe',
    title: 'Replace The Secure Address Authority',
    description: 'The Secure address screen\'s "Replace the authority", where this computer serves GoodVibes\' own certificate: its certificate authority is removed and a new one made, and a new server certificate signed by it is served here and sent, sealed, to the machines that follow this computer. Every phone must then remove the old GoodVibes certificate and install the new one from the page /lan-https; until it does it shows a warning for the address. It is what ends, at once, the trust a phone gives a machine that left the group or was removed and still holds a certificate the old authority signed. It cannot be undone: the screens ask first, opening on No. No input. The answer is ok, one line of words (with the new authority\'s fingerprint) and the screen as secureAddress.get returns it; never a key. Refused 409 SECURE_ADDRESS_NODE on a member of a group, and 409 SECURE_ADDRESS_UNAVAILABLE when https is off or the certificate in force is not GoodVibes\' own.',
    category: 'remote-access',
    effects: ['control-plane.administer'],
    transport: ['ws'],
    inputSchema: objectSchema({}, []),
    outputSchema: objectSchema({ ok: BOOLEAN_SCHEMA, words: STRING_SCHEMA, status: STATUS_SCHEMA }, ['ok', 'words', 'status']),
    errorCodes: [UNAVAILABLE, NODE],
  }),
  methodDescriptor({
    id: 'secureAddress.serve',
    repeat: 'safe',
    title: 'Serve Other Machines For The Secure Address',
    description: 'The Secure address screen\'s "Serve other machines", offered while other machines are not served (controlPlane.enabled off, or the daemon listening on this computer only), when a phone cannot open the https address: what goodvibes-daemon webui enable --lan writes, so the daemon listens on the network and answers other machines; each still needs its own pairing or sign-in. The answer comes once the listener is bound again: ok, one line of words and the screen as secureAddress.get returns it. Refused 409 SECURE_ADDRESS_UNAVAILABLE when this daemon cannot change it from here.',
    category: 'remote-access',
    effects: ['control-plane.administer'],
    transport: ['ws'],
    inputSchema: objectSchema({}, []),
    outputSchema: objectSchema({ ok: BOOLEAN_SCHEMA, words: STRING_SCHEMA, status: STATUS_SCHEMA }, ['ok', 'words', 'status']),
    errorCodes: [UNAVAILABLE],
  }),
];
