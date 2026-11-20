/**
 * `/local-auth`, described once (command-actions/): the people who may sign in
 * to this machine's daemon and web app, their open sessions, and the first-run
 * sign-in file. A password is only ever typed on a hidden line.
 */
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireLocalUserAuthManager } from './runtime-services.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { defineCommand, defineList, type CommandDescription, type FixedChoice, type InputDescription, type ListRow } from '@goodvibes-jev/engine/terminal-shell/command-actions';

function formatRoles(roles: readonly string[]): string {
  return roles.length > 0 ? roles.join(', ') : '(none)';
}

const LOCAL_USERS = defineList<CommandContext>({
  name: 'local-auth.users',
  async read(ctx) {
    return requireLocalUserAuthManager(ctx).inspect().users.map((user): ListRow => ({ value: user.username, label: user.username, state: formatRoles(user.roles) }));
  },
  operator: { method: 'local_auth.status', input: {}, rows: { from: 'users', value: 'username', label: 'username' } },
});

const LOCAL_SESSIONS = defineList<CommandContext>({
  name: 'local-auth.sessions',
  async read(ctx) {
    return requireLocalUserAuthManager(ctx).inspect().sessions.map((session): ListRow => ({
      value: session.id, label: `${session.username}  ${session.id}`, state: `ends ${new Date(session.expiresAt).toISOString()}`,
    }));
  },
  operator: { method: 'local_auth.status', input: {}, rows: { from: 'sessions', value: 'id', label: 'username', detail: 'id' } },
});

// An omitted role must not grant the highest one; admin is always chosen.
const ROLES: readonly FixedChoice[] = [
  { value: 'user', label: 'User', help: 'Can sign in and use the web app.' },
  { value: 'admin', label: 'Administrator', help: 'Can also manage users, settings and the daemon.', risk: 'loosens-a-protection' },
];

const USER: InputDescription = {
  id: 'user', label: 'User', help: 'The people who may sign in here', kind: 'choice',
  choices: { list: LOCAL_USERS }, required: true, typed: { position: 1 },
};
const PASSWORD: InputDescription = {
  id: 'password', label: 'Password', help: 'Hidden as you type', kind: 'secret', required: true, typed: { flag: '--password' },
};
// Typed twice in the guided path, so one mistyped character cannot set a password nobody knows.
const PASSWORD_AGAIN: InputDescription = {
  id: 'again', label: 'Password again', help: 'The same password, to catch a typing mistake', kind: 'secret',
  required: { default: '', defaultMeans: 'not typed a second time' }, typed: { flag: '--again' },
};

function samePassword(values: Readonly<Record<string, string>>, what: string): string {
  if (!values.password) throw commandRefusal(`${what}: no password was given.`);
  if (values.again && values.again !== values.password) throw commandRefusal(`${what}: the two passwords are not the same.`, 'Type the same password twice.');
  return values.password;
}

const LOCAL_AUTH_COMMAND: CommandDescription<CommandContext> = {
  name: 'local-auth',
  title: 'Local sign-in',
  summary: 'Choose who may sign in to this machine\'s daemon and web app',
  group: 'Setup',
  report: 'see-users',
  actions: [
    {
      id: 'see-users', label: 'See who may sign in', word: 'review', inputs: [],
      async rowValue(ctx) {
        const snapshot = requireLocalUserAuthManager(ctx).inspect();
        return `${snapshot.userCount} user${snapshot.userCount === 1 ? '' : 's'}, ${snapshot.sessionCount} signed in`;
      },
      sentence: 'Shows the local users, their roles, the open sessions and whether the first-run sign-in file is still there.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'local_auth.status', fields: {} }, example: {},
      async run(_values, ctx) {
        const snapshot = requireLocalUserAuthManager(ctx).inspect();
        return [
          'Local sign-in',
          `  users: ${snapshot.userCount}${snapshot.users.length > 0 ? '' : ' (add one with /local-auth add)'}`,
          ...snapshot.users.map((user) => `    ${user.username}  ${formatRoles(user.roles)}`),
          `  signed in: ${snapshot.sessionCount}`,
          ...snapshot.sessions.map((session) => `    ${session.username}  ends ${new Date(session.expiresAt).toISOString()}  ${session.id}`),
          `  first-run sign-in file: ${snapshot.bootstrapCredentialPresent ? `present (${snapshot.bootstrapCredentialPath})` : 'removed'}`,
          `  users are kept in ${snapshot.userStorePath}`,
        ].join('\n');
      },
    },
    {
      id: 'open-screen', label: 'Open the local sign-in screen', word: 'open', inputs: [],
      sentence: 'Opens the full-screen view of local users and sessions.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'It is a terminal screen.' }, example: {},
      async run(_values, ctx) {
        if (!ctx.openModal) throw commandRefusal('This surface has no local sign-in screen.', '/local-auth review lists the users.');
        ctx.openModal('local-auth-modal');
      },
    },
    {
      id: 'add-user', label: 'Let someone sign in', word: 'add',
      inputs: [
        { id: 'user', label: 'User name', help: 'The name they sign in with', kind: 'text', freeTextReason: 'a name you choose for them', required: true, typed: { position: 1 } },
        PASSWORD,
        PASSWORD_AGAIN,
        { id: 'role', label: 'Role', help: 'What they may do once signed in', kind: 'choice', choices: ROLES, required: { default: 'user', defaultMeans: 'a user, not an administrator' }, typed: { flag: '--role' } },
      ],
      sentence: '{user} will be able to sign in to this machine\'s daemon and web app as a {role}, until you change it.',
      done: '{user} may sign in as a {role}.',
      touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'remove-user',
      operator: { method: 'local_auth.users.create', fields: { username: 'user', password: 'password', roles: 'role' } },
      example: { user: 'sam', role: 'user' },
      async run(values, ctx) {
        const password = samePassword(values, 'No user was added');
        try {
          requireLocalUserAuthManager(ctx).addUser(values.user!, password, [values.role || 'user']);
        } catch (error) {
          throw commandRefusal(`No user was added: ${summarizeError(error)}`, undefined, 'NOT_DONE');
        }
      },
    },
    {
      id: 'remove-user', label: 'Stop someone signing in', word: 'remove', inputs: [USER],
      sentence: '{user} will no longer be able to sign in, and the account is deleted; add it again to let them back in.',
      done: 'Removed {user}.',
      touches: 'credential', lasts: 'kept', risk: 'cannot-be-undone',
      operator: { method: 'local_auth.users.delete', fields: { username: 'user' } },
      example: { user: 'sam' },
      async run(values, ctx) {
        let deleted: boolean;
        try {
          deleted = requireLocalUserAuthManager(ctx).deleteUser(values.user!);
        } catch (error) {
          throw commandRefusal(`${values.user} was not removed: ${summarizeError(error)}`, undefined, 'NOT_DONE');
        }
        if (!deleted) throw commandRefusal(`No local user is named ${values.user}.`, '/local-auth review lists the users.', 'NOT_FOUND');
      },
    },
    {
      id: 'change-password', label: 'Change someone\'s password', word: 'password', inputs: [USER, PASSWORD, PASSWORD_AGAIN],
      sentence: '{user}\'s password will be replaced and everyone signed in as {user} is signed out, until you change it.',
      done: 'Changed {user}\'s password; their open sessions were ended.',
      touches: 'credential', lasts: 'kept', risk: 'none',
      operator: { method: 'local_auth.users.password.rotate', fields: { username: 'user', password: 'password' } },
      example: { user: 'sam' },
      async run(values, ctx) {
        const password = samePassword(values, `The password for ${values.user} was not changed`);
        try {
          requireLocalUserAuthManager(ctx).rotatePassword(values.user!, password);
        } catch (error) {
          throw commandRefusal(`The password for ${values.user} was not changed: ${summarizeError(error)}`, undefined, 'NOT_DONE');
        }
      },
    },
    {
      id: 'end-session', label: 'Sign someone out', word: 'sign-out',
      inputs: [{ id: 'session', label: 'Session', help: 'Who is signed in now', kind: 'choice', choices: { list: LOCAL_SESSIONS }, required: true, typed: { position: 1 } }],
      sentence: 'Session {session} will be ended; whoever uses it must sign in again.',
      done: 'Ended session {session}.',
      touches: 'credential', lasts: 'kept', risk: 'cannot-be-undone',
      operator: { method: 'local_auth.sessions.delete', fields: { sessionId: 'session' } },
      example: { session: 's-1' },
      async run(values, ctx) {
        if (!requireLocalUserAuthManager(ctx).revokeSession(values.session!)) throw commandRefusal(`No open session is ${values.session}.`, '/local-auth review lists the open sessions.', 'NOT_FOUND');
      },
    },
    {
      id: 'remove-first-run-file', label: 'Remove the first-run sign-in file', word: 'remove-first-run-file', inputs: [],
      sentence: 'The file holding the first-run sign-in is deleted; if no user has been added, nobody can sign in to the web app until one is.',
      done: '',
      touches: 'credential', lasts: 'kept', risk: 'cannot-be-undone',
      operator: { method: 'local_auth.bootstrap.delete', fields: {} }, example: {},
      async run(_values, ctx) {
        return requireLocalUserAuthManager(ctx).clearBootstrapCredentialFile() ? 'Removed the first-run sign-in file.' : 'There was no first-run sign-in file.';
      },
    },
  ],
};

const LOCAL_AUTH_SLASH_COMMAND = defineCommand(LOCAL_AUTH_COMMAND);

export function registerLocalAuthRuntimeCommands(registry: CommandRegistry): void {
  registry.register(LOCAL_AUTH_SLASH_COMMAND);
}
