import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { discoverSkills } from '../../views/skills-discovery.ts';
import { loadEcosystemCatalog, removeEcosystemCatalogEntry, upsertEcosystemCatalogEntry } from '@goodvibes/engine/platform/platform/runtime/ecosystem/catalog';
import { openModalCommand, requireEcosystemCatalogPaths, requireShellPaths } from './runtime-services.ts';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { defineCommand, defineList, type ListRow } from '@goodvibes/engine/terminal-shell/command-actions';
import { doAction, listInput, readAction, textInput } from '@goodvibes/engine/terminal-shell/described-command-kit';

/**
 * `/skills`, described once (command-actions/): the skill packs this app
 * finds, where they come from, and publishing a skill folder into the local
 * curated catalog. Installing from the catalog is /marketplace's.
 */

async function skillsOf(ctx: CommandContext) {
  // The same discovery and inputs as the Skills modal, so marketplace provenance shows here too.
  return discoverSkills(requireShellPaths(ctx), requireEcosystemCatalogPaths(ctx));
}

const SKILLS = defineList<CommandContext>({
  name: 'skills',
  async read(ctx) { return (await skillsOf(ctx)).map((skill): ListRow => ({ value: skill.name, label: skill.name, detail: skill.description || undefined, state: skill.origin })); },
  operator: { terminalOnly: 'Skills are found in this project and on this machine.' },
});
const PUBLISHED = defineList<CommandContext>({
  name: 'skills.catalog',
  async read(ctx) { return loadEcosystemCatalog('skill', requireEcosystemCatalogPaths(ctx)).map((entry): ListRow => ({ value: entry.id, label: entry.name, detail: entry.summary })); },
  operator: { terminalOnly: 'The curated catalog is on this machine.' },
});

export function registerSkillsRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'skills',
    // --yes confirms only right after the action word: the same word in the text is text.
    leadingFlagsOnly: true,
    title: 'Skills',
    summary: 'See the skill packs the model can use, and publish your own',
    group: 'Extensions',
    report: 'list',
    firstScreenRows: ['list', 'show', 'origins', { label: 'Publish your own skill', actions: ['publish-local', 'unpublish'] }, 'open'],
    actions: [
      readAction<CommandContext>({
        id: 'list', label: 'See your skills', word: 'list',
        sentence: 'Lists every skill pack found, where it comes from, and what it is for.',
        async run(_values, ctx) {
          const skills = await skillsOf(ctx);
          if (skills.length === 0) return 'No skills discovered.';
          return [`Skills (${skills.length})`, ...skills.map((skill) => `  ${skill.name}  [${skill.origin}]  ${skill.description || 'No description provided.'}${skill.marketplaceProvenance ? `  (${skill.marketplaceProvenance})` : ''}`)].join('\n');
        },
      }),
      doAction<CommandContext>({
        id: 'open', label: 'Open the skills screen', word: 'open', touches: 'reads',
        sentence: 'Opens the full-screen view of your skills.', operator: { terminalOnly: 'It is a terminal screen.' },
        async run(_values, ctx) { openModalCommand(ctx, 'skills-modal'); },
      }),
      readAction<CommandContext>({
        id: 'show', label: 'See one skill', word: 'show', inputs: [listInput({ id: 'skill', label: 'Skill', help: 'The skills found', list: SKILLS })],
        sentence: 'Shows {skill}\'s origin, path, description, dependencies and what it includes.', example: { skill: 'release-notes' },
        async run(values, ctx) {
          const skill = (await skillsOf(ctx)).find((entry) => entry.name === values.skill);
          if (!skill) throw commandRefusal(`Unknown skill: ${values.skill}`, '/skills list shows them.');
          return [
            `Skill ${skill.name}`, `  origin: ${skill.origin}`, `  path: ${skill.path}`, `  description: ${skill.description || 'No description provided.'}`,
            `  dependencies: ${skill.dependencies.join(', ') || '(none)'}`, `  includes: ${skill.includes.join(', ') || '(none)'}`,
          ].join('\n');
        },
      }),
      readAction<CommandContext>({
        id: 'origins', label: 'See where your skills come from', word: 'origins',
        sentence: 'Counts your skills by where they were found.',
        async run(_values, ctx) {
          const counts = new Map<string, number>();
          for (const skill of await skillsOf(ctx)) counts.set(skill.origin, (counts.get(skill.origin) ?? 0) + 1);
          return ['Skill Origins', ...[...counts.entries()].map(([origin, count]) => `  ${origin}: ${count}`)].join('\n');
        },
      }),
      {
        id: 'publish-local', label: 'Publish a skill folder to the local catalog', word: 'publish-local',
        inputs: [
          textInput({ id: 'id', label: 'Catalog id', help: 'A short id you choose', why: 'a new id you choose', typed: { position: 1 } }),
          textInput({ id: 'path', label: 'Skill folder', help: 'The folder with its SKILL.md', why: 'a folder on this machine', kind: 'path', typed: { position: 2 } }),
          textInput({ id: 'summary', label: 'Summary', help: 'One line on what it does', why: 'your own words', typed: { tail: true } }),
        ],
        sentence: 'The skill in {path} is listed in the local curated catalog as {id} ("{summary}"), until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'unpublish',
        operator: { terminalOnly: 'The curated catalog is on this machine.' }, example: { id: 'release-notes', path: 'skills/release-notes', summary: 'Write release notes from merged changes' },
        async run(values, ctx) {
          const result = upsertEcosystemCatalogEntry({
            id: values.id!,
            kind: 'skill',
            name: values.id!.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()),
            summary: values.summary!,
            source: values.path!,
            tags: ['local-first', 'published'],
            provenance: 'operator-published',
            updateHint: 'Use /skills publish-local again to refresh catalog metadata after edits.',
          }, requireEcosystemCatalogPaths(ctx));
          if (!result.ok) throw commandRefusal(result.error, undefined, 'NOT_DONE');
          return `Published curated skill ${values.id} into ${result.path}`;
        },
      },
      {
        id: 'unpublish', label: 'Take a skill out of the local catalog', word: 'unpublish',
        inputs: [listInput({ id: 'id', label: 'Catalog entry', help: 'Skills in the local curated catalog', list: PUBLISHED })],
        sentence: '{id} is removed from the local curated catalog; installs of it stay.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
        operator: { terminalOnly: 'The curated catalog is on this machine.' }, example: { id: 'release-notes' },
        async run(values, ctx) {
          const result = removeEcosystemCatalogEntry('skill', values.id!, requireEcosystemCatalogPaths(ctx));
          if (!result.ok) throw commandRefusal(result.error, undefined, 'NOT_DONE');
          return `Removed curated skill ${values.id} from ${result.path}`;
        },
      },
    ],
  }));
}
