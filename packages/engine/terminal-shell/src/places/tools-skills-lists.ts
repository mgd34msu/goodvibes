/**
 * tools-skills-lists.ts, the terminal side of the Tools and extensions place's
 * skills, bundles, published skills, presets and managed settings
 * (tools-skills-entries.ts holds their lists and actions): the live lists a
 * form's inputs choose from (a skill, a bundle, a preset, an apply to roll
 * back), read through the program's daemon binding. Moved here from
 * tools-skills-entries.ts, unchanged, so the declaration holds no terminal
 * code and the web UI draws it too (places/browser.ts).
 */
import {
  MANAGED_ROLLBACKS_LIST, PRESETS_LIST, SKILL_BUNDLES_LIST, SKILL_CATALOG_LIST, SKILL_FILES_LIST, SKILLS_LIST,
} from '@goodvibes/engine/platform/platform/capabilities';
import { defineList, type ListRow } from '../command-actions/lists.js';
import { runDaemonCapability, type DaemonCapabilityBinding } from '../command-actions/capability-actions.js';
import type { CommandActionContext } from '../command-actions/types.js';
import {
  ORIGIN_WORDS, REVIEW_WORDS, bundleItems, managedItems, presetItems, publishedItems, reviewOf, skillItems,
} from './tools-skills-entries.js';

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const record = (value: unknown): Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): readonly Readonly<Record<string, unknown>>[] => Array.isArray(value) ? value.map(record) : [];
const plain = (value: unknown): string => text(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
const dataOf = (output: unknown): Readonly<Record<string, unknown>> => record(record(output)['data']);
const when = (at: number): string => at ? new Date(at).toLocaleString() : 'not said';

let binding: DaemonCapabilityBinding<CommandActionContext> | undefined;

/** Each program gives the binding its places use (capability-binding.ts), so a form's lists read the daemon. */
export function bindToolsSkillsLists(next: DaemonCapabilityBinding<never>): void {
  binding = next as unknown as DaemonCapabilityBinding<CommandActionContext>;
}

async function read(id: string, ctx: CommandActionContext): Promise<unknown> {
  if (!binding) return {};
  return runDaemonCapability(id, {}, ctx, binding);
}

const operator = (id: string, from: string, value: string, label: string, state?: string) => ({
  method: 'capabilities.run', input: { id }, rows: { from: `data.${from}`, value, label, ...(state ? { state } : {}) },
});

defineList<CommandActionContext>({
  name: SKILLS_LIST,
  async read(ctx) {
    return skillItems(await read('my-skills.list', ctx)).filter((skill) => skill.state !== 'found')
      .map((skill): ListRow => ({ value: skill.id, label: skill.name, ...(skill.description ? { detail: skill.description } : {}), state: `${skill.state.startsWith('on-') ? 'on' : 'off'}, ${REVIEW_WORDS[reviewOf(skill.state)]}` }));
  },
  operator: operator('my-skills.list', 'skills', 'id', 'name', 'state'),
});
defineList<CommandActionContext>({
  name: SKILL_BUNDLES_LIST,
  async read(ctx) {
    return bundleItems(await read('my-skills.bundles', ctx)).map((bundle): ListRow => ({ value: bundle.id, label: bundle.name, ...(bundle.description ? { detail: bundle.description } : {}), state: `${bundle.state.startsWith('on-') ? 'on' : 'off'}, ${REVIEW_WORDS[reviewOf(bundle.state)]}` }));
  },
  operator: operator('my-skills.bundles', 'bundles', 'id', 'name', 'state'),
});
defineList<CommandActionContext>({
  name: SKILL_FILES_LIST,
  async read(ctx) {
    const files = list(dataOf(await read('my-skills.discover', ctx))['files']);
    return files.filter((file) => text(file['name'])).map((file): ListRow => ({ value: text(file['name']), label: plain(file['name']), ...(text(file['path']) ? { detail: plain(file['path']) } : {}), state: ORIGIN_WORDS[text(file['origin'])] ?? plain(file['origin']) }));
  },
  operator: operator('my-skills.discover', 'files', 'name', 'name', 'origin'),
});
defineList<CommandActionContext>({
  name: SKILL_CATALOG_LIST,
  async read(ctx) {
    return publishedItems(await read('skills.list', ctx)).map((entry): ListRow => ({ value: entry.id, label: entry.name, ...(entry.summary ? { detail: entry.summary } : {}) }));
  },
  operator: operator('skills.list', 'published', 'id', 'name'),
});
defineList<CommandActionContext>({
  name: PRESETS_LIST,
  async read(ctx) {
    return presetItems(await read('presets.list', ctx)).map((preset): ListRow => ({ value: preset.id, label: preset.name, state: `saved ${when(preset.savedAt)}` }));
  },
  operator: operator('presets.list', 'presets', 'id', 'name'),
});
defineList<CommandActionContext>({
  name: MANAGED_ROLLBACKS_LIST,
  async read(ctx) {
    return managedItems(await read('managed.review', ctx)).filter((entry) => entry.state === 'applied').map((entry): ListRow => ({ value: entry.id, label: entry.title.replace(/^Applied: /, '') }));
  },
  operator: operator('managed.review', 'rollbacks', 'id', 'name'),
});
