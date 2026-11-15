import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireLocalUserAuthManager } from './runtime-services.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';

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
      ctx.print('Usage: /local-auth add-user <username> <password> [roles] (roles default to "user"; pass admin explicitly)\nTip: invoke without a password to type it in the masked prompt: /local-auth add-user <username>');
      return;
    }
    if (!password) {
      // No password supplied: open the masked password prompt.
      if (ctx.openLocalAuthMaskedEntry) {
        ctx.openLocalAuthMaskedEntry('add-user', username);
      } else {
        ctx.print('Masked entry unavailable in this context. Use: /local-auth add-user <username> <password>');
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
      ctx.print(summarizeError(error));
    }
    return;
  }

  if (sub === 'delete-user') {
    const username = args[1];
    if (!username) {
      ctx.print('Usage: /local-auth delete-user <username>');
      return;
    }
    try {
      const deleted = auth.deleteUser(username);
      ctx.print(deleted ? `Deleted local auth user ${username}.` : `Unknown local auth user: ${username}`);
    } catch (error) {
      ctx.print(summarizeError(error));
    }
    return;
  }

  if (sub === 'rotate-password') {
    const username = args[1];
    const password = args[2];
    if (!username) {
      ctx.print('Usage: /local-auth rotate-password <username> <password>\nTip: invoke without a password to type it in the masked prompt: /local-auth rotate-password <username>');
      return;
    }
    if (!password) {
      // No password supplied: open the masked password prompt.
      if (ctx.openLocalAuthMaskedEntry) {
        ctx.openLocalAuthMaskedEntry('rotate-password', username);
      } else {
        ctx.print('Masked entry unavailable in this context. Use: /local-auth rotate-password <username> <password>');
      }
      return;
    }
    // Password supplied as argv: it is echoed in the transcript, so say so.
    ctx.print('Warning: a password passed as a command argument stays visible in the transcript and shell scrollback. The masked entry is preferred: /local-auth rotate-password <username>');
    try {
      auth.rotatePassword(username, password);
      ctx.print(`Rotated password for ${username}. Existing sessions were revoked.`);
    } catch (error) {
      ctx.print(summarizeError(error));
    }
    return;
  }

  if (sub === 'revoke-session') {
    const token = args[1];
    if (!token) {
      ctx.print('Usage: /local-auth revoke-session <session-id-or-token>');
      return;
    }
    ctx.print(auth.revokeSession(token) ? 'Revoked the selected session.' : 'Unknown session id or token.');
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
    handler(args, ctx) {
      handleLocalAuthCommand(args, ctx);
    },
  });
}
