import { discoverPersonas, type DiscoveredPersonaRecord } from '../../agent/persona-discovery.ts';
import { AgentPersonaRegistry, type AgentPersonaRecord } from '@goodvibes-jev/engine/terminal-shell/agent-turn/persona-registry';
import { formatAgentRecordOrigin, formatAgentRecordReviewState } from '@goodvibes-jev/engine/terminal-shell/agent-turn/record-labels';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';
import { commandRefusal } from './confirmation.ts';
import { readRefusal } from '@goodvibes-jev/engine/errors';
import { discoverVibeFiles, formatVibeStatus, initVibeFile, loadVibeImportSource } from '@goodvibes-jev/engine/terminal-shell/agent-turn/vibe-file';
import { defineCommand, defineList, type ActionDescription, type InputDescription, type ListRow } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { choiceInput, listInput, readAction, textInput } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';

function splitList(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function registryFromContext(ctx: CommandContext): AgentPersonaRegistry {
  return AgentPersonaRegistry.fromShellPaths(requireShellPaths(ctx));
}

function formatPersonaReceipt(title: string, persona: Pick<AgentPersonaRecord, 'id' | 'name'>, extra: readonly string[] = []): string {
  const activeSuffix = extra.some((line) => line.includes('active yes') || line.includes('active: yes')) ? ' (active)' : '';
  const normalizedExtra = extra.map((line) => line.replace(/^  active /, '  active: '));
  return [
    `${title} ${persona.id}: ${persona.name}${activeSuffix}`,
    `  id ${persona.id}`,
    `  name ${persona.name}`,
    ...normalizedExtra,
  ].join('\n');
}

function summarizePersona(persona: AgentPersonaRecord, activePersonaId: string | null): string {
  const active = persona.id === activePersonaId ? 'active' : 'inactive';
  const review = formatAgentRecordReviewState(persona.reviewState);
  const tags = persona.tags.length > 0 ? ` tags ${persona.tags.join(', ')}` : '';
  return `  ${persona.id}  ${active}  ${review}  ${persona.name} - ${persona.description}${tags}`;
}

function renderList(title: string, registry: AgentPersonaRegistry, personas: readonly AgentPersonaRecord[]): string {
  const snapshot = registry.snapshot();
  if (personas.length === 0) {
    return `${title}\n  No personas yet. Make one: /personas create --name <name> --description <summary> <instructions>.`;
  }
  return [
    `${title} (${personas.length})`,
    `  store ${snapshot.path}`,
    `  active ${snapshot.activePersona?.name ?? '(none)'}`,
    ...personas.map((persona) => summarizePersona(persona, snapshot.activePersonaId)),
  ].join('\n');
}

function renderPersona(persona: AgentPersonaRecord, activePersonaId: string | null): string {
  return [
    `Persona ${persona.name}`,
    `  id ${persona.id}`,
    `  active: ${persona.id === activePersonaId ? 'yes' : 'no'}`,
    `  review: ${formatAgentRecordReviewState(persona.reviewState)}`,
    `  origin: ${formatAgentRecordOrigin(persona.source, persona.provenance)}`,
    `  tags: ${persona.tags.join(', ') || '(none)'}`,
    `  triggers: ${persona.triggers.join(', ') || '(none)'}`,
    `  created: ${persona.createdAt}`,
    `  updated: ${persona.updatedAt}`,
    persona.staleReason ? `  stale reason: ${persona.staleReason}` : '',
    '',
    persona.description,
    '',
    persona.body,
  ].filter(Boolean).join('\n');
}

function summarizeDiscoveredPersona(persona: DiscoveredPersonaRecord): string {
  const description = persona.description ? ` - ${persona.description}` : '';
  return `  ${persona.name}  ${persona.origin}${description}\n    path ${persona.path}`;
}

function renderDiscoveredPersonas(personas: readonly DiscoveredPersonaRecord[]): string {
  if (personas.length === 0) {
    return [
      'Discovered Agent persona files',
      '  No persona markdown files found in project/global Agent persona folders.',
      '  Search roots: .goodvibes/personas, .goodvibes/agent/personas, ~/.goodvibes/personas, ~/.goodvibes/agent/personas',
    ].join('\n');
  }
  return [
    `Persona files you could import (${personas.length})`,
    ...personas.map(summarizeDiscoveredPersona),
    '',
    'Import one: /personas import <name>',
  ].join('\n');
}

function discoveredPersonaLookupValues(persona: DiscoveredPersonaRecord): readonly string[] {
  const slug = persona.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const basename = persona.path.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? '';
  return [persona.name, slug, persona.path, basename].map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function findDiscoveredPersona(personas: readonly DiscoveredPersonaRecord[], idOrName: string): DiscoveredPersonaRecord | null {
  const lookup = idOrName.trim().toLowerCase();
  if (!lookup) return null;
  return personas.find((persona) => discoveredPersonaLookupValues(persona).includes(lookup)) ?? null;
}

function frontmatterList(persona: DiscoveredPersonaRecord, key: string): readonly string[] {
  const value = persona.frontmatter[key];
  if (!value) return [];
  return splitList(value);
}

/** Run one step against the persona store; a failure that is not a refusal is reported as one. */
function step<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (readRefusal(error)) throw error;
    throw commandRefusal(`Error: ${error instanceof Error ? error.message : String(error)}`, undefined, 'COMMAND_FAILED');
  }
}

const PERSONAS = defineList<CommandContext>({
  name: 'personas',
  async read(ctx) {
    const store = registryFromContext(ctx);
    const active = store.snapshot().activePersonaId;
    return store.list().map((persona): ListRow => ({ value: persona.id, label: persona.name, detail: persona.description, state: persona.id === active ? 'in use' : formatAgentRecordReviewState(persona.reviewState) }));
  },
  operator: { terminalOnly: 'Personas are kept in this Agent\'s home.' },
});
const DISCOVERED = defineList<CommandContext>({
  name: 'personas.discovered',
  async read(ctx) {
    return (await discoverPersonas(requireShellPaths(ctx))).map((persona): ListRow => ({ value: persona.name, label: persona.name, detail: persona.path, state: persona.origin }));
  },
  operator: { terminalOnly: 'Persona files are read from this machine.' },
});

const LOCAL_ONLY = { terminalOnly: 'Personas are kept in this Agent\'s home.' } as const;
const PERSONA: InputDescription = listInput({ id: 'persona', label: 'Persona', help: 'Your personas', list: PERSONAS, other: 'a persona id or name' });
const WHERE: InputDescription = choiceInput({
  id: 'where', label: 'Which VIBE.md', help: 'The project\'s, your own, or a file',
  choices: [{ value: 'project', label: 'This project\'s' }, { value: 'global', label: 'Your own, for every project' }],
  typed: { position: 1 }, optional: { default: 'project', means: 'this project\'s' },
});
/** A VIBE.md to read: the project's, your own, or one at a path. */
const VIBE_FILE: InputDescription = textInput({
  id: 'where', label: 'Which VIBE.md', help: 'project, global (your own), or the path of a VIBE.md file', why: 'project, global, or a file path',
  typed: { tail: true }, optional: { default: 'project', means: 'this project\'s' },
});
const USE_NOW: InputDescription = choiceInput({
  id: 'use', label: 'Use it now', help: 'Whether the Agent starts using it', choices: [{ value: 'no', label: 'Not yet' }, { value: 'yes', label: 'Use it now' }],
  typed: { flag: '--use', switchOn: 'yes' }, optional: { default: 'no', means: 'not yet' },
});
const REVIEW_OWNER_ONLY = {
  reason: 'marking a persona reviewed is your decision that its text may reach the prompt',
  instead: 'Ask the owner to review it with /personas review.',
};

type PersonaAction = ActionDescription<CommandContext>;
function change(fields: Pick<PersonaAction, 'id' | 'label' | 'word' | 'inputs' | 'sentence' | 'example' | 'run'> & Partial<Pick<PersonaAction, 'risk' | 'undoneBy' | 'ownerOnly' | 'lasts'>>): PersonaAction {
  return { done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', operator: LOCAL_ONLY, ...fields };
}

export function registerPersonasRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'personas',
    title: 'Personas',
    summary: 'How the Agent talks and behaves: your personas, the one in use, and VIBE.md personality files',
    group: 'Agent',
    report: 'list',
    firstScreenRows: [
      'list', 'active', 'use', 'stop-using', 'create',
      { label: 'See, find or change a persona…', actions: ['show', 'search', 'update', 'review', 'stale', 'delete'] },
      { label: 'Import a persona file…', actions: ['discover', 'import'] },
      { label: 'VIBE.md personality files…', actions: ['vibe', 'vibe-show', 'vibe-create', 'vibe-import'] },
    ],
    actions: [
      readAction<CommandContext>({
        id: 'list', label: 'See your personas', word: 'list',
        sentence: 'Lists your personas: which is in use, which you reviewed, and what each is for.', operator: LOCAL_ONLY,
        async rowValue(ctx) {
          const snapshot = registryFromContext(ctx).snapshot();
          return snapshot.activePersona ? `${snapshot.activePersona.name} in use` : 'none in use';
        },
        async run(_values, ctx) { const store = registryFromContext(ctx); return renderList('Personas', store, store.list()); },
      }),
      readAction<CommandContext>({
        id: 'active', label: 'See the persona in use', word: 'active',
        sentence: 'Shows the persona the Agent uses now, in full.', operator: LOCAL_ONLY,
        async run(_values, ctx) {
          const snapshot = registryFromContext(ctx).snapshot();
          return snapshot.activePersona ? renderPersona(snapshot.activePersona, snapshot.activePersonaId) : 'No persona is in use.';
        },
      }),
      readAction<CommandContext>({
        id: 'show', label: 'See one persona', word: 'show', inputs: [PERSONA],
        sentence: 'Shows persona {persona} in full: its text, review state, tags and where it came from.', example: { persona: 'editor' }, operator: LOCAL_ONLY,
        async run(values, ctx) {
          const store = registryFromContext(ctx);
          const persona = store.get(values.persona!);
          if (!persona) throw commandRefusal(`No persona ${values.persona}.`, '/personas list shows them.');
          return renderPersona(persona, store.snapshot().activePersonaId);
        },
      }),
      readAction<CommandContext>({
        id: 'search', label: 'Find a persona', word: 'search',
        inputs: [textInput({ id: 'words', label: 'Words', help: 'What to look for in their names, text and tags', why: 'your own words', typed: { tail: true } })],
        sentence: 'Lists the personas that mention {words}.', example: { words: 'editor' }, operator: LOCAL_ONLY,
        async run(values, ctx) { const store = registryFromContext(ctx); return renderList(`Personas matching "${values.words}"`, store, store.search(values.words!)); },
      }),
      change({
        id: 'create', label: 'Make a persona', word: 'create',
        inputs: [
          textInput({ id: 'name', label: 'Name', help: 'What it is called', why: 'a name you choose', typed: { flag: '--name' } }),
          textInput({ id: 'description', label: 'Summary', help: 'One line on what it is for', why: 'your own words', typed: { flag: '--description' } }),
          textInput({ id: 'body', label: 'Instructions', help: 'How the Agent talks and behaves with it', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
          textInput({ id: 'tags', label: 'Tags', help: 'Words to find it by, separated by commas', why: 'your own words', typed: { flag: '--tags' }, optional: { default: '', means: 'none' } }),
          textInput({ id: 'triggers', label: 'When to suggest it', help: 'Words that bring it up, separated by commas', why: 'your own words', typed: { flag: '--triggers' }, optional: { default: '', means: 'never on its own' } }),
        ],
        sentence: 'A persona {name} ("{description}") is kept with the instructions given, until you change it.', example: { name: 'editor', description: 'A careful copy editor', body: 'Edit for clarity; keep the author\'s voice.' },
        undoneBy: 'delete',
        async run(values, ctx) {
          const persona = step(() => registryFromContext(ctx).create({
            name: values.name!, description: values.description!, body: values.body!, tags: splitList(values.tags), triggers: splitList(values.triggers), source: 'user', provenance: 'Command',
          }));
          return formatPersonaReceipt('Made persona', persona);
        },
      }),
      change({
        id: 'update', label: 'Change a persona', word: 'update',
        inputs: [
          PERSONA,
          textInput({ id: 'name', label: 'Name', help: 'A new name', why: 'a name you choose', typed: { flag: '--name' }, optional: { default: '', means: 'keep it' } }),
          textInput({ id: 'description', label: 'Summary', help: 'A new one-line summary', why: 'your own words', typed: { flag: '--description' }, optional: { default: '', means: 'keep it' } }),
          textInput({ id: 'body', label: 'Instructions', help: 'New instructions', why: 'your own words', kind: 'long-text', typed: { tail: true }, optional: { default: '', means: 'keep them' } }),
          textInput({ id: 'tags', label: 'Tags', help: 'New tags, separated by commas', why: 'your own words', typed: { flag: '--tags' }, optional: { default: '', means: 'keep them' } }),
          textInput({ id: 'triggers', label: 'When to suggest it', help: 'New words that bring it up', why: 'your own words', typed: { flag: '--triggers' }, optional: { default: '', means: 'keep them' } }),
        ],
        sentence: 'Persona {persona} takes the changes given, until you change it.', example: { persona: 'editor', description: 'A strict copy editor' },
        async run(values, ctx) {
          const updated = step(() => registryFromContext(ctx).update(values.persona!, {
            name: values.name || undefined, description: values.description || undefined, body: values.body || undefined,
            tags: values.tags ? splitList(values.tags) : undefined, triggers: values.triggers ? splitList(values.triggers) : undefined, provenance: 'Command',
          }));
          return formatPersonaReceipt('Changed persona', updated);
        },
      }),
      change({
        id: 'use', label: 'Use a persona', word: 'use', inputs: [PERSONA],
        sentence: 'The Agent talks and behaves as persona {persona}, until you change it.', example: { persona: 'editor' }, undoneBy: 'stop-using',
        async run(values, ctx) { return formatPersonaReceipt('Using persona', step(() => registryFromContext(ctx).setActive(values.persona!))); },
      }),
      change({
        id: 'stop-using', label: 'Stop using a persona', word: 'stop-using', inputs: [],
        sentence: 'The Agent uses no persona, until you change it.', example: {}, undoneBy: 'use',
        async run(_values, ctx) { step(() => registryFromContext(ctx).clearActive()); return 'No persona is in use now.'; },
      }),
      change({
        id: 'review', label: 'Mark a persona reviewed', word: 'review', inputs: [PERSONA],
        sentence: 'Persona {persona} is marked reviewed, so its text may reach the prompt, until you change it.', example: { persona: 'editor' },
        risk: 'loosens-a-protection', ownerOnly: REVIEW_OWNER_ONLY, undoneBy: 'stale',
        async run(values, ctx) { return formatPersonaReceipt('Reviewed persona', step(() => registryFromContext(ctx).markReviewed(values.persona!))); },
      }),
      change({
        id: 'stale', label: 'Mark a persona out of date', word: 'stale',
        inputs: [PERSONA, textInput({ id: 'reason', label: 'Why', help: 'What is out of date', why: 'your own words', kind: 'long-text', typed: { tail: true } })],
        sentence: 'Persona {persona} is marked out of date because "{reason}", until you change it.', example: { persona: 'editor', reason: 'the style guide changed' },
        async run(values, ctx) { return formatPersonaReceipt('Marked out of date', step(() => registryFromContext(ctx).markStale(values.persona!, values.reason!))); },
      }),
      change({
        id: 'delete', label: 'Delete a persona', word: 'delete', inputs: [PERSONA],
        sentence: 'Persona {persona} is removed from this Agent.', example: { persona: 'editor' }, risk: 'cannot-be-undone',
        async run(values, ctx) { return formatPersonaReceipt('Deleted persona', step(() => registryFromContext(ctx).deletePersona(values.persona!))); },
      }),
      readAction<CommandContext>({
        id: 'discover', label: 'See persona files you could import', word: 'discover',
        sentence: 'Lists the persona Markdown files in this project\'s and your own persona folders.', operator: { terminalOnly: 'Persona files are read from this machine.' },
        async run(_values, ctx) { return renderDiscoveredPersonas(await discoverPersonas(requireShellPaths(ctx))); },
      }),
      change({
        id: 'import', label: 'Import a persona file', word: 'import',
        inputs: [listInput({ id: 'file', label: 'Persona file', help: 'Persona files found in your persona folders', list: DISCOVERED, other: 'a persona file name or path' }), USE_NOW],
        sentence: 'The persona in {file} is added to this Agent, not yet reviewed, until you change it.', example: { file: 'editor' }, undoneBy: 'delete',
        async run(values, ctx) {
          const discovered = findDiscoveredPersona(await discoverPersonas(requireShellPaths(ctx)), values.file!);
          if (!discovered) throw commandRefusal(`No persona file ${values.file}.`, '/personas discover lists them.');
          const store = registryFromContext(ctx);
          const persona = step(() => store.create({
            name: discovered.name, description: discovered.description || `Imported persona from ${discovered.origin} markdown file.`, body: discovered.body,
            tags: frontmatterList(discovered, 'tags'), triggers: frontmatterList(discovered, 'triggers'), source: 'imported', provenance: `Imported file (${discovered.origin}): ${discovered.path}`,
          }));
          if (values.use === 'yes') step(() => store.setActive(persona.id));
          return formatPersonaReceipt('Imported persona', persona, [`  active ${values.use === 'yes' ? 'yes' : 'no'}`]);
        },
      }),
      readAction<CommandContext>({
        id: 'vibe', label: 'See your VIBE.md files', word: 'vibe',
        sentence: 'Shows the VIBE.md personality files that apply, any that are blocked, and where new ones go.', operator: { terminalOnly: 'VIBE.md files are read from this machine.' },
        async run(_values, ctx) { return formatVibeStatus(discoverVibeFiles(requireShellPaths(ctx))); },
      }),
      readAction<CommandContext>({
        id: 'vibe-show', label: 'Read a VIBE.md', word: 'vibe-show', inputs: [VIBE_FILE],
        sentence: 'Shows the VIBE.md named {where}, in full.', example: { where: 'global' }, operator: { terminalOnly: 'VIBE.md files are read from this machine.' },
        async run(values, ctx) {
          const source = step(() => loadVibeImportSource(requireShellPaths(ctx), values.where || 'project'));
          return [`${source.scope === 'global' ? 'Your own' : 'This project\'s'} VIBE.md`, `  path ${source.path}`, `  name ${source.name}`, `  description ${source.description}`, '', source.body].join('\n');
        },
      }),
      change({
        id: 'vibe-create', label: 'Make a VIBE.md', word: 'vibe-create',
        inputs: [WHERE, choiceInput({
          id: 'replace', label: 'If one is there', help: 'Keep it, or put the starter in its place',
          choices: [{ value: 'no', label: 'Keep it and stop' }, { value: 'yes', label: 'Put the starter in its place', help: 'What it says now is lost.', risk: 'cannot-be-undone' }],
          typed: { flag: '--force', switchOn: 'yes' }, optional: { default: 'no', means: 'keep it and stop' },
        })],
        sentence: 'A starter VIBE.md ({where}) is written for you to fill in, until you change it.', example: { where: 'project' },
        async run(values, ctx) {
          const shellPaths = requireShellPaths(ctx);
          const scope = values.where === 'global' ? 'global' : 'project';
          const result = step(() => initVibeFile(shellPaths, { scope, force: values.replace === 'yes' }));
          if (!result.created) throw commandRefusal(`A VIBE.md is already at ${result.path}; nothing was written.`, `Put the starter in its place: /personas vibe-create ${scope} --force`);
          return `Wrote a starter VIBE.md at ${result.path}; fill it in, then /personas vibe-import ${scope}.`;
        },
      }),
      change({
        id: 'vibe-import', label: 'Use a VIBE.md as a persona', word: 'vibe-import',
        inputs: [
          VIBE_FILE,
          textInput({ id: 'name', label: 'Name', help: 'What the persona is called', why: 'a name you choose', typed: { flag: '--name' }, optional: { default: '', means: 'the name in the file' } }),
          textInput({ id: 'description', label: 'Summary', help: 'One line on what it is for', why: 'your own words', typed: { flag: '--description' }, optional: { default: '', means: 'the summary in the file' } }),
          choiceInput({
            id: 'review', label: 'Reviewed', help: 'Whether its text may reach the prompt at once',
            choices: [{ value: 'no', label: 'Not yet' }, { value: 'yes', label: 'Reviewed now', help: 'Its text may reach the prompt.', risk: 'loosens-a-protection' }],
            typed: { flag: '--review', switchOn: 'yes' }, optional: { default: 'no', means: 'not yet' },
          }),
          USE_NOW,
        ],
        sentence: 'The VIBE.md named {where} becomes a persona of this Agent, until you change it.', example: { where: 'project' }, undoneBy: 'delete',
        async run(values, ctx) {
          const shellPaths = requireShellPaths(ctx);
          const source = step(() => loadVibeImportSource(shellPaths, values.where || 'project'));
          const store = registryFromContext(ctx);
          const persona = step(() => store.create({
            name: values.name || source.name, description: values.description || source.description, body: source.body,
            tags: ['vibe', source.scope], triggers: ['vibe'], source: 'imported', provenance: `Imported VIBE.md (${source.scope}): ${source.path}`,
          }));
          if (values.review === 'yes') step(() => store.markReviewed(persona.id));
          if (values.use === 'yes') step(() => store.setActive(persona.id));
          return [`Made persona ${persona.id} (${persona.name}) from ${source.path}`, `  reviewed ${values.review === 'yes' ? 'yes' : 'no'}`, `  in use ${values.use === 'yes' ? 'yes' : 'no'}`].join('\n');
        },
      }),
    ],
  }));
}
