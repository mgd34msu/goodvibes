/**
 * method-catalog-pairing.ts
 *
 * Per-pairing operator token verbs: every paired device holds its own named,
 * individually-revocable token. These verbs list the paired devices (never the
 * secret), rename one, revoke one (immediately), mint a fresh one, and migrate
 * a client off the legacy single shared token (and revoke that shared token).
 *
 * Like the other handler-registered verb groups (fleet.*, push.*, checkpoints.*)
 * these declare `transport: ['ws']` and carry NO dedicated REST `http` binding:
 * they are served by the registered in-process handler through the generic
 * `/api/control-plane/methods/{id}/invoke` endpoint. `mint`, `revoke`, `rename`
 * and `list` are the core CRUD tails; `migrate` (move a shared-token client to
 * its own per-device token) and `revokeShared` (turn the legacy token off) are
 * documented in the `pairing-tokens` exempt category in
 * packages/contracts/src/core-verbs.ts.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import type { EffectId } from '../security/effect-authority.js';
import { OWNER_APPROVAL_PENDING_SCHEMA } from './operator-contract-schemas.js';
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

/**
 * What completing a pairing hand-off needs: it can register a step-up passkey,
 * so it is held to what stepup.credentials.register is. pairing.handoff.create
 * offers only what a pairing that holds these may complete.
 */
export const PAIRING_HANDOFF_COMPLETE_EFFECTS: readonly [EffectId, ...EffectId[]] = ['control-plane.write', 'model.refused', 'stepup.credential.register'];

/** Browser-push subscription key material (p256dh + auth), for the notifications offer. */
const PUSH_SUBSCRIPTION_KEYS_SCHEMA = objectSchema({
  p256dh: STRING_SCHEMA,
  auth: STRING_SCHEMA,
}, ['p256dh', 'auth']);

/** The redacted, wire-safe view of a pairing token, name/created/last-seen, never the secret. */
const PUBLIC_PAIRING_TOKEN_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  name: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  lastSeenAt: NUMBER_SCHEMA,
  mintedBy: STRING_SCHEMA,
  /** `agent`: the GoodVibes Agent's credential for the calls it makes on the owner's behalf. */
  client: { type: 'string', enum: ['agent'] },
  /** The operator scopes the device holds when it was paired with a narrower list; absent: full operator authority. */
  scopes: arraySchema(STRING_SCHEMA),
  /** How the token came to exist: `owner-pairing` (a device the owner paired himself) or `automation`. Never changes. */
  origin: { type: 'string', enum: ['owner-pairing', 'automation'] },
}, ['id', 'name', 'createdAt', 'origin']);

/** The minted token, the ONE shape that carries the plaintext secret, returned once. */
const MINTED_PAIRING_TOKEN_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  name: STRING_SCHEMA,
  token: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
}, ['id', 'name', 'token', 'createdAt']);

/**
 * The honest TLS/capability posture of a web origin: whether plain http on a
 * private network applies (the supported LAN posture, with its ONE notice line
 * stated at pairing, never a nag), and which browser-gated capabilities the
 * origin can support, each unavailable one labeled with why and the supported
 * path (tailscale) so surfaces render labels instead of dead buttons. The
 * daemon never mints certificates; https comes from the user's own TLS or
 * tailscale.
 */
const ORIGIN_POSTURE_SCHEMA = objectSchema({
  origin: STRING_SCHEMA,
  scheme: STRING_SCHEMA,
  privateNetwork: BOOLEAN_SCHEMA,
  secureContext: BOOLEAN_SCHEMA,
  notice: STRING_SCHEMA,
  capabilities: arraySchema(objectSchema({
    capability: STRING_SCHEMA,
    available: BOOLEAN_SCHEMA,
    reason: STRING_SCHEMA,
  }, ['capability', 'available'])),
  /**
   * On the address a pairing code carries: whether a phone can open it,
   * decided by the daemon from its settings (a loopback address cannot;
   * web.publicBaseUrl is the owner's statement that it can; otherwise
   * controlPlane.enabled decides), and when not, why, the one command that
   * fixes it (run in a terminal on the daemon's machine) and the numbered steps.
   */
  reach: objectSchema({
    otherDevices: BOOLEAN_SCHEMA,
    reason: STRING_SCHEMA,
    fix: STRING_SCHEMA,
    steps: arraySchema(objectSchema({
      state: { type: 'string', enum: ['done', 'next', 'then'] },
      text: STRING_SCHEMA,
      detail: STRING_SCHEMA,
      command: BOOLEAN_SCHEMA,
    }, ['state', 'text'])),
  }, ['otherDevices']),
}, ['origin', 'scheme', 'privateNetwork', 'secureContext', 'capabilities']);

export const builtinGatewayPairingMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'pairing.tokens.list',
    title: 'List Paired Device Tokens',
    description: 'List the per-pairing operator tokens (paired devices/browsers) as redacted views: id, user-visible name, created timestamp, last-seen timestamp, mintedBy (the paired device that minted it, when one did), scopes (the operator scopes it holds, when it was paired with a narrower list; absent means full operator authority) and origin: `owner-pairing` for a device the owner paired himself through the pairing flow (pairing.handoff.create or the pairing screen, from the operator token, an admin sign-in, an app on his machine or another owner device, with full authority), which makes the owner\'s own acts (loosening a security, permission, judgment or payment setting; answering a change put to him), or `automation` for every other token (pairing.tokens.create, pairing.tokens.migrate, a narrowed list, the Agent\'s credential, and every token minted before origin was recorded), which does not. Origin is recorded at the mint and never changes; to make a device an owner device, pair it again from the pairing screen and revoke the old token. The token secret is never stored in listable form and is never returned.',
    category: 'pairing',
    effects: ['pairing.read'],
    transport: ['ws'],
    outputSchema: objectSchema({
      tokens: arraySchema(PUBLIC_PAIRING_TOKEN_SCHEMA),
      legacySharedRevoked: BOOLEAN_SCHEMA,
    }, ['tokens', 'legacySharedRevoked']),
  }),
  methodDescriptor({
    id: 'pairing.tokens.create',
    effects: ['control-plane.write', 'model.refused'],
    title: 'Mint Paired Device Token',
    description: 'Mint a new named per-device operator token and return its plaintext secret EXACTLY ONCE (for a QR / pairing hand-off). Only a hash is persisted; the secret is never listed or returned again. The name is user-visible and editable. When a paired device asks, the new token records that device (mintedBy) and is revoked with it; a device whose own pairing is gone is refused with 403 PAIRING_TOKEN_NOT_FOUND. client "agent" mints the GoodVibes Agent\'s credential for the calls it makes on the owner\'s behalf: the daemon reports it as credential "agent" and judges every call made with it; it is listed with client "agent" and does not count toward device.nodes.maxPaired. Send an attemptId and send the same one again when a reply is lost: while the token that attempt produced is unused, the repeat returns that token (same id) under a new secret. scopes limits the device to that list of operator scopes (for example read:sessions, read:transcripts and write:sessions for a phone that only chats); left out, the device holds full operator authority. A caller grants only scopes it holds: a narrowed caller\'s token inherits its list when scopes is left out, and naming a scope the caller does not hold is 403 MISSING_SCOPE. A token minted here is automation (origin automation): it does not make the owner\'s own acts, such as loosening a security, permission, judgment or payment setting. A device the owner pairs himself is paired with pairing.handoff.create.',
    category: 'pairing',
    transport: ['ws'],
    replay: { in: 'body', name: 'attemptId', behavior: 'Sending the same attemptId again while the token that attempt produced is still unused returns that token (same id) under a new secret, and the secret of the lost reply stops working; once the token has been used, the same attemptId mints a new token.' },
    inputSchema: objectSchema({ name: STRING_SCHEMA, attemptId: STRING_SCHEMA, client: { type: 'string', enum: ['agent'] }, scopes: arraySchema(STRING_SCHEMA) }, ['name']),
    outputSchema: objectSchema({ token: MINTED_PAIRING_TOKEN_SCHEMA }, ['token']),
  }),
  methodDescriptor({
    id: 'pairing.tokens.rename',
    repeat: 'safe',
    title: 'Rename Paired Device Token',
    description: 'Change the user-visible name of a paired device token. An unknown id is a 404 PAIRING_TOKEN_NOT_FOUND.',
    category: 'pairing',
    effects: ['control-plane.write'],
    transport: ['ws'],
    inputSchema: objectSchema({ id: STRING_SCHEMA, name: STRING_SCHEMA }, ['id', 'name']),
    outputSchema: objectSchema({ id: STRING_SCHEMA, renamed: BOOLEAN_SCHEMA }, ['id', 'renamed']),
  }),
  methodDescriptor({
    id: 'pairing.tokens.delete',
    repeat: 'safe',
    effects: ['control-plane.write', 'model.refused'],
    title: 'Revoke Paired Device Token',
    description: 'Revoke (permanently delete) one paired device token. Revocation is immediate: the token fails the very next request with a 401, and every token this device minted is revoked with it (listed in alsoRevoked); every other paired device keeps working. An unknown id is a 404 PAIRING_TOKEN_NOT_FOUND, never a 200-noop. A token the caller minted, or the caller\'s own token, is revoked at once; any other token (a device the owner paired, another principal\'s) is the owner\'s own act: from an admin who is not the owner it is put to the owner (202 OWNER_APPROVAL_PENDING) and revoked when he approves it, and any other credential is refused 403 OWNER_ONLY.',
    category: 'pairing',
    transport: ['ws'],
    inputSchema: objectSchema({ id: STRING_SCHEMA }, ['id']),
    outputSchema: { anyOf: [
      objectSchema({ id: STRING_SCHEMA, revoked: BOOLEAN_SCHEMA, alsoRevoked: arraySchema(STRING_SCHEMA) }, ['id', 'revoked', 'alsoRevoked']),
      OWNER_APPROVAL_PENDING_SCHEMA,
    ] },
  }),
  methodDescriptor({
    id: 'pairing.tokens.migrate',
    effects: ['control-plane.write', 'model.refused'],
    title: 'Migrate Off The Shared Token',
    description: 'A client currently authenticated with the legacy single shared token mints its OWN named per-device token and receives the plaintext secret once. A token minted here is automation (origin automation), for a script; the owner\'s own browser or app moves off the shared token with pairing.handoff.create and `fromSharedToken: true`, which makes it an owner device. Send an attemptId and send the same one again when a reply is lost: while the token that attempt produced is unused, the repeat returns that token (same id) under a new secret instead of minting a second one. This does NOT revoke the shared token; that is a separate explicit step (pairing.tokens.revokeShared).',
    category: 'pairing',
    transport: ['ws'],
    replay: { in: 'body', name: 'attemptId', behavior: 'Sending the same attemptId again while the token that attempt produced is still unused returns that token (same id) under a new secret, and the secret of the lost reply stops working; once the token has been used, the same attemptId mints a new token.' },
    inputSchema: objectSchema({ name: STRING_SCHEMA, attemptId: STRING_SCHEMA }, ['name']),
    outputSchema: objectSchema({ token: MINTED_PAIRING_TOKEN_SCHEMA }, ['token']),
  }),
  methodDescriptor({
    id: 'pairing.tokens.revokeShared',
    repeat: 'unsafe',
    effects: ['access.withdraw'],
    title: 'Revoke The Legacy Shared Token',
    description: 'Revoke the shared operator token by replacing it: every copy handed to another device stops working immediately, and the daemon writes the new value to its operator-tokens.json, where the apps on its own machine read it, so they stay signed in. Other devices use per-device pairing tokens (or user sessions). The owner\'s own act (access.withdraw): any credential but the owner\'s own (the operator token, a device he paired himself, his sign-in) is refused 403 OWNER_ONLY, an admin\'s with the reason that it is the owner\'s to decide. Refused with SHARED_TOKEN_NOT_REPLACEABLE (409) when the daemon serves a token set by GOODVIBES_DAEMON_TOKEN. Not safe to repeat: each call replaces the shared token again.',
    category: 'pairing',
    transport: ['ws'],
    outputSchema: objectSchema({ legacySharedRevoked: BOOLEAN_SCHEMA }, ['legacySharedRevoked']),
  }),
  methodDescriptor({
    id: 'pairing.handoff.create',
    repeat: 'unsafe',
    effects: ['control-plane.write', 'model.refused'],
    title: 'Create Pairing Hand-off',
    description: 'The owner\'s pairing flow. Mint a per-device token AND assemble the set-up OFFER SET this daemon can satisfy (notifications, carrying the VAPID public key; relay; passkey step-up), so a freshly-paired surface can complete them in one pass. Returns the offer set, the `#pair=<token>` deep-link fragment (the exact URL-fragment shape the web app consumes, token in `pair=`, offers in `offers=`), a full deep link when a web origin is configured, and that origin\'s honest TLS/capability POSTURE: the one plain-http-on-LAN notice line (stated here, never a nag) plus per-capability availability labels so surfaces render "needs https: set up a secure address in Settings, General, Secure address (...)" instead of dead buttons. The token secret is returned exactly once. When a paired device asks, the new token records that device (mintedBy) and is revoked with it; a device whose own pairing is gone is refused with 403 PAIRING_TOKEN_NOT_FOUND. Each offer is independently declinable at completion. A pairing minted narrower than full authority cannot complete a hand-off (pairing.handoff.complete needs what stepup.credentials.register needs), so it is offered nothing to complete and gets its token alone. The device it pairs is recorded as the owner\'s own (origin owner-pairing) when the caller holds the owner\'s own credential (the operator token, an admin sign-in, an app on his machine, or a device he paired himself) with full authority; from a token minted for automation, the Agent\'s credential or a narrowed caller it is recorded as automation. `fromSharedToken: true` is how a client signed in with the shared operator token (the owner\'s own browser) moves onto its own token: it pairs itself here, exempt from device.nodes.maxPaired as pairing.tokens.migrate is, and the token it gets is an owner device; only a caller on the shared token may send it (400 INVALID_ARGUMENT otherwise). No code is made that a phone could not open: when the daemon\'s web address is reachable only from its own machine (a loopback address, or controlPlane.enabled off without web.publicBaseUrl naming it), the call is refused with 409 PAIRING_CODE_UNREACHABLE, saying why and the command to run in a terminal on the daemon\'s machine (goodvibes-daemon webui enable --lan); pairing.posture.get gives the same decision with numbered steps before anything is minted. `serveToNetwork: true` is the owner\'s yes to "Phones on your network cannot reach GoodVibes yet. Serve it to your network?", which a pairing surface asks in place of that refusal: the daemon writes what goodvibes-daemon webui enable --lan writes, waits for its own listener to report it is bound again (TRANSPORT_CONNECTED; no sleep, no poll), and then mints for the address phones can open, in the same call; refused 409 PAIRING_CODE_UNREACHABLE only when it still cannot be reached. `fromSharedToken: true`, and `forThisMachine: true` (a code for a browser on the daemon\'s own machine), are not refused for that.',
    category: 'pairing',
    transport: ['ws'],
    inputSchema: objectSchema({
      name: STRING_SCHEMA,
      offers: arraySchema(STRING_SCHEMA),
      fromSharedToken: BOOLEAN_SCHEMA,
      forThisMachine: BOOLEAN_SCHEMA,
      serveToNetwork: BOOLEAN_SCHEMA,
    }, ['name']),
    outputSchema: objectSchema({
      token: MINTED_PAIRING_TOKEN_SCHEMA,
      offers: arraySchema(objectSchema({
        kind: STRING_SCHEMA,
        available: BOOLEAN_SCHEMA,
        vapidPublicKey: STRING_SCHEMA,
      }, ['kind', 'available'])),
      fragment: STRING_SCHEMA,
      deepLink: STRING_SCHEMA,
      posture: ORIGIN_POSTURE_SCHEMA,
    }, ['token', 'offers', 'fragment']),
  }),
  methodDescriptor({
    id: 'pairing.posture.get',
    title: 'Get Origin TLS/Capability Posture',
    description: 'The honest TLS/capability posture of a web origin, pass your surface\'s current origin (or omit it to read the configured web origin). Plain http on a private-network origin (LAN IP, .local, localhost) is a supported posture reported with its ONE notice line; browser-gated capabilities (service worker/PWA install, push, microphone) are each labeled available or "needs https: set up a secure address in Settings, General, Secure address (...)" so surfaces render labels instead of dead buttons. Localhost keeps all three. https on a private address that is not a tailnet name is the daemon\'s own LAN certificate (controlPlane.lanHttps): its capabilities are available and its notice says each phone installs the certificate once from /lan-https on the plain address. With no origin supplied the answer is about the address a pairing code carries and adds `reach`: whether a phone can open it (otherDevices), decided by the daemon from its settings with no request on the network, and when not, the reason, the fix (a command to run in a terminal on the daemon\'s machine) and the numbered steps (state done|next|then, text, detail, command). Every pairing surface asks this before minting. With controlPlane.lanHttps on (the Secure address), the address a pairing code carries is the https one the listener serves: at the certificate\'s own name for Let\'s Encrypt, a certificate you made or a group\'s (secureAddress.get), with no install notice; at the same host for GoodVibes\' own certificate, with its install notice. Plain http keeps working as before.',
    category: 'pairing',
    effects: ['control-plane.read'],
    transport: ['ws'],
    inputSchema: objectSchema({ origin: STRING_SCHEMA }, []),
    outputSchema: objectSchema({ posture: ORIGIN_POSTURE_SCHEMA }, ['posture']),
  }),
  methodDescriptor({
    id: 'pairing.serve.network',
    repeat: 'safe',
    title: 'Serve The Web UI To The Network',
    description: 'What goodvibes-daemon webui enable --lan does, from any surface, after the owner said yes to "Phones on your network cannot reach GoodVibes yet. Serve it to your network?" (asked opening on No): the daemon writes controlPlane.hostMode and web.hostMode network and controlPlane.enabled true, and answers only once its own listener reports it is bound again (TRANSPORT_CONNECTED; no sleep, no poll). The answer is the pairing posture of the address a code would now carry (`posture`, with `reach`), so the surface can mint at once with pairing.handoff.create. The plain listener stays as it was otherwise; undo with goodvibes-daemon webui enable --loopback. Admin, like config.set.',
    category: 'pairing',
    effects: ['control-plane.administer'],
    transport: ['ws'],
    inputSchema: objectSchema({}, []),
    outputSchema: objectSchema({ posture: ORIGIN_POSTURE_SCHEMA }, ['posture']),
  }),
  methodDescriptor({
    id: 'pairing.handoff.complete',
    repeat: 'safe',
    effects: PAIRING_HANDOFF_COMPLETE_EFFECTS,
    title: 'Complete Pairing Hand-off',
    description: 'Apply the surface\'s per-offer decisions in ONE pass: an accepted notifications offer registers the browser push subscription (endpoint + keys, optional deviceId), an accepted passkey offer registers the WebAuthn credential, an accepted relay offer is acknowledged. Each offer returns an honest per-offer result (completed / declined / unavailable / failed); an omitted or false offer is reported as declined, never silently half-applied. Because it can register a step-up passkey it needs what stepup.credentials.register needs (admin, write:relay, never the Agent\'s credential), and a passkey is accepted only when pairing.handoff.create offered one to this very pairing (the caller is the device that paired with that hand-off\'s token), once, within 30 minutes; otherwise the passkey offer fails and nothing is registered. A pairing minted narrower than full authority cannot complete a hand-off, so pairing.handoff.create offers it nothing to complete.',
    category: 'pairing',
    transport: ['ws'],
    inputSchema: objectSchema({
      accept: objectSchema({
        notifications: objectSchema({
          endpoint: STRING_SCHEMA,
          keys: PUSH_SUBSCRIPTION_KEYS_SCHEMA,
          deviceId: STRING_SCHEMA,
        }, ['endpoint', 'keys']),
        relay: BOOLEAN_SCHEMA,
        passkey: objectSchema({
          rpId: STRING_SCHEMA,
          origin: STRING_SCHEMA,
          credentialId: STRING_SCHEMA,
          publicKeyCose: STRING_SCHEMA,
        }, ['rpId', 'origin', 'credentialId', 'publicKeyCose']),
      }, []),
    }, []),
    outputSchema: objectSchema({
      results: arraySchema(objectSchema({
        kind: STRING_SCHEMA,
        status: STRING_SCHEMA,
        detail: STRING_SCHEMA,
      }, ['kind', 'status'])),
    }, ['results']),
  }),
];
