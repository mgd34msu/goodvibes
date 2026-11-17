import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireLocalUserAuthManager } from './runtime-services.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';

// An omitted roles argument must not grant the highest role; admin is always spelled out.
const DEFAULT_NEW_USER_ROLES: readonly string[] = ['user'];

function formatRoles(roles: readonly string[]): string {
  return roles.length > 0 ? roles.join(', ') : '(none)';
}

export function handleLocalAuthCommand(args: string[], ctx: CommandContext): void {
  // Bare /local-auth opens the Local Auth modal where one can open; the text
  // review stays at /local-auth review.
  const sub = (args[0] ?? (ctx.openModal ? 'open' : 'review')).toLowerCase();
  const auth = requireLocalUserAuthManager(ctx);
  if (sub === 'panel' || sub === 'open') {
    ctx.openModal?.('local-auth-modal');
    return;
  }

  if (sub === 'add-user') {
    const username = args[1];
    const password = args[2];
    if (!username) {
      throw commandRefusal('Usage: /local-auth add-user <username> <password> [roles] (roles default to "user"; pass admin explicitly)', '/local-auth add-user <username> opens a masked prompt for the password');
    }
    if (!password) {
      // No password supplied: open the masked password prompt.
      if (ctx.openLocalAuthMaskedEntry) {
        ctx.openLocalAuthMaskedEntry('add-user', username);
      } else {
        throw commandRefusal('Masked entry is not available here; no user was added.', 'Use: /local-auth add-user <username> <password>', 'MASKED_ENTRY_UNAVAILABLE');
      }
      return;
    }
    // Password supplied as argv: it is echoed in the transcript, so say so.
    ctx.print('Warning: a password passed as a command argument stays visible in the transcript and shell scrollback. The masked entry is preferred: /local-auth add-user <username>');
    const roles = args[3]?.split(',').map((value) => value.trim()).filter(Boolean) ?? DEFAULT_NEW_USER_ROLES;
    try {
      const added = auth.addUser(username, password, roles);
      ctx.print(`Added local auth user ${added.username} (${formatRoles(added.roles)}).`);
    } catch (error) {
      throw commandRefusal(`No user was added: ${summarizeError(error)}`, undefined, 'NOT_DONE');
    }
    return;
  }

  if (sub === 'delete-user') {
    const username = args[1];
    if (!username) throw commandRefusal('Usage: /local-auth delete-user <username>');
    let deleted: boolean;
    try {
      deleted = auth.deleteUser(username);
    } catch (error) {
      throw commandRefusal(`${username} was not deleted: ${summarizeError(error)}`, undefined, 'NOT_DONE');
    }
    if (!deleted) throw commandRefusal(`Unknown local auth user: ${username}`, '/local-auth review lists the local users', 'NOT_FOUND');
    ctx.print(`Deleted local auth user ${username}.`);
    return;
  }

  if (sub === 'rotate-password') {
    const username = args[1];
    const password = args[2];
    if (!username) {
      throw commandRefusal('Usage: /local-auth rotate-password <username> <password>', '/local-auth rotate-password <username> opens a masked prompt for the password');
    }
    if (!password) {
      // No password supplied: open the masked password prompt.
      if (ctx.openLocalAuthMaskedEntry) {
        ctx.openLocalAuthMaskedEntry('rotate-password', username);
      } else {
        throw commandRefusal('Masked entry is not available here; the password was not changed.', 'Use: /local-auth rotate-password <username> <password>', 'MASKED_ENTRY_UNAVAILABLE');
      }
      return;
    }
    // Password supplied as argv: it is echoed in the transcript, so say so.
    ctx.print('Warning: a password passed as a command argument stays visible in the transcript and shell scrollback. The masked entry is preferred: /local-auth rotate-password <username>');
    try {
      auth.rotatePassword(username, password);
      ctx.print(`Rotated password for ${username}. Existing sessions were revoked.`);
    } catch (error) {
      throw commandRefusal(`The password for ${username} was not changed: ${summarizeError(error)}`, undefined, 'NOT_DONE');
    }
    return;
  }

  if (sub === 'revoke-session') {
    const token = args[1];
    if (!token) throw commandRefusal('Usage: /local-auth revoke-session <session-id-or-token>');
    if (!auth.revokeSession(token)) throw commandRefusal('Unknown session id or token.', '/local-auth review lists the open sessions', 'NOT_FOUND');
    ctx.print('Revoked the selected session.');
    return;
  }

  if (sub === 'clear-bootstrap-file') {
    ctx.print(auth.clearBootstrapCredentialFile()
      ? 'Removed bootstrap credential file.'
      : 'No bootstrap credential file was present.');
    return;
  }

  const snapshot = auth.inspect();
  ctx.print([
    'Local Auth Review',
    `  user store: ${snapshot.userStorePath}`,
    `  bootstrap file: ${snapshot.bootstrapCredentialPath}`,
    `  bootstrap credentials: ${snapshot.bootstrapCredentialPresent ? 'present' : 'cleared'}`,
    `  users: ${snapshot.userCount}`,
    `  sessions: ${snapshot.sessionCount}`,
    ...snapshot.users.map((user) => `  user: ${user.username}  roles=${formatRoles(user.roles)}`),
    ...snapshot.sessions.map((session) => `  session: ${session.username}  expires=${new Date(session.expiresAt).toISOString()}  id=${session.id}`),
  ].join('\n'));
}

export function registerLocalAuthRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'local-auth',
    aliases: ['auth-local'],
    description: 'Inspect and manage local daemon/listener auth users, sessions, and bootstrap credentials',
    usage: '[review|panel|add-user <username> <password> [roles, default user]|delete-user <username>|rotate-password <username> <password>|revoke-session <session-id-or-token>|clear-bootstrap-file]',
    secretArgs: { subcommands: { 'add-user': [2], 'rotate-password': [2], 'revoke-session': [1] } },
    subcommands: {
      'add-user': '<username> <password> [roles]', 'delete-user': '<username>', 'rotate-password': '<username> <password>',
      'revoke-session': '<session-id-or-token>', 'clear-bootstrap-file': '',
    },
    confirm(args) {
      if (args[0] === 'delete-user' && args[1]) {
        return { title: `Delete local user ${args[1]}?`, detail: `${args[1]} can no longer sign in and the account cannot be recovered; add it again with /local-auth add-user.`, confirmLabel: 'Delete' };
      }
      if (args[0] === 'clear-bootstrap-file') {
        return { title: 'Remove the bootstrap credential file?', detail: 'The first-run credential file is deleted. If no local user has been created, nobody can sign in to the web app until one is added with /local-auth add-user.', confirmLabel: 'Remove' };
      }
      return undefined;
    },
    handler(args, ctx) {
      handleLocalAuthCommand(args, ctx);
    },
  });
}
