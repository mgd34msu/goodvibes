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
 *  - Policy: `security.policy` (the one activation record every program follows), with what is trusted.
 *  - Sandbox setting: `security.sandbox` (the daemon's `sandbox.mcpIsolation`, which every program follows).
 *  - Sandbox sessions (the terminal app's own): the sandbox sessions it started.
 *  - This conversation also holds what needs attention, the whole review and risky MCP routes: this program's
 *    own MCP servers and plugins with the daemon's facts.
 *
 * Every action is a capability (capabilities/builtin/permissions.ts,
 * secrets.ts, security.ts, security-review.ts, plan.ts, safety-methods.ts,
 * devices.ts), the same the model and a script run; only one that weakens a
 * protection or cannot be undone asks first.
 */
// The program's readers of its own lists (this conversation, its sandbox sessions) are in safety-sources.ts, so a
// browser loads this declaration.
import { definePlace, type PlaceDetailLine, type PlaceItem, type PlaceList } from './place-types.js';

export interface SafetyItem extends PlaceItem {
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
  // A time as a number (ms) or as an ISO string from the daemon's records.
  const ms = typeof at === 'string' && at.trim() ? Date.parse(at) : at;
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : 'not said';
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
    // What the rule is about comes first, so a narrow row still tells two rules apart ("Never run: git push").
    const said = plain(rule.description) || plain(rule.id);
    // Carried from 3.5.0 to every project: it can be kept for one project (its own state, for that action).
    const carried = plain(rule.carried);
    const madeIn = plain(rule.madeIn);
    return {
      id: plain(rule.id), state: carried ? 'carried' : effect || 'rule', fill: plain(rule.id),
      title: tool === '*' ? `${said.charAt(0).toUpperCase()}${said.slice(1)}` : `${tool}: ${said}`,
      // A never-run rule's title already says it is refused: the row keeps its width for the command.
      right: tier === 'never-run' ? undefined : EFFECT_WORDS[effect] ?? effect,
      mark: effect === 'deny' ? 'paused' : effect === 'allow' ? 'attention' : 'ok',
      lines: [
        { label: 'Tool', text: tool === '*' ? 'any tool' : tool },
        { label: 'Then', text: EFFECT_WORDS[effect] ?? effect },
        { label: 'Kind', text: tier === 'never-run' ? 'never run, in every mode' : `${plain(rule.id).startsWith('owner-') ? 'added by you' : `remembered from an answer${madeIn ? ` to ${madeIn}` : ''}`} (${tier})` },
        // The project by its name; its folder below it.
        { label: 'Where', text: project ? `in ${project.split(/[\\/]/).filter(Boolean).pop() ?? project}` : carried ? `Every project (carried from ${carried})` : 'every project' },
        ...(project ? [{ label: 'Folder', text: project, tone: 'muted' as const }] : []),
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

const CANDIDATE_WORDS: Readonly<Record<string, string>> = {
  loaded: 'not reviewed yet', simulating: 'being reviewed', promoting: 'reviewed; ready to enforce',
};

/** The policy in force on this machine, the candidate waiting, and why the record could not be followed (security.policy). */
function policyItems(output: unknown): readonly SafetyItem[] {
  const facts = dataOf(output);
  const current = record(facts.current);
  const candidate = record(facts.candidate);
  const history = typeof facts.history === 'number' ? facts.history : 0;
  const items: SafetyItem[] = [];
  if (plain(facts.problem)) {
    items.push({
      // Item ids are words no answer uses: an outcome line names the selected item by its title in place of its id.
      id: 'policy-problem', state: 'problem', fill: '', title: 'The policy in force could not be read', right: 'needs a look', mark: 'attention',
      lines: [{ text: plain(facts.problem), tone: 'warning' }],
    });
  }
  if (plain(current.id)) {
    items.push({
      id: 'policy-in-force', state: history > 0 ? 'in-force-restorable' : 'in-force', fill: '', title: plain(current.id), right: 'in force', mark: 'ok',
      lines: [
        { label: 'Rules', text: String(current.rules ?? 0) },
        { label: 'Since', text: when(current.since) },
        ...(plain(current.file) ? [{ label: 'File', text: plain(current.file) }] : []),
        { label: 'Earlier ones', text: history > 0 ? `${history}; "Go back to the previous policy" enforces the last one again` : 'none' },
        { text: 'Every program on this machine follows it; a running turn reads its own copy.', tone: 'muted' },
        ...(plain(facts.carried) ? [{ label: 'At the upgrade', text: plain(facts.carried), tone: 'muted' as const }] : []),
      ],
    });
  }
  if (plain(candidate.id)) {
    const state = plain(candidate.state) || 'loaded';
    const changes = typeof candidate.changes === 'number' ? candidate.changes : undefined;
    items.push({
      id: 'policy-candidate', state, fill: '', title: plain(candidate.id), right: state === 'promoting' ? 'ready to enforce' : 'candidate', mark: state === 'promoting' ? 'waiting' : 'paused',
      lines: [
        { label: 'Candidate', text: CANDIDATE_WORDS[state] ?? state },
        { label: 'Rules', text: String(candidate.rules ?? 0) },
        ...(plain(candidate.file) ? [{ label: 'File', text: plain(candidate.file) }] : []),
        { label: 'Reviewed', text: changes === undefined ? 'not yet: nothing is enforced until it is reviewed and enforced' : `it decides ${changes} recorded call${changes === 1 ? '' : 's'} differently` },
      ],
    });
  }
  const lint = typeof facts.lintFindings === 'number' ? facts.lintFindings : 0;
  if (items.length > 0 && (lint > 0 || plain(facts.preflight))) {
    items.push({
      id: 'policy-checks', state: 'checks', fill: '', title: 'Checks of the policies', right: lint > 0 ? `${lint} finding${lint === 1 ? '' : 's'}` : plain(facts.preflight),
      mark: lint > 0 || (plain(facts.preflight) && plain(facts.preflight) !== 'pass') ? 'attention' : 'ok',
      lines: [{ label: 'Lint findings', text: String(lint) }, { label: 'Last review with MCP risk', text: plain(facts.preflight) || 'not run' }],
    });
  }
  return items;
}

/** How commands and MCP servers are contained on this machine (security.sandbox: the daemon's setting every program follows). */
function boundaryItems(output: unknown): readonly SafetyItem[] {
  const facts = dataOf(output);
  const isolation = plain(facts.mcpIsolation);
  if (!isolation) return [];
  const warnings = Array.isArray(facts.warnings) ? facts.warnings.map(plain).filter(Boolean) : [];
  const backend = plain(facts.backend) || 'host';
  const ready = facts.containment === true;
  const common: PlaceDetailLine[] = [
    { label: 'Boundary', text: `${backend}${ready ? '' : ' (no containment on this machine)'}` },
    ...warnings.map((warning) => ({ label: 'Warning', text: warning, tone: 'warning' as const })),
  ];
  const contained = isolation === 'contained';
  return [
    {
      id: 'sandbox-setting-mcp-servers', state: contained ? 'mcp-contained' : 'mcp-host', fill: '', title: 'MCP servers', right: contained ? 'contained' : 'host processes',
      mark: contained ? 'ok' : 'attention',
      lines: [
        { text: contained ? 'Each stdio MCP server runs inside its own boundary, in every program on this machine.' : 'MCP servers run as ordinary processes of this machine, with no boundary, in every program on this machine.' },
        ...common,
      ],
    },
    {
      id: 'sandbox-setting-commands', state: facts.commands === 'host' ? 'commands-host' : 'commands-contained', fill: '', title: 'Commands',
      right: facts.commands === 'host' ? 'on the host' : 'contained', mark: facts.commands === 'host' ? 'attention' : 'ok',
      lines: [
        { text: facts.commands === 'host'
          ? 'Commands run as ordinary processes of this machine, with no boundary, in every program on this machine.'
          : 'Each command runs inside the boundary where this machine has one, in every program on this machine.' },
        ...common,
      ],
    },
  ];
}

/** The program's own items: this conversation's permissions and plan mode, and the sandbox sessions it started. */
function programItems(raw: unknown): readonly SafetyItem[] {
  return Array.isArray(raw) ? raw as SafetyItem[] : [];
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

const RUN_ITEMS: Readonly<Record<string, (output: unknown) => readonly SafetyItem[]>> = {
  'secrets.list': secretItems, 'security.folder': folderItems, 'security.tokens': tokenItems, 'security.policy': policyItems, 'security.sandbox': boundaryItems,
};
const run = (id: string): PlaceList<SafetyItem>['source'] => ({ kind: 'daemon', method: 'capabilities.run', input: { id, inputs: {} }, items: RUN_ITEMS[id] ?? tokenItems });

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
    list('policy', 'Policy', 'the policy in force', run('security.policy'),
      'No policy bundle is loaded: every call is decided by your rules and When GoodVibes asks.', SAFETY_LIST),
    list('sandbox-setting', 'Sandbox setting', 'how commands and MCP servers are contained', run('security.sandbox'),
      'The daemon did not say how commands and MCP servers are contained.', SAFETY_LIST),
    // Only the terminal app starts sandbox sessions.
    { ...list('sandbox', 'Sandbox sessions', 'the sandbox sessions started here', { kind: 'program', name: 'safety-sandbox', items: programItems }, 'No sandbox session was started here.'), programs: ['tui'] },
  ],
  actions: [
    // This conversation.
    { key: 'w', id: 'why', list: 'conversation', states: ['mode'], capability: 'permissions.mode', label: 'what it asks about, and why' },
    { key: 's', id: 'settings-in-force', list: 'conversation', states: ['mode'], capability: 'permissions.show', label: 'settings in force' },
    { key: 'p', id: 'plan-on', list: 'conversation', states: ['off'], capability: 'plan.on', label: 'turn on' },
    { key: 'p', id: 'plan-off', list: 'conversation', states: ['on'], capability: 'plan.off', label: 'turn off' },
    { key: 'u', id: 'use-secret', list: 'conversation', states: ['mode'], capability: 'secrets.use', label: 'a secret for this session' },
    // This program's MCP servers and plugins, with the daemon's tokens, policies and folder trust.
    { key: 'a', id: 'what-needs-attention', list: 'conversation', whole: true, capability: 'security.report', label: 'what needs attention' },
    { key: 'v', id: 'whole-review', list: 'conversation', whole: true, capability: 'security.review', label: 'the whole security review' },
    { key: 'm', id: 'risky-mcp-routes', list: 'conversation', whole: true, capability: 'security.attack-paths', label: 'risky routes through MCP servers' },
    // Rules.
    { key: 'n', id: 'never-run', list: 'rules', whole: true, capability: 'permissions.never', label: 'never run a command' },
    { key: 'a', id: 'add-rule', list: 'rules', whole: true, capability: 'permissions.add', label: 'add a rule' },
    { key: 'x', id: 'remove-rule', list: 'rules', capability: 'permissions.revoke', label: 'remove', fill: { rule: 'fill' } },
    { key: 'k', id: 'place-rule', list: 'rules', states: ['carried'], capability: 'permissions.place', label: 'keep it for this project only', fill: { rule: 'fill' } },
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
    { key: 'c', id: 'change-principal', list: 'people', form: true, capability: 'principals.update', label: 'change', fill: { principal: 'fill' } },
    { key: 'x', id: 'remove-principal', list: 'people', capability: 'principals.delete', label: 'remove', fill: { principal: 'fill' } },
    { key: 'f', id: 'find-identity', list: 'people', whole: true, capability: 'principals.resolve', label: 'find who an identity is' },
    // Phone grants.
    { key: 'x', id: 'revoke-grant', list: 'grants', capability: 'devices.revoke-grant', label: 'revoke', fill: { grant: 'fill' } },
    // Policy: the one activation record every program follows; what is trusted.
    { key: 'n', id: 'load-policy', list: 'policy', whole: true, capability: 'security.load-policy', label: 'load a candidate' },
    { key: 's', id: 'review-candidate', list: 'policy', states: ['loaded', 'promoting'], capability: 'security.simulate-policy', label: 'see what it changes' },
    { key: 'd', id: 'compare-candidate', list: 'policy', states: ['loaded', 'simulating', 'promoting'], capability: 'security.compare-policy', label: 'compare with the one in force' },
    { key: 'e', id: 'enforce-candidate', list: 'policy', states: ['promoting'], capability: 'security.enforce-policy', label: 'enforce it' },
    { key: 'b', id: 'previous-policy', list: 'policy', states: ['in-force-restorable'], capability: 'security.restore-policy', label: 'go back to the previous one' },
    { key: 'enter', id: 'see-policy', list: 'policy', states: ['in-force', 'in-force-restorable', 'loaded', 'simulating', 'promoting', 'problem', 'checks'], capability: 'security.policy', label: 'see it all' },
    { key: 'l', id: 'lint-policies', list: 'policy', whole: true, capability: 'security.lint-policy', label: 'check for mistakes' },
    { key: 'f', id: 'policy-preflight', list: 'policy', whole: true, capability: 'security.preflight', label: 'review with MCP risk' },
    { key: 't', id: 'what-is-trusted', list: 'policy', whole: true, capability: 'security.trust', label: 'what is trusted' },
    { key: 'w', id: 'save-trust', list: 'policy', whole: true, capability: 'security.save-trust', label: 'save the trust summary' },
    { key: 'o', id: 'read-trust', list: 'policy', whole: true, capability: 'security.read-trust', label: 'read a saved trust summary' },
    // Sandbox setting: the daemon's, every program follows it.
    { key: 'c', id: 'contain-mcp', list: 'sandbox-setting', states: ['mcp-host'], capability: 'security.contain-mcp', label: 'run them inside the sandbox' },
    { key: 'h', id: 'host-mcp', list: 'sandbox-setting', states: ['mcp-contained'], capability: 'security.host-mcp', label: 'run them as host processes' },
    { key: 'c', id: 'contain-commands', list: 'sandbox-setting', states: ['commands-host'], capability: 'security.contain-commands', label: 'run them inside the sandbox' },
    { key: 'h', id: 'host-commands', list: 'sandbox-setting', states: ['commands-contained'], capability: 'security.host-commands', label: 'run them on the host' },
    { key: 'enter', id: 'see-sandbox', list: 'sandbox-setting', states: ['mcp-contained', 'mcp-host', 'commands-contained', 'commands-host'], capability: 'security.sandbox', label: 'see the sandbox' },
    { key: 'a', id: 'sandbox-advice', list: 'sandbox-setting', whole: true, capability: 'security.sandbox-advice', label: 'what it should be' },
    { key: 'p', id: 'sandbox-profiles', list: 'sandbox-setting', whole: true, capability: 'security.sandbox-profiles', label: 'the profiles' },
    { key: 's', id: 'sandbox-presets', list: 'sandbox-setting', whole: true, capability: 'security.sandbox-presets', label: 'the presets for MCP servers' },
    { key: 'b', id: 'sandbox-probe', list: 'sandbox-setting', whole: true, capability: 'security.sandbox-probe', label: 'probe this machine' },
    // Sandbox sessions (the terminal app's).
    { key: 'n', id: 'start-sandbox', list: 'sandbox', whole: true, form: true, capability: 'security.start-sandbox', label: 'start one', programs: ['tui'] },
    { key: 'enter', id: 'see-sandbox-session', list: 'sandbox', capability: 'security.sandbox-session', label: 'see it', fill: { session: 'fill' }, programs: ['tui'] },
    { key: 'e', id: 'run-in-sandbox', list: 'sandbox', states: ['running', 'planned'], capability: 'security.run-in-sandbox', label: 'run a command', fill: { session: 'fill' }, programs: ['tui'] },
    { key: 'w', id: 'save-sandbox', list: 'sandbox', capability: 'security.save-sandbox', label: 'save its record', fill: { session: 'fill' }, programs: ['tui'] },
    { key: 'x', id: 'stop-sandbox', list: 'sandbox', states: ['running', 'planned'], capability: 'security.stop-sandbox', label: 'stop', fill: { session: 'fill' }, programs: ['tui'] },
    { key: 'o', id: 'read-sandbox', list: 'sandbox', whole: true, capability: 'security.read-sandbox', label: 'read a saved record', programs: ['tui'] },
  ],
  count: (lists) => {
    const wrongTokens = (lists.tokens ?? []).filter((item) => item.state !== 'ok').length;
    const wrongPolicy = (lists.policy ?? []).filter((item) => item.state === 'problem').length;
    const wrong = wrongTokens + wrongPolicy;
    if (wrong > 0) {
      const words = wrongTokens > 0 && wrongPolicy > 0
        ? `${wrong} safety items need a look`
        : wrongTokens > 0
          ? `${wrongTokens} device token${wrongTokens === 1 ? '' : 's'} need${wrongTokens === 1 ? 's' : ''} a look`
          : `${wrongPolicy} policy issue${wrongPolicy === 1 ? '' : 's'} need${wrongPolicy === 1 ? 's' : ''} a look`;
      return { count: wrong, words, tone: 'wrong' };
    }
    const waiting = (lists.secrets ?? []).filter((item) => item.state === 'waiting').length + (lists.folder ?? []).filter((item) => item.state === 'undecided').length;
    return waiting > 0 ? { count: waiting, words: `${waiting} wait${waiting === 1 ? 's' : ''} for you`, tone: 'waiting' } : undefined;
  },
});
