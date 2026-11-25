/**
 * `/principals`, described once (command-actions/) for both terminal apps:
 * the daemon's registry of who is who across channels (one person or bot with
 * its identities on each channel). Each action is a daemon capability over the
 * `principals.*` methods (capabilities/builtin/safety-methods.ts); each app
 * says how it reaches the daemon.
 */
import {
  PRINCIPALS_CREATE, PRINCIPALS_DELETE, PRINCIPALS_GET, PRINCIPALS_LIST, PRINCIPALS_RESOLVE, PRINCIPALS_UPDATE,
} from '@goodvibes/engine/platform/platform/capabilities';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import { daemonCapabilityAction, runDaemonCapability, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import type { CommandActionContext } from './command-actions/types.js';

/** How the list reaches the daemon: set when a program registers the command. */
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

export function registerPrincipalsCommand<Ctx extends CommandActionContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, binding: DaemonCapabilityBinding<Ctx>): void {
  listBinding = binding as DaemonCapabilityBinding<CommandActionContext>;
  registry.register(defineCommand<Ctx>({
    name: 'principals',
    title: 'Who is who',
    summary: 'The people, bots and services the daemon knows, and their identity on each channel',
    group: 'Channels',
    report: 'list',
    actions: [PRINCIPALS_LIST, PRINCIPALS_GET, PRINCIPALS_RESOLVE, PRINCIPALS_CREATE, PRINCIPALS_UPDATE, PRINCIPALS_DELETE]
      .map((definition) => daemonCapabilityAction<Ctx>(definition, binding)),
  }));
}
