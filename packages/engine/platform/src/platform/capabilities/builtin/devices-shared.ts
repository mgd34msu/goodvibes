/**
 * Devices and network: which of the owner's shared things (control-plane/shared-kinds.ts: his mail, calendar,
 * channels, knowledge library, money, profile, dates, home, notifications) a paired device, a signed-in member, the
 * outside agent or the operator token may reach. Default none, whatever a credential's scopes say: only the owner
 * himself, his programs and his own turns reach them. Given and taken back on the caller's row as a project is
 * (capabilities/builtin/devices-projects.ts); a caller that tries a kind it was not given puts one question to him the
 * first time (daemon/shared-kind-gifts.ts), and his yes there is the same gift. Kept in `<daemon home>/caller-shared.json`.
 */
import { CapabilityRefusal, type CapabilityDefinition, type InputDescription } from '../types.js';
import { SHARED_KINDS, SHARED_KIND_WORDS, isSharedKind, type SharedKind } from '../../control-plane/shared-kinds.js';
import { currentRecordReach } from '@goodvibes/engine/daemon-api';

/** What these capabilities need: the daemon's one record of the shared kinds each caller was given. */
export interface CallerSharedCapabilityServices {
  readonly callerShared?: {
    list(): Readonly<Record<string, readonly SharedKind[]>>;
    kindsOf(principalId: string): readonly SharedKind[];
    set(principalId: string, kinds: readonly SharedKind[]): readonly SharedKind[];
  } | undefined;
}

type Definition = CapabilityDefinition<CallerSharedCapabilityServices>;

const WHO: InputDescription = {
  id: 'who', label: 'Device or member', help: 'A paired device (pairing:<its id>, as its row fills it), a member\'s sign-in name, or the operator token (local)',
  kind: 'text', freeTextReason: 'the device\'s or member\'s name as the daemon knows it', required: true, typed: { position: 1 },
};
const KIND: InputDescription = {
  id: 'kind', label: 'What of yours', help: 'One of your shared things', kind: 'choice', required: true, typed: { position: 2 },
  choices: SHARED_KINDS.map((kind) => ({ value: kind, label: `${kind}: ${SHARED_KIND_WORDS[kind]}` })),
};
const OWNERS_OWN = { reason: 'it decides which of your own things (mail, calendar, money, ...) another device or person may reach', instead: 'Ask the owner to give it in Devices and network, on the device\'s row.' };

function storeOf(services: CallerSharedCapabilityServices): NonNullable<CallerSharedCapabilityServices['callerShared']> {
  if (!services.callerShared) throw new CapabilityRefusal('This daemon keeps no record of what of yours devices may reach; nothing was read or changed.', undefined, 'UNAVAILABLE');
  return services.callerShared;
}

function principalOf(raw: string | undefined): string {
  const who = (raw ?? '').trim();
  if (!who) throw new CapabilityRefusal('Name the device or the member; nothing was changed.');
  return who;
}

function kindOf(raw: string | undefined): SharedKind {
  const kind = (raw ?? '').trim();
  if (!isSharedKind(kind)) throw new CapabilityRefusal(`"${kind}" is none of your shared things; nothing was changed.`, `Choose one of: ${SHARED_KINDS.join(', ')}.`);
  return kind;
}

export const DEVICES_SHARED: Definition = {
  capability: { id: 'devices.shared', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'shared', label: 'See what of yours each device or member may reach', word: 'shared', inputs: [],
  sentence: 'Lists each paired device and member given something of yours that belongs to no project (mail, calendar, money, ...); one not listed reaches none of it.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    // The owner's own record of who reaches his things: his alone to read (anyone else's call runs with a reach filter).
    if (currentRecordReach()) throw new CapabilityRefusal('Only the owner sees who may reach his own things; nothing was read.', undefined, 'OWNER_ONLY');
    const rows = Object.entries(storeOf(services).list()).map(([who, kinds]) => ({ id: who, who, kinds: [...kinds] }));
    if (rows.length === 0) return { text: `No device or member has been given anything of yours: each reaches none of your ${SHARED_KINDS.join(', ')}.`, data: { callers: rows } };
    return { text: ['What of yours each device or member may reach', ...rows.map((row) => `  ${row.who}: ${row.kinds.join(', ')}`)].join('\n'), data: { callers: rows } };
  },
};

export const DEVICES_GIVE_SHARED: Definition = {
  capability: { id: 'devices.give-shared', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'give-shared', label: 'Let a device or member reach something of yours', word: 'give-shared', inputs: [WHO, KIND],
  sentence: '{who} may reach your {kind} until you take it back.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'take-shared', ownerOnly: OWNERS_OWN,
  example: { who: 'pairing:a1b2c3', kind: 'calendar' },
  async run(values, services) {
    const who = principalOf(values.who);
    const kind = kindOf(values.kind);
    const store = storeOf(services);
    const kinds = store.set(who, [...store.kindsOf(who), kind]);
    return { text: `${who} may now ${SHARED_KIND_WORDS[kind]}. It reaches: ${kinds.join(', ')}.`, data: { who, kind, kinds: [...kinds] } };
  },
};

export const DEVICES_TAKE_SHARED: Definition = {
  capability: { id: 'devices.take-shared', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'take-shared', label: 'Stop a device or member reaching something of yours', word: 'take-shared', inputs: [WHO, KIND],
  sentence: '{who} may no longer reach your {kind}.', done: '',
  // It only takes something away: never refused or asked of anyone.
  touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'give-shared', tightens: true,
  example: { who: 'pairing:a1b2c3', kind: 'calendar' },
  async run(values, services) {
    const who = principalOf(values.who);
    const kind = kindOf(values.kind);
    const store = storeOf(services);
    const had = store.kindsOf(who);
    if (!had.includes(kind)) throw new CapabilityRefusal(`${who} was not given your ${kind}; nothing was changed.`, '"See what of yours each device or member may reach" lists them.', 'NOT_FOUND');
    const kept = store.set(who, had.filter((entry) => entry !== kind));
    return { text: kept.length > 0 ? `${who} no longer reaches your ${kind}; it keeps ${kept.join(', ')}.` : `${who} no longer reaches your ${kind}; it reaches nothing of yours now.`, data: { who, kinds: [...kept] } };
  },
};

export const CALLER_SHARED_CAPABILITIES: readonly Definition[] = [DEVICES_SHARED, DEVICES_GIVE_SHARED, DEVICES_TAKE_SHARED];
