/**
 * automation-lists.ts, the live lists the Automation capabilities choose from
 * (platform capabilities/builtin/automation.ts): your schedules (all, running,
 * paused), your triggers, the commands triggers may run, and your CI watches.
 * Each is read from the daemon through the list capability of its kind
 * (`schedule.list`, `triggers.list`, `triggers.commands`, `ci.watches`) with the
 * binding the program reaches the daemon with; the web UI reads the same rows
 * from the methods named in `operator`.
 */
import { ciTargetText } from '@goodvibes/engine/platform/platform/capabilities/automation-words';
import { runDaemonCapability, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext } from './command-actions/types.js';

let bindingOf: DaemonCapabilityBinding<CommandActionContext> | undefined;

type Row = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Row => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const words = (value: unknown): string => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, '') : '';

async function rowsOf(ctx: CommandActionContext, id: string, field: string): Promise<readonly Row[]> {
  if (!bindingOf) return [];
  const answer = await runDaemonCapability(id, {}, ctx, bindingOf);
  const data = answer.data;
  return isRecord(data) && Array.isArray(data[field]) ? data[field].filter(isRecord) : [];
}

function scheduleRow(job: Row): ListRow {
  return {
    value: words(job['id']),
    label: words(job['name']) || words(job['id']),
    ...(words(job['description']) ? { detail: words(job['description']) } : {}),
    ...(job['enabled'] === false ? { state: 'paused' } : {}),
  };
}

defineList<CommandActionContext>({
  name: 'schedules',
  async read(ctx) { return (await rowsOf(ctx, 'schedule.list', 'jobs')).map(scheduleRow); },
  operator: { method: 'automation.schedules.list', input: {}, rows: { from: 'jobs', value: 'id', label: 'name', detail: 'description' } },
});

defineList<CommandActionContext>({
  name: 'schedules.paused',
  async read(ctx) { return (await rowsOf(ctx, 'schedule.list', 'jobs')).filter((job) => job['enabled'] === false).map(scheduleRow); },
  operator: { method: 'automation.schedules.list', input: {}, rows: { from: 'jobs', where: { field: 'enabled', equals: 'false' }, value: 'id', label: 'name', detail: 'description' } },
});

defineList<CommandActionContext>({
  name: 'schedules.running',
  async read(ctx) { return (await rowsOf(ctx, 'schedule.list', 'jobs')).filter((job) => job['enabled'] !== false).map(scheduleRow); },
  operator: { method: 'automation.schedules.list', input: {}, rows: { from: 'jobs', where: { field: 'enabled', equals: 'true' }, value: 'id', label: 'name', detail: 'description' } },
});

defineList<CommandActionContext>({
  name: 'triggers',
  async read(ctx) {
    return (await rowsOf(ctx, 'triggers.list', 'triggers')).map((trigger): ListRow => ({
      value: words(trigger['id']), label: words(trigger['label']) || words(trigger['id']),
      ...(words(trigger['watching']) ? { detail: `watching ${words(trigger['watching'])}` } : {}),
      ...(words(trigger['state']) ? { state: words(trigger['state']) } : {}),
    }));
  },
  operator: { method: 'watchers.triggers.list', input: {}, rows: { from: 'triggers', value: 'id', label: 'label', detail: 'watching', state: 'state' } },
});

defineList<CommandActionContext>({
  name: 'triggers.commands',
  async read(ctx) {
    return (await rowsOf(ctx, 'triggers.commands', 'grants')).map((grant): ListRow => ({
      value: words(grant['id']), label: words(grant['id']),
      detail: [words(grant['command']), ...(Array.isArray(grant['args']) ? grant['args'].map(words) : [])].join(' '),
    }));
  },
  operator: { method: 'watchers.triggers.grant.list', input: {}, rows: { from: 'grants', value: 'id', label: 'id', detail: 'command' } },
});

defineList<CommandActionContext>({
  name: 'ci.watches',
  async read(ctx) {
    return (await rowsOf(ctx, 'ci.watches', 'watches')).map((watch): ListRow => ({
      value: words(watch['id']), label: ciTargetText(watch), detail: `to ${words(watch['deliveryChannel'])}`,
      ...(words(watch['lastOverall']) ? { state: words(watch['lastOverall']) } : {}),
    }));
  },
  operator: { method: 'ci.watches.list', input: {}, rows: { from: 'watches', value: 'id', label: 'repo', detail: 'deliveryChannel', state: 'lastOverall' } },
});

/** Give the lists the binding this program reaches the daemon with. */
export function registerAutomationLists<Ctx extends CommandActionContext>(binding: DaemonCapabilityBinding<Ctx>): void {
  bindingOf = binding as unknown as DaemonCapabilityBinding<CommandActionContext>;
}
