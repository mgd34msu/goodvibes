/**
 * `/secrets`, described once (command-actions/): store, point at, check, test,
 * confirm and delete secrets and see how they are kept (the daemon does each:
 * capabilities/builtin/secrets.ts), and use one for this session only (this
 * program's own environment). Both terminal apps register this one
 * description with how they reach the daemon.
 */
import {
  SECRETS_DELETE, SECRETS_GET, SECRETS_LINK, SECRETS_LIST, SECRETS_PROVIDERS, SECRETS_SET, SECRETS_STORAGE, SECRETS_TEST, SECRETS_TRUST, SECRETS_USE,
  type SecretsSessionServices,
} from '@goodvibes/engine/platform/platform/capabilities';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import { daemonCapabilityAction, runDaemonCapability, sessionCapabilityAction, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import type { CommandActionContext, CommandDescription } from './command-actions/types.js';

export type SecretsCommandContext = CommandActionContext;

/** How the lists reach the daemon: set when a program registers the command. */
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

/** Using a secret for this session: this program's own environment, which the commands it runs inherit. */
const SESSION_ENVIRONMENT: SecretsSessionServices = { environment: { set: (name, value) => { process.env[name] = value; } } };

function describeSecrets<Ctx extends SecretsCommandContext>(binding: DaemonCapabilityBinding<Ctx>): CommandDescription<Ctx> {
  return {
    name: 'secrets',
    title: 'Secrets',
    summary: 'Keep passwords and keys where programs can read them, without showing them',
    group: 'Setup',
    report: 'see-secrets',
    actions: [
      daemonCapabilityAction<Ctx>(SECRETS_LIST, binding),
      daemonCapabilityAction<Ctx>(SECRETS_SET, binding),
      daemonCapabilityAction<Ctx>(SECRETS_LINK, binding),
      daemonCapabilityAction<Ctx>(SECRETS_GET, binding),
      daemonCapabilityAction<Ctx>(SECRETS_TEST, binding),
      daemonCapabilityAction<Ctx>(SECRETS_PROVIDERS, binding),
      daemonCapabilityAction<Ctx>(SECRETS_STORAGE, binding),
      daemonCapabilityAction<Ctx>(SECRETS_TRUST, binding),
      daemonCapabilityAction<Ctx>(SECRETS_DELETE, binding),
      sessionCapabilityAction<Ctx, SecretsSessionServices>(SECRETS_USE, () => SESSION_ENVIRONMENT, { terminalOnly: 'It is set in the terminal app\'s own session.' }),
    ],
  };
}

/** `/secrets` for one app, with how it reaches the daemon (every stored secret is the daemon's to keep). */
export function createSecretsCommand<Ctx extends SecretsCommandContext>(binding: DaemonCapabilityBinding<Ctx>): DescribedCommand<Ctx> {
  listBinding = binding as DaemonCapabilityBinding<CommandActionContext>;
  return defineCommand(describeSecrets<Ctx>(binding));
}

/** This program's environment, as the model's `capability_run` of "Use a secret for this session only" takes it. */
export function secretsSessionServices(): SecretsSessionServices {
  return SESSION_ENVIRONMENT;
}
