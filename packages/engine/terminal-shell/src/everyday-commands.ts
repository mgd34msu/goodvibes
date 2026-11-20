/**
 * The everyday conversation commands, each a single-action command
 * (command-actions/) whose line is its name and, where it takes one, a word:
 * `/undo`, `/redo`, `/retry`, `/title`, `/compact`. Both terminal apps
 * register these descriptions; what each does is the app's policy, read by
 * the action's `run`.
 */
import { commandRefusal } from './command-confirmation.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import { choiceInput, doAction, textInput } from './described-command-kit.js';
import type { ActionValues, CommandActionContext, FixedChoice } from './command-actions/types.js';

type Run<Ctx> = (values: ActionValues, ctx: Ctx) => Promise<string | void>;

const TERMINAL = { terminalOnly: 'It is the terminal app\'s open conversation.' } as const;

/** What `/undo` and `/redo` can take back: the default is the last turn. */
function stepChoices(undo: boolean, rewind: boolean): readonly FixedChoice[] {
  return [
    { value: 'turn', label: undo ? 'The last turn' : 'The turn undone last', help: undo ? 'Your last message and its answer' : 'Your message and its answer come back' },
    { value: 'file', label: undo ? 'The last file change' : 'The file change undone last', help: undo ? 'Every file the last write or edit changed goes back' : 'The files it changed are written again' },
    { value: 'set-aside', label: 'Set aside a blocked file change', help: 'A later change blocks it; set it aside without changing a file' },
    ...(rewind ? [{ value: 'rewind', label: undo ? 'The last rewind' : 'The rewind undone last', help: undo ? 'The conversation and files go back to before it' : 'It is applied again' }] : []),
  ];
}

/**
 * `/undo` and `/redo` for one app. `rewind` is whether this app can undo a
 * rewind; the choice is offered in both, and refused with the reason where it
 * is not.
 */
export function createUndoCommands<Ctx extends CommandActionContext>(policy: {
  readonly undo: Run<Ctx>;
  readonly redo: Run<Ctx>;
}): { readonly undo: DescribedCommand<Ctx>; readonly redo: DescribedCommand<Ctx> } {
  const make = (undo: boolean): DescribedCommand<Ctx> => defineCommand<Ctx>({
    name: undo ? 'undo' : 'redo',
    title: undo ? 'Undo' : 'Redo',
    summary: undo ? 'Take back the last turn, file change or rewind' : 'Bring back what was undone last',
    group: 'Conversation',
    actions: [doAction<Ctx>({
        id: undo ? 'undo' : 'redo', label: undo ? 'Undo the last step' : 'Redo the step undone last', word: '',
        inputs: [choiceInput({ id: 'what', label: 'What', help: undo ? 'What to take back' : 'What to bring back', choices: stepChoices(undo, true), typed: { position: 1 }, optional: { default: 'turn', means: undo ? 'the last turn' : 'the turn undone last' } })],
        sentence: undo ? 'The last step of the kind chosen is taken back; /redo brings it back.' : 'The step of the kind chosen that was undone last is brought back.',
        operator: TERMINAL, example: { what: 'file' },
        run: undo ? policy.undo : policy.redo,
      })],
  });
  return { undo: make(true), redo: make(false) };
}

/** `/retry [changed message]`: send the last message again, as it was or changed. */
export function createRetryCommand<Ctx extends CommandActionContext>(run: Run<Ctx>): DescribedCommand<Ctx> {
  return defineCommand<Ctx>({
    name: 'retry', leadingFlagsOnly: true, title: 'Ask again', summary: 'Send your last message again, as it was or changed', group: 'Conversation',
    actions: [doAction<Ctx>({
      id: 'retry', label: 'Send the last message again', word: '',
      inputs: [textInput({ id: 'message', label: 'Changed message', help: 'What to send instead', why: 'your own words', kind: 'long-text', typed: { tail: true }, optional: { default: '', means: 'the last message as it was' } })],
      sentence: 'Your last message is sent again (changed, when you typed a new one) and answered as a new turn.',
      operator: TERMINAL, example: { message: 'shorter please' }, run,
    })],
  });
}

/** `/title [text]`: show the conversation's title, or give it one. */
export function createTitleCommand<Ctx extends CommandActionContext>(run: Run<Ctx>): DescribedCommand<Ctx> {
  return defineCommand<Ctx>({
    name: 'title', leadingFlagsOnly: true, title: 'Conversation title', summary: 'See or change the conversation\'s title', group: 'Conversation',
    actions: [{
      id: 'title', label: 'Name this conversation', word: '',
      inputs: [textInput({ id: 'text', label: 'Title', help: 'Its new title', why: 'your own words', typed: { tail: true }, optional: { default: '', means: 'show the title it has' } })],
      sentence: 'This conversation will be titled as typed (with nothing typed, its title is shown) until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: TERMINAL, example: { text: 'release notes' }, run,
    }],
  });
}

/** `/compact`: summarise the older part of the conversation to free the context window. */
export function createCompactCommand<Ctx extends CommandActionContext>(run: Run<Ctx>): DescribedCommand<Ctx> {
  return defineCommand<Ctx>({
    name: 'compact', title: 'Compact the conversation', summary: 'Summarise the older part of the conversation to free the context window', group: 'Conversation',
    actions: [doAction<Ctx>({
      id: 'compact', label: 'Compact the conversation now', word: '',
      sentence: 'The older messages are replaced by a summary, so the model has room again; /session compactions lists what each compaction removed.',
      operator: TERMINAL, run,
    })],
  });
}

/** The refusal an everyday command gives while a turn runs. */
export function refuseWhileTurnRuns(ctx: { readonly isGenerating?: (() => boolean) | undefined }, command: string): void {
  if (ctx.isGenerating?.()) throw commandRefusal(`A turn is still running, so ${command} did nothing.`, `Stop it with Esc or let it finish, then ${command}.`);
}
