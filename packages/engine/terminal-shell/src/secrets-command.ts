/**
 * Secrets, as a terminal program reaches them: the lists a secret input chooses from (the stored secrets by name,
 * and this project's own copies that wait for the owner), read from the daemon, which keeps every stored secret
 * (capabilities/builtin/secrets.ts); and a secret used for this session only (this program's own environment). No
 * slash command carries them: Permissions and safety, Secrets, is where a person stores, points, checks, tests,
 * confirms and deletes them; a model, an outside agent and a script run the same capabilities by find and run.
 */
import type { SecretsSessionServices } from '@goodvibes/engine/platform/platform/capabilities';
import { defineList, type ListRow } from './command-actions/lists.js';
import { runDaemonCapability, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import type { CommandActionContext } from './command-actions/types.js';

/** How the lists reach the daemon: set when a program wires them. */
let listBinding: DaemonCapabilityBinding<CommandActionContext> | undefined;

interface ListedSecret { readonly key?: unknown; readonly detail?: unknown; readonly path?: unknown }

async function listedSecrets(ctx: CommandActionContext, field: 'secrets' | 'waiting'): Promise<readonly ListedSecret[]> {
  if (!listBinding) return [];
  const answer = await runDaemonCapability('secrets.list', {}, ctx, listBinding);
  const rows = answer.data?.[field];
  return Array.isArray(rows) ? rows as ListedSecret[] : [];
}

/** The stored secrets by name, as the daemon reads the stores this program reads (never a value). */
defineList<CommandActionContext>({
  name: 'secrets.stored',
  async read(ctx) {
    return (await listedSecrets(ctx, 'secrets')).filter((row) => typeof row.key === 'string').map((row): ListRow => ({
      value: row.key as string, label: row.key as string, ...(typeof row.detail === 'string' ? { state: row.detail } : {}),
    }));
  },
  operator: { method: 'capabilities.run', input: { id: 'secrets.list' }, rows: { from: 'data.secrets', value: 'key', label: 'key', state: 'detail' } },
});

/** The secrets in this project's own store that wait for the owner. */
defineList<CommandActionContext>({
  name: 'secrets.unconfirmed',
  async read(ctx) {
    return (await listedSecrets(ctx, 'waiting')).filter((row) => typeof row.key === 'string').map((row): ListRow => ({
      value: row.key as string, label: row.key as string, ...(typeof row.path === 'string' ? { detail: row.path } : {}), state: 'not used until you confirm it',
    }));
  },
  operator: { method: 'capabilities.run', input: { id: 'secrets.list' }, rows: { from: 'data.waiting', value: 'key', label: 'key', detail: 'path' } },
});

/** Wire the secret lists of one program to its daemon (each program does this once, as it registers its commands). */
export function wireSecretsLists<Ctx extends CommandActionContext>(binding: DaemonCapabilityBinding<Ctx>): void {
  listBinding = binding as DaemonCapabilityBinding<CommandActionContext>;
}

/** Using a secret for this session: this program's own environment, which the commands it runs inherit. */
const SESSION_ENVIRONMENT: SecretsSessionServices = { environment: { set: (name, value) => { process.env[name] = value; } } };

/** This program's environment, as "Use a secret for this session only" takes it (the place and the model's `capability_run`). */
export function secretsSessionServices(): SecretsSessionServices {
  return SESSION_ENVIRONMENT;
}
