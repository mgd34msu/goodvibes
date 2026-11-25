/**
 * Who is who, as a terminal program reaches it: the list a "Who" input chooses from, read from the daemon's registry
 * of people, bots and services and their identity on each channel (the `principals.*` methods;
 * capabilities/builtin/safety-methods.ts). No slash command carries them: Permissions and safety, Who is who, is where
 * a person lists, finds, adds, changes and removes them; a model, an outside agent and a script run the same
 * capabilities by find and run.
 */
import { defineList, type ListRow } from './command-actions/lists.js';
import { runDaemonCapability, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import type { CommandActionContext } from './command-actions/types.js';

/** How the list reaches the daemon: set when a program wires it. */
let listBinding: DaemonCapabilityBinding<CommandActionContext> | undefined;

/** The people, bots and services the daemon knows (the list a "Who" input chooses from). */
defineList<CommandActionContext>({
  name: 'principals',
  async read(ctx) {
    if (!listBinding) return [];
    const answer = await runDaemonCapability('principals.list', {}, ctx, listBinding);
    const principals = Array.isArray(answer.data?.['principals']) ? answer.data['principals'] as Record<string, unknown>[] : [];
    return principals.filter((principal) => typeof principal['id'] === 'string').map((principal): ListRow => {
      const identities = Array.isArray(principal['identities']) ? principal['identities'] as Record<string, unknown>[] : [];
      return {
        value: principal['id'] as string, label: typeof principal['name'] === 'string' ? principal['name'] : principal['id'] as string,
        ...(typeof principal['kind'] === 'string' ? { state: principal['kind'] } : {}),
        detail: identities.map((identity) => `${String(identity['channel'])}:${String(identity['value'])}`).join(', ') || 'no identities',
      };
    });
  },
  operator: { method: 'principals.list', input: {}, rows: { from: 'principals', value: 'id', label: 'name', state: 'kind' } },
});

/** Wire the "Who" list of one program to its daemon (each program does this once, as it registers its commands). */
export function wirePrincipalsList<Ctx extends CommandActionContext>(binding: DaemonCapabilityBinding<Ctx>): void {
  listBinding = binding as DaemonCapabilityBinding<CommandActionContext>;
}
