/**
 * The machine group: this daemon's group with your other GoodVibes machines on
 * the network, which shares inbound channel work and a few settings. Kept and
 * run by the daemon's group runtime (cluster/group-operations.ts); these
 * definitions call the same verbs the daemon's `/api/cluster/*` routes and the
 * `goodvibes-daemon cluster` command call, so every way in reaches one
 * implementation. Every name and reason in an answer was chosen by another
 * machine on the network, so the words are made printable before they are
 * shown.
 */
import { AFTER_REPLY, type ClusterGroupVerbs } from '../../daemon/http/cluster-group-routes.js';
import type { GroupOperationResult } from '../../cluster/group-operations.js';
import { generateQrMatrix, renderQrToString } from '../../pairing/qr-generator.js';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type CapabilityResult, type InputDescription, type ListName } from '../types.js';

/** What the group capabilities need: the daemon's group verbs, or null where this daemon composed no group runtime. */
export interface ClusterCapabilityServices {
  readonly cluster: { verbs(): ClusterGroupVerbs | null };
}

type Definition = CapabilityDefinition<ClusterCapabilityServices>;

/** Control characters and escapes out of words another machine chose. */
function plain(value: unknown): string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim() : '';
}

const when = (at: unknown): string => typeof at === 'number' && Number.isFinite(at) ? new Date(at).toISOString().slice(0, 16).replace('T', ' ') : 'never';

/** The group key in plain words, never "generation N": how often it changed, and when last when that is known. */
function keyChanged(generation: number, changedAt?: number | null): string {
  if (generation <= 0) return typeof changedAt === 'number' ? `not changed since the group started on ${when(changedAt)}` : 'not changed since the group started';
  const times = generation === 1 ? 'once' : generation === 2 ? 'twice' : `${generation} times`;
  return `changed ${times}${typeof changedAt === 'number' ? `, last on ${when(changedAt)}` : ''}`;
}

function verbsOf(services: ClusterCapabilityServices): ClusterGroupVerbs {
  const verbs = services.cluster.verbs();
  if (!verbs) throw new CapabilityRefusal('This daemon runs no machine group, so there is no group to read or change.', 'Groups run on a daemon started as a service on this network.');
  return verbs;
}

const SHARING_OFF_NEXT = 'Turn sharing on under Nearby groups in Devices and network: the daemon restarts to bring the group up.';

/** The answer's data, or the daemon's refusal in its own words with its fix. */
function settled<T>(result: GroupOperationResult<T>): T {
  // A restart through the service the answer carries (a kept action, sharing turned on): the `/api/cluster` routes run
  // it once their reply is written; here it begins on the next turn, after this answer is handed back (as a setting
  // that takes effect at start does: facade-lifecycle.ts restartToApply).
  const after = (result as { readonly [AFTER_REPLY]?: () => void })[AFTER_REPLY];
  if (result.ok && after) setImmediate(after);
  if (result.ok) return result.data;
  const failure = result as { readonly error: string; readonly fix: string; readonly failure?: string };
  // The way on is in the sentence itself: a place says a refusal's words alone.
  if (failure.failure === 'sharing-off') throw new CapabilityRefusal(`${plain(failure.error)}. ${SHARING_OFF_NEXT}`, SHARING_OFF_NEXT, 'CLUSTER_SHARING_OFF');
  throw new CapabilityRefusal(`${plain(failure.error)}.`, plain(failure.fix) || undefined);
}

/** A kept action that finishes after the restart says so, not a result it does not have yet. */
function pending(data: unknown): string | undefined {
  const fields = data as { readonly pending?: unknown; readonly warning?: unknown } | null;
  if (fields?.pending !== true) return undefined;
  return plain(fields.warning) || 'Sharing is on; this finishes when the daemon next starts.';
}

/**
 * A group action implies sharing with the group: joining, renaming, a new key, removing a machine, sharing or taking a
 * setting must reach the other machines, so when sharing is off it is turned on as part of the act (the daemon restarts
 * and the act finishes then). Nothing is asked about it: the act pressed is the request.
 */
const sharingOf = (_values: Readonly<Record<string, string>>): { turnOnSharing: true } => ({ turnOnSharing: true });

/** The shared settings that differ between this machine and the group, each with both values (cluster.differences). */
export const CLUSTER_SETTING_DIFFERENCES_LIST = 'cluster.setting-differences' as ListName;

const SETTING: InputDescription = {
  id: 'setting', label: 'Shared setting', help: 'A shared setting whose value differs between this machine and the group, or user:<name> for a person\'s account (sharing it makes this machine\'s account of that name the group\'s and ends the others; taking it ends this machine\'s)', kind: 'choice',
  choices: { list: CLUSTER_SETTING_DIFFERENCES_LIST }, required: true, typed: { position: 1 },
};

/** A setting's value as a person reads it: short, one line, never a secret (the differences never hold one). */
function shownValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'not set';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const one = plain(text);
  return one.length > 60 ? `${one.slice(0, 59)}…` : one;
}

export const CLUSTER_DIFFERENCES: Definition = {
  capability: { id: 'cluster.differences', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'differences', label: 'See the settings that differ from the group\'s', word: 'differences', inputs: [],
  sentence: 'Lists the shared settings whose value on this machine differs from the group\'s, with both values.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const verbs = verbsOf(services);
    if (!verbs.differences) throw new CapabilityRefusal('This daemon cannot list the settings that differ from the group\'s.');
    const differences = settled(verbs.differences());
    const settings = differences.map((difference) => {
      const account = difference.path.startsWith('user:');
      const shown = account
        ? `an account named ${plain(difference.path.slice('user:'.length))} here and another in the group`
        : `here: ${shownValue(difference.here)} · the group (from ${plain(difference.groupFrom)}): ${shownValue(difference.group)}`;
      return { path: difference.path, shown };
    });
    if (settings.length === 0) return { text: 'No shared setting differs between this machine and the group.', data: { settings: [] } };
    return { text: settings.map((setting) => `${setting.path}: ${setting.shown}`).join('\n'), data: { settings } };
  },
};

export const CLUSTER_STATUS: Definition = {
  capability: { id: 'cluster.status', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'status', label: 'See this machine\'s group', word: 'status', inputs: [],
  sentence: 'Shows the group this machine is in with your other machines on the network, its members and its key\'s age.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const report = settled(await verbsOf(services).status());
    if (report.membership === 'no-group') {
      // Removed by another member: said, so a machine that was in a group is not shown as one that never was.
      const removed = report.removedFrom;
      if (removed) {
        const from = plain(removed.groupName) ? `"${plain(removed.groupName)}"` : 'its group';
        return { text: `This machine (${plain(report.nodeName)}) is in no group: another machine removed it from ${from} on ${when(removed.at)}. To be in it again, join it from Nearby groups with the key a machine in it shows.`, data: { report } };
      }
      return { text: `This machine (${plain(report.nodeName)}) is in no group. Start one, or join one a machine on this network announces.`, data: { report } };
    }
    if (report.membership === 'unreadable-key-material') {
      return { text: 'This machine\'s group key could not be read, so it cannot take part in its group. Leave the group and join it again with its key.', data: { report } };
    }
    return {
      text: [
        `This machine (${plain(report.nodeName)}) is in "${plain(report.groupName)}" with ${report.memberCount} machine${report.memberCount === 1 ? '' : 's'}.`,
        ...(report.keyGeneration !== null ? [`The group key: ${keyChanged(report.keyGeneration, report.keyChangedAt)}.`] : []),
        ...(report.replication?.awaitingSync ? ['This machine does not hold the group\'s settings yet.'] : []),
        ...(report.sharing === 'off' ? ['Sharing is off on this computer, so it is not on the group\'s network: nothing reaches the other machines from it until sharing is on.'] : []),
      ].join('\n'),
      data: { report },
    };
  },
};

/** What Nearby groups says while sharing is off: this machine is not on the group's network, so it hears no group. */
export const SHARING_OFF_NEARBY = 'Sharing is off on this computer, so it cannot see groups on the network.';
/** The same once sharing was turned on and the daemon has not started again yet. */
export const SHARING_NEXT_START_NEARBY = 'Sharing is turned on and takes effect when the daemon starts again; until then this computer cannot see groups on the network.';

export const CLUSTER_GROUPS: Definition = {
  capability: { id: 'cluster.groups', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'groups', label: 'See the groups on this network', word: 'groups', inputs: [],
  sentence: 'Shows the groups other GoodVibes machines on this network announce, to join one.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const verbs = verbsOf(services);
    // Sharing off, this machine listens to nothing: "no group is announced" would not be true.
    const status = await verbs.status();
    if (status.ok && status.data.sharing === 'off') return { text: `${SHARING_OFF_NEARBY} Turning sharing on restarts the daemon to bring it onto the network.`, data: { groups: [], sharing: 'off' } };
    if (status.ok && status.data.sharing === 'next-start') return { text: SHARING_NEXT_START_NEARBY, data: { groups: [], sharing: 'next-start' } };
    const groups = settled(await verbs.groups());
    if (groups.length === 0) return { text: 'No group is announced on this network.', data: { groups: [], sharing: 'on' } };
    return {
      text: [`Groups on this network (${groups.length}):`, ...groups.map((group) => `  ${plain(group.displayName)} (${plain(group.groupId)}): ${group.nodeCount} machine${group.nodeCount === 1 ? '' : 's'}, last heard ${when(group.lastSeenAt)}`)].join('\n'),
      data: { groups: groups.map((group) => ({ ...group, displayName: plain(group.displayName) })), sharing: 'on' },
    };
  },
};

export const CLUSTER_SHARING_ON: Definition = {
  capability: { id: 'cluster.sharing-on', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'sharing-on', label: 'Turn sharing on', word: 'sharing-on', inputs: [],
  sentence: 'Sharing with your other GoodVibes machines on this network is turned on {lasts}: the daemon restarts to bring it up, and then this machine hears the groups announced here and can start or join one.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'none', example: {},
  async run(_values, services) {
    const verbs = verbsOf(services);
    if (!verbs.sharingOn) throw new CapabilityRefusal('This daemon cannot turn sharing on by itself.', 'Set "cluster.enabled" to on in Settings, then restart the daemon.');
    const result = settled(await verbs.sharingOn());
    if (result.already) return { text: 'Sharing is already on on this computer.', data: { sharing: 'on' } };
    return { text: pending(result) ?? 'Sharing is on from the daemon\'s next start.', data: { sharing: 'on', pending: true, ...(result.restart ? { restart: result.restart } : {}) } };
  },
};

export const CLUSTER_CREATE: Definition = {
  capability: { id: 'cluster.create', group: 'devices', home: 'daemon', repeat: 'unsafe' },
  actionId: 'create', label: 'Start a group on this network', word: 'create',
  inputs: [
    { id: 'name', label: 'Group name', help: 'A name the other machines on this network will see', kind: 'text', freeTextReason: 'a name you choose', required: { default: '', defaultMeans: '"goodvibes group"' }, typed: { flag: '--name' } },
    { id: 'passphrase', label: 'Passphrase', help: 'A phrase the join key is made from; hidden as you type', kind: 'secret', required: { default: '', defaultMeans: 'a random key' }, typed: { flag: '--passphrase' } },
  ],
  sentence: 'A new group is started on this machine, until you change it; other machines join it with its key.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'leave', example: { name: 'the workshop' },
  async run(values, services) {
    const created = settled(await verbsOf(services).create({
      ...(values.name ? { name: values.name } : {}), ...(values.passphrase ? { passphrase: values.passphrase } : {}),
    }));
    // The join key is shown only when asked for (cluster.key), never in a result kept in a conversation.
    return {
      text: `Started the group "${plain(created.groupName)}". To add another machine, show the key others join with.`,
      data: { groupId: created.groupId, groupName: plain(created.groupName) },
    };
  },
};

export const CLUSTER_JOIN: Definition = {
  capability: { id: 'cluster.join', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'join', label: 'Join a group', word: 'join',
  inputs: [
    { id: 'group', label: 'Group', help: 'The group\'s id, as the groups on this network show it', kind: 'text', freeTextReason: 'the id another machine announced', required: true, typed: { position: 1 } },
    { id: 'key', label: 'Join key', help: 'The key a machine already in the group shows; hidden as you type', kind: 'secret', required: true, typed: { flag: '--key' } },
  ],
  // Joining a group implies sharing with it: when sharing is off, joining turns it on (the daemon restarts and joins then).
  sentence: 'This machine joins {group} and shares inbound channel work with its members, until you change it; sharing is turned on as part of joining when it is off.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'sends-out', undoneBy: 'leave', example: { group: 'g-41a2', key: 'abc' },
  async run(values, services) {
    const joined = settled(await verbsOf(services).join({ groupId: values.group!, joinKey: values.key!, turnOnSharing: true }));
    const later = pending(joined);
    // Kept for the daemon's next start: nothing has gone out yet.
    if (later) return { text: later, data: { groupId: joined.groupId, pending: true }, riskDone: 'Nothing was sent yet: the join goes out when the daemon starts again.' };
    return {
      text: [`Joined "${plain(joined.groupName)}" with ${joined.memberCount} machine${joined.memberCount === 1 ? '' : 's'}.`, ...(plain(joined.warning) ? [plain(joined.warning)] : [])].join('\n'),
      data: { groupId: joined.groupId, groupName: plain(joined.groupName), memberCount: joined.memberCount },
    };
  },
};

export const CLUSTER_NODES: Definition = {
  capability: { id: 'cluster.nodes', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'nodes', label: 'See the machines in the group', word: 'nodes', inputs: [],
  sentence: 'Shows each machine in the group, when it was last heard and which was removed.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const verbs = verbsOf(services);
    // In no group, there are no machines to list: that is the answer, not a failure.
    const status = await verbs.status();
    if (status.ok && status.data.membership === 'no-group') return { text: 'This machine is in no group, so there are no machines to list.', data: { members: [], removed: [] } };
    const nodes = settled(await verbs.nodes());
    const members = nodes.members.map((member) => ({ ...member, displayName: plain(member.displayName) }));
    return {
      text: [
        `Machines in "${plain(nodes.groupName)}" (${members.length}):`,
        ...members.map((member) => `  ${member.displayName}${member.isThisMachine ? ' (this machine)' : ''}: ${member.heardSinceStart ? `last heard ${when(member.lastSeenAt)}` : 'not heard since this machine started'}`),
        ...(nodes.removed.length > 0 ? [`Removed: ${nodes.removed.map((removed) => plain(removed.nodeId)).join(', ')}`] : []),
      ].join('\n'),
      data: { groupId: nodes.groupId, groupName: plain(nodes.groupName), members, removed: nodes.removed },
    };
  },
};

export const CLUSTER_VIEW: Definition = {
  capability: { id: 'cluster.view', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'view', label: 'See another machine\'s view of the group', word: 'view',
  inputs: [{ id: 'node', label: 'Machine', help: 'Another machine of the group, by its name or id, as the machines in the group show it', kind: 'text', freeTextReason: 'a machine of the group', required: true, typed: { position: 1 } }],
  sentence: 'Asks {node} for its own view of the group, over the group\'s channel: the machines it hears and when, its group key, and whether it holds the group\'s settings.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { node: 'garage-pi' },
  async run(values, services) {
    const verbs = verbsOf(services);
    if (!verbs.view) throw new CapabilityRefusal('This daemon cannot ask another machine for its view of the group.');
    const asked = settled(await verbs.view(values.node!));
    const name = plain(asked.displayName) || asked.nodeId.slice(0, 8);
    const outcome = asked.outcome;
    if (!outcome.ok) {
      const last = outcome.lastHeardAt !== null ? `it was last heard ${when(outcome.lastHeardAt)}` : 'nothing was heard from it since this machine started';
      return {
        text: outcome.reason === 'silent'
          ? `${name} cannot be reached: ${last}, so it was not asked. Its view shows here once it is on the network again.`
          : `${name} did not answer: it was asked over the group's channel and gave no answer within a few seconds; ${last}.`,
        data: { nodeId: asked.nodeId, reached: false, reason: outcome.reason },
      };
    }
    const view = outcome.view;
    const machines = view.machines.map((machine) => `${plain(machine.name)}${machine.thisMachine ? ' (itself)' : machine.heard ? ` (heard ${when(machine.lastSeenAt)})` : ' (not heard since it started)'}`);
    return {
      text: [
        `${name} sees "${plain(view.groupName)}" with ${view.machines.length} machine${view.machines.length === 1 ? '' : 's'}: ${machines.join(', ')}.`,
        ...(view.keyGeneration !== null ? [`Its group key: ${keyChanged(view.keyGeneration)}.`] : []),
        ...(view.awaitingSync ? [`${name} does not hold the group's settings yet.`] : []),
        `It answered at ${when(view.at)}.`,
      ].join('\n'),
      data: { nodeId: asked.nodeId, reached: true, view: { ...view, nodeName: plain(view.nodeName), groupName: plain(view.groupName) } },
    };
  },
};

export const CLUSTER_KEY: Definition = {
  capability: { id: 'cluster.key', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'key', label: 'See the key others join with', word: 'key',
  inputs: [{ id: 'qr', label: 'Also as a QR code', help: 'Show the key as a QR code to scan', kind: 'yes-no', choices: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }], required: { default: 'no', defaultMeans: 'text only' }, typed: { flag: '--qr' } }],
  sentence: 'Shows the group\'s join key; anyone with it can join the group.', done: '',
  touches: 'credential', lasts: 'not-a-change', risk: 'none',
  ownerOnly: { reason: 'the join key lets any machine on the network join the group', instead: 'The Machine group tab of Devices and network shows the group and its machines.' },
  reveals: { label: 'Join key', note: 'Anyone with it can join the group. Type it on the other machine, under Nearby groups, join; this place shows it again when asked.' },
  example: {},
  async run(values, services) {
    const key = settled(await verbsOf(services).key());
    // The key is the outcome's reveal (shown in its own pane, returned only to the owner who asked), never its words.
    return {
      text: `The join key of "${plain(key.groupName)}" is shown for a machine to join it.`,
      data: { groupId: key.groupId, groupName: plain(key.groupName) },
      reveal: { value: key.joinKey, ...(values.qr === 'yes' ? { qr: renderQrToString(generateQrMatrix(key.joinKey)) } : {}) },
    };
  },
};

export const CLUSTER_RENAME: Definition = {
  capability: { id: 'cluster.rename', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'rename', label: 'Rename the group', word: 'rename',
  inputs: [{ id: 'name', label: 'New name', help: 'The name the machines will see; anything on this network can read it', kind: 'text', freeTextReason: 'a name you choose', required: true, typed: { tail: true } }],
  sentence: 'The group is named "{name}" on every machine, until you change it.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'none', example: { name: 'the workshop' },
  async run(values, services) {
    const renamed = settled(await verbsOf(services).rename(values.name!, sharingOf(values)));
    return { text: pending(renamed) ?? `The group is now called "${plain(renamed.groupName)}"; every machine in it picks the name up shortly.`, data: { groupId: renamed.groupId, groupName: plain(renamed.groupName) } };
  },
};

export const CLUSTER_ROTATE: Definition = {
  capability: { id: 'cluster.rotate', group: 'devices', home: 'daemon', repeat: 'unsafe' },
  // The group key the machines sign with is replaced either way; the join key a person types only with "Stops working
  // now" (group-operations.ts rotateGroupKeyOwned: joinKeyReplaced only when immediate).
  actionId: 'rotate', label: 'Change the group\'s key', word: 'rotate',
  inputs: [
    { id: 'when', label: 'The old key', help: 'Whether the old key still works for a while', kind: 'choice', choices: [{ value: 'grace', label: 'Keeps working for a while', help: 'The join key stays the same.' }, { value: 'now', label: 'Stops working now', help: 'A machine that has not picked up the new key is cut off, and the join key is replaced: a machine joining later needs the new one.', risk: 'cannot-be-undone' }], required: { default: 'grace', defaultMeans: 'keeps working for a while' }, typed: { flag: '--now', switchOn: 'now' } },
  ],
  sentence: 'The group gets a new key, until you change it; machines pick it up on their own. The join key is replaced too only when the old key stops working now.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'none', example: {},
  async run(values, services) {
    const rotated = settled(await verbsOf(services).rotate({ immediate: values.when === 'now', ...sharingOf(values) }));
    return {
      text: pending(rotated) ?? `The group has a new key${rotated.immediate ? '; the old key stopped working at once' : '; the old one keeps working for a few minutes'}.${rotated.joinKeyReplaced ? ' The join key was replaced too.' : ''}`,
      data: { keyGeneration: rotated.keyGeneration, immediate: rotated.immediate, joinKeyReplaced: rotated.joinKeyReplaced === true },
    };
  },
};

export const CLUSTER_FORGET: Definition = {
  capability: { id: 'cluster.forget', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'forget', label: 'Remove a machine from the group', word: 'forget',
  inputs: [{ id: 'node', label: 'Machine', help: 'The machine\'s name or id, as the machines in the group show it', kind: 'text', freeTextReason: 'a machine of the group', required: true, typed: { position: 1 } }],
  // Joining again with the group's new key puts the machine back, so it is not "cannot be undone"; the sentence says
  // what changes at once (the same reasoning as leaving).
  sentence: '{node} is removed from the group: the group key and the join key are replaced at once, so it takes no part in the group until it joins again with the new key.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'none', example: { node: 'garage-pi' },
  async run(values, services) {
    const forgotten = settled(await verbsOf(services).forget(values.node!, sharingOf(values)));
    return {
      text: pending(forgotten) ?? `Removed ${plain(forgotten.displayName)} from the group; ${forgotten.memberCount} machine${forgotten.memberCount === 1 ? ' remains' : 's remain'}, and the group has a new key and a new join key.`,
      data: { nodeId: forgotten.nodeId, memberCount: forgotten.memberCount },
    };
  },
};

export const CLUSTER_LEAVE: Definition = {
  capability: { id: 'cluster.leave', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'leave', label: 'Leave the group', word: 'leave', inputs: [],
  // Joining again with the key undoes it, so it is not "cannot be undone": the sentence says what stops until then.
  sentence: 'This machine leaves its group. Until it joins again with the group\'s key, it takes no part in the group\'s channel work, its settings are no longer kept in step with the group, and it serves its own secure address instead of the group\'s.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'none', example: {},
  async run(_values, services) {
    const left = settled(await verbsOf(services).leave());
    return { text: `Left "${plain(left.groupName)}". The other machines still list this one until one of them removes it.`, data: { groupId: left.groupId } };
  },
};

function settingDecision(decision: 'publish' | 'accept'): Definition {
  const publish = decision === 'publish';
  return {
    capability: { id: `cluster.${decision}`, group: 'devices', home: 'daemon', repeat: 'safe' },
    actionId: decision, label: publish ? 'Share a setting with the group' : 'Take the group\'s value of a setting', word: decision,
    inputs: [SETTING],
    // A setting is no one's account: the sentence names none. A person's account (user:<name>) is said by its result.
    sentence: publish
      ? '{setting} on every machine in the group is replaced with this machine\'s value.'
      : 'This machine\'s {setting} is replaced with the group\'s.',
    done: '', touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { setting: 'provider.model' },
    async run(values, services) {
      const verbs = verbsOf(services);
      const result = settled(await (publish ? verbs.publish(values.setting!, sharingOf(values)) : verbs.accept(values.setting!, sharingOf(values))));
      const later = pending(result);
      if (later) return { text: later, data: { path: result.path, pending: true } };
      const user = result.path.startsWith('user:') ? result.path.slice('user:'.length) : null;
      const text = user !== null
        ? (result.decision === 'accepted'
          ? `This machine's account of "${user}" was given up; the group's account is the one on every machine now.`
          : `This machine's account of "${user}" is the group's on every machine now; the other accounts of that name end.`)
        : result.decision === 'accepted' ? `This machine now runs the group's value of ${result.path}.`
          : result.decision === 'held' ? `This machine's value of ${result.path} is held and sent to the group once this machine has the group's settings.`
            : `This machine's value of ${result.path} was sent to every machine in the group.`;
      return { text, data: { path: result.path, decision: result.decision } };
    },
  };
}

export const CLUSTER_PUBLISH = settingDecision('publish');
export const CLUSTER_ACCEPT = settingDecision('accept');

/**
 * Another machine's daemon, as `goodvibes-daemon cluster --host --token` reaches it: its address and its token (typed
 * hidden). A machine in your group needs neither: the group's actions (rename, new key, remove, share or take a
 * setting) reach every member from this machine, and its row in the Machines tab is the one to act on.
 */
const ON_MACHINE: readonly InputDescription[] = [
  {
    id: 'address', label: 'On another machine', kind: 'text', freeTextReason: 'the address that daemon answers at',
    help: 'Blank: this machine\'s daemon. A daemon on another machine, by its address (https://host:3421); a machine already in your group needs no address',
    required: { default: '', defaultMeans: 'this machine\'s daemon' }, typed: { flag: '--host' },
    // A place's form never asks it: a group's acts reach every member from the machine they are pressed on.
    showWhen: { suppliedBy: 'a script or an agent that names another machine\'s daemon' },
  },
  {
    id: 'token', label: 'Its token', kind: 'secret', help: 'The operator token of the daemon at that address; hidden as you type, sent only there',
    required: { default: '', defaultMeans: 'none' }, typed: { flag: '--token' },
    showWhen: { suppliedBy: 'a script or an agent that names another machine\'s daemon' },
  },
];

/** The words another machine's daemon answered, made printable. */
const said = (value: unknown): string => typeof value === 'string' ? value.split('\n').map(plain).filter(Boolean).join('\n') : '';

/**
 * Run the same capability on the daemon at `address` (its own `capabilities.run`, with its token), as the person's
 * request when the person asked here. Undefined when no address was given: it runs on this daemon.
 */
async function onAnotherMachine(id: string, values: Readonly<Record<string, string>>, caller: CapabilityCaller): Promise<CapabilityResult | undefined> {
  const address = values.address?.trim() ?? '';
  if (!address) return undefined;
  let origin: URL;
  try { origin = new URL(address); } catch { throw new CapabilityRefusal(`"${plain(address)}" is not an address: give it as https://host:port.`); }
  if (origin.protocol !== 'https:' && origin.protocol !== 'http:') throw new CapabilityRefusal(`"${plain(address)}" is not a web address: give it as https://host:port.`);
  if (!values.token) throw new CapabilityRefusal(`Nothing was sent to ${origin.origin}: give that daemon's token (its operator token, typed hidden).`);
  const inputs = Object.fromEntries(Object.entries(values).filter(([input]) => input !== 'address' && input !== 'token'));
  let response: Response;
  try {
    response = await fetch(new URL('/api/control-plane/methods/capabilities.run/invoke', origin), {
      method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${values.token}`, 'content-type': 'application/json', ...(caller.personAsked ? { 'x-goodvibes-explicit-user-request': 'true' } : {}) },
      body: JSON.stringify({ body: { id, inputs } }),
    });
  } catch (error) {
    throw new CapabilityRefusal(`Could not reach the daemon at ${origin.origin}: ${error instanceof Error ? plain(error.message) : 'no answer'}.`, 'Check that machine is on and its daemon listens at that address.');
  }
  const body = await response.json().catch(() => ({})) as { text?: unknown; detail?: unknown; error?: unknown; next?: unknown; data?: unknown; reveal?: { value?: unknown; qr?: unknown } };
  if (!response.ok) {
    const next = Array.isArray(body.next) && typeof body.next[0] === 'string' ? plain(body.next[0]) : undefined;
    throw new CapabilityRefusal(`The daemon at ${origin.origin} did not do it: ${said(body.error) || `it answered ${response.status}`}`, next);
  }
  const data = body.data !== null && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data as Record<string, unknown> : {};
  const value = typeof body.reveal?.value === 'string' ? body.reveal.value : '';
  return {
    text: `On ${origin.origin}: ${said(body.detail) || said(body.text) || 'done.'}`,
    data: { ...data, machine: origin.origin },
    ...(value ? { reveal: { value, ...(typeof body.reveal?.qr === 'string' ? { qr: body.reveal.qr } : {}) } } : {}),
  };
}

/** A group capability that also runs on another machine's daemon, given its address and token. */
function onAnyMachine(definition: Definition): Definition {
  return {
    ...definition,
    inputs: [...definition.inputs, ...ON_MACHINE],
    async run(values, services, caller) {
      return (await onAnotherMachine(definition.capability.id, values, caller)) ?? definition.run(values, services, caller);
    },
  };
}

/**
 * Every machine-group capability, in the order a person meets them, each also for another machine's daemon, except
 * joining: a machine joins from its own Nearby groups, and nothing is asked there beyond the key.
 */
export const CLUSTER_CAPABILITIES: readonly Definition[] = [
  ...[CLUSTER_STATUS, CLUSTER_GROUPS, CLUSTER_SHARING_ON, CLUSTER_CREATE].map(onAnyMachine),
  CLUSTER_JOIN,
  ...[CLUSTER_NODES, CLUSTER_VIEW, CLUSTER_KEY, CLUSTER_RENAME, CLUSTER_ROTATE, CLUSTER_FORGET, CLUSTER_LEAVE, CLUSTER_DIFFERENCES, CLUSTER_PUBLISH, CLUSTER_ACCEPT].map(onAnyMachine),
];
