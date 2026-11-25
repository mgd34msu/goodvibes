/**
 * Routines: repeatable steps the Agent runs when you ask. Managing them (see,
 * find, make, change, review, mark out of date, delete, import a routine file)
 * is the daemon's, on the one store `~/.goodvibes/agent/routines/routines.json`
 * that every Agent turn reads for its prompt. Starting one is the
 * conversation's: its steps are sent as the next message of the conversation
 * the person is in, by the program holding it.
 */
import { CapabilityRefusal, type CapabilityDefinition, type InputDescription, type ListName } from '../types.js';
import { fixedInput, pickedInput, storeCapability, storeRead, wordsInput } from './agent-stores.js';

/** Your routines, and the routine files found in your routine folders (terminal-shell's lists read them). */
export const ROUTINES_LIST = 'routines' as ListName;
export const ROUTINE_FILES_LIST = 'routines.discovered' as ListName;

const ROUTINE: InputDescription = pickedInput({ id: 'routine', label: 'Routine', help: 'Your routines', list: ROUTINES_LIST, other: 'a routine id or name' });
const OPTIONAL = (means: string) => ({ default: '', means });
const ENABLED: InputDescription = fixedInput({
  id: 'enabled', label: 'Switched on', help: 'Whether it may be started at once',
  choices: [{ value: 'no', label: 'Not yet' }, { value: 'yes', label: 'Switched on', help: 'It may run before anyone reviewed it.', risk: 'loosens-a-protection' }],
  typed: { flag: '--enabled', switchOn: 'yes' }, optional: { default: 'no', means: 'not yet' },
});
const REVIEW_OWNER_ONLY = {
  reason: 'marking a routine reviewed is your decision that it may run',
  instead: 'Ask the owner to review it in Memory and knowledge, on the routine.',
};
const words = (id: string, label: string, help: string, flag: `--${string}`, means: string, why = 'your own words'): InputDescription =>
  wordsInput({ id, label, help, why, typed: { flag }, optional: OPTIONAL(means) });

export const ROUTINES_LIST_ALL = storeRead({
  id: 'routines.list', actionId: 'list', label: 'See your routines', word: 'list',
  inputs: [fixedInput({ id: 'only', label: 'Only', help: 'Some of them', choices: [{ value: 'enabled', label: 'Switched on' }, { value: 'attention', label: 'Needing setup' }], typed: { flag: '--only' }, optional: { default: '', means: 'all of them' } })],
  sentence: 'Lists your routines: whether each is on, reviewed and ready, and how often it was started.', example: { only: 'enabled' },
});
export const ROUTINES_SHOW = storeRead({
  id: 'routines.show', actionId: 'show', label: 'See one routine', word: 'show', inputs: [ROUTINE],
  sentence: 'Shows routine {routine} in full: its steps, what it needs, and its review state.', example: { routine: 'morning-brief' },
});
export const ROUTINES_SEARCH = storeRead({
  id: 'routines.search', actionId: 'search', label: 'Find a routine', word: 'search',
  inputs: [wordsInput({ id: 'words', label: 'Words', help: 'What to look for in their names, steps and tags', why: 'your own words', typed: { tail: true } })],
  sentence: 'Lists the routines that mention {words}.', example: { words: 'invoices' },
});
export const ROUTINES_CREATE = storeCapability({
  id: 'routines.create', actionId: 'create', label: 'Make a new routine', word: 'create',
  inputs: [
    wordsInput({ id: 'name', label: 'Name', help: 'What it is called', why: 'a name you choose', typed: { flag: '--name' } }),
    wordsInput({ id: 'description', label: 'Summary', help: 'One line on what it does', why: 'your own words', typed: { flag: '--description' } }),
    wordsInput({ id: 'steps', label: 'Steps', help: 'What the Agent does, step by step', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
    words('env', 'Needs settings', 'Environment variables it needs, separated by commas', '--requires-env', 'none', 'variable names'),
    words('commands', 'Needs programs', 'Programs it needs on this machine, separated by commas', '--requires-command', 'none', 'program names'),
    words('tags', 'Tags', 'Words to find it by, separated by commas', '--tags', 'none'),
    words('triggers', 'When to suggest it', 'Words that bring it up, separated by commas', '--triggers', 'only when you ask'),
    ENABLED,
  ],
  sentence: 'A routine {name} ("{description}") is kept with the steps "{steps}", until you change it.',
  example: { name: 'morning-brief', description: 'Summarise my morning', steps: 'Read my inbox and calendar, then summarise.' },
  undoneBy: 'delete',
});
export const ROUTINES_UPDATE = storeCapability({
  id: 'routines.update', actionId: 'update', label: 'Change a routine', word: 'update',
  inputs: [
    ROUTINE,
    words('name', 'Name', 'A new name', '--name', 'keep it', 'a name you choose'),
    words('description', 'Summary', 'A new one-line summary', '--description', 'keep it'),
    wordsInput({ id: 'steps', label: 'Steps', help: 'New steps', why: 'your own words', kind: 'long-text', typed: { tail: true }, optional: OPTIONAL('keep them') }),
    words('env', 'Needs settings', 'New environment variables it needs', '--requires-env', 'keep them', 'variable names'),
    words('commands', 'Needs programs', 'New programs it needs', '--requires-command', 'keep them', 'program names'),
    words('tags', 'Tags', 'New tags', '--tags', 'keep them'),
    words('triggers', 'When to suggest it', 'New words that bring it up', '--triggers', 'keep them'),
  ],
  sentence: 'Routine {routine} takes the changes given, until you change it.', example: { routine: 'morning-brief', steps: 'Read my inbox only.' },
  repeat: 'safe',
});
export const ROUTINES_REVIEW = storeCapability({
  id: 'routines.review', actionId: 'review', label: 'Mark a routine reviewed', word: 'review', inputs: [ROUTINE],
  sentence: 'Routine {routine} is marked reviewed, so it may be switched on and run, until you change it.', example: { routine: 'morning-brief' },
  risk: 'loosens-a-protection', ownerOnly: REVIEW_OWNER_ONLY, undoneBy: 'stale', repeat: 'safe',
});
export const ROUTINES_STALE = storeCapability({
  id: 'routines.stale', actionId: 'stale', label: 'Mark a routine out of date', word: 'stale',
  inputs: [ROUTINE, wordsInput({ id: 'reason', label: 'Why', help: 'What is out of date', why: 'your own words', kind: 'long-text', typed: { tail: true } })],
  sentence: 'Routine {routine} is marked out of date because "{reason}", until you change it.', example: { routine: 'morning-brief', reason: 'the inbox moved' }, repeat: 'safe',
});
export const ROUTINES_DELETE = storeCapability({
  id: 'routines.delete', actionId: 'delete', label: 'Delete a routine', word: 'delete', inputs: [ROUTINE],
  sentence: 'Routine {routine} is removed from this Agent.', example: { routine: 'morning-brief' }, risk: 'cannot-be-undone', repeat: 'safe',
});
export const ROUTINES_DISCOVER = storeRead({
  id: 'routines.discover', actionId: 'discover', label: 'See routine files you could import', word: 'discover', inputs: [],
  sentence: 'Lists the routine Markdown files in this project\'s and your own routine folders.', example: {},
});
export const ROUTINES_IMPORT = storeCapability({
  id: 'routines.import', actionId: 'import', label: 'Import a routine file', word: 'import',
  inputs: [pickedInput({ id: 'file', label: 'Routine file', help: 'Routine files found in your routine folders', list: ROUTINE_FILES_LIST, other: 'a routine file name or path' }), ENABLED],
  sentence: 'The routine in {file} is added to this Agent, not yet reviewed, until you change it.', example: { file: 'morning-brief' }, undoneBy: 'delete',
});

/** The times a routine was put on a schedule (terminal-shell's list reads them from routines.receipts). */
export const ROUTINE_RECEIPTS_LIST = 'routines.receipts' as ListName;

export const ROUTINES_ENABLE = storeCapability({
  id: 'routines.enable', actionId: 'enable', label: 'Switch a routine on', word: 'enable', inputs: [ROUTINE], group: 'automation',
  sentence: 'Routine {routine} is switched on: it may be started and run on its schedule, until you switch it off.', example: { routine: 'morning-brief' },
  // A routine switched on may run by itself; a model's call is put to the owner.
  risk: 'loosens-a-protection', undoneBy: 'disable', repeat: 'safe',
});
export const ROUTINES_DISABLE = storeCapability({
  id: 'routines.disable', actionId: 'disable', label: 'Switch a routine off', word: 'disable', inputs: [ROUTINE], group: 'automation',
  sentence: 'Routine {routine} is switched off: it is not started, until you switch it on.', example: { routine: 'morning-brief' }, undoneBy: 'enable', repeat: 'safe',
});
export const ROUTINES_PROMOTE = storeCapability({
  id: 'routines.promote', actionId: 'promote', label: 'Run a routine on a schedule', word: 'promote', group: 'automation',
  inputs: [
    { ...ROUTINE, step: 1 },
    fixedInput({ id: 'how', label: 'When', help: 'How you say when it runs', choices: [{ value: 'cron', label: 'On a calendar pattern', help: 'Five cron fields, such as 0 9 * * 1-5' }, { value: 'every', label: 'Every so often', help: 'An interval such as 15m, 2h or 1d' }, { value: 'at', label: 'Once, at a date and time', help: 'Such as 2026-12-01T09:00' }], typed: { flag: '--how' }, step: 2 }),
    wordsInput({ id: 'when', label: 'Timing', help: 'The pattern, interval or date and time', why: 'a cron pattern, an interval or a date', typed: { flag: '--when' }, step: 2 }),
    wordsInput({ id: 'tz', label: 'Time zone', help: 'For a calendar pattern', why: 'a time zone such as Europe/Vienna', typed: { flag: '--timezone' }, optional: OPTIONAL('the daemon\'s'), step: 2 }),
    wordsInput({ id: 'channel', label: 'To a channel', help: 'A channel such as slack or telegram:123, one per line', why: 'a channel as configuration writes it', kind: 'long-text', typed: { flag: '--delivery-channel', repeats: true }, optional: OPTIONAL('none'), step: 3 }),
    wordsInput({ id: 'route', label: 'To a route', help: 'Delivery route ids, one per line', why: 'a route id', kind: 'long-text', typed: { flag: '--delivery-route', repeats: true }, optional: OPTIONAL('none'), step: 3 }),
    wordsInput({ id: 'webhook', label: 'To a web address', help: 'Webhook addresses, one per line', why: 'a web address', kind: 'long-text', typed: { flag: '--delivery-webhook', repeats: true }, optional: OPTIONAL('none'), step: 3 }),
    wordsInput({ id: 'link', label: 'To a linked surface', help: 'Linked surfaces such as web, one per line', why: 'a linked surface', kind: 'long-text', typed: { flag: '--delivery-link', repeats: true }, optional: OPTIONAL('none'), step: 3 }),
    wordsInput({ id: 'name', label: 'Schedule name', help: 'What the schedule is called', why: 'a name you choose', typed: { flag: '--name' }, optional: OPTIONAL('the routine\'s name'), step: 4 }),
    wordsInput({ id: 'provider', label: 'Provider', help: 'The provider a run uses', why: 'a provider id', typed: { flag: '--provider' }, optional: OPTIONAL('the daemon\'s usual'), step: 4 }),
    wordsInput({ id: 'model', label: 'Model', help: 'The model a run uses', why: 'a model id', typed: { flag: '--model' }, optional: OPTIONAL('the daemon\'s usual'), step: 4 }),
    fixedInput({ id: 'paused', label: 'Start paused', help: 'Kept, but runs only once resumed', choices: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }], typed: { flag: '--disabled', switchOn: 'yes' }, optional: { default: 'no', means: 'no' }, step: 4 }),
  ],
  sentence: 'Routine {routine} runs on a schedule ({how}: {when}), by itself, whether or not a terminal program is open, until you change it.',
  example: { routine: 'morning-brief', how: 'cron', when: '0 9 * * 1-5' },
});
export const ROUTINES_RECEIPTS = storeRead({
  id: 'routines.receipts', actionId: 'receipts', label: 'See routines put on a schedule', word: 'receipts', inputs: [], group: 'automation',
  sentence: 'Lists every time a routine was put on a schedule, and how it went.', example: {},
});
export const ROUTINES_RECEIPT = storeRead({
  id: 'routines.receipt', actionId: 'receipt', label: 'See one schedule receipt', word: 'receipt', group: 'automation',
  inputs: [pickedInput({ id: 'receipt', label: 'Receipt', help: 'Times a routine was put on a schedule', list: ROUTINE_RECEIPTS_LIST })],
  sentence: 'Shows schedule receipt {receipt}: what was asked for and what was answered.', example: { receipt: 'routine-schedule-morning-brief-20261201' },
});
export const ROUTINES_RECONCILE = storeRead({
  id: 'routines.reconcile', actionId: 'reconcile', label: 'Check scheduled routines against their schedules', word: 'reconcile', inputs: [], group: 'automation',
  sentence: 'Compares the routines put on a schedule with the schedules that exist now, and retires the receipts of schedules that are gone.', example: {},
});

export const ROUTINES_CAPABILITIES = [
  ROUTINES_LIST_ALL, ROUTINES_SHOW, ROUTINES_SEARCH, ROUTINES_CREATE, ROUTINES_UPDATE, ROUTINES_REVIEW, ROUTINES_STALE, ROUTINES_DELETE,
  ROUTINES_DISCOVER, ROUTINES_IMPORT, ROUTINES_ENABLE, ROUTINES_DISABLE, ROUTINES_PROMOTE, ROUTINES_RECEIPTS, ROUTINES_RECEIPT, ROUTINES_RECONCILE,
] as const;

/** A routine as starting it reads it. */
export interface StartedRoutine {
  readonly id: string;
  readonly name: string;
  readonly steps: string;
  /** "ready", or what it still needs. */
  readonly readiness: string;
}

/** What starting a routine needs: the routine marked started, and the conversation its steps are sent to. */
export interface RoutineStartServices {
  readonly routines?: { start(routine: string): Promise<StartedRoutine> } | undefined;
  /**
   * Sends the steps as the person's next message. Absent for a model's call: the model reads the steps as its
   * answer and works through them in the turn it is in, so the answer is the start.
   */
  readonly send?: ((message: string) => void) | undefined;
}

/** Starting a routine: its steps become the next message of this conversation. */
export const ROUTINES_START: CapabilityDefinition<RoutineStartServices> = {
  capability: { id: 'routines.start', group: 'memory', home: 'session', repeat: 'unsafe' },
  actionId: 'start', label: 'Run a routine now', word: 'start', inputs: [ROUTINE],
  sentence: 'Runs routine {routine} now: its steps are sent as your next message in this conversation.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { routine: 'morning-brief' },
  async run(values, services) {
    if (!services.routines) throw new CapabilityRefusal('Not started: this program has no conversation to send a routine\'s steps to.', 'Start it from the conversation in the terminal app or the Agent.');
    const routine = await services.routines.start(values.routine!);
    if (!services.send) {
      return {
        text: [`Started routine ${routine.id} (${routine.name})`, `  readiness: ${routine.readiness}`, '  the same conversation; no hidden job, setting change or outside action was started', '', routine.steps].join('\n'),
        data: { routine: routine.id, steps: routine.steps },
      };
    }
    services.send(`Run Agent routine ${routine.name} (${routine.id}).\n\n${routine.steps}`);
    return {
      text: [`Started routine ${routine.id}: its steps were sent as your next message (after the current turn, if one is running).`, `  readiness: ${routine.readiness}`].join('\n'),
      data: { routine: routine.id },
    };
  },
};
