/**
 * `/local-auth`, described once (command-actions/): the people who may sign in
 * to this machine's daemon and web app, their open sessions, and the first-run
 * sign-in file. The daemon does each act (capabilities/builtin/safety-methods.ts
 * and system.ts, through the `local_auth.*` methods); a password is only ever
 * typed on a hidden line.
 */
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { daemonCapabilityAction, defineCommand, defineList, runDaemonCapability, type CommandDescription, type ListRow } from '@goodvibes/engine/terminal-shell/command-actions';
import {
  LOCAL_AUTH_ADD, LOCAL_AUTH_PASSWORD, LOCAL_AUTH_REMOVE, LOCAL_AUTH_REMOVE_FIRST_RUN_FILE, LOCAL_AUTH_REVIEW, LOCAL_AUTH_SIGN_OUT, type LocalSignInFacts,
} from '@goodvibes/engine/platform/platform/capabilities';
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

const LOCAL_AUTH_COMMAND: CommandDescription<CommandContext> = {
  name: 'local-auth',
  title: 'Local sign-in',
  summary: 'Choose who may sign in to this machine\'s daemon and web app',
  group: 'Setup',
  report: 'see-users',
  actions: [
    // Permissions and safety (capabilities/builtin/safety-methods.ts): who may sign in, through the local_auth methods.
    ...[LOCAL_AUTH_REVIEW, LOCAL_AUTH_ADD, LOCAL_AUTH_REMOVE, LOCAL_AUTH_PASSWORD, LOCAL_AUTH_SIGN_OUT]
      .map((definition) => daemonCapabilityAction<CommandContext>(definition, capabilityBinding)),
    // The daemon removes it (capabilities/builtin/system.ts, through local_auth.bootstrap.delete); the System place's Sign-in tab has it too.
    daemonCapabilityAction<CommandContext>(LOCAL_AUTH_REMOVE_FIRST_RUN_FILE, capabilityBinding),
  ],
};

const LOCAL_AUTH_SLASH_COMMAND = defineCommand(LOCAL_AUTH_COMMAND);

export function registerLocalAuthRuntimeCommands(registry: CommandRegistry): void {
  registry.register(LOCAL_AUTH_SLASH_COMMAND);
}
