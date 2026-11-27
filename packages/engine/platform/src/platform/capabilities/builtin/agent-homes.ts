/**
 * Agent homes, kept by the daemon (terminal-shell agent-turn/agent-homes.ts, run by its store runner): separate homes
 * of the Agent, each with its own settings, sessions, memory, notes, personas, skills and routines, which one the
 * Agent starts in next, and the starter templates a home is made from. The same files the Agent reads when it starts
 * (`~/.goodvibes/agent/profile-homes/`, `profile-selection.json`, `profile-starters/`), so nothing is carried: a 3.5.0
 * Agent sees every home, starter and choice made here.
 */
import { REPLACED_DONE, type InputDescription, type ListName } from '../types.js';
import { fixedInput, pickedInput, storeCapability, storeRead, wordsInput } from './agent-stores.js';

export const AGENT_HOMES_LIST = 'agent-home.homes' as ListName;
export const AGENT_STARTERS_LIST = 'agent-home.starters' as ListName;

const OPTIONAL = (means: string) => ({ default: '', means });
const HOME: InputDescription = pickedInput({ id: 'home', label: 'Home', help: 'Your Agent homes', list: AGENT_HOMES_LIST, other: 'an Agent home name' });
const NAME: InputDescription = wordsInput({ id: 'name', label: 'Name', help: 'A short name for the home', why: 'a name you choose', typed: { position: 1 } });
const STARTER: InputDescription = pickedInput({ id: 'starter', label: 'Starter', help: 'Built-in and your own starter templates', list: AGENT_STARTERS_LIST, other: 'a starter id' });
const PATH: InputDescription = wordsInput({ id: 'path', label: 'File', help: 'A starter JSON file, in your project unless the path says otherwise', why: 'a file on this machine', kind: 'path', typed: { position: 2 } });
const REPLACE_STARTER: InputDescription = fixedInput({
  id: 'replace', label: 'If a starter has that id', help: 'One of your starters may already use it',
  choices: [{ value: 'no', label: 'Stop and say so' }, { value: 'yes', label: 'Replace it', help: 'What it holds now is lost.', risk: 'cannot-be-undone', riskDone: REPLACED_DONE }],
  typed: { flag: '--replace', switchOn: 'yes' }, optional: { default: 'no', means: 'stop and say so' },
});
const VIBE: InputDescription = fixedInput({
  id: 'vibe', label: 'VIBE.md', help: 'Whether the personality file goes in too',
  choices: [{ value: 'no', label: 'Leave it out' }, { value: 'yes', label: 'Include it' }],
  typed: { flag: '--include-vibe', switchOn: 'yes' }, optional: { default: 'no', means: 'leave it out' },
});
/** What a starter made from this Agent's learned behaviour takes, beyond its id. */
const LEARNED: readonly InputDescription[] = [
  wordsInput({ id: 'title', label: 'Display name', help: 'The name it shows', why: 'a name you choose', typed: { flag: '--name' }, optional: OPTIONAL('its id') }),
  wordsInput({ id: 'description', label: 'Description', help: 'One line on what it is for', why: 'your own words', typed: { flag: '--description' }, optional: OPTIONAL('a description made from what it holds') }),
  wordsInput({ id: 'persona', label: 'Persona', help: 'The persona file it starts with', why: 'a persona file name', typed: { flag: '--persona' }, optional: OPTIONAL('the first persona file found') }),
  wordsInput({ id: 'skills', label: 'Skills', help: 'all, or skill names separated by commas', why: 'skill names', typed: { flag: '--skills' }, optional: OPTIONAL('every skill file found') }),
  wordsInput({ id: 'routines', label: 'Routines', help: 'all, or routine names separated by commas', why: 'routine names', typed: { flag: '--routines' }, optional: OPTIONAL('every routine file found') }),
  VIBE,
  REPLACE_STARTER,
];

export const AGENT_HOMES_LIST_ALL = storeRead({
  id: 'agent-home.list', actionId: 'list', label: 'See your Agent homes', word: 'list', inputs: [],
  sentence: 'Lists your Agent homes, their folders, and which one the Agent starts in next.', example: {},
});

export const AGENT_HOMES_SHOW = storeRead({
  id: 'agent-home.show', actionId: 'show', label: 'See one Agent home', word: 'show', inputs: [HOME],
  sentence: 'Shows home {home}: its folder, the starter it was made from, and how to launch it.', example: { home: 'research' },
});

export const AGENT_HOMES_NEXT = storeRead({
  id: 'agent-home.next', actionId: 'next', label: 'See which Agent home starts next', word: 'next', inputs: [],
  sentence: 'Says which Agent home the next launch of the Agent starts in.', example: {},
});

export const AGENT_HOMES_USE = storeCapability({
  id: 'agent-home.use', actionId: 'use', label: 'Start the Agent in a home from now on', word: 'use', inputs: [HOME],
  sentence: 'Every launch of the Agent starts in home {home}, until you change it.', example: { home: 'research' }, undoneBy: 'use-base', repeat: 'safe',
});

export const AGENT_HOMES_USE_BASE = storeCapability({
  id: 'agent-home.use-base', actionId: 'use-base', label: 'Start the Agent in its base home from now on', word: 'use-base', inputs: [],
  sentence: 'Every launch of the Agent starts in its base home, until you change it.', example: {}, undoneBy: 'use', repeat: 'safe',
});

export const AGENT_HOMES_CREATE = storeCapability({
  id: 'agent-home.create', actionId: 'create', label: 'Make a separate Agent home', word: 'create',
  inputs: [NAME, { ...STARTER, required: { default: '', defaultMeans: 'an empty home' }, typed: { flag: '--starter' } }],
  sentence: 'A new Agent home {name} (for research, travel, the household, operations or anything else) is made, from the starter given, until you change it.', example: { name: 'research', starter: 'research' }, undoneBy: 'delete',
});

export const AGENT_HOMES_CREATE_LEARNED = storeCapability({
  id: 'agent-home.create-learned', actionId: 'create-learned', label: 'Make an Agent home from what the Agent has learned', word: 'create-learned',
  inputs: [NAME, wordsInput({ id: 'starter', label: 'Starter id', help: 'The id of the starter made for it', why: 'an id you choose', typed: { flag: '--starter-id' }, optional: OPTIONAL('the home\'s name') }), ...LEARNED],
  sentence: 'A starter is made from the persona, skill and routine files found (and VIBE.md, if chosen), and a new home {name} is made from it, until you change it.',
  example: { name: 'research', skills: 'all' }, undoneBy: 'delete',
});

export const AGENT_HOMES_DELETE = storeCapability({
  id: 'agent-home.delete', actionId: 'delete', label: 'Delete an Agent home', word: 'delete', inputs: [HOME],
  sentence: 'Home {home} and everything in it (settings, sessions, memory, notes, personas, skills, routines) are deleted.', example: { home: 'research' },
  risk: 'cannot-be-undone', repeat: 'safe',
});

export const AGENT_HOMES_STARTERS = storeRead({
  id: 'agent-home.starters', actionId: 'starters', label: 'See Agent home starter templates', word: 'starters', inputs: [],
  sentence: 'Lists the built-in and your own starter templates, with the persona, skills and routines each brings.', example: {},
});

export const AGENT_HOMES_STARTER = storeRead({
  id: 'agent-home.starter', actionId: 'starter', label: 'See one starter template', word: 'starter', inputs: [STARTER],
  sentence: 'Shows starter {starter}: its persona, skills, routines and whether it brings VIBE.md.', example: { starter: 'research' },
});

export const AGENT_HOMES_GUIDE = storeRead({
  id: 'agent-home.guide', actionId: 'guide', label: 'Read how to write a starter template', word: 'guide', inputs: [],
  sentence: 'Shows the steps to save a starter to a file, change it, add it back and make an Agent home from it.', example: {},
});

export const AGENT_HOMES_EXPORT_STARTER = storeCapability({
  id: 'agent-home.export-starter', actionId: 'export-starter', label: 'Save a starter template to a file', word: 'export-starter',
  inputs: [STARTER, { ...PATH, file: 'written' }, VIBE, fixedInput({
    id: 'overwrite', label: 'If the file exists', help: 'Keep it, or write over it',
    choices: [{ value: 'no', label: 'Keep it and stop' }, { value: 'yes', label: 'Write over it', risk: 'cannot-be-undone', riskDone: REPLACED_DONE }],
    typed: { flag: '--overwrite', switchOn: 'yes' }, optional: { default: 'no', means: 'keep it and stop' },
  })],
  // A file outside the project, named by anyone but the person, is refused at every door before the owner is asked
  // (capabilities/path-inputs.ts), and again where the file is written.
  sentence: 'Starter {starter} is written to {path} to change and add back, until you change it.', example: { starter: 'research', path: 'agent-starter.json' },
});

export const AGENT_HOMES_IMPORT_STARTER = storeCapability({
  id: 'agent-home.import-starter', actionId: 'import-starter', label: 'Add a starter template from a file', word: 'import-starter',
  inputs: [{ ...PATH, typed: { position: 1 } }, REPLACE_STARTER],
  sentence: 'The starter in {path} is added to your starter templates, until you change it.', example: { path: 'agent-starter.json' },
});

export const AGENT_HOMES_STARTER_LEARNED = storeCapability({
  id: 'agent-home.starter-learned', actionId: 'starter-learned', label: 'Make a starter template from what the Agent has learned', word: 'starter-learned',
  inputs: [wordsInput({ id: 'starter', label: 'Starter id', help: 'The id of the new starter', why: 'an id you choose', typed: { position: 1 } }), ...LEARNED],
  sentence: 'Starter {starter} is made from the persona, skill and routine files found (and VIBE.md, if chosen), until you change it.', example: { starter: 'my-research', skills: 'all' },
});

export const AGENT_HOMES_CAPABILITIES = [
  AGENT_HOMES_LIST_ALL, AGENT_HOMES_SHOW, AGENT_HOMES_NEXT, AGENT_HOMES_USE, AGENT_HOMES_USE_BASE, AGENT_HOMES_CREATE, AGENT_HOMES_CREATE_LEARNED,
  AGENT_HOMES_DELETE, AGENT_HOMES_STARTERS, AGENT_HOMES_STARTER, AGENT_HOMES_GUIDE, AGENT_HOMES_EXPORT_STARTER, AGENT_HOMES_IMPORT_STARTER,
  AGENT_HOMES_STARTER_LEARNED,
] as const;
