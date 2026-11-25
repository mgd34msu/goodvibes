/**
 * Skills, managed by the daemon over the one skill store (skills/library.ts):
 * the skill files in the project's and the home's skill folders, with
 * GoodVibes' facts about each (switched on, reviewed, what it needs) in its
 * frontmatter, and the skill bundles beside them. Every program's turns read
 * the same files: the Agent's prompt applies the skills switched on and
 * reviewed, and the model's skill reader in both programs loads them by name
 * or trigger. Reading the store and firing a skill stay with each turn; every
 * change to it is made here.
 *
 * The local curated catalog (the skill folders you publish for others to
 * install from the marketplace) is the asking program's, on this machine.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { SkillLibrary } from '../../skills/library.js';
import {
  buildAgentSkillRequirements, evaluateAgentSkillBundleReadiness, evaluateAgentSkillReadiness, formatAgentSkillRequirement,
  parseSkillStandardMarkdown, skillStandardFilePath, wasCopiedIn,
} from '../../skills/library.js';
import type { AgentSkillBundleRecord, AgentSkillRecord } from '../../skills/library-types.js';
import type { EcosystemCatalogPathOptions } from '../../runtime/ecosystem/catalog.js';
import { listInstalledEcosystemEntries, loadEcosystemCatalog, removeEcosystemCatalogEntry, upsertEcosystemCatalogEntry } from '../../runtime/ecosystem/catalog.js';
import {
  CapabilityRefusal, REPLACED_DONE, type ActionValues, type CapabilityCaller, type CapabilityDefinition, type CapabilityResult, type InputDescription, type ListName,
} from '../types.js';
import { fixedInput, pickedInput, wordsInput } from './agent-stores.js';
import { noteListChanged } from '../../runtime/list-changes.js';

/** What the skills capabilities need: the store as the asking program's turns read it, and its curated catalog. */
export interface SkillsCapabilityServices {
  readonly skills: {
    /** The one skill store, with the caller's project folder and program (`tui` when none said). */
    library(caller: CapabilityCaller): SkillLibrary;
    /** The asking program's local curated catalog and installs. */
    catalogPaths(caller: CapabilityCaller): EcosystemCatalogPathOptions;
    /** A file path the caller gave, in its own project folder when it is not absolute. */
    resolvePath(caller: CapabilityCaller, path: string): string;
  };
}

/** The lists an input chooses from (terminal-shell's lists read them through these capabilities). */
export const SKILLS_LIST = 'my-skills' as ListName;
export const SKILL_BUNDLES_LIST = 'my-skills.bundles' as ListName;
export const SKILL_FILES_LIST = 'my-skills.discovered' as ListName;
export const SKILL_CATALOG_LIST = 'skills.catalog' as ListName;

const SKILL: InputDescription = pickedInput({ id: 'skill', label: 'Skill', help: 'Your skills', list: SKILLS_LIST, other: 'a skill name' });
const BUNDLE: InputDescription = pickedInput({ id: 'bundle', label: 'Bundle', help: 'Your skill bundles', list: SKILL_BUNDLES_LIST, other: 'a bundle name' });
const text = (id: string, label: string, help: string, typed: InputDescription['typed'], optional?: { default: string; means: string }, kind: InputDescription['kind'] = 'text'): InputDescription =>
  wordsInput({ id, label, help, why: 'your own words', typed, kind, ...(optional ? { optional } : {}) });
const LIST = (id: string, label: string, help: string, flag: `--${string}`, means: string): InputDescription =>
  wordsInput({ id, label, help: `${help}, separated by commas`, why: 'names you choose', typed: { flag }, optional: { default: '', means } });
const SWITCH_ON = (help: string): InputDescription => fixedInput({
  id: 'enabled', label: 'Switch it on now', help, choices: [{ value: 'no', label: 'No, after a review' }, { value: 'yes', label: 'Yes' }],
  typed: { flag: '--enabled' }, optional: { default: 'no', means: 'off until you review it' },
});

function splitList(value: string | undefined): readonly string[] {
  return value ? value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean) : [];
}

/** A store error in its own words, as the capability's refusal. */
async function guarded(run: () => CapabilityResult | Promise<CapabilityResult>): Promise<CapabilityResult> {
  try { return await run(); }
  catch (error) {
    if (error instanceof CapabilityRefusal) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CapabilityRefusal(message.endsWith('.') ? message : `${message}.`, undefined, /^Unknown /.test(message) ? 'NOT_FOUND' : 'CAPABILITY_REFUSED');
  }
}

/** A model is refused marking reviewed outright (nothing is put to the owner for it): the review is his own act. */
const REVIEW_IS_THE_OWNERS = {
  reason: 'marking it reviewed is your decision that its text may reach the prompt',
  instead: 'Ask the owner to mark it reviewed in Tools and extensions.',
};

/** Who made or changed a skill, as its provenance says it: the person's own press or line, else the model. */
function madeBy(caller: CapabilityCaller): string {
  return caller.personAsked === true ? 'Made by you' : 'Made by the model';
}

/** Marking reviewed, and switching on what nobody reviewed, count only from the owner's own press or typed line. */
function ownerMay(caller: CapabilityCaller, what: string): void {
  if (caller.personAsked === true) return;
  throw new CapabilityRefusal(`${what} is the owner's decision that its text may reach the prompt, so it counts only when the owner does it himself; nothing was changed.`,
    'Ask the owner to do it in Tools and extensions, on the skill.', 'OWNER_REVIEW_REQUIRED');
}

// ---------------------------------------------------------------------------
// The words a person reads, and the facts a screen reads
// ---------------------------------------------------------------------------

const REVIEW_WORDS: Readonly<Record<string, string>> = { fresh: 'needs review', reviewed: 'reviewed', stale: 'needs refresh' };

function skillFacts(skill: AgentSkillRecord) {
  const readiness = evaluateAgentSkillReadiness(skill);
  return {
    id: skill.id, name: skill.name, description: skill.description,
    state: skill.enabled ? 'on' : 'off', enabled: skill.enabled, review: skill.reviewState,
    ready: readiness.ready, missing: readiness.missing.map(formatAgentSkillRequirement),
    requirements: skill.requirements.map(formatAgentSkillRequirement),
    triggers: skill.triggers, tags: skill.tags, source: skill.source, provenance: skill.provenance,
    ...(skill.staleReason ? { staleReason: skill.staleReason } : {}),
    ...(skill.path ? { path: skill.path } : {}), ...(skill.origin ? { origin: skill.origin } : {}),
    marked: skill.marked === true, createdAt: skill.createdAt, updatedAt: skill.updatedAt,
  };
}

function bundleFacts(bundle: AgentSkillBundleRecord, skills: readonly AgentSkillRecord[]) {
  const readiness = evaluateAgentSkillBundleReadiness(bundle, skills);
  return {
    id: bundle.id, name: bundle.name, description: bundle.description,
    state: bundle.enabled ? 'on' : 'off', enabled: bundle.enabled, review: bundle.reviewState,
    ready: readiness.ready,
    missing: [...readiness.missingRequirements.map(formatAgentSkillRequirement), ...readiness.missingSkillIds.map((id) => `skill ${id}`)],
    skillIds: bundle.skillIds, source: bundle.source, provenance: bundle.provenance,
    ...(bundle.staleReason ? { staleReason: bundle.staleReason } : {}),
  };
}

function summarize(skill: AgentSkillRecord): string {
  const readiness = evaluateAgentSkillReadiness(skill);
  const ready = readiness.ready ? 'ready' : `needs ${readiness.missing.map(formatAgentSkillRequirement).join(', ')}`;
  return `  ${skill.id}  ${skill.enabled ? 'on' : 'off'}  ${REVIEW_WORDS[skill.reviewState]}  ${ready}  ${skill.name} - ${skill.description}${skill.tags.length > 0 ? `  tags ${skill.tags.join(', ')}` : ''}`;
}

function summarizeBundle(bundle: AgentSkillBundleRecord, skills: readonly AgentSkillRecord[]): string {
  const facts = bundleFacts(bundle, skills);
  return `  ${bundle.id}  ${bundle.enabled ? 'on' : 'off'}  ${REVIEW_WORDS[bundle.reviewState]}  ${facts.ready ? 'ready' : `needs ${facts.missing.join(', ')}`}  ${bundle.name} - ${bundle.description}  skills ${bundle.skillIds.join(', ')}`;
}

function skillList(title: string, library: SkillLibrary, listed: readonly AgentSkillRecord[], empty = 'No skills yet.'): CapabilityResult {
  // A file found on disk that was copied into the store is listed as its copy, not again as found.
  const all = library.list();
  const skills = listed.filter((skill) => !wasCopiedIn(skill, all));
  const data = { skills: skills.map(skillFacts), folder: library.folder };
  if (skills.length === 0) return { text: `${title}\n  ${empty}`, data };
  return { text: [`${title} (${skills.length})`, `  kept in ${library.folder}`, ...skills.map(summarize)].join('\n'), data };
}

function bundleList(title: string, library: SkillLibrary, bundles: readonly AgentSkillBundleRecord[], empty = 'No skill bundles yet.'): CapabilityResult {
  const snapshot = library.snapshot();
  const data = { bundles: bundles.map((bundle) => bundleFacts(bundle, snapshot.skills)) };
  if (bundles.length === 0) return { text: `${title}\n  ${empty}`, data };
  return {
    text: [`${title} (${bundles.length})`, `  skills applied to turns: ${snapshot.activeSkills.length}`, ...bundles.map((bundle) => summarizeBundle(bundle, snapshot.skills))].join('\n'),
    data,
  };
}

function receipt(title: string, record: { readonly id: string; readonly name: string }, extra: readonly string[] = []): string {
  return [`${title} ${record.name}.`, ...extra.map((line) => `${line.trim().replace(/^./, (first) => first.toUpperCase())}.`)].join('\n');
}

function showSkill(skill: AgentSkillRecord): string {
  const readiness = evaluateAgentSkillReadiness(skill);
  return [
    `Skill ${skill.name}`,
    `  id ${skill.id}`,
    `  switched ${skill.enabled ? 'on' : 'off'}`,
    `  ready: ${readiness.ready ? 'yes' : 'needs setting up'}`,
    `  needs: ${skill.requirements.map(formatAgentSkillRequirement).join(', ') || 'nothing'}`,
    readiness.missing.length > 0 ? `  missing: ${readiness.missing.map(formatAgentSkillRequirement).join(', ')}` : '',
    `  review: ${REVIEW_WORDS[skill.reviewState]}`,
    `  came from: ${skill.source}${skill.provenance && skill.provenance !== skill.source ? ` (${skill.provenance})` : ''}`,
    skill.path ? `  file: ${skill.path}` : '',
    `  tags: ${skill.tags.join(', ') || 'none'}`,
    `  brought up by: ${skill.triggers.join(', ') || 'only when asked for'}`,
    skill.staleReason ? `  out of date because: ${skill.staleReason}` : '',
    '', skill.description, '', skill.procedure,
  ].filter((line, index, lines) => line !== '' || (index > 0 && lines[index - 1] !== '')).join('\n');
}

function showBundle(bundle: AgentSkillBundleRecord, library: SkillLibrary): string {
  const skills = library.list();
  const facts = bundleFacts(bundle, skills);
  return [
    `Skill bundle ${bundle.name}`,
    `  id ${bundle.id}`,
    `  switched ${bundle.enabled ? 'on' : 'off'}`,
    `  ready: ${facts.ready ? 'yes' : `needs ${facts.missing.join(', ')}`}`,
    `  review: ${REVIEW_WORDS[bundle.reviewState]}`,
    bundle.staleReason ? `  out of date because: ${bundle.staleReason}` : '',
    '', bundle.description, '',
    ...bundle.skillIds.map((id) => { const skill = skills.find((entry) => entry.id === id); return `- ${id}${skill ? `: ${skill.name} - ${skill.description}` : ' (not found)'}`; }),
  ].filter(Boolean).join('\n');
}

function requirementsOf(values: ActionValues, library: SkillLibrary, id?: string) {
  if (!values.env && !values.commands && id) return undefined;
  const existing = id ? library.get(id)?.requirements ?? [] : [];
  // A list for one kind must not erase the other kind the skill already has.
  return buildAgentSkillRequirements({
    env: values.env ? splitList(values.env) : existing.filter((requirement) => requirement.kind === 'env').map((requirement) => requirement.name),
    commands: values.commands ? splitList(values.commands) : existing.filter((requirement) => requirement.kind === 'command').map((requirement) => requirement.name),
  });
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

type Fields = Pick<CapabilityDefinition<SkillsCapabilityServices>, 'actionId' | 'label' | 'word' | 'sentence' | 'example'> & {
  readonly id: string;
  readonly inputs?: readonly InputDescription[] | undefined;
  readonly risk?: CapabilityDefinition<SkillsCapabilityServices>['risk'] | undefined;
  readonly undoneBy?: string | undefined;
  readonly repeat?: 'safe' | 'unsafe' | undefined;
  readonly lasts?: CapabilityDefinition<SkillsCapabilityServices>['lasts'] | undefined;
  readonly ownerOnly?: CapabilityDefinition<SkillsCapabilityServices>['ownerOnly'] | undefined;
  readonly run: (values: ActionValues, library: SkillLibrary, caller: CapabilityCaller, services: SkillsCapabilityServices) => CapabilityResult | Promise<CapabilityResult>;
};

function read(fields: Fields): CapabilityDefinition<SkillsCapabilityServices> {
  return {
    capability: { id: fields.id, group: 'tools', home: 'daemon', repeat: 'safe' },
    actionId: fields.actionId, label: fields.label, word: fields.word, inputs: fields.inputs ?? [], sentence: fields.sentence, done: '',
    touches: 'reads', lasts: 'not-a-change', risk: 'none', example: fields.example,
    run: (values, services, caller) => guarded(() => fields.run(values, services.skills.library(caller), caller, services)),
  };
}

function change(fields: Fields): CapabilityDefinition<SkillsCapabilityServices> {
  return {
    capability: { id: fields.id, group: 'tools', home: 'daemon', repeat: fields.repeat ?? 'safe' },
    actionId: fields.actionId, label: fields.label, word: fields.word, inputs: fields.inputs ?? [], sentence: fields.sentence, done: '',
    touches: 'this-machine', lasts: fields.lasts ?? 'kept', risk: fields.risk ?? 'none',
    ...(fields.undoneBy ? { undoneBy: fields.undoneBy } : {}),
    ...(fields.ownerOnly ? { ownerOnly: fields.ownerOnly } : {}),
    example: fields.example,
    async run(values, services, caller) {
      const result = await guarded(() => fields.run(values, services.skills.library(caller), caller, services));
      // Every screen showing the skills reads them again (LIST_CHANGED `tools`).
      noteListChanged({ list: 'tools', change: 'changed' });
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Your skills (the Agent's /my-skills until 3.5.0)
// ---------------------------------------------------------------------------

export const MY_SKILLS_LIST = read({
  id: 'my-skills.list', actionId: 'list', label: 'See your skills', word: 'list',
  sentence: 'Lists every skill: switched on or off, reviewed or not, and whether it has what it needs.', example: {},
  run: (_values, library) => skillList('Skills', library, library.list()),
});
export const MY_SKILLS_ENABLED = read({
  id: 'my-skills.enabled', actionId: 'enabled', label: 'See the skills that are on', word: 'enabled',
  sentence: 'Lists the skills that are switched on.', example: {},
  run: (_values, library) => skillList('Skills switched on', library, library.snapshot().enabledSkills, 'No skill is switched on.'),
});
export const MY_SKILLS_ATTENTION = read({
  id: 'my-skills.attention', actionId: 'attention', label: 'See skills that need setting up', word: 'attention',
  sentence: 'Lists skills missing an environment variable or a program they need.', example: {},
  run: (_values, library) => skillList('Skills that need setting up', library, library.list().filter((skill) => !evaluateAgentSkillReadiness(skill).ready), 'No skill needs setting up.'),
});
export const MY_SKILLS_SEARCH = read({
  id: 'my-skills.search', actionId: 'search', label: 'Search your skills', word: 'search',
  inputs: [text('query', 'Looking for', 'Words to search for', { tail: true })],
  sentence: 'Lists skills that mention "{query}".', example: { query: 'release' },
  run: (values, library) => skillList(`Skills that mention "${values.query}"`, library, library.search(values.query ?? ''), 'No skill mentions that.'),
});
export const MY_SKILLS_SHOW = read({
  id: 'my-skills.show', actionId: 'show', label: 'See one skill', word: 'show', inputs: [SKILL],
  sentence: 'Shows {skill}\'s steps, what it needs, its review and where it came from.', example: { skill: 'release-notes' },
  run: (values, library) => {
    const skill = library.get(values.skill!);
    if (!skill) throw new CapabilityRefusal(`No skill named ${values.skill}.`, 'Your skills are listed in Tools and extensions, Skills.', 'NOT_FOUND');
    return { text: showSkill(skill), data: { skill: { ...skillFacts(skill), procedure: skill.procedure } } };
  },
});
export const MY_SKILLS_CREATE = change({
  id: 'my-skills.create', actionId: 'create', label: 'Make a new skill', word: 'create', repeat: 'unsafe',
  inputs: [
    text('name', 'Name', 'A short name', { flag: '--name' }),
    text('description', 'What it is for', 'One line the model matches tasks against', { flag: '--description' }),
    text('procedure', 'Steps', 'What to do, step by step', { tail: true }, undefined, 'long-text'),
    LIST('triggers', 'When it applies', 'Words that bring it up', '--triggers', 'only when asked for'),
    LIST('tags', 'Tags', 'Tags', '--tags', 'none'),
    LIST('env', 'Environment it needs', 'Environment variable names', '--requires-env', 'none'),
    LIST('commands', 'Programs it needs', 'Program names', '--requires-command', 'none'),
    SWITCH_ON('Switch it on at once, or after you review it'),
  ],
  sentence: 'A new skill {name} ("{description}") is made, step by step, for the model to follow, and kept until you change it; its steps: {procedure}', undoneBy: 'delete',
  example: { name: 'release notes', description: 'Write release notes from merged changes', procedure: 'List merged pull requests, then group them.' },
  run: (values, library, caller) => {
    if (values.enabled === 'yes') ownerMay(caller, 'Switching on a skill nobody reviewed');
    const skill = library.create({
      name: values.name!, description: values.description!, procedure: values.procedure!,
      triggers: splitList(values.triggers), tags: splitList(values.tags), requirements: requirementsOf(values, library)!,
      enabled: values.enabled === 'yes', source: caller.personAsked === true ? 'user' : 'agent', provenance: madeBy(caller),
    });
    return { text: receipt('Made the skill', skill, [`  file ${skill.path ?? library.folder}`, skill.enabled ? '  switched on' : '  off until you review it and switch it on']), data: { skill: skillFacts(skill) } };
  },
});
export const MY_SKILLS_UPDATE = change({
  id: 'my-skills.update', actionId: 'update', label: 'Change a skill', word: 'update',
  inputs: [
    SKILL,
    text('name', 'Name', 'A new name', { flag: '--name' }, { default: '', means: 'unchanged' }),
    text('description', 'What it is for', 'A new line', { flag: '--description' }, { default: '', means: 'unchanged' }),
    text('procedure', 'Steps', 'New steps', { flag: '--procedure' }, { default: '', means: 'unchanged' }, 'long-text'),
    LIST('triggers', 'When it applies', 'Words that bring it up', '--triggers', 'unchanged'),
    LIST('tags', 'Tags', 'Tags', '--tags', 'unchanged'),
    LIST('env', 'Environment it needs', 'Environment variable names', '--requires-env', 'unchanged'),
    LIST('commands', 'Programs it needs', 'Program names', '--requires-command', 'unchanged'),
  ],
  sentence: '{skill} is changed to what you gave until you change it; a changed skill waits for review again.', example: { skill: 'release-notes', description: 'Write release notes for a tag' },
  run: (values, library, caller) => {
    const skill = library.update(values.skill!, {
      name: values.name || undefined, description: values.description || undefined, procedure: values.procedure || undefined,
      triggers: values.triggers ? splitList(values.triggers) : undefined, tags: values.tags ? splitList(values.tags) : undefined,
      requirements: requirementsOf(values, library, values.skill!), provenance: caller.personAsked === true ? 'Changed by you' : 'Changed by the model',
    });
    return { text: receipt('Changed the skill', skill, ['  waits for your review again']), data: { skill: skillFacts(skill) } };
  },
});

function skillToggle(enabled: boolean): CapabilityDefinition<SkillsCapabilityServices> {
  return change({
    id: enabled ? 'my-skills.enable' : 'my-skills.disable', actionId: enabled ? 'enable' : 'disable',
    label: enabled ? 'Switch a skill on' : 'Switch a skill off', word: enabled ? 'enable' : 'disable', inputs: [SKILL],
    sentence: enabled ? 'The model may follow {skill} until you change it.' : 'The model stops following {skill} until you change it.',
    undoneBy: enabled ? 'disable' : 'enable', example: { skill: 'release-notes' },
    run: (values, library, caller) => {
      if (enabled && library.get(values.skill!)?.reviewState !== 'reviewed') ownerMay(caller, 'Switching on a skill nobody reviewed');
      const skill = library.setEnabled(values.skill!, enabled);
      return { text: receipt(enabled ? 'Switched on the skill' : 'Switched off the skill', skill), data: { skill: skillFacts(skill) } };
    },
  });
}
export const MY_SKILLS_ENABLE = skillToggle(true);
export const MY_SKILLS_DISABLE = skillToggle(false);

export const MY_SKILLS_REVIEW = change({
  id: 'my-skills.review', actionId: 'review', label: 'Mark a skill reviewed', word: 'review', inputs: [SKILL], ownerOnly: REVIEW_IS_THE_OWNERS,
  sentence: '{skill} is marked reviewed by you until you change it, so it may be switched on.', example: { skill: 'release-notes' },
  run: (values, library, caller) => {
    ownerMay(caller, 'Marking a skill reviewed');
    const skill = library.markReviewed(values.skill!);
    return { text: receipt('Marked reviewed', skill), data: { skill: skillFacts(skill) } };
  },
});
export const MY_SKILLS_STALE = change({
  id: 'my-skills.stale', actionId: 'stale', label: 'Mark a skill out of date', word: 'stale',
  inputs: [SKILL, text('reason', 'Why', 'What is out of date', { tail: true })],
  sentence: '{skill} is marked out of date ("{reason}") until you change it.', example: { skill: 'release-notes', reason: 'the release script moved' },
  run: (values, library) => {
    const skill = library.markStale(values.skill!, values.reason!);
    return { text: receipt('Marked out of date', skill, [`  because ${skill.staleReason ?? values.reason}`]), data: { skill: skillFacts(skill) } };
  },
});
export const MY_SKILLS_DELETE = change({
  id: 'my-skills.delete', actionId: 'delete', label: 'Delete a skill', word: 'delete', inputs: [SKILL], risk: 'cannot-be-undone',
  sentence: '{skill} is deleted (its file, or its folder and what is in it) and taken out of every bundle; a bundle left empty is removed, and one that keeps other skills waits for review again.',
  example: { skill: 'release-notes' },
  run: (values, library) => {
    const deleted = library.deleteSkill(values.skill!);
    return {
      text: receipt('Deleted the skill', deleted.skill, [
        ...(deleted.removedBundles.length > 0 ? [`  bundles removed, no skill left in them: ${deleted.removedBundles.map((bundle) => bundle.name).join(', ')}`] : []),
        ...(deleted.changedBundles.length > 0 ? [`  bundles waiting for review again: ${deleted.changedBundles.map((bundle) => bundle.name).join(', ')}`] : []),
      ]),
      data: { skill: deleted.skill.id, removedBundles: deleted.removedBundles.map((bundle) => bundle.id), changedBundles: deleted.changedBundles.map((bundle) => bundle.id) },
    };
  },
});
export const MY_SKILLS_DISCOVER = read({
  id: 'my-skills.discover', actionId: 'discover', label: 'See skill files found on disk', word: 'discover',
  sentence: 'Lists the SKILL.md and .md skill files in the project\'s and your skill folders that nobody has taken into your skills yet.', example: {},
  run: (_values, library) => {
    const all = library.list();
    const found = all.filter((skill) => skill.marked !== true && !wasCopiedIn(skill, all));
    const data = { files: found.map((skill) => ({ name: skill.id, path: skill.path, origin: skill.origin, description: skill.description })) };
    if (found.length === 0) return { text: 'Skill files found on disk\n  None that are not already yours: every skill file found is in your skills.', data };
    return { text: [`Skill files found on disk (${found.length})`, ...found.map((skill) => `  ${skill.id}  ${skill.origin ?? ''}  ${skill.description}\n    ${skill.path ?? ''}`)].join('\n'), data };
  },
});
export const MY_SKILLS_IMPORT_DISCOVERED = change({
  id: 'my-skills.import-discovered', actionId: 'import-discovered', label: 'Import a skill file found on disk', word: 'import-discovered',
  inputs: [pickedInput({ id: 'file', label: 'Skill file', help: 'Skill files found on disk', list: SKILL_FILES_LIST, other: 'a skill name' }), SWITCH_ON('Switch it on at once, or after you review it')],
  sentence: '{file} is copied into your skills, off until you review it unless you switch it on, until you change it; the file it was found in is not changed.', undoneBy: 'delete', example: { file: 'release-notes' },
  run: (values, library, caller) => {
    const found = library.get(values.file!);
    if (!found) throw new CapabilityRefusal(`No skill file named ${values.file} was found.`, 'The skill files found are listed in Tools and extensions, Skills.', 'NOT_FOUND');
    if (values.enabled === 'yes') ownerMay(caller, 'Switching on a skill nobody reviewed');
    if (found.marked === true) throw new CapabilityRefusal(`${found.id} is already one of your skills; nothing was copied.`, undefined, 'CAPABILITY_REFUSED');
    // The person's file is never changed: the skill is copied into the store and GoodVibes' facts go on the copy.
    const { skill, original } = library.copyIn(found.id, { enabled: values.enabled === 'yes', source: caller.personAsked === true ? 'user' : 'agent' });
    return {
      text: receipt('Copied the skill into your skills as', { id: skill.id, name: skill.id }, [
        `  the copy is ${skill.path ?? library.folder}`,
        `  the original, ${original}, was not changed`,
        skill.enabled ? '  switched on at import by you' : '  off until you review it and switch it on',
      ]),
      data: { skill: skillFacts(skill), original },
    };
  },
});
export const MY_SKILLS_IMPORT_STANDARD = change({
  id: 'my-skills.import-standard', actionId: 'import-standard', label: 'Import a shared SKILL.md', word: 'import-standard', repeat: 'unsafe',
  inputs: [wordsInput({ id: 'path', label: 'SKILL.md file', help: 'A skill in the shared SKILL.md format', why: 'a file path on this machine', kind: 'path', typed: { position: 1 } })],
  sentence: 'The skill in {path} is added, off until you review it, until you change it.', undoneBy: 'delete', example: { path: 'skills/release-notes/SKILL.md' },
  run: (values, library, caller, services) => {
    const sourcePath = services.skills.resolvePath(caller, values.path!);
    let content: string;
    try { content = readFileSync(sourcePath, 'utf-8'); } catch (error) {
      throw new CapabilityRefusal(`${sourcePath} could not be read (${error instanceof Error ? error.message : String(error)}); nothing was added.`);
    }
    const parsed = parseSkillStandardMarkdown(content);
    if ('error' in parsed) throw new CapabilityRefusal(`${sourcePath} was not added: ${parsed.error}.`);
    const skill = library.importFromStandard(content);
    return { text: receipt('Imported the shared skill', skill, [`  from ${sourcePath}`, '  off until you review it and switch it on']), data: { skill: skillFacts(skill) } };
  },
});
export const MY_SKILLS_EXPORT_STANDARD = change({
  id: 'my-skills.export-standard', actionId: 'export-standard', label: 'Save a skill as a shared SKILL.md', word: 'export-standard', lasts: 'not-a-change',
  inputs: [SKILL, wordsInput({ id: 'dir', label: 'Folder', help: 'Where to write its SKILL.md', why: 'a folder on this machine', kind: 'path', typed: { position: 2 } }),
    fixedInput({ id: 'overwrite', label: 'If a SKILL.md is there', help: 'Keep it, or replace it', choices: [{ value: 'keep', label: 'Refuse and keep it' }, { value: 'replace', label: 'Replace it', risk: 'cannot-be-undone', riskDone: REPLACED_DONE }], typed: { flag: '--overwrite', switchOn: 'replace' }, optional: { default: 'keep', means: 'refuse and keep it' } })],
  sentence: '{skill} is written as a SKILL.md into {dir}.', example: { skill: 'release-notes', dir: 'skills/release-notes' },
  run: (values, library, caller, services) => {
    const skill = library.get(values.skill!);
    if (!skill) throw new CapabilityRefusal(`No skill named ${values.skill}.`, undefined, 'NOT_FOUND');
    const targetDir = services.skills.resolvePath(caller, values.dir!);
    const overwrite = values.overwrite === 'replace';
    const replaced = overwrite && existsSync(skillStandardFilePath(skill.name, targetDir));
    if (!overwrite && existsSync(skillStandardFilePath(skill.name, targetDir))) {
      throw new CapabilityRefusal(`A SKILL.md is already at ${skillStandardFilePath(skill.name, targetDir)}; it was kept and nothing was written.`, 'Choose "Replace it" to write over it.');
    }
    const written = library.exportToStandard(skill.id, targetDir, overwrite);
    // Where the file went, in one true sentence: "Saved garden journal as a shared SKILL.md at <path>."
    return {
      text: `Saved ${skill.name} as a shared SKILL.md at ${written}${replaced ? ', in place of the file that was there' : ''}.`,
      data: { file: written },
    };
  },
});

// Skill bundles

export const MY_SKILLS_BUNDLES = read({
  id: 'my-skills.bundles', actionId: 'bundles', label: 'See your skill bundles', word: 'bundles',
  sentence: 'Lists every skill bundle: switched on or off, reviewed or not, and whether it has what it needs.', example: {},
  run: (_values, library) => bundleList('Skill bundles', library, library.listBundles()),
});
export const MY_SKILLS_BUNDLES_ENABLED = read({
  id: 'my-skills.bundles-enabled', actionId: 'bundles-enabled', label: 'See the bundles that are on', word: 'bundles-enabled',
  sentence: 'Lists the skill bundles that are switched on.', example: {},
  run: (_values, library) => bundleList('Skill bundles switched on', library, library.snapshot().enabledBundles, 'No skill bundle is switched on.'),
});
export const MY_SKILLS_BUNDLES_ATTENTION = read({
  id: 'my-skills.bundles-attention', actionId: 'bundles-attention', label: 'See bundles that need setting up', word: 'bundles-attention',
  sentence: 'Lists bundles missing a skill or something a skill needs.', example: {},
  run: (_values, library) => {
    const snapshot = library.snapshot();
    return bundleList('Skill bundles that need setting up', library, snapshot.bundles.filter((bundle) => !evaluateAgentSkillBundleReadiness(bundle, snapshot.skills).ready), 'No skill bundle needs setting up.');
  },
});
export const MY_SKILLS_BUNDLE_SEARCH = read({
  id: 'my-skills.bundle-search', actionId: 'bundle-search', label: 'Search your skill bundles', word: 'bundle-search',
  inputs: [text('query', 'Looking for', 'Words to search for', { tail: true })],
  sentence: 'Lists skill bundles that mention "{query}".', example: { query: 'release' },
  run: (values, library) => bundleList(`Skill bundles that mention "${values.query}"`, library, library.searchBundles(values.query ?? ''), 'No skill bundle mentions that.'),
});
export const MY_SKILLS_BUNDLE_SHOW = read({
  id: 'my-skills.bundle-show', actionId: 'bundle-show', label: 'See one skill bundle', word: 'bundle-show', inputs: [BUNDLE],
  sentence: 'Shows {bundle}\'s skills, whether it has what it needs, and its review.', example: { bundle: 'releases' },
  run: (values, library) => {
    const bundle = library.getBundle(values.bundle!);
    if (!bundle) throw new CapabilityRefusal(`No skill bundle named ${values.bundle}.`, undefined, 'NOT_FOUND');
    return { text: showBundle(bundle, library), data: { bundle: bundleFacts(bundle, library.list()) } };
  },
});
const BUNDLE_SKILLS = (optional?: { default: string; means: string }): InputDescription => wordsInput({
  id: 'skills', label: 'Skills in it', help: 'Skill names, separated by commas', why: 'names of your skills', typed: { flag: '--skills' }, ...(optional ? { optional } : {}),
});
export const MY_SKILLS_BUNDLE_CREATE = change({
  id: 'my-skills.bundle-create', actionId: 'bundle-create', label: 'Make a skill bundle', word: 'bundle-create', repeat: 'unsafe',
  inputs: [text('name', 'Name', 'A short name', { flag: '--name' }), text('description', 'What it is for', 'One line', { flag: '--description' }), BUNDLE_SKILLS(), SWITCH_ON('Switch it on at once, or after you review it')],
  sentence: 'The skills {skills} are grouped together as a new skill bundle {name} ("{description}"), kept until you change it.', undoneBy: 'bundle-delete',
  example: { name: 'releases', description: 'Everything for a release', skills: 'release-notes,changelog' },
  run: (values, library, caller) => {
    if (values.enabled === 'yes') ownerMay(caller, 'Switching on a skill bundle nobody reviewed');
    const bundle = library.createBundle({ name: values.name!, description: values.description!, skillIds: splitList(values.skills), enabled: values.enabled === 'yes', source: caller.personAsked === true ? 'user' : 'agent', provenance: madeBy(caller) });
    return { text: receipt('Made the skill bundle', bundle, [`  skills ${bundle.skillIds.join(', ')}`]), data: { bundle: bundleFacts(bundle, library.list()) } };
  },
});
export const MY_SKILLS_BUNDLE_UPDATE = change({
  id: 'my-skills.bundle-update', actionId: 'bundle-update', label: 'Change a skill bundle', word: 'bundle-update',
  inputs: [BUNDLE, text('name', 'Name', 'A new name', { flag: '--name' }, { default: '', means: 'unchanged' }), text('description', 'What it is for', 'A new line', { flag: '--description' }, { default: '', means: 'unchanged' }), BUNDLE_SKILLS({ default: '', means: 'unchanged' })],
  sentence: '{bundle} is changed to what you gave until you change it; a changed bundle waits for review again.', example: { bundle: 'releases', skills: 'release-notes' },
  run: (values, library, caller) => {
    const bundle = library.updateBundle(values.bundle!, { name: values.name || undefined, description: values.description || undefined, skillIds: values.skills ? splitList(values.skills) : undefined, provenance: caller.personAsked === true ? 'Changed by you' : 'Changed by the model' });
    return { text: receipt('Changed the skill bundle', bundle, ['  waits for your review again']), data: { bundle: bundleFacts(bundle, library.list()) } };
  },
});
function bundleToggle(enabled: boolean): CapabilityDefinition<SkillsCapabilityServices> {
  return change({
    id: enabled ? 'my-skills.bundle-enable' : 'my-skills.bundle-disable', actionId: enabled ? 'bundle-enable' : 'bundle-disable',
    label: enabled ? 'Switch a skill bundle on' : 'Switch a skill bundle off', word: enabled ? 'bundle-enable' : 'bundle-disable', inputs: [BUNDLE],
    sentence: enabled ? 'The skills of {bundle} are in use until you change it.' : '{bundle} is out of use until you change it.',
    undoneBy: enabled ? 'bundle-disable' : 'bundle-enable', example: { bundle: 'releases' },
    run: (values, library, caller) => {
      if (enabled && library.getBundle(values.bundle!)?.reviewState !== 'reviewed') ownerMay(caller, 'Switching on a skill bundle nobody reviewed');
      const bundle = library.setBundleEnabled(values.bundle!, enabled);
      return { text: receipt(enabled ? 'Switched on the skill bundle' : 'Switched off the skill bundle', bundle), data: { bundle: bundleFacts(bundle, library.list()) } };
    },
  });
}
export const MY_SKILLS_BUNDLE_ENABLE = bundleToggle(true);
export const MY_SKILLS_BUNDLE_DISABLE = bundleToggle(false);
export const MY_SKILLS_BUNDLE_REVIEW = change({
  id: 'my-skills.bundle-review', actionId: 'bundle-review', label: 'Mark a skill bundle reviewed', word: 'bundle-review', inputs: [BUNDLE], ownerOnly: REVIEW_IS_THE_OWNERS,
  sentence: '{bundle} is marked reviewed by you until you change it, so it may be switched on.', example: { bundle: 'releases' },
  run: (values, library, caller) => {
    ownerMay(caller, 'Marking a skill bundle reviewed');
    const bundle = library.markBundleReviewed(values.bundle!);
    return { text: receipt('Marked reviewed', bundle), data: { bundle: bundleFacts(bundle, library.list()) } };
  },
});
export const MY_SKILLS_BUNDLE_STALE = change({
  id: 'my-skills.bundle-stale', actionId: 'bundle-stale', label: 'Mark a skill bundle out of date', word: 'bundle-stale',
  inputs: [BUNDLE, text('reason', 'Why', 'What is out of date', { tail: true })],
  sentence: '{bundle} is marked out of date ("{reason}") until you change it.', example: { bundle: 'releases', reason: 'a skill in it was removed' },
  run: (values, library) => {
    const bundle = library.markBundleStale(values.bundle!, values.reason!);
    return { text: receipt('Marked out of date', bundle), data: { bundle: bundleFacts(bundle, library.list()) } };
  },
});
export const MY_SKILLS_BUNDLE_DELETE = change({
  id: 'my-skills.bundle-delete', actionId: 'bundle-delete', label: 'Delete a skill bundle', word: 'bundle-delete', inputs: [BUNDLE], risk: 'cannot-be-undone',
  sentence: '{bundle} is deleted; its skills stay.', example: { bundle: 'releases' },
  run: (values, library) => {
    const bundle = library.deleteBundle(values.bundle!);
    return { text: receipt('Deleted the skill bundle', bundle, ['  its skills stay']), data: { bundle: bundle.id } };
  },
});

// ---------------------------------------------------------------------------
// The skill packs the model can use, and the local catalog (the terminal app's /skills until 3.5.0)
// ---------------------------------------------------------------------------

function marketplaceOf(services: SkillsCapabilityServices, caller: CapabilityCaller, path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    const receipt = listInstalledEcosystemEntries('skill', services.skills.catalogPaths(caller))
      .find((entry) => path === entry.targetPath || path.startsWith(`${entry.targetPath}/`));
    return receipt?.provenanceSummary;
  } catch { return undefined; }
}

function publishedOf(services: SkillsCapabilityServices, caller: CapabilityCaller) {
  return loadEcosystemCatalog('skill', services.skills.catalogPaths(caller)).map((entry) => ({ id: entry.id, name: entry.name, summary: entry.summary, source: entry.source, state: 'published' }));
}

export const SKILLS_LIST_PACKS = read({
  id: 'skills.list', actionId: 'list', label: 'See the skill packs the model can use', word: 'list',
  sentence: 'Lists every skill pack found in the project\'s and your skill folders, where it comes from, and what it is for.', example: {},
  run: (_values, library, caller, services) => {
    const skills = library.list().map((skill) => ({ ...skillFacts(skill), marketplace: marketplaceOf(services, caller, skill.path) }));
    const published = publishedOf(services, caller);
    const data = { skills, published };
    if (skills.length === 0) return { text: 'No skill packs found.', data };
    return { text: [`Skill packs (${skills.length})`, ...skills.map((skill) => `  ${skill.id}  [${skill.origin ?? 'custom'}]  ${skill.description}${skill.marketplace ? `  (${skill.marketplace})` : ''}`)].join('\n'), data };
  },
});
export const SKILLS_SHOW_PACK = read({
  id: 'skills.show', actionId: 'show', label: 'See where one skill pack is and what it includes', word: 'show', inputs: [SKILL],
  sentence: 'Shows {skill}\'s folder, file, description, what it depends on and the files it includes.', example: { skill: 'release-notes' },
  run: (values, library, caller, services) => {
    const skill = library.get(values.skill!);
    if (!skill) throw new CapabilityRefusal(`No skill pack named ${values.skill}.`, undefined, 'NOT_FOUND');
    const includes = [...skill.procedure.matchAll(/^@([\w/-]+)/gm)].map((match) => match[1]!);
    const marketplace = marketplaceOf(services, caller, skill.path);
    return {
      text: [`Skill pack ${skill.id}`, `  found in: ${skill.origin ?? 'custom'}`, `  file: ${skill.path ?? 'not on disk'}`, `  what it is for: ${skill.description}`,
        `  includes: ${includes.join(', ') || 'nothing'}`, ...(marketplace ? [`  installed from: ${marketplace}`] : [])].join('\n'),
      data: { skill: { ...skillFacts(skill), includes, ...(marketplace ? { marketplace } : {}) } },
    };
  },
});
export const SKILLS_ORIGINS = read({
  id: 'skills.origins', actionId: 'origins', label: 'See where your skills come from', word: 'origins',
  sentence: 'Counts your skills by the folder they were found in.', example: {},
  run: (_values, library) => {
    const counts = new Map<string, number>();
    for (const skill of library.list()) counts.set(skill.origin ?? 'custom', (counts.get(skill.origin ?? 'custom') ?? 0) + 1);
    const words: Record<string, string> = { 'project-local': 'this project', global: 'your own skill folders', custom: 'another folder' };
    return {
      text: ['Where your skills come from', ...[...counts.entries()].map(([origin, count]) => `  ${words[origin] ?? origin}: ${count}`)].join('\n'),
      data: { origins: Object.fromEntries(counts) },
    };
  },
});
export const SKILLS_PUBLISH_LOCAL = change({
  id: 'skills.publish-local', actionId: 'publish-local', label: 'Publish a skill folder to the local catalog', word: 'publish-local',
  inputs: [
    wordsInput({ id: 'id', label: 'Catalog id', help: 'A short id you choose', why: 'a new id you choose', typed: { position: 1 } }),
    wordsInput({ id: 'path', label: 'Skill folder', help: 'The folder with its SKILL.md', why: 'a folder on this machine', kind: 'path', typed: { position: 2 } }),
    wordsInput({ id: 'summary', label: 'Summary', help: 'One line on what it does', why: 'your own words', typed: { tail: true } }),
  ],
  sentence: 'The skill in {path} is listed in the local curated catalog as {id} ("{summary}"), until you change it.', undoneBy: 'unpublish',
  example: { id: 'release-notes', path: 'skills/release-notes', summary: 'Write release notes from merged changes' },
  run: (values, _library, caller, services) => {
    const result = upsertEcosystemCatalogEntry({
      id: values.id!, kind: 'skill',
      name: values.id!.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()),
      summary: values.summary!, source: values.path!, tags: ['local-first', 'published'], provenance: 'operator-published',
      updateHint: 'Publish it again from Tools and extensions after you change it, to refresh what the catalog says.',
    }, services.skills.catalogPaths(caller));
    if (!result.ok) throw new CapabilityRefusal(`${result.error}${result.error.endsWith('.') ? '' : '.'}`);
    return { text: `Published the skill ${values.id} to the local catalog (${result.path}).`, data: { id: values.id, catalog: result.path } };
  },
});
export const SKILLS_UNPUBLISH = change({
  id: 'skills.unpublish', actionId: 'unpublish', label: 'Take a skill out of the local catalog', word: 'unpublish', risk: 'cannot-be-undone',
  inputs: [pickedInput({ id: 'id', label: 'Catalog entry', help: 'Skills in the local curated catalog', list: SKILL_CATALOG_LIST, other: 'a catalog id' })],
  sentence: '{id} is removed from the local curated catalog; installs of it stay.', example: { id: 'release-notes' },
  run: (values, _library, caller, services) => {
    const result = removeEcosystemCatalogEntry('skill', values.id!, services.skills.catalogPaths(caller));
    if (!result.ok) throw new CapabilityRefusal(`${result.error}${result.error.endsWith('.') ? '' : '.'}`, undefined, 'NOT_FOUND');
    return { text: `Took ${values.id} out of the local catalog (${result.path}); installs of it stay.`, data: { id: values.id } };
  },
});

/** Every skills capability, with the command it answered to until this version. */
export const MY_SKILLS_CAPABILITIES: readonly CapabilityDefinition<SkillsCapabilityServices>[] = [
  MY_SKILLS_LIST, MY_SKILLS_ENABLED, MY_SKILLS_ATTENTION, MY_SKILLS_SEARCH, MY_SKILLS_SHOW, MY_SKILLS_CREATE, MY_SKILLS_UPDATE,
  MY_SKILLS_ENABLE, MY_SKILLS_DISABLE, MY_SKILLS_REVIEW, MY_SKILLS_STALE, MY_SKILLS_DELETE, MY_SKILLS_DISCOVER, MY_SKILLS_IMPORT_DISCOVERED,
  MY_SKILLS_IMPORT_STANDARD, MY_SKILLS_EXPORT_STANDARD, MY_SKILLS_BUNDLES, MY_SKILLS_BUNDLES_ENABLED, MY_SKILLS_BUNDLES_ATTENTION,
  MY_SKILLS_BUNDLE_SEARCH, MY_SKILLS_BUNDLE_SHOW, MY_SKILLS_BUNDLE_CREATE, MY_SKILLS_BUNDLE_UPDATE, MY_SKILLS_BUNDLE_ENABLE,
  MY_SKILLS_BUNDLE_DISABLE, MY_SKILLS_BUNDLE_REVIEW, MY_SKILLS_BUNDLE_STALE, MY_SKILLS_BUNDLE_DELETE,
];
export const SKILL_PACK_CAPABILITIES: readonly CapabilityDefinition<SkillsCapabilityServices>[] = [
  SKILLS_LIST_PACKS, SKILLS_SHOW_PACK, SKILLS_ORIGINS, SKILLS_PUBLISH_LOCAL, SKILLS_UNPUBLISH,
];

/** A path the caller gave: as it is when absolute, else in the caller's project folder. */
export function resolveCallerPath(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}
