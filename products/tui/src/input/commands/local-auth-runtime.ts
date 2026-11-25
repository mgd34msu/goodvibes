/**
 * Who may sign in to this machine's daemon and web app, and their open sessions: the lists a form chooses a user or
 * a session from, read from the daemon. The daemon does each act (capabilities/builtin/safety-methods.ts and
 * system.ts, through the `local_auth.*` methods), from Permissions and safety (Sign-in, Signed in) and System; no
 * slash command carries them. A password is only ever typed on a hidden line.
 */
import type { CommandContext } from '../command-registry.ts';
import { defineList, runDaemonCapability, type ListRow } from '@goodvibes/engine/terminal-shell/command-actions';
import type { LocalSignInFacts } from '@goodvibes/engine/platform/platform/capabilities';
import { capabilityBinding } from './capability-binding.ts';

async function signIn(ctx: CommandContext): Promise<LocalSignInFacts | undefined> {
  const answer = await runDaemonCapability('local-auth.review', {}, ctx, capabilityBinding);
  return answer.data as LocalSignInFacts | undefined;
}

defineList<CommandContext>({
  name: 'local-auth.users',
  async read(ctx) {
    return ((await signIn(ctx))?.users ?? []).map((user): ListRow => ({ value: user.username, label: user.username, state: user.roles.length > 0 ? user.roles.join(', ') : 'no role' }));
  },
  operator: { method: 'local_auth.status', input: {}, rows: { from: 'users', value: 'username', label: 'username' } },
});

defineList<CommandContext>({
  name: 'local-auth.sessions',
  async read(ctx) {
    return ((await signIn(ctx))?.sessions ?? []).map((session): ListRow => ({
      value: session.id, label: session.username, state: `ends ${new Date(session.expiresAt).toISOString()}`,
    }));
  },
  operator: { method: 'local_auth.status', input: {}, rows: { from: 'sessions', value: 'id', label: 'username', detail: 'id' } },
});

