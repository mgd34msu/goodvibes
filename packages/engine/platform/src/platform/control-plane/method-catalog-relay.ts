/**
 * method-catalog-relay.ts, asking a daemon whether it is reachable through
 * the relay, and getting the pairing payload that makes a surface able to.
 *
 * The controller has been composed on every daemon that turns the relay on
 * (platform/relay/reachability.ts), and its state was reachable through
 * exactly one door: `DaemonServer.getRelayReachability()`, an in-process method
 * on the facade. A surface running in the same process could read it; every
 * pure client, the terminal, the web surface, the agent, anything over the
 * wire, had no verb to ask and could only report the relay as unavailable,
 * which it did, honestly and uselessly.
 *
 * The first two verbs expose what already exists. `status` is the
 * controller's own value, including the `disabled` it reports when any of the
 * three gates (relay.enabled, the relay-connect capability, a configured
 * relay.url) is off, so "not reachable" and "not turned on" stay different
 * answers. `mint` is the same call the facade's capability exposes, and returns
 * null the same way when there is no live registration to mint against.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  arraySchema,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

/** The controller's own status vocabulary, plus the gated-off value and a start that failed ('failed', lastRefusal says why). */
const RELAY_STATUS_SCHEMA: Record<string, unknown> = {
  type: 'string',
  enum: ['disabled', 'failed', 'idle', 'connecting', 'registered', 'reconnecting', 'refused', 'stopped'],
};

/** Why the relay refused the registration, or why its start failed (code relay-start-failed): what is true, what to do, and whether the daemon keeps trying. */
const RELAY_REFUSAL_SCHEMA = objectSchema({
  code: STRING_SCHEMA,
  message: STRING_SCHEMA,
  state: STRING_SCHEMA,
  next: arraySchema(STRING_SCHEMA),
  retryable: { type: 'boolean' },
}, ['code', 'message', 'state', 'next', 'retryable']);

const RELAY_PAIRING_SCHEMA = objectSchema({
  protocol: NUMBER_SCHEMA,
  relayUrl: STRING_SCHEMA,
  rid: STRING_SCHEMA,
  daemonPublicKey: STRING_SCHEMA,
  /** This device's relay code, returned once: listed and revoked with relay.codes.list and relay.codes.revoke. */
  code: STRING_SCHEMA,
  label: STRING_SCHEMA,
}, ['protocol', 'relayUrl', 'rid', 'daemonPublicKey', 'code']);

/** A relay code as it is listed: never the code itself. */
const RELAY_CODE_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  name: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  lastSeenAt: NUMBER_SCHEMA,
}, ['id', 'name', 'createdAt']);

export const builtinGatewayRelayMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'relay.reachability.get',
    title: 'Relay Reachability',
    description: 'Whether this daemon is registered with the relay, and what state its registration is in. `disabled` is a distinct answer from every other one and the distinction is the point: it means a gate is off, `relay.enabled`, the relay-connect capability, or an empty `relay.url`, rather than that a connection is failing. `idle` means the gates are open and nothing has started; `connecting`, `registered` and `reconnecting` are the live registration; `refused` means the relay refused the registration for a reason another attempt cannot clear, and the daemon stops dialling until the relay settings or identity change; `stopped` is a controller that was told to stop. `configured` says whether all three gates are open, so a caller can render "turn it on" instead of "it is broken". `rendezvousId`, present while a registration is running, is the id the daemon is registered under, derived from its relay identity key; it is the id a pairing payload carries and a step-up challenge is bound to. `refusal`, present after the relay refused the registration, says why (`state`), what to do (`next`) and whether the daemon keeps trying (`retryable`). ws-only invoke verb; no REST binding.',
    category: 'control-plane',
    effects: ['control-plane.read'],
    transport: ['ws'],
    // Declared and empty rather than omitted: the invoke gate skips a verb with
    // no typed inputSchema, so "takes nothing" has to be stated to be enforced.
    inputSchema: objectSchema({}, []),
    outputSchema: objectSchema({
      status: RELAY_STATUS_SCHEMA,
      configured: { type: 'boolean' },
      rendezvousId: STRING_SCHEMA,
      refusal: RELAY_REFUSAL_SCHEMA,
    }, ['status', 'configured']),
  }),
  methodDescriptor({
    id: 'relay.pairing.mint',
    repeat: 'unsafe',
    effects: ['control-plane.administer', 'model.refused'],
    title: 'Mint A Relay Pairing Payload',
    description: 'Return the pairing payload one device scans to reach this daemon through the relay: the relay URL to dial, the rendezvous id the daemon registered under, the daemon\'s static public key, and a relay code issued for this device alone (returned once; only its hash is kept). Every request the device tunnels through the relay presents that code, and the daemon refuses one whose code it did not issue or has revoked (401 RELAY_CODE_REVOKED), so one phone is cut off with relay.codes.revoke while every other keeps working. `name` labels the code in relay.codes.list (default: "Relay device" and the time). `codeId` and `codeName` name the code minted. `pairing` is null, not an error, and no code is kept, when there is no live registration to mint against, which is the honest answer for a daemon whose relay is off or has not connected yet. Minting does not create a second identity or a second registration; it describes the one that exists. 409 RELAY_CODE_LIMIT when 64 codes are held.',
    category: 'control-plane',
    transport: ['ws'],
    inputSchema: objectSchema({ name: STRING_SCHEMA }, []),
    outputSchema: objectSchema({
      pairing: { anyOf: [RELAY_PAIRING_SCHEMA, { type: 'null' }] },
      status: RELAY_STATUS_SCHEMA,
      codeId: STRING_SCHEMA,
      codeName: STRING_SCHEMA,
    }, ['pairing', 'status']),
  }),
  methodDescriptor({
    id: 'relay.codes.list',
    title: 'List Relay Codes',
    description: 'List the relay codes this daemon issued, one per device paired through the relay (relay.pairing.mint), as redacted views: id, name, created time and, when the device has used it, the last time a relayed request presented it. The code itself is never stored in listable form and is never returned.',
    category: 'control-plane',
    effects: ['control-plane.inspect'],
    // Which devices can reach the daemon is the owner's to see, as paired devices are.
    transport: ['ws'],
    inputSchema: objectSchema({}, []),
    outputSchema: objectSchema({ codes: arraySchema(RELAY_CODE_SCHEMA) }, ['codes']),
  }),
  methodDescriptor({
    id: 'relay.codes.revoke',
    repeat: 'safe',
    effects: ['control-plane.administer', 'model.refused'],
    title: 'Revoke Relay Code',
    description: 'Revoke one device\'s relay code. Revocation is immediate: every relay connection the code opened is closed at once (each open stream gets a stream-close with reason relay-code-revoked, its in-flight requests are aborted; `closedConnections` counts them), the device\'s next request through the relay is refused with 401 RELAY_CODE_REVOKED, and every other device keeps working. The device reaches the daemon through the relay again only after pairing again on the home network. An unknown id is a 404 RELAY_CODE_NOT_FOUND, never a 200-noop.',
    category: 'control-plane',
    transport: ['ws'],
    inputSchema: objectSchema({ id: STRING_SCHEMA }, ['id']),
    outputSchema: objectSchema({ id: STRING_SCHEMA, revoked: { type: 'boolean' }, closedConnections: NUMBER_SCHEMA }, ['id', 'revoked', 'closedConnections']),
  }),
];
