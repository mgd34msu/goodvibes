/**
 * tools-lists.ts, the terminal side of the Tools and extensions place's hooks
 * and marketplace (tools-place.ts holds their lists and actions): the live
 * lists a form's inputs choose from (a managed hook, a hook or chain to
 * remove, a curated entry, an installed entry, a backup to roll back to), read
 * from the daemon through the program's binding. Kept out of the declaration so
 * it holds no terminal code and the web UI draws it too.
 */
import {
  MANAGED_ENTRIES_LIST, MANAGED_HOOKS_LIST, MARKETPLACE_BACKUPS_LIST, MARKETPLACE_CATALOG_LIST, MARKETPLACE_INSTALLED_LIST,
} from '@goodvibes/engine/platform/platform/capabilities';
import { defineList, type ListRow } from '../command-actions/lists.js';
import { runDaemonCapability, type DaemonCapabilityBinding } from '../command-actions/capability-actions.js';
import type { ActionValues, CommandActionContext } from '../command-actions/types.js';
// A made image or video is opened here after the person's own press of "make an image or a video".
import '../media-viewer.js';

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const record = (value: unknown): Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rows = (value: unknown): readonly Readonly<Record<string, unknown>>[] => Array.isArray(value) ? value.map(record) : [];

let binding: DaemonCapabilityBinding<CommandActionContext> | undefined;

/** Each program gives the binding its places use (capability-binding.ts), so a form's lists read the daemon. */
export function bindToolsLists(next: DaemonCapabilityBinding<never>): void {
  binding = next as unknown as DaemonCapabilityBinding<CommandActionContext>;
}

async function dataOf(id: string, values: ActionValues, ctx: CommandActionContext): Promise<Readonly<Record<string, unknown>>> {
  if (!binding) return {};
  return record((await runDaemonCapability(id, values, ctx, binding)).data);
}

// Hooks: the managed hooks (switched on or off) and the hooks and chains (removed), as the daemon reads the project's file.
defineList<CommandActionContext>({
  name: MANAGED_HOOKS_LIST,
  async read(ctx) {
    return rows((await dataOf('hooks.contracts', {}, ctx))['managed']).filter((hook) => text(hook['name'])).map((hook): ListRow => ({
      value: text(hook['name']), label: text(hook['name']), ...(text(hook['detail']) ? { detail: text(hook['detail']) } : {}), ...(text(hook['state']) ? { state: text(hook['state']) } : {}),
    }));
  },
  operator: { method: 'capabilities.run', input: { id: 'hooks.contracts' }, rows: { from: 'data.managed', value: 'name', label: 'name', detail: 'detail', state: 'state' } },
});
defineList<CommandActionContext>({
  name: MANAGED_ENTRIES_LIST,
  async read(ctx) {
    const data = await dataOf('hooks.contracts', {}, ctx);
    return [
      ...rows(data['managed']).filter((hook) => text(hook['name'])).map((hook): ListRow => ({ value: text(hook['name']), label: text(hook['name']), ...(text(hook['detail']) ? { detail: text(hook['detail']) } : {}), ...(text(hook['state']) ? { state: text(hook['state']) } : {}) })),
      ...rows(data['chains']).filter((chain) => text(chain['name'])).map((chain): ListRow => ({ value: text(chain['name']), label: text(chain['name']), detail: `chain of ${typeof chain['steps'] === 'number' ? chain['steps'] : 0} step${chain['steps'] === 1 ? '' : 's'}` })),
    ];
  },
  operator: { method: 'capabilities.run', input: { id: 'hooks.contracts' }, rows: { from: 'data.entries', value: 'name', label: 'name', detail: 'detail', state: 'state' } },
});

// The media providers that make something ("make an image or a video", "collect a media job"), as the daemon has them.
defineList<CommandActionContext>({
  name: 'media.providers',
  async read(ctx) {
    return rows((await dataOf('media.providers', {}, ctx))['providers'])
      .filter((provider) => text(provider['id']) && Array.isArray(provider['capabilities']) && provider['capabilities'].includes('generate'))
      .map((provider): ListRow => ({
        value: text(provider['id']), label: text(provider['label']) || text(provider['id']),
        ...(Array.isArray(provider['outputs']) && provider['outputs'].length > 0 ? { state: `makes ${provider['outputs'].join(', ')}` } : provider['configured'] === false ? { state: 'setup needed' } : {}),
      }));
  },
  // A row's operator filter matches one value, and "makes something" is one capability among several: as before the move.
  operator: { terminalOnly: 'The providers that make media are picked out of every media provider here.' },
});

// The marketplace: the curated entries of the kind chosen, what is installed of it, and the backups of one install.
defineList<CommandActionContext>({
  name: MARKETPLACE_CATALOG_LIST,
  async read(ctx, earlier) {
    if (!earlier.kind) return [];
    return rows((await dataOf('marketplace.browse', {}, ctx))['entries']).filter((entry) => entry['kind'] === earlier.kind && text(entry['id'])).map((entry): ListRow => ({
      value: text(entry['id']), label: text(entry['name']) || text(entry['id']), ...(text(entry['summary']) ? { detail: text(entry['summary']) } : {}), ...(entry['installed'] === true ? { state: 'installed' } : {}),
    }));
  },
  operator: { method: 'capabilities.run', input: { id: 'marketplace.browse' }, rows: { from: 'data.entries', where: { field: 'kind', equals: '{kind}' }, value: 'id', label: 'name', detail: 'summary' } },
});
defineList<CommandActionContext>({
  name: MARKETPLACE_INSTALLED_LIST,
  async read(ctx, earlier) {
    if (!earlier.kind) return [];
    return rows((await dataOf('marketplace.installed', {}, ctx))['installed']).filter((entry) => entry['kind'] === earlier.kind && text(entry['id'])).map((entry): ListRow => ({
      value: text(entry['id']), label: text(entry['name']) || text(entry['id']), state: entry['scope'] === 'user' ? 'all your projects' : 'this project',
    }));
  },
  operator: { method: 'capabilities.run', input: { id: 'marketplace.installed' }, rows: { from: 'data.installed', where: { field: 'kind', equals: '{kind}' }, value: 'id', label: 'name', state: 'scope' } },
});
defineList<CommandActionContext>({
  name: MARKETPLACE_BACKUPS_LIST,
  async read(ctx, earlier) {
    if (!earlier.kind || !earlier.entry) return [];
    const data = await dataOf('marketplace.backups', { kind: earlier.kind, entry: earlier.entry, scope: earlier.scope === 'user' ? 'user' : 'project' }, ctx);
    return rows(data['backups']).filter((backup) => text(backup['id'])).map((backup): ListRow => ({
      value: text(backup['id']), label: typeof backup['at'] === 'number' ? new Date(backup['at']).toLocaleString() : text(backup['id']),
      ...(text(backup['reason']) ? { detail: text(backup['reason']) } : {}), ...(text(backup['version']) ? { state: text(backup['version']) } : {}),
    }));
  },
  // A list's operator input is one flat level, and capabilities.run takes the entry inside `inputs`: the web UI's sheet
  // leaves the backup blank, which means the newest one.
  operator: { terminalOnly: 'The backups are read for the entry chosen in the same form.' },
});
