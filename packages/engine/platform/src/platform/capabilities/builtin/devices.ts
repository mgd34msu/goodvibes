/**
 * Paired devices, the relay, devices waiting to pair, phones paired as device
 * nodes, their always-allow grants and the captures the daemon keeps: every
 * one of these is the daemon's own store, and a daemon method already does
 * each act. These definitions are those acts as capabilities: each runs its
 * method (`method`), which keeps its own effects, confirmation and repeat, so
 * the Devices place, the web UI, the model, an outside agent and a script all
 * reach the one implementation (method-capability.ts).
 */
import type { CapabilityMethod } from '../operator-input.js';
import { CapabilityRefusal, type CapabilityDefinition, type InputDescription, type ListName } from '../types.js';
import type { MethodCapabilityDefinition } from './method-capability.js';

/** The live lists the inputs choose from (terminal-shell devices-command.ts defines them over the same methods). */
export const DEVICE_TOKENS_LIST = 'devices.tokens' as ListName;
export const RELAY_CODES_LIST = 'devices.relay-codes' as ListName;
export const PAIR_REQUESTS_LIST = 'devices.pair-requests' as ListName;
export const DEVICE_GRANTS_LIST = 'devices.grants' as ListName;
export const DEVICE_CAPTURES_LIST = 'devices.captures' as ListName;

type Described = Omit<CapabilityDefinition<never>, 'run' | 'capability'> & { readonly id: string; readonly repeat: 'safe' | 'unsafe' };

/** A capability whose act a daemon method already does: run through that method, never by a handler here. */
export function throughMethod(described: Described, method: CapabilityMethod, said?: MethodCapabilityDefinition['said']): MethodCapabilityDefinition {
  const { id, repeat, ...rest } = described;
  return { ...rest, capability: { id, group: 'devices', home: 'daemon', repeat }, method, ...(said ? { said } : {}) };
}

function choose(id: string, label: string, help: string, list: ListName): InputDescription {
  return { id, label, help, kind: 'choice', choices: { list }, required: true, typed: { position: 1 } };
}

const DEVICE = choose('device', 'Device', 'One of your paired devices (a phone, a tablet, a browser, an app)', DEVICE_TOKENS_LIST);
const WAITING = 'The Waiting to pair tab of Devices and network lists the devices waiting to pair.';

export const DEVICES_LIST = throughMethod({
  id: 'devices.list', repeat: 'safe', actionId: 'list', label: 'See your paired devices', word: 'list', inputs: [],
  sentence: 'Lists each paired device with when it was paired and last seen, and whether the old shared token still works.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
}, { id: 'pairing.tokens.list', fields: {} });

export const DEVICES_RENAME = throughMethod({
  id: 'devices.rename', repeat: 'safe', actionId: 'rename', label: 'Rename a device', word: 'rename',
  inputs: [DEVICE, { id: 'name', label: 'New name', help: 'What to call it in the device list', kind: 'text', freeTextReason: 'a name you choose', required: true, typed: { tail: true } }],
  sentence: '{device} is called {name} in the device list, until you change it.', done: '{device} is now called {name}.',
  touches: 'another-machine', lasts: 'kept', risk: 'none', example: { device: 'a1b2c3', name: 'Work phone' },
}, { id: 'pairing.tokens.rename', fields: { id: 'device', name: 'name' } });

export const DEVICES_REVOKE = throughMethod({
  id: 'devices.revoke', repeat: 'safe', actionId: 'revoke', label: 'Revoke a device', word: 'revoke', inputs: [DEVICE],
  sentence: '{device} loses its access at once: it stops reaching the daemon and has to pair again for a new token.', done: '{device} was revoked: it can no longer reach the daemon.',
  touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { device: 'a1b2c3' },
}, { id: 'pairing.tokens.delete', fields: { id: 'device' } });

export const DEVICES_REVOKE_SHARED = throughMethod({
  id: 'devices.revoke-shared', repeat: 'unsafe', actionId: 'revoke-shared', label: 'Retire the shared token', word: 'revoke-shared', inputs: [],
  sentence: 'The old shared token stops working: every device still using it is signed out and has to pair again; the apps on this machine get its replacement.', done: 'The old shared token was retired; the apps on this machine hold its replacement.',
  touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone', example: {},
}, { id: 'pairing.tokens.revokeShared', fields: {} });

export const DEVICES_RELAY_STATUS = throughMethod({
  id: 'devices.relay-status', repeat: 'safe', actionId: 'relay-status', label: 'See whether the relay is reachable', word: 'relay-status', inputs: [],
  sentence: 'Shows whether the relay (the way in from outside your network) is on, the daemon\'s live registration with it, and what the relay refused if it did.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
}, { id: 'relay.reachability.get', fields: {} },
// The daemon's own words for the state ("The relay is off: ...", "Registered with the relay at ..."), never "done".
(answer) => typeof answer.words === 'string' && answer.words.trim() !== '' ? answer.words.trim() : `The relay is ${typeof answer.status === 'string' ? answer.status : 'in an unknown state'}.`);

export const DEVICES_RELAY_CODES = throughMethod({
  id: 'devices.relay-codes', repeat: 'safe', actionId: 'relay-codes', label: 'See devices paired through the relay', word: 'relay-codes', inputs: [],
  sentence: 'Lists each relay code, one per device paired through the relay, with when it was last used.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
}, { id: 'relay.codes.list', fields: {} });

export const DEVICES_RELAY_REVOKE = throughMethod({
  id: 'devices.relay-revoke', repeat: 'safe', actionId: 'relay-revoke', label: 'Cut a device off the relay', word: 'relay-revoke',
  inputs: [choose('code', 'Relay code', 'The devices paired through the relay', RELAY_CODES_LIST)],
  sentence: 'The device paired with {code} is refused at its next request through the relay; every other device keeps working.', done: '{code} was cut off the relay.',
  touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { code: 'rc-1' },
}, { id: 'relay.codes.revoke', fields: { id: 'code' } });

export const DEVICES_REQUESTS = throughMethod({
  id: 'devices.requests', repeat: 'safe', actionId: 'requests', label: 'See devices waiting to pair', word: 'requests', inputs: [],
  sentence: 'Lists each phone or other machine\'s daemon that asked to pair and waits for your approval, with what it offers, the name it pairs as and the address it asked from.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
}, { id: 'remote.pair.requests.list', fields: {} });

export const DEVICES_APPROVE = throughMethod({
  id: 'devices.approve', repeat: 'safe', actionId: 'approve', label: 'Approve a device waiting to pair', word: 'approve',
  inputs: [
    choose('request', 'Request', 'The devices waiting to pair', PAIR_REQUESTS_LIST),
    { id: 'replace', label: 'Replace', help: 'The request names a device already paired: approve it as that same device pairing again, which ends the old pairing', kind: 'choice',
      choices: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes, it is the same device pairing again' }],
      required: { default: 'no', defaultMeans: 'no' }, typed: { flag: '--replace', switchOn: 'yes' } },
  ],
  sentence: 'The phone or machine that sent {request} may finish pairing and then reach this daemon {lasts}: revoking it ends that.', done: 'Approved {request}: a phone finishes pairing when Finish pairing is pressed on it; another machine\'s daemon finishes by itself.',
  touches: 'credential', lasts: 'kept', risk: 'none',
  ownerOnly: { reason: 'approving gives a device access to the daemon', instead: WAITING },
  example: { request: 'pair-1' },
}, { id: 'remote.pair.requests.approve', fields: { requestId: 'request', confirmReplace: 'replace:yes' } });

export const DEVICES_REJECT = throughMethod({
  id: 'devices.reject', repeat: 'safe', actionId: 'reject', label: 'Reject a device waiting to pair', word: 'reject',
  inputs: [choose('request', 'Request', 'The devices waiting to pair', PAIR_REQUESTS_LIST)],
  sentence: 'The device that sent {request} stays unpaired {lasts}; to pair after all, it has to ask again.', done: 'Rejected {request}: it stays unpaired.',
  touches: 'another-machine', lasts: 'kept', risk: 'none',
  ownerOnly: { reason: 'answering a pairing request is the owner\'s own act', instead: WAITING },
  example: { request: 'pair-1' },
}, { id: 'remote.pair.requests.reject', fields: { requestId: 'request' } });

export const DEVICES_NODES = throughMethod({
  id: 'devices.nodes', repeat: 'safe', actionId: 'nodes', label: 'See phones paired as device nodes', word: 'nodes', inputs: [],
  sentence: 'Lists each phone paired as a device node and what it can serve (camera, location, clipboard, notifications).', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
}, { id: 'devices.nodes.list', fields: {} });

export const DEVICES_REVOKE_GRANT = throughMethod({
  id: 'devices.revoke-grant', repeat: 'safe', actionId: 'revoke-grant', label: 'Revoke an always-allow grant', word: 'revoke-grant',
  inputs: [choose('grant', 'Grant', 'The "always allow" answers given to a phone\'s capabilities', DEVICE_GRANTS_LIST)],
  sentence: 'The "always allow" answer {grant} is removed; the next request for that capability asks you again, until you change it.', done: 'The "always allow" answer {grant} was removed.',
  // It only takes an "always allow" away: never refused or asked of a model, in any folder.
  touches: 'another-machine', lasts: 'kept', risk: 'none', tightens: true, example: { grant: 'g-1' },
}, { id: 'devices.grants.revoke', fields: { grantId: 'grant' } });

export const DEVICES_CAPTURES = throughMethod({
  id: 'devices.captures', repeat: 'safe', actionId: 'captures', label: 'See captures the daemon keeps', word: 'captures', inputs: [],
  sentence: 'Lists the photos and screen captures from your phones the daemon is keeping, and when each is deleted.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
}, { id: 'devices.artifacts.list', fields: {} });

export const DEVICES_DELETE_CAPTURE = throughMethod({
  id: 'devices.delete-capture', repeat: 'safe', actionId: 'delete-capture', label: 'Delete a capture now', word: 'delete-capture',
  inputs: [choose('capture', 'Capture', 'The photos and screen captures the daemon keeps', DEVICE_CAPTURES_LIST)],
  sentence: 'The capture {capture} and its record are removed from the daemon host now.', done: 'The capture {capture} was deleted.',
  touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { capture: 'art-1' },
}, { id: 'devices.artifacts.delete', fields: { artifactId: 'capture' } });

const shortId = (id: string): string => id.length > 10 ? id.slice(0, 8) : id;

/**
 * A device still on the old shared token gets a token of its own: the daemon's `pairing.tokens.migrate` makes it and
 * answers its value once. That value is this capability's reveal (its own pane in the place, returned only to the
 * owner who asked), never its words or its data.
 */
export const DEVICES_MIGRATE_SHARED: CapabilityDefinition<unknown> = {
  capability: { id: 'devices.migrate-shared', group: 'devices', home: 'daemon', repeat: 'unsafe' },
  actionId: 'migrate-shared', label: 'Give an old device its own token', word: 'migrate-shared',
  inputs: [{ id: 'name', label: 'Name', help: 'What to call the device in the device list', kind: 'text', freeTextReason: 'a name you choose', required: true, typed: { tail: true } }],
  sentence: 'A token of its own is made for a device that still signs in with the old shared token, kept until you change it; it is shown once, here.', done: '',
  touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'revoke',
  ownerOnly: { reason: 'it makes a token that gives a device access', instead: 'The Devices and network place lists what is paired.' },
  reveals: { label: 'One-time token', note: 'Sign the device in with it now: it is shown this once and cannot be read again. Then retire the old shared token on the Paired tab.' },
  example: { name: 'Old tablet' },
  async run(values, _services, caller) {
    if (!caller.method) throw new CapabilityRefusal('A token is made by the daemon\'s own method, which this run cannot reach.', 'Run it from the Devices and network place or goodvibes do.');
    const answer = await caller.method('pairing.tokens.migrate', { name: values.name?.trim() || 'migrated device' });
    const token = answer !== null && typeof answer === 'object' ? (answer as { token?: { id?: unknown; name?: unknown; token?: unknown } }).token : undefined;
    const value = typeof token?.token === 'string' ? token.token : '';
    const id = typeof token?.id === 'string' ? token.id : '';
    const name = typeof token?.name === 'string' ? token.name : values.name || 'migrated device';
    if (!value || !id) throw new CapabilityRefusal('The daemon made no token: its answer held none.', 'Read the Paired tab again; nothing new is listed if nothing was made.');
    return { text: `Made a token of its own for "${name}" (id ${shortId(id)}).`, data: { id, name }, reveal: { value } };
  },
};

/** Every devices capability that runs through its own daemon method. */
export const DEVICES_CAPABILITIES: readonly MethodCapabilityDefinition[] = [
  DEVICES_LIST, DEVICES_RENAME, DEVICES_REVOKE, DEVICES_REVOKE_SHARED,
  DEVICES_RELAY_STATUS, DEVICES_RELAY_CODES, DEVICES_RELAY_REVOKE,
  DEVICES_REQUESTS, DEVICES_APPROVE, DEVICES_REJECT,
  DEVICES_NODES, DEVICES_REVOKE_GRANT, DEVICES_CAPTURES, DEVICES_DELETE_CAPTURE,
];
