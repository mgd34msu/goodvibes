import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  clearAgentRuntimeProfileSelection,
  createAgentRuntimeProfileFromDiscovered,
  createAgentRuntimeProfileTemplateFromDiscovered,
  createAgentRuntimeProfile,
  deleteAgentRuntimeProfile,
  exportAgentRuntimeProfileTemplate,
  getAgentRuntimeProfileTemplateFile,
  importAgentRuntimeProfileTemplate,
  listAgentRuntimeProfiles,
  listAgentRuntimeProfileTemplates,
  readAgentRuntimeProfileSelection,
  resolveAgentRuntimeProfileHome,
  setAgentRuntimeProfileSelection,
  type AgentRuntimeProfileInfo,
  type AgentRuntimeProfileTemplateSummary,
} from '../../agent/runtime-profile.ts';
import { formatAgentRecordSource } from '@goodvibes-jev/engine/terminal-shell/agent-turn/record-labels';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { commandRefusal } from './confirmation.ts';
import { defineCommand, defineList, type ActionDescription, type InputDescription, type ListRow } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { choiceInput, listInput, readAction, textInput } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';
import { requireShellPaths } from './runtime-services.ts';
import { readRefusal } from '@goodvibes-jev/engine/errors';

function profileLine(profile: AgentRuntimeProfileInfo): string {
  const created = profile.createdAt ? `  created ${profile.createdAt}` : '';
  const starter = profile.starterTemplateId ? `  starter=${profile.starterTemplateId}` : '';
  return `  ${profile.id}  home ${profile.homeDirectory}${created}${starter}`;
}

function templateLine(template: AgentRuntimeProfileTemplateSummary): string {
  const origin = template.source === 'local' ? `local ${template.path ?? ''}`.trim() : formatAgentRecordSource(template.source).toLowerCase();
  return [
    `  ${template.id}  [${origin}]`,
    `    ${template.name} - ${template.description}`,
    `    persona ${template.personaName}`,
    `    skills ${template.skillNames.join(', ')}`,
    `    routines ${template.routineNames.join(', ')}`,
    template.vibeIncluded ? '    vibe included' : '',
  ].filter(Boolean).join('\n');
}

function renderProfiles(homeDirectory: string): string {
  const profiles = listAgentRuntimeProfiles(homeDirectory);
  const selected = readAgentRuntimeProfileSelection(homeDirectory);
  const defaultLine = selected ? `  starts next: ${selected.id}${selected.exists ? '' : ' (missing)'}` : '  starts next: the base Agent home';
  if (profiles.length === 0) {
    return [
      'Agent homes',
      defaultLine,
      '  No separate Agent homes yet.',
      '  Make one with /agent-home create <name> --starter <id>.',
    ].join('\n');
  }
  return ['Agent homes', defaultLine, ...profiles.map(profileLine)].join('\n');
}

function renderProfileDetail(homeDirectory: string, name: string): string {
  const profile = resolveAgentRuntimeProfileHome(homeDirectory, name);
  const info = listAgentRuntimeProfiles(homeDirectory).find((entry) => entry.id === profile.id) ?? { ...profile, createdAt: null };
  const starter = info.starterTemplateId ? [`  starter: ${info.starterTemplateId} (${info.starterTemplateName ?? info.starterTemplateId})`] : [];
  return [
    `Agent home ${profile.id}`,
    `  home ${profile.homeDirectory}`,
    ...starter,
    `  use goodvibes-agent --agent-profile ${profile.id}`,
  ].join('\n');
}

function renderTemplates(homeDirectory: string): string {
  const templates = listAgentRuntimeProfileTemplates(homeDirectory);
  return [
    `Agent Starter Templates (${templates.length})`,
    ...templates.map(templateLine),
    '',
    'Authoring flow:',
    '  /agent-home export-starter research ./agent-starter.json',
    '  edit the JSON file',
    '  /agent-home import-starter ./agent-starter.json',
    '  /agent-home create <name> --starter <imported-id>',
    '  /agent-home create-learned <name>',
  ].join('\n');
}

function renderGuide(homeDirectory: string): string {
  const templates = listAgentRuntimeProfileTemplates(homeDirectory);
  const localCount = templates.filter((template) => template.source === 'local').length;
  return [
    'Agent Starter Authoring Guide',
    `  built-in starters ${templates.length - localCount}`,
    `  local starters ${localCount}`,
    '',
    '1. Pick a base starter:',
    '   /agent-home starters',
    '2. Export a starter JSON file:',
    '   /agent-home export-starter research ./agent-starter.json',
    '3. Edit id, name, description, persona, skills, routines, and optional vibe in that JSON file.',
    '4. Import it into this Agent home:',
    '   /agent-home import-starter ./agent-starter.json',
    '5. Make an Agent home from the imported starter:',
    '   /agent-home create <name> --starter <imported-id>',
    '',
    'This writes only Agent-local starter/profile state. It does not mutate connected GoodVibes host, default knowledge, or non-Agent knowledge segments.',
  ].join('\n');
}

function renderTemplatePreview(homeDirectory: string, templateId: string): string {
  const file = getAgentRuntimeProfileTemplateFile(templateId, homeDirectory);
  return [
    `Agent Starter Template ${file.template.id}`,
    `  name ${file.template.name}`,
    `  origin ${formatAgentRecordSource(file.template.source)}`,
    `  description ${file.template.description}`,
    `  persona ${file.template.persona.name}`,
    `  skills ${file.template.skills.map((skill) => skill.name).join(', ')}`,
    `  routines ${file.template.routines.map((routine) => routine.name).join(', ')}`,
    file.template.vibe ? '  vibe included' : '',
    '',
    'Export/edit/import to customize this starter:',
    `  /agent-home export-starter ${file.template.id} ./agent-starter.json --include-vibe`,
  ].join('\n');
}

/** Run one step against the Agent's home; a failure that is not a refusal is reported as one. */
function step<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (readRefusal(error)) throw error;
    throw commandRefusal(`Error: ${error instanceof Error ? error.message : String(error)}`, undefined, 'COMMAND_FAILED');
  }
}
async function stepAsync<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (readRefusal(error)) throw error;
    throw commandRefusal(`Error: ${error instanceof Error ? error.message : String(error)}`, undefined, 'COMMAND_FAILED');
  }
}
const homeOf = (ctx: CommandContext): string => requireShellPaths(ctx).homeDirectory;
const csv = (value: string | undefined): readonly string[] | undefined => value ? value.split(',').map((entry) => entry.trim()).filter(Boolean) : undefined;

const HOMES = defineList<CommandContext>({
  name: 'agent-home.homes',
  async read(ctx) {
    const selected = readAgentRuntimeProfileSelection(homeOf(ctx));
    return listAgentRuntimeProfiles(homeOf(ctx)).map((profile): ListRow => ({ value: profile.id, label: profile.id, detail: profile.homeDirectory, ...(selected?.id === profile.id ? { state: 'starts next' } : {}) }));
  },
  operator: { terminalOnly: 'Agent homes are folders of this Agent on this machine.' },
});
const STARTERS = defineList<CommandContext>({
  name: 'agent-home.starters',
  async read(ctx) {
    return listAgentRuntimeProfileTemplates(homeOf(ctx)).map((template): ListRow => ({ value: template.id, label: template.name, detail: template.description, state: template.source === 'local' ? 'yours' : 'built in' }));
  },
  operator: { terminalOnly: 'Starter templates are files of this Agent on this machine.' },
});

const HOME: InputDescription = listInput({ id: 'home', label: 'Home', help: 'Your Agent homes', list: HOMES });
const NAME: InputDescription = textInput({ id: 'name', label: 'Name', help: 'A short name for the home', why: 'a name you choose', typed: { position: 1 } });
const STARTER: InputDescription = listInput({ id: 'starter', label: 'Starter', help: 'Built-in and your own starter templates', list: STARTERS });
const PATH: InputDescription = textInput({ id: 'path', label: 'File', help: 'A starter JSON file', why: 'a file on this machine', kind: 'path', typed: { position: 2 } });
const REPLACE_STARTER: InputDescription = choiceInput({
  id: 'replace', label: 'If a starter has that id', help: 'One of your starters may already use it',
  choices: [{ value: 'no', label: 'Stop and say so' }, { value: 'yes', label: 'Replace it', help: 'What it holds now is lost.', risk: 'cannot-be-undone' }],
  typed: { flag: '--replace', switchOn: 'yes' }, optional: { default: 'no', means: 'stop and say so' },
});
const VIBE: InputDescription = choiceInput({
  id: 'vibe', label: 'VIBE.md', help: 'Whether the personality file goes in too',
  choices: [{ value: 'no', label: 'Leave it out' }, { value: 'yes', label: 'Include it' }],
  typed: { flag: '--include-vibe', switchOn: 'yes' }, optional: { default: 'no', means: 'leave it out' },
});
/** What a starter made from this Agent's learned behaviour takes, beyond its id. */
const LEARNED: readonly InputDescription[] = [
  textInput({ id: 'title', label: 'Display name', help: 'The name it shows', why: 'a name you choose', typed: { flag: '--name' }, optional: { default: '', means: 'its id' } }),
  textInput({ id: 'description', label: 'Description', help: 'One line on what it is for', why: 'your own words', typed: { flag: '--description' }, optional: { default: '', means: 'a description made from what it holds' } }),
  textInput({ id: 'persona', label: 'Persona', help: 'The persona it starts with', why: 'a persona name from /personas', typed: { flag: '--persona' }, optional: { default: '', means: 'the active persona' } }),
  textInput({ id: 'skills', label: 'Skills', help: 'all, or skill names separated by commas', why: 'skill names', typed: { flag: '--skills' }, optional: { default: '', means: 'the enabled skills' } }),
  textInput({ id: 'routines', label: 'Routines', help: 'all, or routine names separated by commas', why: 'routine names', typed: { flag: '--routines' }, optional: { default: '', means: 'the enabled routines' } }),
  VIBE,
  REPLACE_STARTER,
];
const LOCAL_ONLY = { terminalOnly: 'Agent homes are folders of this Agent on this machine.' } as const;

type HomeAction = ActionDescription<CommandContext>;
function change(fields: Pick<HomeAction, 'id' | 'label' | 'word' | 'inputs' | 'sentence' | 'example' | 'run'> & Partial<Pick<HomeAction, 'risk' | 'undoneBy' | 'lasts'>>): HomeAction {
  return { done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', operator: LOCAL_ONLY, ...fields };
}

function useHome(homeDirectory: string, name: string): string {
  const previous = readAgentRuntimeProfileSelection(homeDirectory);
  const selected = setAgentRuntimeProfileSelection(homeDirectory, name);
  return [
    `The Agent starts in home ${selected.id} from the next launch.`,
    `  home ${selected.homeDirectory}`,
    previous ? `  before: ${previous.id}` : '  before: the base Agent home',
    '  one launch elsewhere: goodvibes-agent --agent-profile <name>',
  ].join('\n');
}

export function registerAgentRuntimeProfileRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'agent-home',
    title: 'Agent homes',
    summary: 'Separate Agent homes, each with its own settings, memory and sessions, and the starters they are made from',
    group: 'Agent',
    report: 'list',
    firstScreenRows: [
      'list', 'create', 'use', 'use-base',
      { label: 'See or delete a home…', actions: ['show', 'next', 'delete', 'create-learned'] },
      { label: 'Starter templates…', actions: ['starters', 'starter', 'guide', 'export-starter', 'import-starter', 'starter-learned'] },
    ],
    actions: [
      readAction<CommandContext>({
        id: 'list', label: 'See your Agent homes', readsOnlyThisMachine: true, word: 'list',
        sentence: 'Lists your Agent homes, their folders, and which one the Agent starts in next.',
        operator: LOCAL_ONLY,
        async rowValue(ctx) {
          const count = listAgentRuntimeProfiles(homeOf(ctx)).length;
          return count === 0 ? 'only the base home' : `${count} home${count === 1 ? '' : 's'}`;
        },
        async run(_values, ctx) { return step(() => renderProfiles(homeOf(ctx))); },
      }),
      readAction<CommandContext>({
        id: 'show', label: 'See one Agent home', word: 'show', inputs: [HOME],
        sentence: 'Shows home {home}: its folder, the starter it was made from, and how to launch it.', example: { home: 'research' }, operator: LOCAL_ONLY,
        async run(values, ctx) { return step(() => renderProfileDetail(homeOf(ctx), values.home!)); },
      }),
      readAction<CommandContext>({
        id: 'next', label: 'See which home starts next', word: 'next',
        sentence: 'Says which Agent home the next launch starts in.', operator: LOCAL_ONLY,
        async run(_values, ctx) {
          const selected = readAgentRuntimeProfileSelection(homeOf(ctx));
          return selected
            ? `The next launch starts in home ${selected.id}${selected.exists ? '' : ' (its folder is missing)'}.\n  home ${selected.homeDirectory}`
            : 'The next launch starts in the base Agent home.';
        },
      }),
      change({
        id: 'use', label: 'Start in a home from now on', word: 'use', inputs: [HOME],
        sentence: 'Every launch of the Agent starts in home {home}, until you change it.', example: { home: 'research' }, undoneBy: 'use-base',
        async run(values, ctx) { return step(() => useHome(homeOf(ctx), values.home!)); },
      }),
      change({
        id: 'use-base', label: 'Start in the base home from now on', word: 'use-base', inputs: [],
        sentence: 'Every launch of the Agent starts in the base home, until you change it.', example: {}, undoneBy: 'use',
        async run(_values, ctx) {
          return step(() => {
            const home = homeOf(ctx);
            const previous = readAgentRuntimeProfileSelection(home);
            clearAgentRuntimeProfileSelection(home);
            return `The Agent starts in the base home from the next launch.${previous ? `\n  before: ${previous.id} (put it back: /agent-home use ${previous.id})` : ''}`;
          });
        },
      }),
      change({
        id: 'create', label: 'Make an Agent home', word: 'create',
        inputs: [NAME, { ...STARTER, required: { default: '', defaultMeans: 'an empty home' }, typed: { flag: '--starter' } }],
        sentence: 'A new Agent home {name} is made, from the starter given, until you change it.', example: { name: 'research', starter: 'research' }, undoneBy: 'delete',
        async run(values, ctx) {
          return step(() => {
            const profile = createAgentRuntimeProfile(homeOf(ctx), values.name!, { templateId: values.starter || undefined });
            return [
              `Made Agent home ${profile.id}`,
              `  home ${profile.homeDirectory}`,
              profile.starterTemplateId ? `  starter: ${profile.starterTemplateId}` : '',
              profile.starterTemplateApplication?.vibePath ? `  vibe ${profile.starterTemplateApplication.vibePath}` : '',
              ...(profile.starterTemplateApplication?.reviewCommands.length
                ? ['  review before they apply:', ...profile.starterTemplateApplication.reviewCommands.map((command) => `    ${command}`)]
                : []),
              `  launch it: goodvibes-agent --agent-profile ${profile.id}, or /agent-home use ${profile.id}`,
            ].filter(Boolean).join('\n');
          });
        },
      }),
      change({
        id: 'create-learned', label: 'Make a home from what this Agent has learned', word: 'create-learned',
        inputs: [NAME, textInput({ id: 'starter', label: 'Starter id', help: 'The id of the starter made for it', why: 'an id you choose', typed: { flag: '--starter-id' }, optional: { default: '', means: 'the home\'s name' } }), ...LEARNED],
        sentence: 'A starter is made from this Agent\'s persona, skills, routines and (if chosen) VIBE.md, and a new home {name} is made from it, until you change it.', example: { name: 'research', skills: 'all' }, undoneBy: 'delete',
        async run(values, ctx) {
          const created = await stepAsync(() => createAgentRuntimeProfileFromDiscovered(requireShellPaths(ctx), {
            profileName: values.name!, templateId: values.starter || undefined, name: values.title || undefined, description: values.description || undefined,
            persona: values.persona || undefined, skills: csv(values.skills), routines: csv(values.routines), includeVibe: values.vibe === 'yes', replace: values.replace === 'yes',
          }));
          return [
            `Made Agent home ${created.profile.id} from what this Agent has learned`,
            `  home ${created.profile.homeDirectory}`,
            `  starter: ${created.template.id}`,
            `  persona ${created.template.personaName}`,
            `  skills ${created.template.skillNames.join(', ')}`,
            `  routines ${created.template.routineNames.join(', ')}`,
            created.template.vibeIncluded ? '  vibe included' : '',
            `  launch it: goodvibes-agent --agent-profile ${created.profile.id}`,
          ].filter(Boolean).join('\n');
        },
      }),
      change({
        id: 'delete', label: 'Delete an Agent home', word: 'delete', inputs: [HOME],
        sentence: 'Home {home} and everything in it (settings, sessions, memory, notes, personas, skills, routines) are deleted.', example: { home: 'research' }, risk: 'cannot-be-undone',
        async run(values, ctx) {
          return step(() => {
            if (!deleteAgentRuntimeProfile(homeOf(ctx), values.home!)) throw commandRefusal(`No Agent home ${values.home}.`, '/agent-home list shows them.');
            return `Deleted Agent home ${values.home}.`;
          });
        },
      }),
      readAction<CommandContext>({
        id: 'starters', label: 'See starter templates', word: 'starters',
        sentence: 'Lists the built-in and your own starter templates, with the persona, skills and routines each brings.', operator: LOCAL_ONLY,
        async run(_values, ctx) { return step(() => renderTemplates(homeOf(ctx))); },
      }),
      readAction<CommandContext>({
        id: 'starter', label: 'See one starter template', word: 'starter', inputs: [STARTER],
        sentence: 'Shows starter {starter}: its persona, skills, routines and whether it brings VIBE.md.', example: { starter: 'research' }, operator: LOCAL_ONLY,
        async run(values, ctx) { return step(() => renderTemplatePreview(homeOf(ctx), values.starter!)); },
      }),
      readAction<CommandContext>({
        id: 'guide', label: 'Read how to write a starter', word: 'guide',
        sentence: 'Shows the steps to save a starter to a file, change it, add it back and make a home from it.', operator: LOCAL_ONLY,
        async run(_values, ctx) { return step(() => renderGuide(homeOf(ctx))); },
      }),
      change({
        id: 'export-starter', label: 'Save a starter to a file', word: 'export-starter',
        inputs: [STARTER, PATH, VIBE, choiceInput({
          id: 'overwrite', label: 'If the file exists', help: 'Keep it, or write over it',
          choices: [{ value: 'no', label: 'Keep it and stop' }, { value: 'yes', label: 'Write over it', risk: 'cannot-be-undone' }],
          typed: { flag: '--overwrite', switchOn: 'yes' }, optional: { default: 'no', means: 'keep it and stop' },
        })],
        sentence: 'Starter {starter} is written to {path} to change and add back, until you change it.', example: { starter: 'research', path: 'agent-starter.json' },
        async run(values, ctx) {
          const shellPaths = requireShellPaths(ctx);
          const target = shellPaths.resolveWorkspacePath(values.path!);
          if (existsSync(target) && values.overwrite !== 'yes') throw commandRefusal(`${target} already exists; nothing was written.`, `Write over it: /agent-home export-starter ${values.starter} ${values.path} --overwrite`);
          return step(() => {
            mkdirSync(dirname(target), { recursive: true });
            const template = exportAgentRuntimeProfileTemplate(shellPaths.homeDirectory, values.starter!, target, { includeVibe: values.vibe === 'yes', shellPaths });
            return [`Saved starter ${template.id} to ${template.path ?? target}`, template.vibeIncluded ? '  vibe included' : '', `  change it, then add it back: /agent-home import-starter ${values.path}`].filter(Boolean).join('\n');
          });
        },
      }),
      change({
        id: 'import-starter', label: 'Add a starter from a file', word: 'import-starter',
        inputs: [{ ...PATH, typed: { position: 1 } }, REPLACE_STARTER],
        sentence: 'The starter in {path} is added to your starters, until you change it.', example: { path: 'agent-starter.json' },
        async run(values, ctx) {
          const shellPaths = requireShellPaths(ctx);
          return step(() => {
            const template = importAgentRuntimeProfileTemplate(shellPaths.homeDirectory, shellPaths.resolveWorkspacePath(values.path!), { replace: values.replace === 'yes' });
            return `Added starter ${template.id} (${formatAgentRecordSource(template.source).toLowerCase()}).\n  make a home from it: /agent-home create <name> --starter ${template.id}`;
          });
        },
      }),
      change({
        id: 'starter-learned', label: 'Make a starter from what this Agent has learned', word: 'starter-learned',
        inputs: [textInput({ id: 'starter', label: 'Starter id', help: 'The id of the new starter', why: 'an id you choose', typed: { position: 1 } }), ...LEARNED],
        sentence: 'Starter {starter} is made from this Agent\'s persona, skills, routines and (if chosen) VIBE.md, until you change it.', example: { starter: 'my-research', skills: 'all' },
        async run(values, ctx) {
          const template = await stepAsync(() => createAgentRuntimeProfileTemplateFromDiscovered(requireShellPaths(ctx), {
            id: values.starter!, name: values.title || undefined, description: values.description || undefined, persona: values.persona || undefined,
            skills: csv(values.skills), routines: csv(values.routines), includeVibe: values.vibe === 'yes', replace: values.replace === 'yes',
          }));
          return [
            `Made starter ${template.id} from what this Agent has learned`,
            `  persona ${template.personaName}`,
            `  skills ${template.skillNames.join(', ')}`,
            `  routines ${template.routineNames.join(', ')}`,
            template.vibeIncluded ? '  vibe included' : '',
            `  make a home from it: /agent-home create <name> --starter ${template.id}`,
          ].filter(Boolean).join('\n');
        },
      }),
    ],
  }));
}
