/**
 * tools-skills-entries.ts, the Tools and extensions place's skills, skill
 * bundles, published skills, presets and managed settings (tools-place.ts
 * holds the place; these are its lists and actions for those things).
 *
 * Every list is read from the daemon through `capabilities.run` (the place
 * sends this program's project and name with each, so the skills are the ones
 * this program's turns read and the presets and managed settings are this
 * program's own), and follows LIST_CHANGED `tools`, which every change made
 * through the daemon announces. Every action is a capability by id; the
 * selected item fills its inputs, a form asks for the rest.
 *
 * The live lists a form's inputs choose from (a skill, a bundle, a preset, an
 * apply to roll back) are the terminal's side, in tools-skills-lists.ts, and
 * read the same capabilities. This file holds no terminal code: the web UI
 * draws these lists too (places/browser.ts).
 */
import type { PlaceAction, PlaceDetailLine, PlaceFollow, PlaceItem, PlaceList } from './place-types.js';

type Review = 'fresh' | 'reviewed' | 'stale';
type SkillState = `${'on' | 'off'}-${Review}` | 'found';

export interface SkillItem extends PlaceItem {
  readonly kind: 'skill';
  readonly state: SkillState;
  readonly name: string;
  readonly description: string;
  readonly ready: boolean;
  readonly missing: readonly string[];
  readonly requirements: readonly string[];
  readonly triggers: readonly string[];
  readonly tags: readonly string[];
  readonly source: string;
  readonly provenance: string;
  readonly staleReason: string;
  readonly path: string;
  readonly origin: string;
}

export interface BundleItem extends PlaceItem {
  readonly kind: 'bundle';
  readonly state: `${'on' | 'off'}-${Review}`;
  readonly name: string;
  readonly description: string;
  readonly ready: boolean;
  readonly missing: readonly string[];
  readonly skills: readonly string[];
  readonly staleReason: string;
}

export interface PublishedItem extends PlaceItem {
  readonly kind: 'published';
  readonly state: 'published';
  readonly name: string;
  readonly summary: string;
  readonly source: string;
}

export interface PresetItem extends PlaceItem {
  readonly kind: 'preset';
  readonly state: 'saved';
  readonly name: string;
  readonly savedAt: number;
}

export interface ManagedItem extends PlaceItem {
  readonly kind: 'managed';
  readonly state: 'staged' | 'locked' | 'applied';
  readonly title: string;
  readonly lines: readonly PlaceDetailLine[];
}

export type ToolsSkillsItem = SkillItem | BundleItem | PublishedItem | PresetItem | ManagedItem;

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const record = (value: unknown): Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): readonly Readonly<Record<string, unknown>>[] => Array.isArray(value) ? value.map(record) : [];
const strings = (value: unknown): readonly string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => plain(entry)) : [];
/** Text from a skill file or another process, on one line: control characters out. */
const plain = (value: unknown): string => text(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
const dataOf = (output: unknown): Readonly<Record<string, unknown>> => record(record(output)['data']);
const review = (value: unknown): Review => value === 'reviewed' || value === 'stale' ? value : 'fresh';
const when = (at: number): string => at ? new Date(at).toLocaleString() : 'not said';

export function skillItems(output: unknown): readonly SkillItem[] {
  return list(dataOf(output)['skills']).filter((skill) => text(skill['id'])).map((skill): SkillItem => ({
    kind: 'skill',
    id: text(skill['id']),
    // A file nobody took in yet is "found"; every other skill is on or off, with its review.
    state: skill['marked'] === true ? `${skill['enabled'] === true ? 'on' : 'off'}-${review(skill['review'])}` : 'found',
    name: plain(skill['name']) || text(skill['id']),
    description: plain(skill['description']),
    ready: skill['ready'] !== false,
    missing: strings(skill['missing']),
    requirements: strings(skill['requirements']),
    triggers: strings(skill['triggers']),
    tags: strings(skill['tags']),
    source: plain(skill['source']),
    provenance: plain(skill['provenance']),
    staleReason: plain(skill['staleReason']),
    path: plain(skill['path']),
    origin: plain(skill['origin']),
  }));
}

export function bundleItems(output: unknown): readonly BundleItem[] {
  return list(dataOf(output)['bundles']).filter((bundle) => text(bundle['id'])).map((bundle): BundleItem => ({
    kind: 'bundle',
    id: text(bundle['id']),
    state: `${bundle['enabled'] === true ? 'on' : 'off'}-${review(bundle['review'])}`,
    name: plain(bundle['name']) || text(bundle['id']),
    description: plain(bundle['description']),
    ready: bundle['ready'] !== false,
    missing: strings(bundle['missing']),
    skills: strings(bundle['skillIds']),
    staleReason: plain(bundle['staleReason']),
  }));
}

export function publishedItems(output: unknown): readonly PublishedItem[] {
  return list(dataOf(output)['published']).filter((entry) => text(entry['id'])).map((entry): PublishedItem => ({
    kind: 'published', id: text(entry['id']), state: 'published', name: plain(entry['name']) || text(entry['id']), summary: plain(entry['summary']), source: plain(entry['source']),
  }));
}

export function presetItems(output: unknown): readonly PresetItem[] {
  return list(dataOf(output)['presets']).filter((preset) => text(preset['id'])).map((preset): PresetItem => ({
    kind: 'preset', id: text(preset['id']), state: 'saved', name: plain(preset['name']) || text(preset['id']), savedAt: typeof preset['savedAt'] === 'number' ? preset['savedAt'] : 0,
  }));
}

export function managedItems(output: unknown): readonly ManagedItem[] {
  const data = dataOf(output);
  const staged = list(data['staged']).filter((entry) => text(entry['id'])).map((entry): ManagedItem => ({
    kind: 'managed', id: text(entry['id']), state: 'staged', title: `Staged: ${plain(entry['name']) || 'a bundle'}`,
    lines: [
      { label: 'From', text: plain(entry['path']) || 'not said' },
      { label: 'Changes', text: `${typeof entry['changes'] === 'number' ? entry['changes'] : 0}, risk ${plain(entry['risk']) || 'not said'}` },
      { label: 'Settings', text: strings(entry['keys']).join(', ') || 'none that differ', tone: 'muted' },
      { label: 'Staged', text: when(typeof entry['at'] === 'number' ? entry['at'] : 0), tone: 'muted' },
    ],
  }));
  const locks = list(data['locks']).filter((entry) => text(entry['id'])).map((entry): ManagedItem => ({
    kind: 'managed', id: text(entry['id']), state: 'locked', title: `Locked: ${plain(entry['key'])}`,
    lines: [
      { label: 'Setting', text: plain(entry['key']) },
      { label: 'Managed by', text: plain(entry['source']) || 'not said' },
      { label: 'Why', text: plain(entry['reason']) || 'not said' },
      { label: 'Since', text: when(typeof entry['at'] === 'number' ? entry['at'] : 0), tone: 'muted' },
    ],
  }));
  const applies = list(data['rollbacks']).filter((entry) => text(entry['id'])).map((entry): ManagedItem => ({
    kind: 'managed', id: text(entry['id']), state: 'applied', title: `Applied: ${plain(entry['name']) || 'a bundle'}`,
    lines: [
      { label: 'Applied', text: when(typeof entry['at'] === 'number' ? entry['at'] : 0) },
      { label: 'From', text: plain(entry['path']) || 'not said' },
      { label: 'Settings it changed', text: strings(entry['keys']).join(', ') || String(entry['settings'] ?? 0) },
      { text: 'Rolling it back puts the values from before it back.', tone: 'muted' },
    ],
  }));
  return [...staged, ...locks, ...applies];
}

const REVIEW_WORDS: Readonly<Record<Review, string>> = { fresh: 'not reviewed yet', reviewed: 'reviewed by you', stale: 'marked out of date' };
const ORIGIN_WORDS: Readonly<Record<string, string>> = { 'project-local': 'this project', global: 'your own skill folders', custom: 'another folder' };
const reviewOf = (state: string): Review => (state.split('-')[1] as Review | undefined) ?? 'fresh';

/** A change to any of these, made through the daemon from anywhere, is announced as LIST_CHANGED `tools`. */
// LIST_CHANGED travels on the `workspace` domain: the stream is opened on it, whatever else the place follows.
const TOOLS_FOLLOW: PlaceFollow = { domains: ['workspace'], events: [], lists: ['tools'] };
const run = (id: string) => ({ id, inputs: {} });

const skillsList: PlaceList<ToolsSkillsItem> = {
  id: 'skills',
  label: 'Skills',
  noun: 'your skills',
  source: { kind: 'daemon', method: 'capabilities.run', input: run('my-skills.list'), items: skillItems },
  follows: TOOLS_FOLLOW,
  empty: 'No skills yet: the model has no procedure of yours.',
  row: (item) => {
    const skill = item as SkillItem;
    if (skill.state === 'found') return { title: skill.name, right: 'found on disk', mark: 'waiting' };
    const on = skill.state.startsWith('on-');
    const needs = on && !skill.ready ? 'needs setting up' : reviewOf(skill.state) !== 'reviewed' ? REVIEW_WORDS[reviewOf(skill.state)] : on ? undefined : 'off';
    return { title: skill.name, ...(needs ? { right: needs } : {}), mark: on && !skill.ready ? 'attention' : on ? 'ok' : 'paused' };
  },
  detail: (item) => {
    const skill = item as SkillItem;
    return [
      { text: skill.description || 'It says nothing about what it is for.' },
      { text: '' },
      { label: 'State', text: skill.state === 'found' ? 'a skill file found on disk, not taken into your skills yet' : skill.state.startsWith('on-') ? 'switched on: the model may follow it' : 'switched off' },
      ...(skill.state === 'found' ? [] : [{ label: 'Review', text: REVIEW_WORDS[reviewOf(skill.state)] }]),
      ...(skill.staleReason ? [{ label: 'Out of date because', text: skill.staleReason, tone: 'warning' as const }] : []),
      { label: 'Needs', text: skill.requirements.join(', ') || 'nothing' },
      ...(skill.missing.length > 0 ? [{ label: 'Missing', text: skill.missing.join(', '), tone: 'warning' as const }] : []),
      { label: 'Brought up by', text: skill.triggers.join(', ') || 'only when asked for' },
      ...(skill.tags.length > 0 ? [{ label: 'Tags', text: skill.tags.join(', ') }] : []),
      // Who made it: the person, the model, or a file (its provenance says which, and where a copy came from).
      ...(skill.state === 'found' ? [] : [{ label: 'Made by', text: skill.source === 'agent' ? 'the model' : skill.source === 'user' ? 'you' : skill.provenance || 'a skill file' }]),
      ...(skill.provenance.startsWith('Copied from the file ') ? [{ label: 'Copied from', text: skill.provenance.slice('Copied from the file '.length), tone: 'muted' as const }] : []),
      { label: 'Found in', text: ORIGIN_WORDS[skill.origin] ?? (skill.origin || 'not said'), tone: 'muted' as const },
      { label: 'File', text: skill.path || 'not said', tone: 'muted' as const },
    ];
  },
};

const bundlesList: PlaceList<ToolsSkillsItem> = {
  id: 'skill-bundles',
  label: 'Skill bundles',
  noun: 'your skill bundles',
  source: { kind: 'daemon', method: 'capabilities.run', input: run('my-skills.bundles'), items: bundleItems },
  follows: TOOLS_FOLLOW,
  empty: 'No skill bundles yet: a bundle puts skills to use together.',
  row: (item) => {
    const bundle = item as BundleItem;
    const on = bundle.state.startsWith('on-');
    const needs = on && !bundle.ready ? 'needs setting up' : reviewOf(bundle.state) !== 'reviewed' ? REVIEW_WORDS[reviewOf(bundle.state)] : on ? undefined : 'off';
    return { title: bundle.name, ...(needs ? { right: needs } : {}), mark: on && !bundle.ready ? 'attention' : on ? 'ok' : 'paused' };
  },
  detail: (item) => {
    const bundle = item as BundleItem;
    return [
      { text: bundle.description },
      { text: '' },
      { label: 'Skills in it', text: bundle.skills.join(', ') || 'none' },
      { label: 'State', text: bundle.state.startsWith('on-') ? 'switched on: its skills are in use' : 'switched off' },
      { label: 'Review', text: REVIEW_WORDS[reviewOf(bundle.state)] },
      ...(bundle.staleReason ? [{ label: 'Out of date because', text: bundle.staleReason, tone: 'warning' as const }] : []),
      ...(bundle.missing.length > 0 ? [{ label: 'Missing', text: bundle.missing.join(', '), tone: 'warning' as const }] : []),
    ];
  },
};

const publishedList: PlaceList<ToolsSkillsItem> = {
  id: 'published',
  label: 'Published skills',
  noun: 'the skills you published to the local catalog',
  source: { kind: 'daemon', method: 'capabilities.run', input: run('skills.list'), items: publishedItems },
  follows: TOOLS_FOLLOW,
  empty: 'Nothing published to the local catalog yet.',
  row: (item) => ({ title: (item as PublishedItem).name, mark: 'ok' }),
  detail: (item) => {
    const entry = item as PublishedItem;
    return [{ text: entry.summary || 'It says nothing about what it does.' }, { text: '' }, { label: 'Catalog id', text: entry.id }, { label: 'Folder', text: entry.source || 'not said', tone: 'muted' }];
  },
};

const presetsList: PlaceList<ToolsSkillsItem> = {
  id: 'presets',
  label: 'Presets',
  noun: 'your presets',
  source: { kind: 'daemon', method: 'capabilities.run', input: run('presets.list'), items: presetItems },
  follows: TOOLS_FOLLOW,
  empty: 'No presets yet: save your settings as one.',
  row: (item) => ({ title: (item as PresetItem).name }),
  detail: (item) => [
    { label: 'Saved', text: when((item as PresetItem).savedAt) },
    { text: 'Loading it sets your display, model and behaviour settings to the ones saved in it.', tone: 'muted' },
  ],
};

const managedList: PlaceList<ToolsSkillsItem> = {
  id: 'managed',
  label: 'Managed settings',
  noun: 'your managed settings',
  source: { kind: 'daemon', method: 'capabilities.run', input: run('managed.review'), items: managedItems },
  follows: TOOLS_FOLLOW,
  empty: 'Nothing staged, locked or applied by a managed bundle.',
  row: (item) => {
    const entry = item as ManagedItem;
    return { title: entry.title, mark: entry.state === 'staged' ? 'waiting' : entry.state === 'locked' ? 'paused' : 'ok' };
  },
  detail: (item) => (item as ManagedItem).lines,
};

export const TOOLS_SKILLS_LISTS: readonly PlaceList<ToolsSkillsItem>[] = [skillsList, bundlesList, publishedList, presetsList, managedList];

const SKILL_ON = ['on-fresh', 'on-reviewed', 'on-stale'];
const SKILL_OFF = ['off-fresh', 'off-reviewed', 'off-stale'];
const NOT_REVIEWED = ['on-fresh', 'on-stale', 'off-fresh', 'off-stale'];
const NOT_STALE = ['on-fresh', 'on-reviewed', 'off-fresh', 'off-reviewed'];
const TAKEN = [...SKILL_ON, ...SKILL_OFF];

/**
 * The actions. Keys are this place's (rebindable in Keys); a key here never meets
 * one of the place's own keys (n c l e i m w are the place's on every tab).
 */
export const TOOLS_SKILLS_ACTIONS: readonly PlaceAction<ToolsSkillsItem>[] = [
  // Skills
  { key: 'enter', id: 'skill-see', list: 'skills', capability: 'my-skills.show', label: 'see it', fill: { skill: 'id' } },
  { key: 'a', id: 'skill-new', list: 'skills', whole: true, capability: 'my-skills.create', label: 'new skill' },
  { key: 'u', id: 'skill-import-file', list: 'skills', whole: true, capability: 'my-skills.import-standard', label: 'import' },
  { key: 'f', id: 'skill-search', list: 'skills', whole: true, capability: 'my-skills.search', label: 'search' },
  { key: 'y', id: 'skills-on', list: 'skills', whole: true, capability: 'my-skills.enabled', label: 'which are on' },
  { key: 'z', id: 'skills-need-setup', list: 'skills', whole: true, capability: 'my-skills.attention', label: 'needs setup' },
  { key: 'j', id: 'skill-files-found', list: 'skills', whole: true, capability: 'my-skills.discover', label: 'on disk' },
  { key: 'g', id: 'skill-origins', list: 'skills', whole: true, capability: 'skills.origins', label: 'origins' },
  { key: 'h', id: 'skill-take-in', list: 'skills', states: ['found'], capability: 'my-skills.import-discovered', label: 'take it in', fill: { file: 'id' } },
  { key: 'o', id: 'skill-switch-on', list: 'skills', states: SKILL_OFF, capability: 'my-skills.enable', label: 'switch on', fill: { skill: 'id' } },
  { key: 'o', id: 'skill-switch-off', list: 'skills', states: SKILL_ON, capability: 'my-skills.disable', label: 'switch off', fill: { skill: 'id' } },
  { key: 'v', id: 'skill-reviewed', list: 'skills', states: NOT_REVIEWED, capability: 'my-skills.review', label: 'mark reviewed', fill: { skill: 'id' } },
  { key: 't', id: 'skill-out-of-date', list: 'skills', states: NOT_STALE, capability: 'my-skills.stale', label: 'out of date', fill: { skill: 'id' } },
  { key: 'd', id: 'skill-change', list: 'skills', states: TAKEN, capability: 'my-skills.update', label: 'change', fill: { skill: 'id' } },
  { key: 's', id: 'skill-save-file', list: 'skills', capability: 'my-skills.export-standard', label: 'save file', fill: { skill: 'id' } },
  { key: 'k', id: 'skill-where', list: 'skills', capability: 'skills.show', label: 'where', fill: { skill: 'id' } },
  { key: 'x', id: 'skill-delete', list: 'skills', capability: 'my-skills.delete', label: 'delete', fill: { skill: 'id' } },
  // Skill bundles
  { key: 'enter', id: 'bundle-see', list: 'skill-bundles', capability: 'my-skills.bundle-show', label: 'see it', fill: { bundle: 'id' } },
  { key: 'a', id: 'bundle-new', list: 'skill-bundles', whole: true, capability: 'my-skills.bundle-create', label: 'new bundle' },
  { key: 'f', id: 'bundle-search', list: 'skill-bundles', whole: true, capability: 'my-skills.bundle-search', label: 'search' },
  { key: 'y', id: 'bundles-on', list: 'skill-bundles', whole: true, capability: 'my-skills.bundles-enabled', label: 'which are on' },
  { key: 'z', id: 'bundles-need-setup', list: 'skill-bundles', whole: true, capability: 'my-skills.bundles-attention', label: 'needs setup' },
  { key: 'o', id: 'bundle-switch-on', list: 'skill-bundles', states: SKILL_OFF, capability: 'my-skills.bundle-enable', label: 'switch on', fill: { bundle: 'id' } },
  { key: 'o', id: 'bundle-switch-off', list: 'skill-bundles', states: SKILL_ON, capability: 'my-skills.bundle-disable', label: 'switch off', fill: { bundle: 'id' } },
  { key: 'v', id: 'bundle-reviewed', list: 'skill-bundles', states: NOT_REVIEWED, capability: 'my-skills.bundle-review', label: 'mark reviewed', fill: { bundle: 'id' } },
  { key: 't', id: 'bundle-out-of-date', list: 'skill-bundles', states: NOT_STALE, capability: 'my-skills.bundle-stale', label: 'out of date', fill: { bundle: 'id' } },
  { key: 'd', id: 'bundle-change', list: 'skill-bundles', capability: 'my-skills.bundle-update', label: 'change', fill: { bundle: 'id' } },
  { key: 'x', id: 'bundle-delete', list: 'skill-bundles', capability: 'my-skills.bundle-delete', label: 'delete', fill: { bundle: 'id' } },
  // Published skills (the local curated catalog)
  { key: 'p', id: 'skill-publish', list: 'published', whole: true, capability: 'skills.publish-local', label: 'publish a skill folder' },
  { key: 'x', id: 'skill-unpublish', list: 'published', capability: 'skills.unpublish', label: 'take it out', fill: { id: 'id' } },
  // Presets
  { key: 'enter', id: 'preset-load', list: 'presets', capability: 'presets.load', label: 'load it', fill: { preset: 'id' } },
  { key: 'a', id: 'preset-save', list: 'presets', whole: true, capability: 'presets.save', label: 'save mine as one' },
  { key: 's', id: 'presets-to-file', list: 'presets', whole: true, capability: 'presets.export', label: 'save all to file' },
  { key: 'u', id: 'presets-from-file', list: 'presets', whole: true, capability: 'presets.import', label: 'add from a file' },
  { key: 'k', id: 'presets-check-file', list: 'presets', whole: true, capability: 'presets.inspect', label: 'check a file' },
  { key: 'b', id: 'preset-as-managed', list: 'presets', capability: 'managed.export', label: 'as managed bundle', fill: { profile: 'id' } },
  { key: 'x', id: 'preset-delete', list: 'presets', capability: 'presets.delete', label: 'delete', fill: { preset: 'id' } },
  // Managed settings
  { key: 'enter', id: 'managed-see-staged', list: 'managed', states: ['staged'], capability: 'managed.staged', label: 'see its changes' },
  { key: 'a', id: 'managed-apply-staged', list: 'managed', states: ['staged'], capability: 'managed.apply-staged', label: 'apply it' },
  { key: 'o', id: 'managed-unlock', list: 'managed', states: ['locked'], capability: 'managed.unlock', label: 'unlock', fill: { key: 'id' } },
  { key: 'b', id: 'managed-roll-back', list: 'managed', states: ['applied'], capability: 'managed.rollback', label: 'roll it back', fill: { token: 'id' } },
  { key: 's', id: 'managed-stage', list: 'managed', whole: true, capability: 'managed.stage', label: 'stage a bundle' },
  { key: 'p', id: 'managed-apply', list: 'managed', whole: true, capability: 'managed.apply', label: 'apply a bundle' },
  { key: 'k', id: 'managed-look-inside', list: 'managed', whole: true, capability: 'managed.inspect', label: 'look inside a managed bundle' },
  { key: 'y', id: 'managed-lock', list: 'managed', whole: true, capability: 'managed.lock', label: 'lock a setting' },
  { key: 'j', id: 'managed-history', list: 'managed', whole: true, capability: 'managed.history', label: 'applies so far' },
];

/** What the terminal side of these lists reads (tools-skills-lists.ts: the live lists a form's inputs choose from). */
export { ORIGIN_WORDS, REVIEW_WORDS, reviewOf };
