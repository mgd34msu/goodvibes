/**
 * The live lists the model and provider capabilities' inputs choose from
 * (capabilities/builtin/models.ts, services.ts), read from the daemon, which
 * keeps them: your providers and their sign-ins, providers of your own, the
 * pinned models, the provider accounts, the services. Each is read through the
 * capability that lists the thing, and the web UI reads the same rows from the
 * same answer. Each program gives how it reaches the daemon once
 * (`registerModelsLists`), where it registers its commands.
 */
import {
  ACCOUNT_PROVIDERS_LIST, ALL_MODELS_LIST, AUTH_PROVIDERS_LIST, CUSTOM_PROVIDERS_LIST, PENDING_SERVICES_LIST, PINNED_MODELS_LIST, PROVIDERS_LIST,
  PROVIDER_MODELS_LIST, SERVICES_LIST, SUBSCRIPTIONS_AVAILABLE_LIST, SUBSCRIPTIONS_PENDING_LIST, SUBSCRIPTIONS_STORED_LIST,
} from '@goodvibes/engine/platform/platform/capabilities';
import { commandRefusal } from './command-confirmation.js';
import { defineList, rowsFromOutput, type ListRow, type ListRowsFromOutput } from './command-actions/lists.js';
import type { CommandActionContext } from './command-actions/types.js';
import { runDaemonCapability, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';

let binding: DaemonCapabilityBinding<CommandActionContext> | undefined;

/** How this program reaches the daemon for these lists (its `capability-binding.ts`). */
export function registerModelsLists<Ctx>(daemon: DaemonCapabilityBinding<Ctx>): void {
  binding = daemon as unknown as DaemonCapabilityBinding<CommandActionContext>;
}

/**
 * Run a model or provider capability in the daemon as this person's own press (the model picker's pin star): true
 * when it ran, false when the daemon refused it or cannot be reached. A model's call never comes this way.
 */
export async function runModelsCapability(id: string, values: Readonly<Record<string, string>>, ctx: CommandActionContext): Promise<boolean> {
  if (!binding) return false;
  try {
    await runDaemonCapability(id, values, ctx, binding);
    return true;
  } catch {
    return false;
  }
}

/** One list over one listing capability's `data`, the same rows for the terminal and the web UI. */
function daemonList(name: string, capability: string, rows: ListRowsFromOutput): void {
  defineList<CommandActionContext>({
    name,
    async read(ctx, earlier) {
      if (!binding) throw commandRefusal('The daemon is not reachable from this program yet.');
      const answer = await runDaemonCapability(capability, {}, ctx, binding);
      return rowsFromOutput(rows, { data: answer.data ?? {} }, earlier) as readonly ListRow[];
    },
    operator: { method: 'capabilities.run', input: { id: capability }, rows },
  });
}

daemonList(PROVIDERS_LIST, 'provider.list', { from: 'data.providers', value: 'id', label: 'id', state: 'signIn' });
daemonList(PROVIDER_MODELS_LIST, 'provider.list', { from: 'data.models', where: { field: 'provider', equals: '{provider}' }, value: 'registryKey', label: 'label' });
daemonList(CUSTOM_PROVIDERS_LIST, 'provider.list', { from: 'data.providers', where: { field: 'custom', equals: 'true' }, value: 'id', label: 'id' });
daemonList(SUBSCRIPTIONS_AVAILABLE_LIST, 'provider.list', { from: 'data.available', value: '.', label: '.' });
daemonList(SUBSCRIPTIONS_PENDING_LIST, 'provider.list', { from: 'data.pending', value: 'provider', label: 'provider' });
daemonList(SUBSCRIPTIONS_STORED_LIST, 'provider.list', { from: 'data.stored', value: 'provider', label: 'provider' });
daemonList(ALL_MODELS_LIST, 'provider.list', { from: 'data.models', value: 'registryKey', label: 'label', detail: 'provider' });
daemonList(PINNED_MODELS_LIST, 'pin.list', { from: 'data.pinned', value: 'registryKey', label: 'registryKey' });
daemonList(ACCOUNT_PROVIDERS_LIST, 'accounts.review', { from: 'data.providers', value: 'providerId', label: 'providerId', state: 'authFreshness' });
daemonList(AUTH_PROVIDERS_LIST, 'auth.review', { from: 'data.providers', value: 'provider', label: 'provider', state: 'freshness' });
daemonList(SERVICES_LIST, 'services.list', { from: 'data.services', value: 'name', label: 'name', detail: 'address', state: 'state' });
daemonList(PENDING_SERVICES_LIST, 'services.list', { from: 'data.pending', value: 'name', label: 'name', detail: 'sends' });
