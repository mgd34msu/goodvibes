/**
 * Devices and network, Addresses and ports: the account that signs in to this machine's daemon and web app from a
 * browser or another device. Opening GoodVibes to the network (the System, Setup topics "Use it in a browser", "Other
 * devices" and "Receive webhooks", in both terminal programs) needs one; this is the step the terminal app's own form
 * for those topics held, as a capability the place runs. It makes an administrator, or gives an administrator of that
 * name a new password; then the first-run sign-in is retired, as that form retired it: the user the first-run file
 * names (when it is another name) is removed, then the file. Each act is a daemon method run as the same caller
 * (`local_auth.*`); the file is read here only for the name it gives, never its password.
 */
import { readFileSync } from 'node:fs';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type InputDescription } from '../types.js';

/** It needs nothing of its own: every act is a daemon method run as the caller. */
export type NetworkAccountServices = Readonly<Record<never, never>>;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function call(caller: CapabilityCaller, methodId: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  if (!caller.method) throw new CapabilityRefusal('This runs in the daemon, and no daemon took the request here; nothing was done.', undefined, 'UNAVAILABLE');
  return record(await caller.method(methodId, body));
}

/** The user the first-run sign-in file names (its `username=` line), or null; the password line is never read out. */
function firstRunUserOf(path: unknown): string | null {
  if (typeof path !== 'string' || !path) return null;
  try {
    const line = readFileSync(path, 'utf-8').split('\n').map((entry) => entry.trim()).find((entry) => entry.startsWith('username='));
    const name = line?.slice('username='.length).trim();
    return name || null;
  } catch {
    return null;
  }
}

const PASSWORD: InputDescription = {
  id: 'password', label: 'Password', help: 'At least 8 characters; hidden as you type', kind: 'secret', required: true, typed: { flag: '--password' },
};
// Typed twice in a form, so one mistyped character cannot set a password nobody knows.
const PASSWORD_AGAIN: InputDescription = {
  id: 'again', label: 'Password again', help: 'The same password, to catch a typing mistake', kind: 'secret',
  required: { default: '', defaultMeans: 'not typed a second time' }, typed: { flag: '--again' },
};

export const NETWORK_SIGN_IN_ACCOUNT: CapabilityDefinition<NetworkAccountServices> = {
  capability: { id: 'devices.sign-in-account', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'sign-in-account', label: 'Make the account that signs in from other devices', word: 'sign-in-account',
  button: 'Make the account',
  inputs: [
    {
      id: 'user', label: 'User name', help: 'The name an administrator signs in with from a browser or another device', kind: 'text',
      freeTextReason: 'a name you choose', required: { default: 'admin', defaultMeans: 'admin' }, typed: { position: 1 },
    },
    PASSWORD,
    PASSWORD_AGAIN,
  ],
  sentence: '{user} will be able to sign in to this machine\'s daemon and web app from a browser or another device as an administrator, until you change it; the first-run sign-in, when there is one, is removed (its user and its file).',
  done: '{user} signs in from your other devices as an administrator.',
  touches: 'credential', lasts: 'kept', risk: 'none',
  // The method's own: an administrator's act on sign-in, which a model never takes.
  effects: ['auth.administer', 'model.refused'],
  example: { user: 'admin' },
  async run(values, _services, caller) {
    const user = (values.user ?? '').trim() || 'admin';
    const password = values.password ?? '';
    if (!password) throw new CapabilityRefusal('No account was made: no password was given.', 'Type a password of at least 8 characters.');
    if (password.length < 8) throw new CapabilityRefusal('No account was made: the password is shorter than 8 characters.', 'Type a password of at least 8 characters.');
    if (values.again && values.again !== password) throw new CapabilityRefusal('No account was made: the two passwords are not the same.', 'Type the same password twice.');
    const status = await call(caller, 'local_auth.status');
    const users = Array.isArray(status.users) ? status.users.map(record) : [];
    const existing = users.find((entry) => entry.username === user);
    const roles = existing && Array.isArray(existing.roles) ? existing.roles.filter((role): role is string => typeof role === 'string') : [];
    if (existing && !roles.includes('admin')) {
      throw new CapabilityRefusal(`No account was made: ${user} may already sign in, but not as an administrator.`, 'Choose another name, or change who may sign in on the Sign-in tab of Permissions and safety.');
    }
    // The first-run user, read before anything changes (a new password for that same user retires its file by itself).
    const firstRunUser = status.bootstrapCredentialPresent === true ? firstRunUserOf(status.bootstrapCredentialPath) : null;
    if (existing) await call(caller, 'local_auth.users.password.rotate', { username: user, password });
    else await call(caller, 'local_auth.users.create', { username: user, password, roles: ['admin'] });
    // The first-run sign-in retired: its user, when it is another name, then its file.
    const removeUser = firstRunUser !== null && firstRunUser !== user && users.some((entry) => entry.username === firstRunUser);
    const userRemoved = removeUser ? (await call(caller, 'local_auth.users.delete', { username: firstRunUser })).deleted === true : false;
    const fileRemoved = status.bootstrapCredentialPresent === true
      ? (await call(caller, 'local_auth.bootstrap.delete')).removed === true || firstRunUser === user
      : false;
    // The done line says who signs in; the text adds only what it does not say, so the outcome stays short.
    return {
      text: [
        ...(existing ? [`${user} already existed: it has the new password.`] : []),
        ...(userRemoved ? [`The first-run user ${firstRunUser} and the first-run sign-in file are removed.`]
          : fileRemoved ? ['The first-run sign-in file is removed.'] : []),
      ].join(' '),
      data: { user, made: !existing, firstRunUserRemoved: userRemoved, firstRunFileRemoved: fileRemoved },
    };
  },
};
