/**
 * Permissions and safety, the acts a daemon method already does, each run as
 * the same caller (`caller.method`, its own admission applying) and worded
 * here: who is who across channels (`principals.*`), who may sign in to this
 * machine's daemon and web app (`local_auth.*`), the permission rules
 * (`permissions.rules.list`, `permissions.rules.delete`) and the always-allow
 * grants given to phones (`devices.grants.list`). Nothing is kept here.
 */
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type FixedChoice, type InputDescription, type ListName } from '../types.js';
import type { EffectId } from '../../security/effect-authority.js';

/** These need nothing of their own: every act is a daemon method run as the caller. */
export type SafetyMethodServices = Readonly<Record<never, never>>;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function rows(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

/** Run the daemon method that does this act, as the same caller. */
async function call(caller: CapabilityCaller, methodId: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  if (!caller.method) throw new CapabilityRefusal('This runs in the daemon, and no daemon took the request here; nothing was done.', undefined, 'UNAVAILABLE');
  return record(await caller.method(methodId, body));
}

const READ = { done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none' } as const;

// ---------------------------------------------------------------------------
// Who is who: principals.*
// ---------------------------------------------------------------------------

/** The people, bots and services the daemon knows (the list a "Who" input chooses from). */
export const PRINCIPALS_LIST_NAME = 'principals' as ListName;

const KINDS: readonly FixedChoice[] = [
  { value: 'user', label: 'A person' }, { value: 'bot', label: 'A bot' }, { value: 'service', label: 'A service' }, { value: 'token', label: 'A token' },
];
const PRINCIPAL: InputDescription = {
  id: 'principal', label: 'Who', help: 'The people, bots and services the daemon knows', kind: 'choice',
  choices: { list: PRINCIPALS_LIST_NAME }, required: true, typed: { position: 1 },
};

/** One principal as a person reads it: name, kind, identities. */
export function principalWords(principal: Record<string, unknown>): string {
  const identities = rows(principal.identities).map((identity) => `${text(identity.channel)}:${text(identity.value)}`);
  return [
    `  ${text(principal.name) || text(principal.id)}  [${text(principal.kind)}]`,
    `    identities: ${identities.length > 0 ? identities.join(', ') : 'none'}`,
  ].join('\n');
}

/** `slack:U123, telegram:42` as identity pairs; a malformed one is refused, nothing changed. */
function identitiesOf(value: string): { channel: string; value: string }[] {
  const tokens = value.split(/[,\n]/).map((token) => token.trim()).filter(Boolean);
  const rejected = tokens.filter((token) => { const at = token.indexOf(':'); return at <= 0 || at === token.length - 1; });
  if (rejected.length > 0) throw new CapabilityRefusal(`Not a channel:value identity: ${rejected.join(', ')}. Nothing was changed.`, 'Write identities as slack:U123, separated by commas.');
  return tokens.map((token) => ({ channel: token.slice(0, token.indexOf(':')), value: token.slice(token.indexOf(':') + 1) }));
}

const PRINCIPAL_WRITE: readonly EffectId[] = ['principals.write', 'model.refused'];

export const PRINCIPALS_LIST: CapabilityDefinition<SafetyMethodServices> = {
  capability: { id: 'principals.list', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'list', label: 'See who the daemon knows', word: 'list', inputs: [], ...READ,
  sentence: 'Lists every person, bot and service with their identities on each channel.', effects: ['principals.read'], example: {},
  async run(_values, _services, caller) {
    const principals = rows((await call(caller, 'principals.list')).principals);
    if (principals.length === 0) return { text: 'Nobody is registered yet.', data: { principals: [] } };
    return { text: ['Who the daemon knows:', ...principals.map(principalWords)].join('\n'), data: { principals } };
  },
};

export const PRINCIPALS_GET: CapabilityDefinition<SafetyMethodServices> = {
  capability: { id: 'principals.get', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'get', label: 'See the details of one known person, bot or service', word: 'get', inputs: [PRINCIPAL], ...READ,
  sentence: 'Shows the details the daemon knows of {principal}: its kind and its identity on each channel.', effects: ['principals.read'], example: { principal: 'p-sam' },
  async run(values, _services, caller) {
    const principal = record((await call(caller, 'principals.get', { principalId: values.principal })).principal);
    return { text: principalWords(principal), data: { principal } };
  },
};

export const PRINCIPALS_RESOLVE: CapabilityDefinition<SafetyMethodServices> = {
  capability: { id: 'principals.resolve', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'resolve', label: 'Find who a user on a channel is', word: 'resolve', ...READ,
  inputs: [
    { id: 'channel', label: 'Channel', help: 'The channel kind: slack, telegram, discord, email...', kind: 'text', freeTextReason: 'a channel kind', required: true, typed: { position: 1 } },
    { id: 'value', label: 'Identity', help: 'Their id or address on that channel', kind: 'text', freeTextReason: 'an id on that channel', required: true, typed: { position: 2 } },
  ],
  sentence: 'Shows who {channel}:{value} is (a Slack, Telegram, Discord or email user), if the daemon knows.', effects: ['principals.read'], example: { channel: 'slack', value: 'U123' },
  async run(values, _services, caller) {
    const answer = await call(caller, 'principals.resolve', { channel: values.channel, value: values.value });
    if (answer.known !== true) return { text: `${values.channel}:${values.value} is not mapped to anyone the daemon knows.`, data: { known: false } };
    const principal = record(answer.principal);
    return { text: `${values.channel}:${values.value} is ${text(principal.name)}\n${principalWords(principal)}`, data: { known: true, principal } };
  },
};

export const PRINCIPALS_CREATE: CapabilityDefinition<SafetyMethodServices> = {
  capability: { id: 'principals.create', group: 'safety', home: 'daemon', repeat: 'unsafe' },
  actionId: 'create', label: 'Add a person, bot or service', word: 'create',
  inputs: [
    { id: 'name', label: 'Name', help: 'Their name', kind: 'text', freeTextReason: 'a name you choose', required: true, typed: { position: 1 } },
    { id: 'kind', label: 'Kind', help: 'What they are', kind: 'choice', choices: KINDS, required: true, typed: { position: 2 } },
    { id: 'identities', label: 'Identities', help: 'channel:value pairs, separated by commas (slack:U123)', kind: 'text', freeTextReason: 'channel:value pairs', required: { default: '', defaultMeans: 'none yet' }, typed: { flag: '--identity', repeats: true } },
  ],
  sentence: '{name} ({kind}) is added to the daemon\'s registry, until you change it.', done: 'Added {name}.',
  touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'delete', effects: PRINCIPAL_WRITE,
  example: { name: 'Sam', kind: 'user', identities: 'slack:U123' },
  async run(values, _services, caller) {
    const principal = record((await call(caller, 'principals.create', { name: values.name, kind: values.kind, identities: identitiesOf(values.identities ?? '') })).principal);
    return { text: principalWords(principal), data: { principal } };
  },
};

export const PRINCIPALS_UPDATE: CapabilityDefinition<SafetyMethodServices> = {
  capability: { id: 'principals.update', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'update', label: 'Rename or change a known person, bot or service', word: 'update',
  inputs: [
    PRINCIPAL,
    { id: 'name', label: 'Name', help: 'A new name', kind: 'text', freeTextReason: 'a name you choose', required: { default: '', defaultMeans: 'unchanged' }, typed: { flag: '--name' } },
    { id: 'kind', label: 'Kind', help: 'What they are', kind: 'choice', choices: KINDS, required: { default: '', defaultMeans: 'unchanged' }, typed: { flag: '--kind' } },
    { id: 'identities', label: 'Identities', help: 'All their channel:value pairs, separated by commas; none clears them', kind: 'text', freeTextReason: 'channel:value pairs, or none', required: { default: '', defaultMeans: 'unchanged' }, typed: { flag: '--identities' } },
  ],
  sentence: '{principal} is changed to what you gave, until you change it.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'none', effects: PRINCIPAL_WRITE, example: { principal: 'p-sam', name: 'Sam Lee' },
  async run(values, _services, caller) {
    const raw = values.identities?.trim();
    // Clearing every identity mapping must be asked for with the word none.
    const identities = raw === undefined || raw === '' ? undefined : raw.toLowerCase() === 'none' ? [] : identitiesOf(raw);
    const principal = record((await call(caller, 'principals.update', {
      principalId: values.principal,
      ...(values.name ? { name: values.name } : {}),
      ...(values.kind ? { kind: values.kind } : {}),
      ...(identities !== undefined ? { identities } : {}),
    })).principal);
    return { text: `Changed:\n${principalWords(principal)}`, data: { principal } };
  },
};

export const PRINCIPALS_DELETE: CapabilityDefinition<SafetyMethodServices> = {
  capability: { id: 'principals.delete', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'delete', label: 'Remove a person, bot or service', word: 'delete', inputs: [PRINCIPAL],
  sentence: '{principal} and its identities are removed from the daemon\'s registry.', done: 'Removed {principal}.',
  touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone', effects: [...PRINCIPAL_WRITE, 'record.destroy'], example: { principal: 'p-sam' },
  async run(values, _services, caller) {
    if ((await call(caller, 'principals.delete', { principalId: values.principal })).deleted !== true) {
      throw new CapabilityRefusal(`Nobody the daemon knows has the id ${values.principal}; nothing was removed.`, '"See who the daemon knows" lists everyone.');
    }
    return { text: '', data: { deleted: true } };
  },
};

// ---------------------------------------------------------------------------
// Local sign-in: local_auth.*
// ---------------------------------------------------------------------------

/** The people who may sign in, and who is signed in now (the lists the inputs choose from). */
export const LOCAL_USERS_LIST = 'local-auth.users' as ListName;
export const LOCAL_SESSIONS_LIST = 'local-auth.sessions' as ListName;

// An omitted role must not grant the highest one; admin is always chosen.
const ROLES: readonly FixedChoice[] = [
  { value: 'user', label: 'User', help: 'Can sign in and use the web app.' },
  { value: 'admin', label: 'Administrator', help: 'Can also manage users, settings and the daemon.', risk: 'loosens-a-protection' },
];
const USER: InputDescription = {
  id: 'user', label: 'User', help: 'The people who may sign in here', kind: 'choice',
  choices: { list: LOCAL_USERS_LIST }, required: true, typed: { position: 1 },
};
const PASSWORD: InputDescription = {
  id: 'password', label: 'Password', help: 'Hidden as you type', kind: 'secret', required: true, typed: { flag: '--password' },
};
// Typed twice in a form, so one mistyped character cannot set a password nobody knows.
const PASSWORD_AGAIN: InputDescription = {
  id: 'again', label: 'Password again', help: 'The same password, to catch a typing mistake', kind: 'secret',
  required: { default: '', defaultMeans: 'not typed a second time' }, typed: { flag: '--again' },
};
const AUTH_WRITE: readonly EffectId[] = ['auth.administer', 'model.refused'];

function samePassword(values: Readonly<Record<string, string>>, what: string): string {
  if (!values.password) throw new CapabilityRefusal(`${what}: no password was given.`);
  if (values.again && values.again !== values.password) throw new CapabilityRefusal(`${what}: the two passwords are not the same.`, 'Type the same password twice.');
  return values.password;
}

/** The sign-in picture as a screen reads it. */
export interface LocalSignInFacts {
  readonly users: readonly { readonly username: string; readonly roles: readonly string[] }[];
  readonly sessions: readonly { readonly id: string; readonly username: string; readonly expiresAt: number }[];
  readonly firstRunFile: { readonly present: boolean; readonly path?: string | undefined };
  readonly userStorePath?: string | undefined;
}

function signInFacts(status: Record<string, unknown>): LocalSignInFacts {
  return {
    users: rows(status.users).map((user) => ({ username: text(user.username), roles: Array.isArray(user.roles) ? user.roles.filter((role): role is string => typeof role === 'string') : [] })),
    sessions: rows(status.sessions).map((session) => ({ id: text(session.id), username: text(session.username), expiresAt: typeof session.expiresAt === 'number' ? session.expiresAt : 0 })),
    firstRunFile: { present: status.bootstrapCredentialPresent === true, ...(text(status.bootstrapCredentialPath) ? { path: text(status.bootstrapCredentialPath) } : {}) },
    ...(text(status.userStorePath) ? { userStorePath: text(status.userStorePath) } : {}),
  };
}

export const LOCAL_AUTH_REVIEW: CapabilityDefinition<SafetyMethodServices> = {
  capability: { id: 'local-auth.review', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'see-users', label: 'See who may sign in', word: 'review', inputs: [], ...READ,
  sentence: 'Shows the local users, their roles, the open sessions and whether the first-run sign-in file is still there.',
  effects: ['auth.inspect'], example: {},
  async run(_values, _services, caller) {
    const facts = signInFacts(await call(caller, 'local_auth.status'));
    return {
      text: [
        'Local sign-in',
        `  users: ${facts.users.length}${facts.users.length > 0 ? '' : ' (nobody may sign in yet)'}`,
        ...facts.users.map((user) => `    ${user.username}  ${user.roles.length > 0 ? user.roles.join(', ') : 'no role'}`),
        `  signed in: ${facts.sessions.length}`,
        ...facts.sessions.map((session) => `    ${session.username}  ends ${new Date(session.expiresAt).toISOString()}`),
        `  first-run sign-in file: ${facts.firstRunFile.present ? `present (${facts.firstRunFile.path ?? 'path not given'})` : 'removed'}`,
        ...(facts.userStorePath ? [`  users are kept in ${facts.userStorePath}`] : []),
      ].join('\n'),
      data: { ...facts },
    };
  },
};

export const LOCAL_AUTH_ADD: CapabilityDefinition<SafetyMethodServices> = {
  capability: { id: 'local-auth.add', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'add-user', label: 'Let someone sign in', word: 'add', button: 'Let them sign in',
  inputs: [
    { id: 'user', label: 'User name', help: 'The name they sign in with', kind: 'text', freeTextReason: 'a name you choose for them', required: true, typed: { position: 1 } },
    PASSWORD,
    PASSWORD_AGAIN,
    { id: 'role', label: 'Role', help: 'What they may do once signed in', kind: 'choice', choices: ROLES, required: { default: 'user', defaultMeans: 'a user, not an administrator' }, typed: { flag: '--role' } },
  ],
  sentence: '{user} will be able to sign in to this machine\'s daemon and web app as a {role}, until you change it.',
  done: '{user} may sign in as a {role}.',
  touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'remove-user', effects: AUTH_WRITE, example: { user: 'sam', role: 'user' },
  async run(values, _services, caller) {
    const password = samePassword(values, 'No user was added');
    await call(caller, 'local_auth.users.create', { username: values.user, password, roles: [values.role || 'user'] });
    return { text: '', data: { user: values.user, role: values.role || 'user' } };
  },
};

export const LOCAL_AUTH_REMOVE: CapabilityDefinition<SafetyMethodServices> = {
  capability: { id: 'local-auth.remove', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'remove-user', label: 'Stop someone signing in', word: 'remove', inputs: [USER],
  sentence: '{user} will no longer be able to sign in, and the account is deleted; add it again to let them back in.',
  done: 'Removed {user}.',
  touches: 'credential', lasts: 'kept', risk: 'cannot-be-undone', effects: [...AUTH_WRITE, 'record.destroy'], example: { user: 'sam' },
  async run(values, _services, caller) {
    const answer = await call(caller, 'local_auth.users.delete', { username: values.user });
    if (answer.deleted === false) throw new CapabilityRefusal(`No local user is named ${values.user}; nothing was removed.`, '"See who may sign in" lists the users.', 'NOT_FOUND');
    return { text: '', data: { user: values.user } };
  },
};

export const LOCAL_AUTH_PASSWORD: CapabilityDefinition<SafetyMethodServices> = {
  capability: { id: 'local-auth.password', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'change-password', label: 'Change someone\'s password', word: 'password', inputs: [USER, PASSWORD, PASSWORD_AGAIN],
  sentence: '{user}\'s password will be replaced and everyone signed in as {user} is signed out, until you change it.',
  done: 'Changed {user}\'s password; their open sessions were ended.',
  touches: 'credential', lasts: 'kept', risk: 'none', effects: AUTH_WRITE, example: { user: 'sam' },
  async run(values, _services, caller) {
    const password = samePassword(values, `The password for ${values.user} was not changed`);
    await call(caller, 'local_auth.users.password.rotate', { username: values.user, password });
    return { text: '', data: { user: values.user } };
  },
};

export const LOCAL_AUTH_SIGN_OUT: CapabilityDefinition<SafetyMethodServices> = {
  capability: { id: 'local-auth.sign-out', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'end-session', label: 'Sign out a browser session of the web app', word: 'sign-out',
  inputs: [{ id: 'session', label: 'Session', help: 'The browser sessions still signed in now', kind: 'choice', choices: { list: LOCAL_SESSIONS_LIST }, required: true, typed: { position: 1 } }],
  sentence: 'That browser session, still open and signed in to the web app, is signed out; whoever uses it must sign in again.',
  done: 'Ended that session.',
  touches: 'credential', lasts: 'kept', risk: 'cannot-be-undone', effects: [...AUTH_WRITE, 'record.destroy'], example: { session: 's-1' },
  async run(values, _services, caller) {
    const gone = (): CapabilityRefusal => new CapabilityRefusal('That session is not open any more; nothing was ended.', '"See who may sign in" lists who is signed in.', 'NOT_FOUND');
    let answer: Record<string, unknown>;
    try {
      answer = await call(caller, 'local_auth.sessions.delete', { sessionId: values.session });
    } catch (error) {
      // The method's own word for a session that is not open ("Unknown session"), in the person's.
      if ((error as { status?: unknown } | null)?.status === 404) throw gone();
      throw error;
    }
    if (answer.deleted === false || answer.revoked === false) throw gone();
    return { text: '', data: { session: values.session } };
  },
};

// ---------------------------------------------------------------------------
// Permission rules: permissions.rules.list, permissions.rules.delete
// ---------------------------------------------------------------------------

/** The rules in force (the list "Remove a permission rule" chooses from). */
export const PERMISSION_RULES_LIST_NAME = 'permissions.rules' as ListName;

/** One rule as a person reads it. */
export function ruleWords(rule: Record<string, unknown>): { readonly title: string; readonly detail: string } {
  const tool = text(rule.tool);
  const tier = text(rule.tier);
  const what = text(rule.description) || text(rule.id);
  const kind = tier === 'never-run' ? 'never run, every mode' : `${text(rule.id).startsWith('owner-') ? 'added' : 'remembered'} (${tier})`;
  // The project by its name (its folder's last part), as a person calls it.
  const folder = text(rule.project);
  const carried = text(rule.carried);
  const where = folder ? `in ${folder.split(/[\\/]/).filter(Boolean).pop() ?? folder}` : carried ? `Every project (carried from ${carried})` : 'every project';
  // The session whose answer made it, by its title (a runner by its task).
  const madeIn = text(rule.madeIn);
  return { title: `${tool === '*' ? 'any tool' : tool}: ${what}`, detail: `${text(rule.effect)} · ${kind}${madeIn ? ` to ${madeIn}` : ''} · ${where}` };
}

export const PERMISSIONS_RULES: CapabilityDefinition<SafetyMethodServices> = {
  capability: { id: 'permissions.rules', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'rules', label: 'See the permission rules', word: 'rules', inputs: [], ...READ,
  sentence: 'Lists every rule that decides a call here without asking: this project\'s and those of every project, what each covers, allow or deny.', effects: ['approvals.read'], example: {},
  async run(_values, _services, caller) {
    // The caller's own project's rules and every project's; another project's rules are not in force here.
    const rules = rows((await call(caller, 'permissions.rules.list', caller.workingDirectory ? { project: caller.workingDirectory } : {})).rules);
    if (rules.length === 0) return { text: 'No permission rules. Approving an ask with a remember tier stores one; "Add a permission rule" writes one directly.', data: { rules: [] } };
    return {
      text: ['Permission rules:', ...rules.map((rule) => { const words = ruleWords(rule); return `  ${words.title}  (${words.detail})`; })].join('\n'),
      data: { rules },
    };
  },
};

export const PERMISSIONS_REVOKE: CapabilityDefinition<SafetyMethodServices> = {
  capability: { id: 'permissions.revoke', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'revoke', label: 'Remove a permission rule', word: 'revoke',
  inputs: [{ id: 'rule', label: 'Rule', help: 'The rules in force', kind: 'choice', choices: { list: PERMISSION_RULES_LIST_NAME }, required: true, typed: { position: 1 } }],
  sentence: '{rule} is removed, so a call it covered is decided as usual again (it may run, or be asked), until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none',
  ownerOnly: { reason: 'a rule may be what stops a command from running', instead: 'Ask the owner to remove it under Permissions and safety.' },
  effects: ['approvals.write', 'model.refused'], example: { rule: 'owner-never-run-git-1' },
  async run(values, _services, caller) {
    const deleted = (await call(caller, 'permissions.rules.delete', { ruleId: values.rule })).deleted === true;
    if (!deleted) throw new CapabilityRefusal(`No permission rule has the id ${values.rule}; nothing was removed.`, '"See the permission rules" lists them.', 'NOT_FOUND');
    return { text: `Removed the rule ${values.rule}.`, data: { deleted: true } };
  },
};

// ---------------------------------------------------------------------------
// Phones' always-allow grants: devices.grants.list
// ---------------------------------------------------------------------------

export const DEVICES_GRANTS: CapabilityDefinition<SafetyMethodServices> = {
  capability: { id: 'devices.grants', group: 'safety', home: 'daemon', repeat: 'safe' },
  actionId: 'grants', label: 'See always-allow grants', word: 'grants', inputs: [], ...READ,
  sentence: 'Lists the "always allow" answers given to phone capabilities, with how often each was used.', effects: ['remote.read'], example: {},
  async run(_values, _services, caller) {
    const grants = rows((await call(caller, 'devices.grants.list')).grants);
    if (grants.length === 0) return { text: 'No always-allow grants: every phone capability asks each time.', data: { grants: [] } };
    return {
      text: ['Always-allow grants:', ...grants.map((grant) => `  ${text(grant.capabilityTitle) || text(grant.capabilityId) || text(grant.grantId)}  on ${text(grant.nodeId) || 'a phone'}${typeof grant.useCount === 'number' ? `  used ${grant.useCount} time${grant.useCount === 1 ? '' : 's'}` : ''}`)].join('\n'),
      data: { grants },
    };
  },
};

/** Every capability here, with the command it answers to today. */
export const SAFETY_METHOD_CAPABILITIES: readonly { readonly definition: CapabilityDefinition<SafetyMethodServices>; readonly command: { readonly name: string; readonly title: string } }[] = [
  ...[PRINCIPALS_LIST, PRINCIPALS_GET, PRINCIPALS_RESOLVE, PRINCIPALS_CREATE, PRINCIPALS_UPDATE, PRINCIPALS_DELETE]
    .map((definition) => ({ definition, command: { name: 'principals', title: 'Who is who' } })),
  ...[LOCAL_AUTH_REVIEW, LOCAL_AUTH_ADD, LOCAL_AUTH_REMOVE, LOCAL_AUTH_PASSWORD, LOCAL_AUTH_SIGN_OUT]
    .map((definition) => ({ definition, command: { name: 'local-auth', title: 'Local sign-in' } })),
  ...[PERMISSIONS_RULES, PERMISSIONS_REVOKE].map((definition) => ({ definition, command: { name: 'permissions', title: 'Permissions' } })),
  { definition: DEVICES_GRANTS, command: { name: 'devices', title: 'Devices' } },
];
