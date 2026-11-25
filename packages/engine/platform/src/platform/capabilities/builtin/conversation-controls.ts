/**
 * The controls on the conversation itself: the turn (redo, send again, its
 * title), its record (save it, save it as a file, branch it, fold its blocks,
 * what compaction removed), what fills its context, how hard its model thinks,
 * the guidance about it, the composer (the editor, an image, pastes, the queue)
 * and the workspace checkpoints a turn takes. They act on the live
 * conversation, the terminal's own screen or the project files a turn
 * changed, so they run in the program holding the conversation (home
 * `session`), with that program's own services handed in. Each service is the
 * program's: absent where the program has no such thing, and the capability
 * then says so in one line. Nothing here reaches a screen; the program draws
 * what changed.
 */
import { CapabilityRefusal, REPLACED_DONE, type CapabilityDefinition, type FixedChoice, type InputDescription, type ListName } from '../types.js';
import type { LiveConversation, UndoServices } from './conversation.js';
import type { SessionsCapabilityServices } from './sessions.js';

// ---------------------------------------------------------------------------
// What the program holding the conversation hands in
// ---------------------------------------------------------------------------

/** The turn: redo, the last message, sending, the title. */
export interface ConversationTurns {
  /** Bring back the turn undone last; false when there is none. */
  redoTurn(): boolean;
  /** The person's last message, or null when there is none. */
  lastUserMessage(): string | null;
  /** Send a message as a new turn; undefined where this program cannot send one. */
  readonly send: ((message: string) => void) | undefined;
  /** Whether sending the last message again first takes back the turn it had (the Agent). */
  readonly retryRemovesLastTurn: boolean;
  title(): string;
  setTitle(text: string): void;
}

/** The conversation's record: saved under a name, written as a file, branched, its blocks, its compactions. */
export interface ConversationRecord {
  /** Save it under a name (its title when empty); what happened, in words. */
  save(input: { readonly name: string; readonly replace: boolean; readonly switchTo: boolean }): Promise<string>;
  /** Whether a file is at this path now. */
  fileExists(path: string): boolean;
  /** Write it as a file; what happened, in words. */
  saveFile(input: { readonly format: 'markdown' | 'text' | 'html' | 'json'; readonly path: string; readonly redact: boolean; readonly open: boolean; readonly copy: boolean }): Promise<string>;
  /** Keep a branch of it as it is now; what happened, in words. */
  branch(name: string): Promise<string>;
  /** Fold or open its blocks of a kind; what happened, in words. */
  blocks(type: string, fold: boolean): Promise<string>;
  /** What compaction removed so far; undefined where this program keeps no such record. */
  readonly compactions: (() => Promise<string>) | undefined;
}

/** What the conversation's model is given and how hard it thinks. */
export interface ConversationContext {
  /** What fills the context now, message by message (or the program's own screen for it); its words. */
  show(): Promise<string>;
  /** The project instruction files read into each turn; undefined where this program does not list them. */
  readonly instructionFiles: (() => Promise<string>) | undefined;
  /** What this conversation's last turns were given (memories, persona, skills, routines, what was left out); undefined where the program keeps no such record. */
  readonly given: (() => Promise<string>) | undefined;
  /** The level asked for, the level the model in use runs at, and the levels it offers. */
  effort(): Promise<string>;
  /** Have the model think at `level` from the next message; what happened, in words. */
  setEffort(level: string): Promise<string>;
}

/** The guidance about this conversation, where the program keeps it. */
export interface ConversationGuidance {
  review(): Promise<string>;
  dismiss(item: string): Promise<string>;
  reset(item: string): Promise<string>;
}

/** The composer: the message being written, its pastes, the editor, an image. */
export interface ConversationComposer {
  /** Open the message being written in the person's editor; what happened, in words. Undefined where no editor can be opened. */
  readonly openEditor: (() => Promise<string>) | undefined;
  /** The pastes folded in the prompt, by id; undefined where the program folds none. */
  pastes(): ReadonlyMap<string, string> | undefined;
  /** Put the clipboard into the prompt; whether anything was pasted. Undefined where pasting is not available. */
  readonly pasteClipboard: (() => boolean) | undefined;
  /** Send an image file of the project with a message as a new turn; what happened, in words. */
  attachImage(path: string, message: string): Promise<string>;
}

/** The messages typed while a turn runs, waiting to be sent. */
export interface ConversationQueue {
  list(): readonly { readonly id: string; readonly text: string }[];
  /** False when the message was sent meanwhile. */
  edit(id: string, text: string): boolean;
  /** False when the message was sent meanwhile. */
  remove(id: string): boolean;
}

/** What going back to a turn takes back. */
export type RewindScope = 'files' | 'conversation' | 'both';

/** The workspace checkpoints this program keeps. */
export interface ConversationCheckpoints {
  /** The checkpoints, newest first, in words. */
  list(): Promise<string>;
  /** Make one now; what happened, in words. Refused with the reason where the program makes none on request. */
  readonly make: ((label: string) => Promise<string>) | { readonly refused: string };
  /** Put the files back to a checkpoint (a number newest first, or an id); what happened, in words. */
  restore(checkpoint: string): Promise<string>;
  /** Go back to an earlier turn; what happened, in words. Refused with the reason where the program cannot. */
  readonly rewind: ((turn: string, scope: RewindScope) => Promise<string>) | { readonly refused: string };
}

export interface RedoServices extends Pick<UndoServices, 'files' | 'rewind'> {
  readonly conversation: Pick<LiveConversation, 'isGenerating'>;
  readonly turns?: ConversationTurns | undefined;
}
export interface TurnServices {
  readonly conversation: Pick<LiveConversation, 'isGenerating' | 'undoTurn'>;
  readonly turns?: ConversationTurns | undefined;
}
export interface RecordServices {
  readonly conversation: Pick<LiveConversation, 'isGenerating'>;
  readonly record?: ConversationRecord | undefined;
}
export interface ContextServices { readonly context?: ConversationContext | undefined }
export interface GuidanceServices { readonly guidance?: ConversationGuidance | undefined }
export interface ComposerServices { readonly composer?: ConversationComposer | undefined }
export interface QueueServices { readonly queue?: ConversationQueue | undefined }
export interface CheckpointServices { readonly checkpoints?: ConversationCheckpoints | undefined }

/** Every service the conversation's controls take, as the program holding the conversation hands them in. */
export type ConversationControlServices = RedoServices & TurnServices & RecordServices & ContextServices & GuidanceServices
  & ComposerServices & QueueServices & CheckpointServices & Pick<SessionsCapabilityServices, 'hostedJoin'>;

function need<Service>(service: Service | undefined, what: string): Service {
  if (!service) throw new CapabilityRefusal(`${what} is not available in this program.`, undefined, 'UNAVAILABLE');
  return service;
}

function refuseWhileTurnRuns(conversation: Pick<LiveConversation, 'isGenerating'>, nothing: string): void {
  if (conversation.isGenerating()) throw new CapabilityRefusal(`A turn is still running, so ${nothing}.`, 'Stop it with Esc or let it finish, then try again', 'TURN_RUNNING');
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

const REDO_CHOICES: readonly FixedChoice[] = [
  { value: 'turn', label: 'The turn undone last', help: 'Your message and its answer come back' },
  { value: 'file', label: 'The file change undone last', help: 'The files it changed are written again' },
  { value: 'set-aside', label: 'Set aside a blocked file change', help: 'A later change blocks it; set it aside without changing a file' },
  { value: 'rewind', label: 'The rewind undone last', help: 'The last checkpoint rewind that was undone is applied again' },
];

export const CONVERSATION_REDO: CapabilityDefinition<RedoServices> = {
  capability: { id: 'conversation.redo', group: 'conversation', home: 'session', repeat: 'unsafe' },
  actionId: 'redo', label: 'Redo the step undone last', word: '',
  inputs: [{ id: 'what', label: 'What', help: 'What to bring back', kind: 'choice', choices: REDO_CHOICES, required: { default: 'turn', defaultMeans: 'the turn undone last' }, typed: { position: 1 } }],
  sentence: 'The step of the kind chosen that was undone last is brought back.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { what: 'file' },
  async run(values, services) {
    const what = values.what || 'turn';
    if (what === 'file') {
      const files = need(services.files, 'File redo');
      let result: ReturnType<NonNullable<RedoServices['files']>['redo']>;
      try { result = files.redo(); } catch (error) { throw new CapabilityRefusal(`File redo failed: ${error instanceof Error ? error.message : String(error)}`, undefined, 'NOT_DONE'); }
      return { text: result
        ? `${result.paths.length === 1 ? 'File' : `${result.paths.length} files`} re-applied (${result.tool} call):\n${result.paths.map((path) => `  ${path}`).join('\n')}`
        : 'Nothing to redo.', data: { what, paths: result?.paths ?? [] } };
    }
    if (what === 'set-aside') {
      const files = services.files?.discard ? services.files : undefined;
      if (!files?.discard) throw new CapabilityRefusal('File redo is not available in this program.', undefined, 'UNAVAILABLE');
      const dropped = files.discard('redo');
      return { text: dropped
        ? `Dropped the newest redo entry (${dropped.tool} call) without changing any file:\n${dropped.paths.map((path) => `  ${path}`).join('\n')}\nThe next file redo acts on the one before it.`
        : 'Nothing to drop: no redo entries are recorded.', data: { what, paths: dropped?.paths ?? [] } };
    }
    if (what === 'rewind') {
      if (!services.rewind?.redo) throw new CapabilityRefusal('This program has no rewind to redo: going back to a turn is the terminal app\'s.');
      return { text: await services.rewind.redo(), data: { what } };
    }
    refuseWhileTurnRuns(services.conversation, 'nothing was brought back');
    if (!need(services.turns, 'Redo').redoTurn()) throw new CapabilityRefusal('There is nothing to redo.', 'To write a reverted file change again, redo the file change');
    return { text: 'Turn restored.', data: { what } };
  },
};

export const CONVERSATION_RETRY: CapabilityDefinition<TurnServices> = {
  capability: { id: 'conversation.retry', group: 'conversation', home: 'session', repeat: 'unsafe' },
  actionId: 'retry', label: 'Send the last message again', word: '',
  inputs: [{ id: 'message', label: 'Changed message', help: 'What to send instead', kind: 'long-text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'the last message as it was' }, typed: { tail: true } }],
  sentence: 'Asks again: your last message, the same question, is sent again (changed, when you typed a new one) and answered as a new turn.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { message: 'shorter please' },
  async run(values, services) {
    const turns = need(services.turns, 'Sending a message again');
    refuseWhileTurnRuns(services.conversation, 'nothing was sent');
    const last = turns.lastUserMessage();
    if (!last) throw new CapabilityRefusal('There is no message to send again.');
    if (!turns.send) throw new CapabilityRefusal('This program cannot send a message again, so the conversation was left unchanged.');
    // The old turn is taken back only when the message can be sent again, and nothing is sent if it could not be (that would duplicate it).
    if (turns.retryRemovesLastTurn && !services.conversation.undoTurn()) {
      throw new CapabilityRefusal('Nothing was sent: the last turn could not be removed, and sending it again would duplicate it. Type the message as a new prompt if you still want an answer.');
    }
    turns.send(values.message ? values.message : last);
    return {
      text: values.message ? 'Your last message was sent again as you changed it; its answer follows in the conversation.' : 'Your last message was sent again; its answer follows in the conversation.',
      data: { changed: Boolean(values.message) },
    };
  },
};

export const CONVERSATION_TITLE: CapabilityDefinition<TurnServices> = {
  capability: { id: 'conversation.title', group: 'conversation', home: 'session', repeat: 'safe' },
  actionId: 'title', label: 'Give this chat a title', word: '',
  inputs: [{ id: 'text', label: 'Title', help: 'Its new title: the name this chat goes by', kind: 'text', freeTextReason: 'your own words', required: true, typed: { tail: true } }],
  sentence: 'The title, the name this conversation (this chat) goes by, becomes {text} until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', button: 'Set the title', example: { text: 'release notes' },
  async run(values, services) {
    const turns = need(services.turns, 'A conversation title');
    const text = (values.text ?? '').trim();
    // The title it has now is on the control's row (This conversation) and in the session's details.
    if (!text) throw new CapabilityRefusal('A title needs words; the title was left as it is.', turns.title() ? `It is "${turns.title()}" now` : 'It has none yet');
    turns.setTitle(text);
    return { text: `Title set to: ${text}`, data: { title: text } };
  },
};

// ---------------------------------------------------------------------------
// The conversation's record
// ---------------------------------------------------------------------------

export const SESSION_SAVE: CapabilityDefinition<RecordServices> = {
  capability: { id: 'session.save', group: 'conversation', home: 'session', repeat: 'safe' },
  actionId: 'save', label: 'Save this session under a name', word: 'save',
  inputs: [
    { id: 'name', label: 'Name', help: 'A name you choose', kind: 'text', freeTextReason: 'a name you choose', required: { default: '', defaultMeans: 'the conversation\'s title' }, typed: { tail: true } },
    { id: 'continue', label: 'Keep working in', help: 'This session, or the saved copy', kind: 'choice', choices: [
      { value: 'here', label: 'This session' },
      { value: 'copy', label: 'The saved copy', help: 'Later turns are saved under the new name.' },
    ], required: { default: 'here', defaultMeans: 'this session' }, typed: { flag: '--switch', switchOn: 'copy' } },
    { id: 'replace', label: 'If the name is taken', help: 'Another saved conversation may have it', kind: 'choice', choices: [
      { value: 'no', label: 'Stop and say so' },
      { value: 'yes', label: 'Replace it', help: 'The conversation saved under that name now is lost.', risk: 'cannot-be-undone', riskDone: REPLACED_DONE },
    ], required: { default: 'no', defaultMeans: 'stop and say so' }, typed: { flag: '--replace', switchOn: 'yes' } },
  ],
  sentence: 'This conversation will be saved under the name given (or its title), until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'delete', example: { name: 'release notes' },
  async run(values, services) {
    const text = await need(services.record, 'Saving this conversation').save({ name: values.name ?? '', replace: values.replace === 'yes', switchTo: values.continue === 'copy' });
    return { text, data: { name: values.name ?? '' } };
  },
};

const BLOCK_TYPES: readonly FixedChoice[] = [
  { value: 'all', label: 'Every block' }, { value: 'thinking', label: 'Thinking' }, { value: 'tool', label: 'Tool calls' }, { value: 'code', label: 'Code' },
];
const BLOCK_TYPE: InputDescription = {
  id: 'type', label: 'Blocks', help: 'Which blocks', kind: 'choice', choices: BLOCK_TYPES,
  required: { default: 'all', defaultMeans: 'every block' }, typed: { position: 1 },
};

export const SESSION_EXPAND: CapabilityDefinition<RecordServices> = {
  capability: { id: 'session.expand', group: 'conversation', home: 'session', repeat: 'safe' },
  actionId: 'expand', label: 'Open folded blocks', word: 'expand', inputs: [BLOCK_TYPE],
  sentence: 'Opens the folded blocks of the kind chosen in this conversation.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { type: 'tool' },
  async run(values, services) {
    return { text: await need(services.record, 'Folding blocks').blocks(values.type || 'all', false) };
  },
};

export const SESSION_COLLAPSE: CapabilityDefinition<RecordServices> = {
  capability: { id: 'session.collapse', group: 'conversation', home: 'session', repeat: 'safe' },
  actionId: 'collapse', label: 'Fold blocks', word: 'collapse', inputs: [BLOCK_TYPE],
  sentence: 'Folds the blocks of the kind chosen in this conversation to one line each.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { type: 'thinking' },
  async run(values, services) {
    return { text: await need(services.record, 'Folding blocks').blocks(values.type || 'all', true) };
  },
};

export const SESSION_COMPACTIONS: CapabilityDefinition<RecordServices> = {
  capability: { id: 'session.compactions', group: 'conversation', home: 'session', repeat: 'safe' },
  actionId: 'compactions', label: 'See what compaction removed', word: 'compactions', inputs: [],
  sentence: 'Lists each compaction of this session: when, how much it removed and what it kept.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  available: (services) => services.record?.compactions !== undefined,
  async run(_values, services) {
    const compactions = need(services.record, 'A record of compactions').compactions;
    if (!compactions) throw new CapabilityRefusal('This program keeps no record of compactions.', 'Compacting the conversation says what it removed when it runs');
    return { text: await compactions() };
  },
};

export const SESSION_SAVE_FILE: CapabilityDefinition<RecordServices> = {
  capability: { id: 'session.save-file', group: 'conversation', home: 'session', repeat: 'unsafe' },
  actionId: 'save-file', label: 'Save or export this conversation as a file', word: 'save-file',
  inputs: [
    { id: 'format', label: 'As', help: 'The kind of file', kind: 'choice', choices: [
      { value: 'markdown', label: 'Markdown' }, { value: 'text', label: 'Plain text' },
      { value: 'html', label: 'A web page', help: 'Self-contained, with code highlighted' }, { value: 'json', label: 'JSON', help: 'For programs' },
    ], required: { default: 'markdown', defaultMeans: 'Markdown' }, typed: { position: 1 } },
    { id: 'path', label: 'File', help: 'Where to write it', kind: 'path', freeTextReason: 'a file path', required: { default: '', defaultMeans: 'a new file named for the time' }, typed: { position: 2 } },
    { id: 'redact', label: 'Keys and paths', help: 'API keys, tokens and your home path and login name', kind: 'choice', choices: [
      { value: 'hide', label: 'Hide them' }, { value: 'keep', label: 'Keep them as they are' },
    ], required: { default: 'hide', defaultMeans: 'hide them' }, typed: { flag: '--keep-secrets', switchOn: 'keep' } },
    { id: 'replace', label: 'If the file exists', help: 'Keep it, or write over it', kind: 'choice', choices: [
      { value: 'no', label: 'Keep it and stop' }, { value: 'yes', label: 'Write over it', risk: 'cannot-be-undone', riskDone: REPLACED_DONE },
    ], required: { default: 'no', defaultMeans: 'keep it and stop' }, typed: { flag: '--replace', switchOn: 'yes' } },
    { id: 'open', label: 'Then', help: 'What to do with the file', kind: 'choice', choices: [
      { value: 'nothing', label: 'Nothing more' }, { value: 'open', label: 'Open it in the browser', help: 'A web page only' }, { value: 'copy', label: 'Copy its path' },
    ], required: { default: 'nothing', defaultMeans: 'nothing more' }, typed: { flag: '--then' } },
  ],
  sentence: 'This conversation (the chat) will be exported to the file {path} as {format} (Markdown, text, a web page or JSON) on this machine, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { format: 'html', path: 'notes/session.html' },
  async run(values, services) {
    const record = need(services.record, 'Saving this conversation as a file');
    if (values.path && values.replace !== 'yes' && record.fileExists(values.path)) {
      throw new CapabilityRefusal(`${values.path} already exists; nothing was written.`, 'Choose "Write over it" for "If the file exists", or another file');
    }
    const text = await record.saveFile({
      format: (values.format || 'markdown') as 'markdown' | 'text' | 'html' | 'json', path: values.path ?? '',
      redact: values.redact !== 'keep', open: values.open === 'open', copy: values.open === 'copy',
    });
    return { text, data: { format: values.format || 'markdown', path: values.path ?? '' } };
  },
};

export const SESSION_BRANCH: CapabilityDefinition<RecordServices> = {
  capability: { id: 'session.branch', group: 'conversation', home: 'session', repeat: 'unsafe' },
  actionId: 'branch', label: 'Branch this conversation here', word: 'branch',
  inputs: [{ id: 'name', label: 'Name', help: 'A name for the branch', kind: 'text', freeTextReason: 'a name you choose', required: { default: '', defaultMeans: 'a numbered name' }, typed: { tail: true } }],
  sentence: 'A branch of the conversation is kept as it is now, under the name given, to come back to and try something else from; you go on in the current one, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { name: 'before refactor' },
  async run(values, services) {
    return { text: await need(services.record, 'Branching this conversation').branch(values.name ?? '') };
  },
};

// ---------------------------------------------------------------------------
// What fills the context, and how hard the model thinks
// ---------------------------------------------------------------------------

export const CONTEXT_SHOW: CapabilityDefinition<ContextServices> = {
  capability: { id: 'context.show', group: 'conversation', home: 'session', repeat: 'safe' },
  actionId: 'see', label: 'See what fills the context', word: 'show', inputs: [],
  sentence: 'Shows how many tokens each message of this conversation takes, and the total.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    return { text: await need(services.context, 'What fills the context').show() };
  },
};

export const CONTEXT_FILES: CapabilityDefinition<ContextServices> = {
  capability: { id: 'context.files', group: 'conversation', home: 'session', repeat: 'safe' },
  actionId: 'files', label: 'See the project instruction files', word: 'files', inputs: [],
  sentence: 'Lists which project instruction files (AGENTS.md, CLAUDE.md and the like) are loaded into each turn, any cut short, and any held back with why.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  available: (services) => services.context?.instructionFiles !== undefined,
  async run(_values, services) {
    const files = need(services.context, 'The project instruction files').instructionFiles;
    if (!files) throw new CapabilityRefusal('Only the Agent lists the instruction files it reads; this program does not.');
    return { text: await files() };
  },
};

export const CONTEXT_GIVEN: CapabilityDefinition<ContextServices> = {
  capability: { id: 'context.given', group: 'conversation', home: 'session', repeat: 'safe' },
  actionId: 'given', label: 'See what the last turns were given', word: 'given', inputs: [],
  sentence: 'Shows, for this conversation\'s last turns, how many memories, personas, skills and routines the model was given, how many were left out, and roughly how many tokens they took.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  available: (services) => services.context?.given !== undefined,
  async run(_values, services) {
    const given = need(services.context, 'What the last turns were given').given;
    if (!given) throw new CapabilityRefusal('Only the Agent keeps a record of what each turn was given; what fills the context now is "See what fills the context".');
    return { text: await given() };
  },
};

/** The levels the model in use offers (the terminal's list reads the program's model). */
export const EFFORT_LEVELS_LIST = 'effort.levels' as ListName;

export const EFFORT_SHOW: CapabilityDefinition<ContextServices> = {
  // Models and providers in the group table; its row stays in This conversation too (one capability, two places).
  capability: { id: 'effort.show', group: 'models', home: 'session', repeat: 'safe' },
  actionId: 'see-effort', label: 'See how hard the model thinks', word: 'show', inputs: [],
  sentence: 'Shows how hard the model in this chat is thinking (its reasoning effort): the level you chose, the level it runs at, and the levels it offers.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    return { text: await need(services.context, 'Reasoning effort').effort() };
  },
};

export const EFFORT_SET: CapabilityDefinition<ContextServices> = {
  // Models and providers in the group table; its row stays in This conversation too (one capability, two places).
  capability: { id: 'effort.set', group: 'models', home: 'session', repeat: 'safe' },
  actionId: 'set', label: 'Choose how hard the model thinks', word: 'set',
  inputs: [{ id: 'level', label: 'Level', help: 'The levels the model in use offers', kind: 'choice', choices: { list: EFFORT_LEVELS_LIST }, required: true, typed: { position: 1 } }],
  sentence: 'The model in this chat will think harder or lighter, at reasoning effort {level}, from the next message, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { level: 'high' },
  async run(values, services) {
    return { text: await need(services.context, 'Reasoning effort').setEffort(values.level!), data: { level: values.level } };
  },
};

// ---------------------------------------------------------------------------
// Guidance about this conversation
// ---------------------------------------------------------------------------

/** The guidance showing now (the terminal's list reads the program's session). */
export const CURRENT_GUIDANCE_LIST = 'guidance.current' as ListName;

export const GUIDANCE_REVIEW: CapabilityDefinition<GuidanceServices> = {
  capability: { id: 'guidance.review', group: 'conversation', home: 'session', repeat: 'safe' },
  actionId: 'review', label: 'See guidance for now', word: 'review', inputs: [],
  sentence: 'Shows the guidance, advice and tips that apply right now, with what acts on each, and how this session is doing for size.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  available: (services) => services.guidance !== undefined,
  async run(_values, services) {
    return { text: await need(services.guidance, 'Guidance').review() };
  },
};

export const GUIDANCE_DISMISS: CapabilityDefinition<GuidanceServices> = {
  capability: { id: 'guidance.dismiss', group: 'conversation', home: 'session', repeat: 'safe' },
  actionId: 'dismiss', label: 'Dismiss a piece of guidance', word: 'dismiss',
  inputs: [{ id: 'item', label: 'Guidance', help: 'The guidance showing now', kind: 'choice', choices: { list: CURRENT_GUIDANCE_LIST, allowOther: { reason: 'a guidance id' } }, required: true, typed: { position: 1 } }],
  sentence: 'The guidance (advice) {item} is hidden for what it reports now; a new occurrence shows again, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'reset', example: { item: 'approval-pending' },
  available: (services) => services.guidance !== undefined,
  async run(values, services) {
    return { text: await need(services.guidance, 'Guidance').dismiss(values.item!), data: { item: values.item } };
  },
};

export const GUIDANCE_RESET: CapabilityDefinition<GuidanceServices> = {
  capability: { id: 'guidance.reset', group: 'conversation', home: 'session', repeat: 'safe' },
  actionId: 'reset', label: 'Show dismissed guidance again', word: 'reset',
  inputs: [{ id: 'item', label: 'Guidance', help: 'One dismissed piece of guidance, by id', kind: 'text', freeTextReason: 'a guidance id you dismissed', required: { default: '', defaultMeans: 'every dismissed piece' }, typed: { position: 1 } }],
  sentence: 'The guidance (advice) {item} you dismissed and hid shows again when it applies, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'dismiss', example: { item: 'approval-pending' },
  available: (services) => services.guidance !== undefined,
  async run(values, services) {
    return { text: await need(services.guidance, 'Guidance').reset(values.item ?? ''), data: { item: values.item ?? '' } };
  },
};

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

export const CONVERSATION_EDITOR: CapabilityDefinition<ComposerServices> = {
  capability: { id: 'conversation.editor', group: 'conversation', home: 'session', repeat: 'unsafe' },
  actionId: 'editor', label: 'Write the message in your editor', word: '', inputs: [],
  sentence: 'Opens the message you are writing in $VISUAL or $EDITOR; when you close it, the text comes back here.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: {},
  available: (services) => services.composer?.openEditor !== undefined,
  async run(_values, services) {
    const open = need(services.composer, 'The composer').openEditor;
    if (!open) throw new CapabilityRefusal('No editor can be opened here.');
    return { text: await open() };
  },
};

export const CONVERSATION_IMAGE: CapabilityDefinition<ComposerServices> = {
  capability: { id: 'conversation.image', group: 'conversation', home: 'session', repeat: 'unsafe' },
  actionId: 'attach', label: 'Send an image with a message', word: '',
  inputs: [
    { id: 'path', label: 'Image file', help: 'A screenshot, picture or photo: a .png, .jpg, .jpeg, .webp or .gif file in this project, up to 20 MB', kind: 'path', freeTextReason: 'a file path', required: true, typed: { position: 1 } },
    { id: 'message', label: 'Message', help: 'What to ask about it', kind: 'long-text', freeTextReason: 'your own words', required: { default: '', defaultMeans: '"Attached image:" and its file name' }, typed: { tail: true } },
  ],
  sentence: 'The image (a screenshot, picture or photo) {path} is sent to the model with your message, as a new turn.', done: '',
  touches: 'another-machine', lasts: 'not-a-change', risk: 'none', example: { path: 'screenshots/error.png', message: 'what is wrong here?' },
  async run(values, services) {
    return { text: await need(services.composer, 'The composer').attachImage(values.path!, values.message ?? ''), data: { path: values.path } };
  },
};

/** The pastes folded in the prompt now (the terminal's list reads the composer). */
export const PENDING_PASTES_LIST = 'composer.pastes' as ListName;

export const PASTE_LIST: CapabilityDefinition<ComposerServices> = {
  capability: { id: 'paste.list', group: 'conversation', home: 'session', repeat: 'safe' },
  actionId: 'see-pastes', label: 'Read the pastes folded in the prompt', word: 'list',
  inputs: [{ id: 'paste', label: 'Paste', help: 'Pastes folded in the prompt now', kind: 'choice', choices: { list: PENDING_PASTES_LIST }, required: { default: '', defaultMeans: 'a line for each' }, typed: { position: 1 } }],
  sentence: 'Shows what each folded paste ([TEXT: pN, M lines]) in the prompt holds; with one chosen, its whole text.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { paste: 'p1' },
  async run(values, services) {
    const pending = need(services.composer, 'The composer').pastes();
    if (!pending || pending.size === 0) return { text: 'No paste is folded in the prompt (a paste over 8 lines folds to [TEXT: pN, M lines]).', data: { pastes: [] } };
    if (values.paste) {
      const content = pending.get(values.paste);
      if (content === undefined) throw new CapabilityRefusal(`No folded paste is ${values.paste}.`, `Folded now: ${[...pending.keys()].join(', ')}`);
      return { text: `${values.paste} (${content.split('\n').length} lines):\n${content}` };
    }
    return { text: ['Folded in the prompt now:', ...[...pending].map(([id, content]) => {
      const lines = content.split('\n');
      const preview = lines[0]!.slice(0, 80);
      return `  ${id} (${lines.length} lines): ${preview}${lines.length > 1 || preview.length < lines[0]!.length ? '…' : ''}`;
    })].join('\n'), data: { pastes: [...pending.keys()] } };
  },
};

export const PASTE_CLIPBOARD: CapabilityDefinition<ComposerServices> = {
  capability: { id: 'paste.clipboard', group: 'conversation', home: 'session', repeat: 'unsafe' },
  actionId: 'paste-clipboard', label: 'Paste the clipboard into the prompt', word: 'clipboard', inputs: [],
  sentence: 'The text or image on the clipboard goes into the prompt; nothing is sent until you send it.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const paste = need(services.composer, 'The composer').pasteClipboard;
    if (!paste) throw new CapabilityRefusal('Pasting is not available here.');
    if (!paste()) throw new CapabilityRefusal('The clipboard holds no text or image this program can paste.');
    return { text: 'The clipboard is in the prompt; nothing is sent until you send it.' };
  },
};

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/** The messages waiting to be sent (the terminal's list reads the composer). */
export const QUEUED_MESSAGES_LIST = 'queue.messages' as ListName;

/** A queued message's text, shortened for a reply line. */
function quoted(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return `"${flat.length <= 60 ? flat : `${flat.slice(0, 59)}…`}"`;
}

/**
 * The queued message a picked id or a typed 1-based position names. A picked id that is no longer queued was sent
 * meanwhile and is refused as such; it is never swapped for the message now at its old position.
 */
function queuedAt(queue: ConversationQueue, choice: string): { readonly id: string; readonly text: string } {
  const list = queue.list();
  const byId = list.find((message) => message.id === choice);
  if (byId) return { id: byId.id, text: byId.text };
  if (!/^\d+$/.test(choice)) throw new CapabilityRefusal('That message is no longer queued: it was sent when the turn before it ended, so nothing was changed.', 'See your queued messages to know what is still waiting');
  if (list.length === 0) throw new CapabilityRefusal('No message is queued.', 'Messages typed while a turn runs wait there until it finishes');
  const n = Number.parseInt(choice, 10);
  if (n < 1 || n > list.length) throw new CapabilityRefusal(`No queued message #${choice}; they are numbered 1 to ${list.length}.`, 'See your queued messages for their numbers');
  const message = list[n - 1]!;
  return { id: message.id, text: message.text };
}

const QUEUED_MESSAGE: InputDescription = {
  id: 'message', label: 'Message', help: 'The messages waiting, in order', kind: 'choice',
  choices: { list: QUEUED_MESSAGES_LIST, allowOther: { reason: 'its number, counting from 1 in the order they will be sent' } }, required: true, typed: { position: 1 },
};

export const QUEUE_LIST: CapabilityDefinition<QueueServices> = {
  capability: { id: 'queue.list', group: 'conversation', home: 'session', repeat: 'safe' },
  actionId: 'list', label: 'See your queued messages', word: 'list', inputs: [],
  sentence: 'Lists the messages waiting to be sent after the running turn, in the order they will go.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  available: (services) => services.queue !== undefined,
  async run(_values, services) {
    const list = need(services.queue, 'The message queue').list();
    if (list.length === 0) return { text: 'No queued messages. (Messages typed while a turn is streaming queue here until it finishes.)', data: { queued: [] } };
    return { text: [`Queued messages (${list.length}), changeable until sent:`, ...list.map((message, index) => `  ${index + 1}. ${message.text}`)].join('\n'), data: { queued: list.map((message) => message.id) } };
  },
};

export const QUEUE_EDIT: CapabilityDefinition<QueueServices> = {
  capability: { id: 'queue.edit', group: 'conversation', home: 'session', repeat: 'safe' },
  actionId: 'edit', label: 'Change a queued message', word: 'edit',
  inputs: [QUEUED_MESSAGE, { id: 'text', label: 'New text', help: 'What it says instead', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } }],
  sentence: 'Queued message {message} is sent as {text} instead, when the running turn ends.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { message: '1', text: 'also check the tests' },
  available: (services) => services.queue !== undefined,
  async run(values, services) {
    const queue = need(services.queue, 'The message queue');
    const target = queuedAt(queue, values.message!);
    if (!queue.edit(target.id, values.text!)) throw new CapabilityRefusal(`The queued message ${quoted(target.text)} was already sent, so it was not changed.`);
    return { text: `Changed the queued message ${quoted(target.text)}.` };
  },
};

export const QUEUE_DELETE: CapabilityDefinition<QueueServices> = {
  capability: { id: 'queue.delete', group: 'conversation', home: 'session', repeat: 'safe' },
  actionId: 'delete', label: 'Take back a queued message', word: 'delete',
  inputs: [QUEUED_MESSAGE],
  sentence: 'Queued message {message} is taken back and never sent.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { message: '1' },
  available: (services) => services.queue !== undefined,
  async run(values, services) {
    const queue = need(services.queue, 'The message queue');
    const target = queuedAt(queue, values.message!);
    if (!queue.remove(target.id)) throw new CapabilityRefusal(`The queued message ${quoted(target.text)} was already sent, so it was not taken back.`);
    return { text: `Took back the queued message ${quoted(target.text)}.` };
  },
};

// ---------------------------------------------------------------------------
// Workspace checkpoints
// ---------------------------------------------------------------------------

/** The workspace checkpoints, and the open conversation's turns (the terminal's lists read the program's store). */
export const CHECKPOINTS_LIST = 'checkpoints' as ListName;
export const CHECKPOINT_TURNS_LIST = 'checkpoint.turns' as ListName;

const REWIND_SCOPES: readonly FixedChoice[] = [
  { value: 'both', label: 'Files and conversation' },
  { value: 'files', label: 'Files only', help: 'The conversation stays as it is' },
  { value: 'conversation', label: 'Conversation only', help: 'No file changes' },
];

export const CHECKPOINT_LIST: CapabilityDefinition<CheckpointServices> = {
  capability: { id: 'checkpoint.list', group: 'conversation', home: 'session', repeat: 'safe' },
  actionId: 'list', label: 'See your checkpoints', word: 'list', inputs: [],
  sentence: 'Lists the workspace checkpoints (snapshots of your files), newest first, with how old each is and how much it added.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    return { text: await need(services.checkpoints, 'Checkpoints').list() };
  },
};

export const CHECKPOINT_MAKE: CapabilityDefinition<CheckpointServices> = {
  capability: { id: 'checkpoint.make', group: 'conversation', home: 'session', repeat: 'unsafe' },
  actionId: 'make', label: 'Make a checkpoint now', word: 'make',
  inputs: [{ id: 'label', label: 'Name', help: 'What to call it', kind: 'text', freeTextReason: 'a name you choose', required: { default: '', defaultMeans: 'a name made from the time' }, typed: { tail: true } }],
  sentence: 'A snapshot of the workspace\'s files as they are now is kept as a checkpoint (before a refactor, say), held longer than the automatic ones; nothing changes in the files.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { label: 'before the refactor' },
  available: (services) => services.checkpoints !== undefined && !('refused' in services.checkpoints.make),
  async run(values, services) {
    const make = need(services.checkpoints, 'Checkpoints').make;
    if ('refused' in make) throw new CapabilityRefusal(make.refused, 'See your checkpoints to know the ones this workspace has');
    return { text: await make(values.label ?? '') };
  },
};

export const CHECKPOINT_RESTORE: CapabilityDefinition<CheckpointServices> = {
  capability: { id: 'checkpoint.restore', group: 'conversation', home: 'session', repeat: 'unsafe' },
  actionId: 'restore', label: 'Put the files back to a checkpoint', word: 'restore',
  inputs: [{ id: 'checkpoint', label: 'Checkpoint', help: 'Your checkpoints, newest first', kind: 'choice', choices: { list: CHECKPOINTS_LIST, allowOther: { reason: 'a number from the list, newest first, or a checkpoint id' } }, required: true, typed: { position: 1 } }],
  sentence: 'The workspace\'s files are put back the way they were at checkpoint {checkpoint}; the current files are kept as a checkpoint first, which a restore brings back, and the conversation is unchanged.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', asksItself: true, example: { checkpoint: '1' },
  async run(values, services) {
    return { text: await need(services.checkpoints, 'Checkpoints').restore(values.checkpoint!), data: { checkpoint: values.checkpoint } };
  },
};

export const CHECKPOINT_REWIND: CapabilityDefinition<CheckpointServices> = {
  capability: { id: 'checkpoint.rewind', group: 'conversation', home: 'session', repeat: 'unsafe' },
  actionId: 'rewind', label: 'Go back to an earlier turn', word: 'rewind',
  inputs: [
    { id: 'turn', label: 'Turn', help: 'The turns of this conversation, newest first', kind: 'choice', choices: { list: CHECKPOINT_TURNS_LIST, allowOther: { reason: 'a number from the list, newest first, or a turn id' } }, required: true, typed: { position: 1 } },
    { id: 'scope', label: 'What goes back', help: 'The files, the conversation, or both', kind: 'choice', choices: REWIND_SCOPES, required: { default: 'both', defaultMeans: 'files and conversation' }, typed: { position: 2 } },
  ],
  sentence: 'What changed after turn {turn} is taken back ({scope}): messages after it are dropped and files go back to how they were then. Undoing the rewind brings them back only while no new message has been added.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', asksItself: true,
  // What ran can still be undone until a new message is added: "This cannot be undone." would not be true of it.
  riskDone: 'The dropped messages are gone for good once a new message is added; undoing the rewind brings them back until then.',
  available: (services) => services.checkpoints !== undefined && !('refused' in services.checkpoints.rewind),
  example: { turn: '2', scope: 'files' },
  async run(values, services) {
    const rewind = need(services.checkpoints, 'Checkpoints').rewind;
    if ('refused' in rewind) throw new CapabilityRefusal(rewind.refused, 'Putting the files back to a checkpoint is still possible');
    return { text: await rewind(values.turn!, (values.scope || 'both') as RewindScope), data: { turn: values.turn, scope: values.scope || 'both' } };
  },
};

// ---------------------------------------------------------------------------
// A message for after the turn, in the hosted session this terminal joined
// ---------------------------------------------------------------------------

export const HOSTED_SEND_LATER: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'hosted.send-later', group: 'conversation', home: 'session', repeat: 'unsafe' },
  actionId: 'send-later', label: 'Send a message after this turn', word: 'send-later',
  inputs: [{ id: 'text', label: 'Message', help: 'What it should do next, once the turn it is in ends', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } }],
  sentence: '"{text}" will wait and run after the current turn of the hosted session this terminal joined.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { text: 'then update the changelog' },
  available: (services) => services.hostedJoin?.sendLater !== undefined,
  async run(values, services) {
    const later = services.hostedJoin?.sendLater;
    if (!later) throw new CapabilityRefusal('Only the terminal app joins hosted sessions; this program cannot queue a message for one.', undefined, 'UNAVAILABLE');
    return { text: await later((values.text ?? '').trim()) };
  },
};

const command = (name: string, title: string) => ({ name, title });
const SESSION = command('session', 'Sessions');
const CONTEXT = command('context', 'Context');
const EFFORT = command('effort', 'Reasoning effort');
const GUIDANCE = command('guidance', 'Guidance');
const PASTE = command('paste', 'Paste');
const QUEUE = command('queue', 'Queued messages');
const CHECKPOINT = command('checkpoint', 'Checkpoints');

/**
 * Every control on the conversation defined here, with the command each came from, in the order the
 * conversation's list shows them.
 */
export const CONVERSATION_CONTROLS: readonly { readonly definition: CapabilityDefinition<ConversationControlServices>; readonly command: { readonly name: string; readonly title: string } }[] = [
  { definition: CONVERSATION_RETRY, command: command('retry', 'Ask again') },
  { definition: CONVERSATION_REDO, command: command('redo', 'Redo') },
  { definition: CONVERSATION_TITLE, command: command('title', 'Conversation title') },
  { definition: CONVERSATION_EDITOR, command: command('editor', 'Write in your editor') },
  { definition: CONVERSATION_IMAGE, command: command('image', 'Attach an image') },
  { definition: HOSTED_SEND_LATER, command: command('hosted', 'Hosted sessions') },
  { definition: PASTE_CLIPBOARD, command: PASTE },
  { definition: PASTE_LIST, command: PASTE },
  { definition: QUEUE_LIST, command: QUEUE },
  { definition: QUEUE_EDIT, command: QUEUE },
  { definition: QUEUE_DELETE, command: QUEUE },
  { definition: CONTEXT_SHOW, command: CONTEXT },
  { definition: CONTEXT_FILES, command: CONTEXT },
  { definition: CONTEXT_GIVEN, command: CONTEXT },
  { definition: EFFORT_SHOW, command: EFFORT },
  { definition: EFFORT_SET, command: EFFORT },
  { definition: SESSION_SAVE, command: SESSION },
  { definition: SESSION_SAVE_FILE, command: SESSION },
  { definition: SESSION_BRANCH, command: SESSION },
  { definition: SESSION_EXPAND, command: SESSION },
  { definition: SESSION_COLLAPSE, command: SESSION },
  { definition: SESSION_COMPACTIONS, command: SESSION },
  { definition: GUIDANCE_REVIEW, command: GUIDANCE },
  { definition: GUIDANCE_DISMISS, command: GUIDANCE },
  { definition: GUIDANCE_RESET, command: GUIDANCE },
  { definition: CHECKPOINT_LIST, command: CHECKPOINT },
  { definition: CHECKPOINT_MAKE, command: CHECKPOINT },
  { definition: CHECKPOINT_RESTORE, command: CHECKPOINT },
  { definition: CHECKPOINT_REWIND, command: CHECKPOINT },
].map((entry) => ({ definition: entry.definition as CapabilityDefinition<ConversationControlServices>, command: entry.command }));
