/**
 * knowledge-lists.ts, the live lists the knowledge, "about you" and template
 * capabilities choose from (platform capabilities/builtin/knowledge.ts,
 * profile.ts, templates.ts name them): the issues waiting for review, the
 * knowledge jobs waiting or running, the connectors, the facts and sections
 * of your profile and a section's lines, and your templates. Each reads the
 * daemon through the binding the program is wired with; the web UI reads the
 * same lists through each one's method.
 */
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext } from './command-actions/types.js';
import { runDaemonCapability, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import { stripDangerousAnsi } from './ansi-sanitize.js';

let binding: DaemonCapabilityBinding<never> | undefined;

/** Register these lists with the program's way to its daemon (its `capability-binding.ts`); once, at start. */
export function registerKnowledgeLists<Ctx>(next: DaemonCapabilityBinding<Ctx>): void {
  binding = next as unknown as DaemonCapabilityBinding<never>;
}

const text = (value: unknown): string => typeof value === 'string' ? stripDangerousAnsi(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ') : '';
const record = (value: unknown): Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const entries = (value: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> => Array.isArray(value) ? value.map(record) : [];

function bound(): DaemonCapabilityBinding<never> {
  if (!binding) throw new Error('this program has no way to its daemon wired for these lists');
  return binding;
}
async function invoke(ctx: CommandActionContext, method: string, input: Record<string, unknown>): Promise<Readonly<Record<string, unknown>>> {
  return record(await bound().daemon(ctx as never).invoke(method, input));
}

defineList<CommandActionContext>({
  name: 'knowledge.issues',
  async read(ctx) {
    return entries((await invoke(ctx, 'knowledge.issues.list', { limit: 50 })).issues)
      .map((issue): ListRow => ({ value: text(issue.id), label: text(issue.message), detail: text(issue.code), state: text(issue.severity) }));
  },
  operator: { method: 'knowledge.issues.list', input: {}, rows: { from: 'issues', value: 'id', label: 'message', detail: 'code', state: 'severity' } },
});

defineList<CommandActionContext>({
  name: 'knowledge.runs.active',
  async read(ctx) {
    return entries((await invoke(ctx, 'knowledge.job-runs.list', { limit: 100 })).runs)
      .filter((run) => run.status === 'queued' || run.status === 'running')
      .map((run): ListRow => ({ value: text(run.id), label: text(run.jobId), state: text(run.status) }));
  },
  operator: { method: 'knowledge.job-runs.list', input: {}, rows: { from: 'runs', value: 'id', label: 'jobId', state: 'status' } },
});

defineList<CommandActionContext>({
  name: 'knowledge.connectors',
  async read(ctx) {
    return entries((await invoke(ctx, 'knowledge.connectors.list', {})).connectors)
      .map((connector): ListRow => ({ value: text(connector.id), label: text(connector.displayName) || text(connector.id), detail: text(connector.description), state: text(connector.sourceType) }));
  },
  operator: { method: 'knowledge.connectors.list', input: {}, rows: { from: 'connectors', value: 'id', label: 'displayName', detail: 'description' } },
});

async function profileSections(ctx: CommandActionContext): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>> {
  return entries((await invoke(ctx, 'profile.read', {})).sections);
}

defineList<CommandActionContext>({
  name: 'about-me.fields',
  async read(ctx) {
    // People are read one at a time ("See what is known about a person"), never listed.
    return (await profileSections(ctx)).flatMap((section) => text(section.heading).trim().toLowerCase() === 'people' ? []
      : entries(section.fields).map((field): ListRow => ({ value: text(field.fieldId), label: text(field.label), detail: text(section.heading) })));
  },
  operator: { method: 'profile.read', input: {}, rows: { from: 'sections', each: 'fields', value: 'fieldId', label: 'label' } },
});

defineList<CommandActionContext>({
  name: 'about-me.sections',
  async read(ctx) {
    return (await profileSections(ctx)).map((section): ListRow => {
      const lines = entries(section.prose).length;
      return { value: text(section.heading), label: text(section.heading), state: `${lines} line${lines === 1 ? '' : 's'}` };
    });
  },
  operator: { method: 'profile.read', input: {}, rows: { from: 'sections', value: 'heading', label: 'heading' } },
});

defineList<CommandActionContext>({
  name: 'about-me.lines',
  async read(ctx, earlier) {
    const section = (await profileSections(ctx)).find((entry) => text(entry.heading) === earlier.section);
    return entries(section?.prose).map((line): ListRow => ({ value: text(line.text), label: text(line.text) }));
  },
  operator: { method: 'profile.read', input: {}, rows: { from: 'sections', where: { field: 'heading', equals: '{section}' }, each: 'prose', value: 'text', label: 'text' } },
});

defineList<CommandActionContext>({
  name: 'templates',
  async read(ctx) {
    const answer = await runDaemonCapability('template.list', {}, ctx, bound() as unknown as DaemonCapabilityBinding<CommandActionContext>);
    return entries(answer.data?.templates).map((template): ListRow => ({
      value: text(template.name), label: text(template.name), detail: text(template.preview), state: template.scope === 'project' ? 'this project' : 'every project',
    }));
  },
  operator: { method: 'capabilities.run', input: { id: 'template.list' }, rows: { from: 'data.templates', value: 'name', label: 'name', detail: 'preview' } },
});
