/**
 * How the Agent talks and behaves: personas, the one in use, and VIBE.md
 * personality files. The personas are one store, `~/.goodvibes/agent/personas/
 * personas.json`, managed by the daemon; every Agent turn (in the Agent and in
 * a session the daemon hosts for it) reads the one in use, and the VIBE.md
 * files, for its prompt.
 */
import { REPLACED_DONE, type InputDescription, type ListName } from '../types.js';
import { fixedInput, pickedInput, storeCapability, storeRead, wordsInput } from './agent-stores.js';

/** Your personas, and the persona files found in your persona folders (terminal-shell's lists read them). */
export const PERSONAS_LIST = 'personas' as ListName;
export const PERSONA_FILES_LIST = 'personas.discovered' as ListName;

const PERSONA: InputDescription = pickedInput({ id: 'persona', label: 'Persona', help: 'Your personas', list: PERSONAS_LIST, other: 'a persona id or name' });
const WHERE: InputDescription = fixedInput({
  id: 'where', label: 'Which VIBE.md', help: 'The project\'s, or your own',
  choices: [{ value: 'project', label: 'This project\'s' }, { value: 'global', label: 'Your own, for every project' }],
  typed: { position: 1 }, optional: { default: 'project', means: 'this project\'s' },
});
/** A VIBE.md to read: the project's, your own, or one at a path. */
const VIBE_FILE: InputDescription = wordsInput({
  id: 'where', label: 'Which VIBE.md', help: 'project, global (your own), or the path of a VIBE.md file', why: 'project, global, or a file path',
  typed: { tail: true }, optional: { default: 'project', means: 'this project\'s' },
});
const USE_NOW: InputDescription = fixedInput({
  id: 'use', label: 'Use it now', help: 'Whether the Agent starts using it', choices: [{ value: 'no', label: 'Not yet' }, { value: 'yes', label: 'Use it now' }],
  typed: { flag: '--use', switchOn: 'yes' }, optional: { default: 'no', means: 'not yet' },
});
const REVIEW_OWNER_ONLY = {
  reason: 'marking a persona reviewed is your decision that its text may reach the prompt',
  instead: 'Ask the owner to review it in Memory and knowledge, on the persona.',
};
const words = (id: string, label: string, help: string, flag: `--${string}`, means: string, why = 'your own words'): InputDescription =>
  wordsInput({ id, label, help, why, typed: { flag }, optional: { default: '', means } });

export const PERSONAS_LIST_ALL = storeRead({
  id: 'personas.list', actionId: 'list', label: 'See your personas', word: 'list', inputs: [],
  sentence: 'Lists your personas: which is in use, which you reviewed, and what each is for.', example: {},
});
export const PERSONAS_ACTIVE = storeRead({
  id: 'personas.active', actionId: 'active', label: 'See the persona in use', word: 'active', inputs: [],
  sentence: 'Shows the persona the Agent uses now, in full.', example: {},
});
export const PERSONAS_SHOW = storeRead({
  id: 'personas.show', actionId: 'show', label: 'See one persona', word: 'show', inputs: [PERSONA],
  sentence: 'Shows persona {persona} in full: its text, review state, tags and where it came from.', example: { persona: 'editor' },
});
export const PERSONAS_SEARCH = storeRead({
  id: 'personas.search', actionId: 'search', label: 'Find a persona', word: 'search',
  inputs: [wordsInput({ id: 'words', label: 'Words', help: 'What to look for in their names, text and tags', why: 'your own words', typed: { tail: true } })],
  sentence: 'Lists the personas that mention {words}.', example: { words: 'editor' },
});
export const PERSONAS_CREATE = storeCapability({
  id: 'personas.create', actionId: 'create', label: 'Make a persona for how the Agent talks', word: 'create',
  inputs: [
    wordsInput({ id: 'name', label: 'Name', help: 'What it is called', why: 'a name you choose', typed: { flag: '--name' } }),
    wordsInput({ id: 'description', label: 'Summary', help: 'One line on what it is for', why: 'your own words', typed: { flag: '--description' } }),
    wordsInput({ id: 'body', label: 'Instructions', help: 'How the Agent talks and behaves with it', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
    words('tags', 'Tags', 'Words to find it by, separated by commas', '--tags', 'none'),
    words('triggers', 'When to suggest it', 'Words that bring it up, separated by commas', '--triggers', 'never on its own'),
  ],
  sentence: 'A persona {name} ("{description}"), how the Agent talks and behaves, is kept with the instructions "{body}", until you change it.',
  example: { name: 'editor', description: 'A careful copy editor', body: 'Edit for clarity; keep the author\'s voice.' },
  undoneBy: 'delete',
});
export const PERSONAS_UPDATE = storeCapability({
  id: 'personas.update', actionId: 'update', label: 'Change a persona', word: 'update',
  inputs: [
    PERSONA,
    words('name', 'Name', 'A new name', '--name', 'keep it', 'a name you choose'),
    words('description', 'Summary', 'A new one-line summary', '--description', 'keep it'),
    wordsInput({ id: 'body', label: 'Instructions', help: 'New instructions', why: 'your own words', kind: 'long-text', typed: { tail: true }, optional: { default: '', means: 'keep them' } }),
    words('tags', 'Tags', 'New tags, separated by commas', '--tags', 'keep them'),
    words('triggers', 'When to suggest it', 'New words that bring it up', '--triggers', 'keep them'),
  ],
  sentence: 'Persona {persona} takes the changes given, until you change it.', example: { persona: 'editor', description: 'A strict copy editor' },
  repeat: 'safe',
});
export const PERSONAS_USE = storeCapability({
  id: 'personas.use', actionId: 'use', label: 'Switch to a persona', word: 'use', inputs: [PERSONA],
  sentence: 'The Agent switches to persona {persona} and talks and behaves as it, until you change it.', example: { persona: 'editor' }, undoneBy: 'stop-using', repeat: 'safe',
});
export const PERSONAS_STOP_USING = storeCapability({
  id: 'personas.stop-using', actionId: 'stop-using', label: 'Stop using a persona', word: 'stop-using', inputs: [],
  sentence: 'The Agent uses no persona, until you change it.', example: {}, undoneBy: 'use', repeat: 'safe',
});
export const PERSONAS_REVIEW = storeCapability({
  id: 'personas.review', actionId: 'review', label: 'Mark a persona reviewed', word: 'review', inputs: [PERSONA],
  sentence: 'Persona {persona} is marked reviewed, so its text may reach the prompt, until you change it.', example: { persona: 'editor' },
  risk: 'loosens-a-protection', ownerOnly: REVIEW_OWNER_ONLY, undoneBy: 'stale', repeat: 'safe',
});
export const PERSONAS_STALE = storeCapability({
  id: 'personas.stale', actionId: 'stale', label: 'Mark a persona out of date', word: 'stale',
  inputs: [PERSONA, wordsInput({ id: 'reason', label: 'Why', help: 'What is out of date', why: 'your own words', kind: 'long-text', typed: { tail: true } })],
  sentence: 'Persona {persona} is marked out of date because "{reason}", until you change it.', example: { persona: 'editor', reason: 'the style guide changed' }, repeat: 'safe',
});
export const PERSONAS_DELETE = storeCapability({
  id: 'personas.delete', actionId: 'delete', label: 'Delete a persona', word: 'delete', inputs: [PERSONA],
  sentence: 'Persona {persona} is removed from this Agent.', example: { persona: 'editor' }, risk: 'cannot-be-undone', repeat: 'safe',
});
export const PERSONAS_DISCOVER = storeRead({
  id: 'personas.discover', actionId: 'discover', label: 'See persona files you could import', word: 'discover', inputs: [],
  sentence: 'Lists the persona Markdown files in this project\'s and your own persona folders.', example: {},
});
export const PERSONAS_IMPORT = storeCapability({
  id: 'personas.import', actionId: 'import', label: 'Import a persona file', word: 'import',
  inputs: [pickedInput({ id: 'file', label: 'Persona file', help: 'Persona files found in your persona folders', list: PERSONA_FILES_LIST, other: 'a persona file name or path' }), USE_NOW],
  sentence: 'The persona in {file} is added to this Agent, not yet reviewed, until you change it.', example: { file: 'editor' }, undoneBy: 'delete',
});
export const PERSONAS_VIBE = storeRead({
  id: 'personas.vibe', actionId: 'vibe', label: 'See your VIBE.md files', word: 'vibe', inputs: [],
  sentence: 'Shows the VIBE.md personality files that apply, any that are blocked, and where new ones go.', example: {},
});
export const PERSONAS_VIBE_SHOW = storeRead({
  id: 'personas.vibe-show', actionId: 'vibe-show', label: 'Read a VIBE.md', word: 'vibe-show', inputs: [VIBE_FILE],
  sentence: 'Shows the VIBE.md named {where}, in full.', example: { where: 'global' },
});
export const PERSONAS_VIBE_CREATE = storeCapability({
  id: 'personas.vibe-create', actionId: 'vibe-create', label: 'Make a VIBE.md', word: 'vibe-create',
  inputs: [WHERE, fixedInput({
    id: 'replace', label: 'If one is there', help: 'Keep it, or put the starter in its place',
    choices: [{ value: 'no', label: 'Keep it and stop' }, { value: 'yes', label: 'Put the starter in its place', help: 'What it says now is lost.', risk: 'cannot-be-undone', riskDone: REPLACED_DONE }],
    typed: { flag: '--force', switchOn: 'yes' }, optional: { default: 'no', means: 'keep it and stop' },
  })],
  sentence: 'A starter VIBE.md personality file ({where}) is written for you to fill in, until you change it.', example: { where: 'project' }, repeat: 'safe',
});
export const PERSONAS_VIBE_IMPORT = storeCapability({
  id: 'personas.vibe-import', actionId: 'vibe-import', label: 'Use a VIBE.md as a persona', word: 'vibe-import',
  inputs: [
    VIBE_FILE,
    words('name', 'Name', 'What the persona is called', '--name', 'the name in the file', 'a name you choose'),
    words('description', 'Summary', 'One line on what it is for', '--description', 'the summary in the file'),
    fixedInput({
      id: 'review', label: 'Reviewed', help: 'Whether its text may reach the prompt at once',
      choices: [{ value: 'no', label: 'Not yet' }, { value: 'yes', label: 'Reviewed now', help: 'Its text may reach the prompt.', risk: 'loosens-a-protection' }],
      typed: { flag: '--review', switchOn: 'yes' }, optional: { default: 'no', means: 'not yet' },
    }),
    USE_NOW,
  ],
  sentence: 'The VIBE.md named {where} becomes a persona of this Agent, until you change it.', example: { where: 'project' }, undoneBy: 'delete',
});

export const PERSONAS_CAPABILITIES = [
  PERSONAS_LIST_ALL, PERSONAS_ACTIVE, PERSONAS_SHOW, PERSONAS_SEARCH, PERSONAS_CREATE, PERSONAS_UPDATE, PERSONAS_USE, PERSONAS_STOP_USING,
  PERSONAS_REVIEW, PERSONAS_STALE, PERSONAS_DELETE, PERSONAS_DISCOVER, PERSONAS_IMPORT, PERSONAS_VIBE, PERSONAS_VIBE_SHOW,
  PERSONAS_VIBE_CREATE, PERSONAS_VIBE_IMPORT,
] as const;
