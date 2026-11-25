/**
 * safety-place.ts, the Permissions and safety place: what GoodVibes asks you
 * about and the rules that decide without asking, your secrets, this folder's
 * trust, who may sign in, who is who across channels, the paired devices'
 * tokens, the phones' always-allow grants, and the sandbox sessions this
 * program started.
 *
 *  - This conversation (the program's own): the mode in force and plan mode.
 *  - Rules: `permissions.rules` (through `permissions.rules.list`), followed on the `safety` list.
 *  - Secrets, This folder, Device tokens: their capabilities through
 *    `capabilities.run` (the place host sends this program's folder and name).
 *  - Sign-in and Signed in: `local_auth.status` (one call for both lists).
 *  - Who is who: `principals.list`, followed on the `people` list.
 *  - Phone grants: `devices.grants.list`.
 *  - Sandbox (the terminal app's own): the sandbox sessions it started.
 *
 * Every action is a capability (capabilities/builtin/permissions.ts,
 * secrets.ts, security.ts, plan.ts, safety-methods.ts, devices.ts), the same
 * the model and a script run; only one that weakens a protection or cannot
 * be undone asks first.
 */
import type { SessionCapabilityServices } from '../agent-turn/capability-tools.js';
import type { PlaceProgramSource } from './place-host.js';
import { definePlace, type PlaceDetailLine, type PlaceItem, type PlaceList } from './place-types.js';

interface SafetyItem extends PlaceItem {
  readonly title: string;
  readonly right?: string | undefined;
  readonly mark?: 'ok' | 'paused' | 'attention' | 'running' | 'waiting' | undefined;
  readonly lines: readonly PlaceDetailLine[];
  /** The value an action fills from this item (a rule id, a secret's name, a user name, ...). */
  readonly fill: string;
}

/** Text from another process or a file, with control characters taken out before it is drawn. */
const plain = (value: unknown): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim() : '';
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function rows(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
/** A capability's answer read through `capabilities.run`: its `data`. */
function dataOf(output: unknown): Record<string, unknown> {
  return record(record(output).data);
}
function when(at: unknown): string {
  return typeof at === 'number' && Number.isFinite(at) && at > 0 ? new Date(at).toLocaleString() : 'not said';
}

// ---------------------------------------------------------------------------
// The lists
// ---------------------------------------------------------------------------

const EFFECT_WORDS: Readonly<Record<string, string>> = { allow: 'runs without asking', deny: 'refused', ask: 'asks you' };

function ruleItems(output: unknown): readonly SafetyItem[] {
  return rows(dataOf(output).rules).filter((rule) => plain(rule.id)).map((rule): SafetyItem => {
    const tool = plain(rule.tool);
    const tier = plain(rule.tier);
    const effect = plain(rule.effect);
    const project = plain(rule.project);
    return {
      id: plain(rule.id), state: effect || 'rule', fill: plain(rule.id),
      title: `${tool === '*' ? 'Any tool' : tool}: ${plain(rule.description) || plain(rule.id)}`,
      right: EFFECT_WORDS[effect] ?? effect,
      mark: effect === 'deny' ? 'paused' : effect === 'allow' ? 'attention' : 'ok',
      lines: [
        { label: 'Then', text: EFFECT_WORDS[effect] ?? effect },
        { label: 'Kind', text: tier === 'never-run' ? 'never run, in every mode' : `${plain(rule.id).startsWith('owner-') ? 'added by you' : 'remembered from an answer'} (${tier})` },
        { label: 'Where', text: project ? `in ${project}` : 'every project' },
        { label: 'Since', text: when(rule.createdAt), tone: 'muted' },
      ],
    };
  });
}

const SECRET_WORDS: Readonly<Record<string, string>> = { stored: 'stored', referenced: 'from a password manager', waiting: 'waits for you' };

function secretItems(output: unknown): readonly SafetyItem[] {
  return rows(dataOf(output).secrets).filter((secret) => plain(secret.key)).map((secret): SafetyItem => {
    const state = plain(secret.state) || 'stored';
    const where = Array.isArray(secret.where) ? secret.where.map(plain).filter(Boolean) : [];
    return {
      id: plain(secret.key), state, fill: plain(secret.key), title: plain(secret.key),
      ...(state !== 'stored' ? { right: SECRET_WORDS[state] ?? state } : secret.overridden === true ? { right: 'overridden' } : {}),
      mark: state === 'waiting' ? 'waiting' : 'ok',
      lines: [
        ...where.map((place) => ({ label: 'Kept', text: place })),
        ...(state === 'waiting' ? [{ text: 'This project\'s own copy is not used until you confirm it: whoever wrote the repository may have put it there.', tone: 'warning' as const }] : []),
        { text: 'Its value is never shown.', tone: 'muted' },
      ],
    };
  });
}

const FOLDER_WORDS: Readonly<Record<string, string>> = {
  trusted: 'trusted', restricted: 'restricted', undecided: 'not decided yet', unreadable: 'its record could not be read',
};

function folderItems(output: unknown): readonly SafetyItem[] {
  const folder = dataOf(output);
  const state = plain(folder.state);
  if (!state) return [];
  return [{
    id: 'this-folder', state, fill: plain(folder.folder), title: plain(folder.folder).split('/').filter(Boolean).pop() || 'This folder', right: FOLDER_WORDS[state] ?? state,
    mark: state === 'trusted' ? 'ok' : state === 'restricted' ? 'paused' : 'attention',
    lines: [
      { label: 'Folder', text: plain(folder.folder) },
      { text: plain(folder.meaning) },
      ...(state === 'undecided' || state === 'unreadable' ? [{ text: 'Until you decide, it counts as restricted.', tone: 'warning' as const }] : []),
      ...(plain(folder.fault) ? [{ label: 'Why', text: plain(folder.fault), tone: 'warning' as const }] : []),
    ],
  }];
}

function userItems(output: unknown): readonly SafetyItem[] {
  const status = record(output);
  return rows(status.users).filter((user) => plain(user.username)).map((user): SafetyItem => {
    const roles = Array.isArray(user.roles) ? user.roles.map(plain).filter(Boolean) : [];
    const admin = roles.includes('admin');
    return {
      id: plain(user.username), state: admin ? 'admin' : 'user', fill: plain(user.username), title: plain(user.username),
      right: admin ? 'administrator' : 'user', mark: 'ok',
      lines: [
        { label: 'Role', text: admin ? 'administrator: may also manage users, settings and the daemon' : 'user: may sign in and use the web app' },
      ],
    };
  });
}

function signedInItems(output: unknown): readonly SafetyItem[] {
  const status = record(output);
  return rows(status.sessions).filter((session) => plain(session.id)).map((session): SafetyItem => ({
    id: plain(session.id), state: 'signed-in', fill: plain(session.id), title: plain(session.username) || 'someone',
    right: `until ${when(session.expiresAt)}`, mark: 'running',
    lines: [{ label: 'Signed in until', text: when(session.expiresAt) }],
  }));
}

const KIND_WORDS: Readonly<Record<string, string>> = { user: 'a person', bot: 'a bot', service: 'a service', token: 'a token' };

function principalItems(output: unknown): readonly SafetyItem[] {
  return rows(record(output).principals).filter((principal) => plain(principal.id)).map((principal): SafetyItem => {
    const kind = plain(principal.kind);
    const identities = rows(principal.identities).map((identity) => `${plain(identity.channel)}: ${plain(identity.value)}`);
    return {
      id: plain(principal.id), state: kind || 'user', fill: plain(principal.id), title: plain(principal.name) || plain(principal.id),
      right: KIND_WORDS[kind] ?? kind, mark: 'ok',
      lines: [
        { label: 'Is', text: KIND_WORDS[kind] ?? kind },
        ...(identities.length > 0 ? identities.map((identity) => ({ label: 'Known as', text: identity })) : [{ label: 'Known as', text: 'no identity on any channel yet', tone: 'muted' as const }]),
      ],
    };
  });
}

function tokenItems(output: unknown): readonly SafetyItem[] {
  return rows(dataOf(output).tokens).filter((token) => plain(token.id)).map((token): SafetyItem => {
    const blocked = token.blocked === true;
    const scope = plain(token.scope);
    const rotation = plain(token.rotation);
    const state = blocked ? 'blocked' : scope && scope !== 'ok' && scope !== 'pass' ? 'out-of-scope' : rotation === 'overdue' ? 'overdue' : 'ok';
    const right: Readonly<Record<string, string | undefined>> = { blocked: 'blocked', 'out-of-scope': 'reaches past its policy', overdue: 'due to be replaced', ok: undefined };
    return {
      id: plain(token.id), state, fill: plain(token.id), title: plain(token.label) || plain(token.id),
      ...(right[state] ? { right: right[state] } : {}), mark: state === 'ok' ? 'ok' : 'attention',
      lines: [
        { label: 'Policy', text: plain(token.policy) || 'not said' },
        { label: 'Scope', text: scope || 'not said' },
        { label: 'Rotation', text: rotation || 'not said' },
        { label: 'Blocked', text: blocked ? 'yes' : 'no', ...(blocked ? { tone: 'warning' as const } : {}) },
      ],
    };
  });
}

function grantItems(output: unknown): readonly SafetyItem[] {
  return rows(record(output).grants).filter((grant) => plain(grant.grantId)).map((grant): SafetyItem => ({
    id: plain(grant.grantId), state: 'granted', fill: plain(grant.grantId),
    title: plain(grant.capabilityTitle) || plain(grant.capabilityId) || plain(grant.grantId),
    right: plain(grant.nodeId) ? `on ${plain(grant.nodeId)}` : undefined, mark: 'ok',
    lines: [
      { label: 'Phone', text: plain(grant.nodeId) || 'not said' },
      ...(typeof grant.useCount === 'number' ? [{ label: 'Used', text: `${grant.useCount} time${grant.useCount === 1 ? '' : 's'}` }] : []),
      { text: 'Each request for this capability runs without asking until you revoke it.', tone: 'muted' },
    ],
  }));
}

/** The program's own items: this conversation's permissions and plan mode, and the sandbox sessions it started. */
function programItems(raw: unknown): readonly SafetyItem[] {
  return Array.isArray(raw) ? raw as SafetyItem[] : [];
}

/** The two program sources this place reads: this conversation, and the sandbox sessions this program started. */
export function safetyPlaceSources(services: (() => SessionCapabilityServices | undefined) | undefined): Readonly<Record<string, PlaceProgramSource>> {
  const conversation: PlaceProgramSource = {
    read: () => {
      const live = services?.();
      const items: SafetyItem[] = [];
      const here = live?.permissionsHere;
      if (here) {
        const words = here.modeWords();
        items.push({
          id: 'mode', state: 'mode', fill: '', title: 'When GoodVibes asks',
          right: words.inForce ? words.inForce : words.chosen, mark: words.inForce ? 'attention' : 'ok',
          lines: [
            { label: 'Chosen', text: words.chosen },
            ...(words.inForce ? [{ label: 'In force now', text: words.inForce, tone: 'warning' as const }, ...(words.because ? [{ label: 'Because', text: words.because }] : [])] : []),
            { text: words.sentence },
            { text: 'Change it in Settings, When GoodVibes asks.', tone: 'muted' },
          ],
        });
      }
      const plan = live?.planMode;
      if (plan) {
        const on = plan.isOn();
        items.push({
          id: 'plan-mode', state: on ? 'on' : 'off', fill: '', title: 'Plan mode', right: on ? 'on' : 'off', mark: on ? 'running' : 'paused',
          lines: [{ text: on ? 'Writes, commands and network calls are blocked in this conversation.' : `Off: the mode is ${plan.modeLabel()}.` }],
        });
      }
      return items;
    },
    // Read again on every read of the place (after each action); a mode changed with Shift+Tab shows on the next read.
    subscribe: () => () => {},
  };
  const sandbox: PlaceProgramSource = {
    read: () => {
      const held = services?.()?.sandboxSessions;
      if (!held) return [];
      return held.registry.list().map((session): SafetyItem => ({
        id: session.id, state: session.state, fill: session.id, title: plain(session.label) || session.profileId,
        right: session.state, mark: session.state === 'running' ? 'running' : 'paused',
        lines: [
          { label: 'Profile', text: session.profileId },
          { label: 'Boundary', text: session.backend },
          ...(session.lastCommandSummary ? [{ label: 'Last ran', text: plain(session.lastCommandSummary) }] : []),
        ],
      }));
    },
    subscribe: () => () => {},
  };
  return { 'safety-conversation': conversation, 'safety-sandbox': sandbox };
}

/** The `safety` list's frames: a rule, a secret, a folder's trust or a sign-in changed, from any program. */
const SAFETY_LIST = { domains: ['workspace'], events: [], lists: ['safety'] } as const;

function list(id: string, label: string, noun: string, source: PlaceList<SafetyItem>['source'], empty: string, follows?: PlaceList<SafetyItem>['follows']): PlaceList<SafetyItem> {
  return {
    id, label, noun, source, empty, ...(follows ? { follows } : {}),
    row: (item) => ({ title: item.title, ...(item.right ? { right: item.right } : {}), ...(item.mark ? { mark: item.mark } : {}) }),
    detail: (item) => item.lines,
  };
}

const run = (id: string): PlaceList<SafetyItem>['source'] => ({ kind: 'daemon', method: 'capabilities.run', input: { id, inputs: {} }, items: id === 'secrets.list' ? secretItems : id === 'security.folder' ? folderItems : tokenItems });

export const SAFETY_PLACE = definePlace<SafetyItem>({
  id: 'safety',
  group: 'safety',
  title: 'Permissions and safety',
  lists: [
    list('conversation', 'This conversation', 'this conversation\'s permissions', { kind: 'program', name: 'safety-conversation', items: programItems }, 'This program says nothing about its permissions.'),
    list('rules', 'Rules', 'the permission rules', { kind: 'daemon', method: 'capabilities.run', input: { id: 'permissions.rules', inputs: {} }, items: ruleItems },
      'No rules: every call is decided under When GoodVibes asks.', { domains: ['workspace', 'gate'], events: ['approval-update'], lists: ['safety'] }),
    list('secrets', 'Secrets', 'your secrets', run('secrets.list'), 'No secrets stored yet.', SAFETY_LIST),
    list('folder', 'This folder', 'this folder\'s trust', run('security.folder'), 'The daemon did not say whether this folder is trusted.', SAFETY_LIST),
    list('users', 'Sign-in', 'who may sign in', { kind: 'daemon', method: 'local_auth.status', input: {}, items: userItems }, 'Nobody may sign in to the web app yet.', SAFETY_LIST),
    list('signed-in', 'Signed in', 'who is signed in', { kind: 'daemon', method: 'local_auth.status', input: {}, items: signedInItems }, 'Nobody is signed in now.', SAFETY_LIST),
    list('people', 'Who is who', 'the people, bots and services the daemon knows', { kind: 'daemon', method: 'principals.list', input: {}, items: principalItems },
      'Nobody is registered yet.', { domains: ['workspace'], events: [], lists: ['people'] }),
    list('tokens', 'Device tokens', 'the paired devices\' tokens', run('security.tokens'), 'No device is paired with this machine.', { domains: ['workspace'], events: [], lists: ['paired-devices'] }),
    list('grants', 'Phone grants', 'the phones\' always-allow grants', { kind: 'daemon', method: 'devices.grants.list', input: {}, items: grantItems },
      'No always-allow grants: every phone capability asks each time.', { domains: ['workspace'], events: [], lists: ['paired-devices'] }),
    list('sandbox', 'Sandbox', 'the sandbox sessions started here', { kind: 'program', name: 'safety-sandbox', items: programItems }, 'No sandbox session was started here.'),
  ],
  actions: [
    // This conversation.
    { key: 'w', id: 'why', list: 'conversation', states: ['mode'], capability: 'permissions.mode', label: 'what it asks about, and why' },
    { key: 's', id: 'settings-in-force', list: 'conversation', states: ['mode'], capability: 'permissions.show', label: 'settings in force' },
    { key: 'p', id: 'plan-on', list: 'conversation', states: ['off'], capability: 'plan.on', label: 'turn on' },
    { key: 'p', id: 'plan-off', list: 'conversation', states: ['on'], capability: 'plan.off', label: 'turn off' },
    { key: 'u', id: 'use-secret', list: 'conversation', states: ['mode'], capability: 'secrets.use', label: 'a secret for this session' },
    // Rules.
    { key: 'n', id: 'never-run', list: 'rules', whole: true, capability: 'permissions.never', label: 'never run a command' },
    { key: 'a', id: 'add-rule', list: 'rules', whole: true, capability: 'permissions.add', label: 'add a rule' },
    { key: 'x', id: 'remove-rule', list: 'rules', capability: 'permissions.revoke', label: 'remove', fill: { rule: 'fill' } },
    // Secrets.
    { key: 'n', id: 'store-secret', list: 'secrets', whole: true, capability: 'secrets.set', label: 'store one' },
    { key: 'l', id: 'link-secret', list: 'secrets', whole: true, capability: 'secrets.link', label: 'from a password manager' },
    { key: 'c', id: 'check-secret', list: 'secrets', capability: 'secrets.get', label: 'check', fill: { key: 'fill' } },
    { key: 't', id: 'use-project-secret', list: 'secrets', states: ['waiting'], capability: 'secrets.trust', label: 'use this project\'s copy', fill: { key: 'fill' } },
    { key: 'x', id: 'delete-secret', list: 'secrets', capability: 'secrets.delete', label: 'delete', fill: { key: 'fill' } },
    { key: 'e', id: 'test-reference', list: 'secrets', whole: true, capability: 'secrets.test', label: 'test a reference' },
    { key: 'h', id: 'secret-sources', list: 'secrets', whole: true, capability: 'secrets.providers', label: 'where they can come from' },
    { key: 'k', id: 'secret-storage', list: 'secrets', whole: true, capability: 'secrets.storage', label: 'how they are kept' },
    // This folder.
    { key: 't', id: 'trust-folder', list: 'folder', states: ['restricted', 'undecided', 'unreadable'], capability: 'security.trust-folder', label: 'trust it' },
    { key: 'x', id: 'restrict-folder', list: 'folder', states: ['trusted', 'undecided', 'unreadable'], capability: 'security.restrict-folder', label: 'restrict it' },
    // Sign-in.
    { key: 'n', id: 'add-user', list: 'users', whole: true, capability: 'local-auth.add', label: 'let someone sign in' },
    { key: 'p', id: 'change-password', list: 'users', capability: 'local-auth.password', label: 'change password', fill: { user: 'fill' } },
    { key: 'x', id: 'remove-user', list: 'users', capability: 'local-auth.remove', label: 'stop them signing in', fill: { user: 'fill' } },
    { key: 'x', id: 'sign-out', list: 'signed-in', capability: 'local-auth.sign-out', label: 'sign out', fill: { session: 'fill' } },
    // Who is who.
    { key: 'n', id: 'add-principal', list: 'people', whole: true, capability: 'principals.create', label: 'add' },
    { key: 'c', id: 'change-principal', list: 'people', capability: 'principals.update', label: 'change', fill: { principal: 'fill' } },
    { key: 'x', id: 'remove-principal', list: 'people', capability: 'principals.delete', label: 'remove', fill: { principal: 'fill' } },
    { key: 'f', id: 'find-identity', list: 'people', whole: true, capability: 'principals.resolve', label: 'find who an identity is' },
    // Phone grants.
    { key: 'x', id: 'revoke-grant', list: 'grants', capability: 'devices.revoke-grant', label: 'revoke', fill: { grant: 'fill' } },
    // Sandbox sessions.
    { key: 'n', id: 'start-sandbox', list: 'sandbox', whole: true, capability: 'security.start-sandbox', label: 'start one' },
    { key: 'e', id: 'run-in-sandbox', list: 'sandbox', states: ['running', 'planned'], capability: 'security.run-in-sandbox', label: 'run a command', fill: { session: 'fill' } },
    { key: 'w', id: 'save-sandbox', list: 'sandbox', capability: 'security.save-sandbox', label: 'save its record', fill: { session: 'fill' } },
    { key: 'x', id: 'stop-sandbox', list: 'sandbox', states: ['running', 'planned'], capability: 'security.stop-sandbox', label: 'stop', fill: { session: 'fill' } },
    { key: 'o', id: 'read-sandbox', list: 'sandbox', whole: true, capability: 'security.read-sandbox', label: 'read a saved record' },
    { key: 'p', id: 'sandbox-presets', list: 'sandbox', whole: true, capability: 'security.sandbox-presets', label: 'the presets for MCP servers' },
  ],
  count: (lists) => {
    const wrong = (lists.tokens ?? []).filter((item) => item.state !== 'ok').length;
    if (wrong > 0) return { count: wrong, words: `${wrong} device token${wrong === 1 ? '' : 's'} need${wrong === 1 ? 's' : ''} a look`, tone: 'wrong' };
    const waiting = (lists.secrets ?? []).filter((item) => item.state === 'waiting').length + (lists.folder ?? []).filter((item) => item.state === 'undecided').length;
    return waiting > 0 ? { count: waiting, words: `${waiting} wait${waiting === 1 ? 's' : ''} for you`, tone: 'waiting' } : undefined;
  },
});
