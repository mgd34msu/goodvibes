import type { HookApi } from '@goodvibes/engine/platform/platform/hooks';
import type { TerminalCommandRegistry } from './command-registry.js';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext } from './command-actions/types.js';
import { daemonCapabilityAction, runDaemonCapability, sessionCapabilityAction, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import {
  HOOKS_CHAIN, HOOKS_CONTRACTS, HOOKS_DISABLE, HOOKS_ENABLE, HOOKS_EXPORT, HOOKS_IMPORT, HOOKS_INSPECT, HOOKS_RELOAD, HOOKS_REMOVE,
  HOOKS_SCAFFOLD, HOOKS_SIMULATE, HOOKS_TRACE, MANAGED_ENTRIES_LIST, MANAGED_HOOKS_LIST, type HooksReloadServices,
} from '@goodvibes/engine/platform/platform/capabilities';

/**
 * `/hooks`, described once (command-actions/) for both terminal apps. Every
 * act on the hooks file runs in the daemon (capabilities/builtin/hooks.ts), on
 * the project's own hooks file: see the hook points and the managed hooks,
 * make, switch on or off and remove hooks and chains, try which hooks an event
 * would run, move hooks between machines, and the trace of which hooks ran.
 * Reading the file again into this program's own dispatcher is this
 * program's. The hooks are shown in the Tools and extensions place.
 */

/** What `/hooks` reads from a product's command context. */
export interface HooksCommandContext extends CommandActionContext {
  /** This program's hook API: its own dispatcher, which `reload` reads the file into. */
  readonly clients?: { readonly hookApi?: HookApi | undefined } | undefined;
}

/**
 * How `/hooks` reaches the daemon, which manages the hooks file. Set when the
 * product registers the command; the lists below read through it.
 */
let daemonBinding: DaemonCapabilityBinding<HooksCommandContext> | undefined;

function bindingFor(): DaemonCapabilityBinding<HooksCommandContext> {
  if (!daemonBinding) throw commandRefusal('The hooks are managed by the daemon, and this program has no way to reach it yet.');
  return daemonBinding;
}

interface ManagedRow { readonly name: string; readonly detail?: string; readonly state?: string }
interface ChainRow { readonly name: string; readonly steps?: number }

async function managedFromDaemon(ctx: HooksCommandContext): Promise<{ readonly managed: readonly ManagedRow[]; readonly chains: readonly ChainRow[] }> {
  const answer = await runDaemonCapability('hooks.contracts', {}, ctx, bindingFor());
  const data = answer.data ?? {};
  return {
    managed: Array.isArray(data['managed']) ? data['managed'] as ManagedRow[] : [],
    chains: Array.isArray(data['chains']) ? data['chains'] as ChainRow[] : [],
  };
}

/** The managed hooks alone: the entries that can be switched on or off, as the daemon reads them from the hooks file. */
defineList<HooksCommandContext>({
  name: MANAGED_HOOKS_LIST,
  async read(ctx) {
    const { managed } = await managedFromDaemon(ctx);
    return managed.map((hook): ListRow => ({ value: hook.name, label: hook.name, ...(hook.detail ? { detail: hook.detail } : {}), ...(hook.state ? { state: hook.state } : {}) }));
  },
  operator: { method: 'capabilities.run', input: { id: 'hooks.contracts' }, rows: { from: 'data.managed', value: 'name', label: 'name', detail: 'detail', state: 'state' } },
});
/** The managed hooks and chains: the entries that can be removed. */
defineList<HooksCommandContext>({
  name: MANAGED_ENTRIES_LIST,
  async read(ctx) {
    const { managed, chains } = await managedFromDaemon(ctx);
    return [
      ...managed.map((hook): ListRow => ({ value: hook.name, label: hook.name, ...(hook.detail ? { detail: hook.detail } : {}), ...(hook.state ? { state: hook.state } : {}) })),
      ...chains.map((chain): ListRow => ({ value: chain.name, label: chain.name, detail: `chain of ${chain.steps ?? 0} step(s)` })),
    ];
  },
  operator: { method: 'capabilities.run', input: { id: 'hooks.contracts' }, rows: { from: 'data.entries', value: 'name', label: 'name', detail: 'detail', state: 'state' } },
});

/** This program's own dispatcher, as `hooks.reload` takes it. */
export function hooksReloadServices(ctx: HooksCommandContext): HooksReloadServices {
  return {
    hookFile: {
      async reload() {
        const api = ctx.clients?.hookApi;
        if (!api) throw commandRefusal('This program runs no hooks, so there is nothing to read again.');
        await api.workbench.reload();
        return api.workbench.getFilePath();
      },
    },
  };
}

/**
 * `binding` is how this program reaches the daemon: every act on the hooks
 * file runs there and nowhere else.
 */
export function registerHooksCommand<Ctx extends HooksCommandContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, binding: DaemonCapabilityBinding<Ctx>): void {
  // The list readers are shared by every registration; they are handed the same product context the actions are.
  daemonBinding = binding as unknown as DaemonCapabilityBinding<HooksCommandContext>;
  registry.register(defineCommand<Ctx>({
    name: 'hooks',
    title: 'Hooks',
    summary: 'Run your own steps when things happen: before a tool runs, after a turn, and more',
    group: 'Extensions',
    report: 'contracts',
    firstScreenRows: [
      'contracts', 'trace', 'scaffold', 'chain',
      { label: 'Switch a hook on or off, or remove it', actions: ['enable', 'disable', 'remove'] },
      { label: 'Try and move hooks', actions: ['simulate', 'reload', 'export', 'inspect', 'import'] },
    ],
    actions: [
      // Moved to the daemon (capabilities/builtin/hooks.ts): the description and the handler are the capability's.
      daemonCapabilityAction<Ctx>(HOOKS_CONTRACTS, binding),
      daemonCapabilityAction<Ctx>(HOOKS_TRACE, binding),
      daemonCapabilityAction<Ctx>(HOOKS_SCAFFOLD, binding),
      daemonCapabilityAction<Ctx>(HOOKS_CHAIN, binding),
      daemonCapabilityAction<Ctx>(HOOKS_ENABLE, binding),
      daemonCapabilityAction<Ctx>(HOOKS_DISABLE, binding),
      daemonCapabilityAction<Ctx>(HOOKS_REMOVE, binding),
      daemonCapabilityAction<Ctx>(HOOKS_SIMULATE, binding),
      // This program's own dispatcher reads the file again.
      sessionCapabilityAction<Ctx, HooksReloadServices>(HOOKS_RELOAD, hooksReloadServices, { terminalOnly: 'It reads the hooks file into the dispatcher of the program holding the conversation.' }),
      daemonCapabilityAction<Ctx>(HOOKS_EXPORT, binding),
      daemonCapabilityAction<Ctx>(HOOKS_INSPECT, binding),
      daemonCapabilityAction<Ctx>(HOOKS_IMPORT, binding),
    ],
  }));
}
