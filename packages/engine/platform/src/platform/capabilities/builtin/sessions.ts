/**
 * Your conversations: this one and the ones saved in this project (see them,
 * resume one here, copy, rename, search, delete, write one out, upload this
 * one for a link), this conversation's branches, and the hosted session this
 * terminal joined. The saved conversations are files of the program holding
 * the conversation, inside the project (`<project>/.goodvibes/<program>/sessions/`),
 * and resuming one replaces the live conversation, so these run in that
 * program (home `session`), with the program's own session routines handed in.
 * Nothing here reaches a screen; the program draws what changed.
 */
import type { TranscriptEventKind } from '../../core/transcript-events/types.js';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type FixedChoice, type InputDescription, type ListName } from '../types.js';

/** The program's own session routines, each answering in the words it would print. */
export interface LiveSessions {
  /** False in a program that keeps one line of conversation (the Agent): the branch capabilities are not offered. */
  readonly keepsBranches: boolean;
  /** False in a program that uploads no conversation (the Agent). */
  readonly uploads: boolean;
  /** A saved session's title by its id, when it has one (an ask names the session by it). */
  readonly titleOf?: ((id: string) => string | undefined) | undefined;
  /** This session's id, name, start, message count and model. */
  current(): Promise<string>;
  /** The saved sessions, newest first. */
  list(): Promise<string>;
  /** One saved session's details (this one when `target` is empty). */
  info(target: string): Promise<string>;
  /** Saved sessions whose messages hold the words. */
  search(words: string): Promise<string>;
  /** Delete a saved session and its messages. */
  remove(target: string): Promise<string>;
  /** Set this conversation aside and continue the saved one here. */
  resume(target: string, force: boolean): Promise<string>;
  /** Save a copy under a name and go on in the copy. */
  fork(name: string): Promise<string>;
  /** Give a saved session a new name (this one when `target` is empty). */
  rename(target: string, name: string): Promise<string>;
  /** Write a saved session's redacted transcript to a file, or show it. */
  exportSaved(input: { readonly target: string; readonly format: 'markdown' | 'text'; readonly path: string; readonly print: boolean }): Promise<string>;
  /** Upload this conversation as a secret gist and say its link. */
  upload(input: { readonly format: 'html' | 'json' | 'md'; readonly redact: boolean; readonly open: boolean; readonly copy: boolean }): Promise<string>;
  /** This conversation's branches. */
  branches(): Promise<string>;
  switchBranch(name: string): Promise<string>;
  mergeBranch(name: string): Promise<string>;
  /** This conversation's record: entry by entry, by turn, or counted by what took most. */
  review(view: 'events' | 'groups' | 'hotspots', input: { readonly kind: string; readonly start: string; readonly last: string }): Promise<string>;
  /** Entries holding the words (none: the program's in-place search). */
  /** `opensScreen`: the in-place search may open (the person's press, words left blank); a model's call opens nothing. */
  find(words: string, kind: string, options?: { readonly opensScreen?: boolean | undefined }): Promise<string>;
  /** Move the view to the next or previous entry of a kind (`error`: an error). */
  jump(direction: 'next' | 'prev', kind: string): Promise<string>;
  /** What the composer waits on. */
  composer(): Promise<string>;
  /** What the last resume brought back. */
  restored(): Promise<string>;
  /**
   * The bookmarked blocks; with a block's key, the conversation is moved to that block. `asWords`: the list is the
   * answer (a model asked), never a picker opened on the person's screen.
   */
  bookmarks(block: string, asWords: boolean): Promise<string>;
  /**
   * The cross-session task graph: the project's one file for both terminal programs (`.goodvibes/shared/task-graph.json`),
   * the same one a turn's task tool reads. False in a program that only reads it: its changes are no controls.
   */
  readonly changesTaskGraph: boolean;
  /**
   * True in a program that changes only what is its own session's (the Agent): it adds and cancels its own tasks,
   * accepts a task handed to it and takes back one handed off from it; it hands nothing off itself.
   */
  readonly ownTasksOnly?: boolean | undefined;
  /** The graph as text or JSON, every session's tasks or one's. */
  graph(input: { readonly session: string; readonly format: string }): Promise<string>;
  linkTask(input: { readonly task: string; readonly from: string; readonly after: string; readonly label: string }): Promise<string>;
  handOff(input: { readonly task: string; readonly to: string; readonly from: string; readonly reason: string }): Promise<string>;
  accept(handoff: string): Promise<string>;
  withdraw(handoff: string): Promise<string>;
  cancelTasks(input: { readonly scope: string; readonly task: string; readonly root: string; readonly from: string; readonly reason: string }): Promise<string>;
}

export interface SessionsCapabilityServices {
  /** Absent in a turn with no terminal program's conversation. */
  readonly sessions?: LiveSessions | undefined;
  /**
   * This terminal's part in the daemon's hosted sessions: joining one (it follows it live here), what it joined,
   * sending to it and leaving it. Absent in a program that cannot join one (only the terminal app does).
   */
  readonly hostedJoin?: HostedJoin | undefined;
}

/** The terminal's own join of a hosted session; each call runs the daemon's method with this terminal's own id. */
export interface HostedJoin {
  /** Whether this terminal is in a hosted session now: a control that acts on the joined one shows only then. */
  joined(): boolean;
  status(): Promise<string>;
  /** Joins it; `opensScreen` only for the person's own press (a model's join opens no screen on his display). */
  join(session: string, options?: { readonly opensScreen?: boolean | undefined }): Promise<string>;
  /**
   * `personAsked`: the person typed it himself (his own press, never the model's call). Only then is it sent with a
   * person's claim, which lets the daemon run it as his own turn in the session's project.
   */
  send(text: string, personAsked?: boolean): Promise<string>;
  leave(): Promise<string>;
  /** Queue a message to run after the joined session's current turn (hosted.send-later, builtin/conversation-controls.ts). */
  readonly sendLater?: ((text: string, personAsked?: boolean) => Promise<string>) | undefined;
}

/** The daemon's hosted sessions (the terminal's list reads them from sessions.hosted.list). */
export const HOSTED_SESSIONS_LIST = 'hosted.sessions' as ListName;

/** The saved sessions of this program in this project (terminal-shell session-command.ts reads them). */
export const SAVED_SESSIONS_LIST = 'sessions.saved' as ListName;
/** This conversation's branches. */
export const SESSION_BRANCHES_LIST = 'sessions.branches' as ListName;
/** The handoffs in the cross-session task graph still waiting to be accepted. */
export const WAITING_HANDOFFS_LIST = 'sessions.handoffs.waiting' as ListName;

const SAVED: InputDescription = {
  id: 'session', label: 'Session', help: 'Your saved sessions, newest first', kind: 'choice',
  choices: { list: SAVED_SESSIONS_LIST, allowOther: { reason: 'a session id, the start of one, or its title' } }, required: true, typed: { position: 1 },
};
const NAME: InputDescription = {
  id: 'name', label: 'Name', help: 'A name you choose', kind: 'text', freeTextReason: 'a name you choose',
  required: { default: '', defaultMeans: 'the conversation\'s title' }, typed: { tail: true },
};
const BRANCH: InputDescription = {
  id: 'branch', label: 'Branch', help: 'This conversation\'s branches', kind: 'choice',
  choices: { list: SESSION_BRANCHES_LIST }, required: true, typed: { position: 1 },
};

/** A program that keeps branches of its conversation (the Agent keeps one line). */
function keepsBranches(services: SessionsCapabilityServices): boolean {
  return services.sessions?.keepsBranches !== false;
}

/** A program that joins the daemon's hosted sessions (the terminal app). */
function joinsHosted(services: SessionsCapabilityServices): boolean {
  return services.hostedJoin !== undefined;
}

function live(services: SessionsCapabilityServices): LiveSessions {
  if (!services.sessions) throw new CapabilityRefusal('This turn has no conversation of a terminal program, so it has no saved sessions to act on.', undefined, 'UNAVAILABLE');
  return services.sessions;
}

export const SESSION_CURRENT: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.current', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'current', label: 'See this session', word: 'current', inputs: [],
  sentence: 'Shows this session, the conversation you are in right now: its id, name, when it started, how many messages it has and its model.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) { return { text: await live(services).current() }; },
};

export const SESSION_LIST: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.list', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'list', label: 'See your saved sessions', word: 'list', inputs: [],
  sentence: 'Lists your saved sessions, your old conversations and past chats kept in this project, newest first, with what each was doing when it was left.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) { return { text: await live(services).list() }; },
};

export const SESSION_INFO: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.info', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'info', label: 'See a saved session\'s details', word: 'info',
  inputs: [{ ...SAVED, required: { default: '', defaultMeans: 'this session' } }],
  sentence: 'Shows a saved session: its title, model, provider, date, message count, file and what it was doing.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { session: 'my-notes' },
  async run(values, services) { return { text: await live(services).info(values.session ?? '') }; },
};

export const SESSION_SEARCH: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.search', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'search', label: 'Search saved sessions', word: 'search',
  inputs: [{ id: 'words', label: 'Words', help: 'What to look for in their messages', kind: 'text', freeTextReason: 'your own words', required: true, typed: { tail: true } }],
  sentence: 'Finds the saved sessions (your past chats) whose messages hold {words}, with the matching lines.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { words: 'release' },
  async run(values, services) { return { text: await live(services).search(values.words ?? '') }; },
};

export const SESSION_DELETE: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.delete', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'delete', label: 'Delete a saved session', word: 'delete', inputs: [SAVED],
  sentence: 'Saved session {session} and its messages will be deleted from this project: you get rid of that conversation for good.',
  done: 'Deleted saved session {session} and its messages.',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { session: 'my-notes' },
  async run(values, services) {
    await live(services).remove(values.session ?? '');
    return { text: '' };
  },
};

const RESUME_FORCE: readonly FixedChoice[] = [
  { value: 'no', label: 'Stop and say so' },
  { value: 'yes', label: 'Have it handed over here', help: 'That terminal saves it and lets go first, through the daemon both are attached to.' },
];

/**
 * The preview check of an act that changes the live conversation itself (resume, fork, switch or merge a branch): it
 * cannot run while a turn is running, and a model's call always comes from inside its own turn, so a model's call is
 * refused before anyone is asked, saying why and what the person presses instead. The person's own press runs it.
 */
function notDuringModelTurn(act: string, press: string): NonNullable<CapabilityDefinition<SessionsCapabilityServices>['check']> {
  return (_values, caller) => caller.personAsked === true ? undefined
    : new CapabilityRefusal(`Not done: ${act} changes the conversation this turn is running in, so it cannot run while the model's turn is running; nobody was asked.`,
      `The person does it after the turn: ${press}`);
}

export const SESSION_RESUME: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.resume', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'resume', label: 'Resume a saved session', word: 'resume',
  inputs: [SAVED, {
    id: 'force', label: 'If it is open elsewhere', help: 'Another running terminal may have it open', kind: 'choice', choices: RESUME_FORCE,
    required: { default: 'no', defaultMeans: 'stop and say so' }, typed: { flag: '--force', switchOn: 'yes' },
  }],
  sentence: 'You go back to {session}: this conversation is set aside and that one continues here, with its messages, model and agent records.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { session: 'my-notes' },
  check: notDuringModelTurn('resuming another conversation', 'Enter on it in Sessions'),
  async run(values, services) { return { text: await live(services).resume(values.session ?? '', values.force === 'yes') }; },
};

export const SESSION_FORK: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.fork', group: 'sessions', home: 'session', repeat: 'unsafe' },
  actionId: 'fork', label: 'Continue in a copy of this session', word: 'fork',
  inputs: [{ ...NAME, required: { default: '', defaultMeans: 'fork-of- and this session\'s id' } }],
  sentence: 'A copy of this chat is saved under the name given and you keep going in the copy; this session stays as it is now, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { name: 'try another way' },
  check: notDuringModelTurn('continuing in a copy of this conversation', '"f" on this conversation in Sessions'),
  async run(values, services) { return { text: await live(services).fork(values.name ?? '') }; },
};

export const SESSION_RENAME: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.rename', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'rename', label: 'Rename a saved session', word: 'rename',
  inputs: [
    { ...SAVED, help: 'Your saved sessions, chosen from the list', required: { default: '', defaultMeans: 'the one open here' }, typed: { flag: '--session' } },
    { ...NAME, required: true, help: 'Its new name' },
  ],
  sentence: 'Saved session {session}, one of the saved sessions listed in this project, will be called {name} in the list until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', button: 'Rename', example: { session: 'my-notes', name: 'release notes' },
  async run(values, services) {
    // The program's own line names the session it renamed.
    return { text: await live(services).rename(values.session ?? '', values.name ?? '') };
  },
};

export const SESSION_SAVE_SAVED: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.save-saved', group: 'sessions', home: 'session', repeat: 'unsafe' },
  actionId: 'save-saved', label: 'Export a saved session to a file', word: 'save-saved',
  inputs: [
    { ...SAVED, help: 'Your saved sessions; . is this one' },
    { id: 'format', label: 'As', help: 'The kind of text', kind: 'choice', choices: [{ value: 'markdown', label: 'Markdown' }, { value: 'text', label: 'Plain text' }], required: { default: 'markdown', defaultMeans: 'Markdown' }, typed: { position: 2 } },
    { id: 'where', label: 'Where', help: 'A file, or this screen', kind: 'choice', choices: [{ value: 'file', label: 'Write it to a file' }, { value: 'here', label: 'Print it here', help: 'Shown only, never part of this conversation' }], required: { default: 'file', defaultMeans: 'a file' }, typed: { flag: '--print', switchOn: 'here' } },
    { id: 'path', label: 'File', help: 'Where to write it', kind: 'path', freeTextReason: 'a file path', required: { default: '', defaultMeans: 'a new file in ~/goodvibes-exports' }, typed: { flag: '--out' }, showWhen: { input: 'where', is: 'file' } },
  ],
  sentence: 'The redacted transcript of {session}, a saved conversation, will be written out as text ({format}); an existing file is never replaced.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { session: 'my-notes', format: 'text' },
  async run(values, services) {
    const print = values.where === 'here';
    return { text: await live(services).exportSaved({ target: values.session ?? '', format: values.format === 'text' ? 'text' : 'markdown', path: print ? '' : values.path ?? '', print }) };
  },
};

export const SESSION_UPLOAD: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.upload', group: 'sessions', home: 'session', repeat: 'unsafe' },
  actionId: 'upload', label: 'Upload this conversation and get a link', word: 'upload',
  inputs: [
    { id: 'format', label: 'As', help: 'The kind of file', kind: 'choice', choices: [{ value: 'html', label: 'A web page' }, { value: 'md', label: 'Markdown' }, { value: 'json', label: 'JSON' }], required: { default: 'html', defaultMeans: 'a web page' }, typed: { position: 1 } },
    { id: 'redact', label: 'Keys and paths', help: 'API keys, tokens and your home path and login name', kind: 'choice', choices: [
      { value: 'hide', label: 'Hide them' },
      { value: 'keep', label: 'Send them as stored', help: 'Anyone with the link reads them, and copies cannot be recalled.' },
    ], required: { default: 'hide', defaultMeans: 'hide them' }, typed: { flag: '--keep-secrets', switchOn: 'keep' } },
    { id: 'open', label: 'Then', help: 'What to do with the local copy', kind: 'choice', choices: [
      { value: 'nothing', label: 'Nothing more' }, { value: 'open', label: 'Open it in the browser' }, { value: 'copy', label: 'Copy its path' },
    ], required: { default: 'nothing', defaultMeans: 'nothing more' }, typed: { flag: '--then' } },
  ],
  sentence: 'This conversation ({format}) will be written to a file and uploaded as a secret GitHub Gist that anyone with its link can read.', done: '',
  touches: 'another-machine', lasts: 'not-a-change', risk: 'sends-out',
  ownerOnly: { reason: 'it sends the conversation outside this machine', instead: 'Save it as a file instead: This conversation, "Save or export this conversation as a file".' },
  example: { format: 'md' }, available: (services) => services.sessions?.uploads !== false,
  async run(values, services) {
    const format = values.format === 'md' || values.format === 'json' ? values.format : 'html';
    return { text: await live(services).upload({ format, redact: values.redact !== 'keep', open: values.open === 'open', copy: values.open === 'copy' }) };
  },
};

export const SESSION_BRANCHES: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.branches', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'branches', label: 'See this conversation\'s branches', word: 'branches', inputs: [],
  sentence: 'Lists the branches of this conversation and which one you are on.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {}, available: keepsBranches,
  async run(_values, services) { return { text: await live(services).branches() }; },
};

export const SESSION_SWITCH_BRANCH: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.switch-branch', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'switch-branch', label: 'Switch to a branch', word: 'switch-branch', inputs: [BRANCH],
  sentence: 'The conversation goes on from branch {branch} until you change it.', done: 'The conversation goes on from branch {branch} now.',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { branch: 'main' }, available: keepsBranches,
  check: notDuringModelTurn('switching to another branch', 'Enter on the branch in Sessions, Branches'),
  async run(values, services) {
    // The done line says it; the program's own line says the same.
    await live(services).switchBranch(values.branch ?? '');
    return { text: '' };
  },
};

export const SESSION_MERGE_BRANCH: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.merge-branch', group: 'sessions', home: 'session', repeat: 'unsafe' },
  actionId: 'merge-branch', label: 'Bring a branch\'s new messages in', word: 'merge-branch', inputs: [BRANCH],
  sentence: 'The messages branch {branch} gained after it was made are brought back into this conversation, until you change it.',
  done: 'The new messages of branch {branch} are in this conversation now.',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { branch: 'before refactor' }, available: keepsBranches,
  check: notDuringModelTurn('bringing in a branch\'s new messages', '"m" on the branch in Sessions, Branches'),
  async run(values, services) {
    await live(services).mergeBranch(values.branch ?? '');
    return { text: '' };
  },
};

// ---------------------------------------------------------------------------
// This conversation's record, read through
// ---------------------------------------------------------------------------

/** Every kind of entry in a conversation's record; keyed by the union, so a new kind fails to compile until it is listed. */
const RECORD_KINDS: Record<TranscriptEventKind, true> = {
  user_input: true, assistant_output: true, tool_call: true, tool_result: true, approval_request: true, approval_resolution: true,
  task_transition: true, remote_status: true, policy_warning: true, artifact_preview: true, contract_state: true, session_restore: true,
  diagnostic_notice: true, system_notice: true,
};
const KINDS: readonly FixedChoice[] = [
  { value: 'all', label: 'Everything' },
  ...Object.keys(RECORD_KINDS).map((kind) => ({ value: kind, label: kind.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase()) })),
];
const KIND: InputDescription = {
  id: 'kind', label: 'Kind', help: 'Only one kind of entry', kind: 'choice', choices: KINDS,
  required: { default: 'all', defaultMeans: 'everything' }, typed: { position: 1 },
};
const JUMP_KIND: InputDescription = {
  id: 'kind', label: 'To', help: 'Which kind of entry', kind: 'choice',
  choices: [{ value: 'error', label: 'Errors' }, ...KINDS.map((choice) => choice.value === 'all' ? { value: 'all', label: 'Any entry' } : choice)],
  required: { default: 'all', defaultMeans: 'any entry' }, typed: { position: 1 },
};
const START: InputDescription = {
  id: 'start', label: 'From row', help: 'The first row to show', kind: 'number', freeTextReason: 'a row number from 1',
  required: { default: '', defaultMeans: 'the newest page' }, typed: { position: 2 },
};
const LAST: InputDescription = {
  id: 'last', label: 'How many', help: 'How many rows to show', kind: 'number', freeTextReason: 'a whole number',
  required: { default: '', defaultMeans: 'one page' }, typed: { flag: '--last' },
};

function review(view: 'events' | 'groups' | 'hotspots', id: string, label: string, sentence: string, example: Readonly<Record<string, string>>): CapabilityDefinition<SessionsCapabilityServices> {
  return {
    capability: { id, group: 'sessions', home: 'session', repeat: 'safe' },
    actionId: view, label, word: view, inputs: view === 'hotspots' ? [KIND] : [KIND, START, LAST],
    sentence, done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none', example,
    async run(values, services) {
      return { text: await live(services).review(view, { kind: values.kind ?? '', start: values.start ?? '', last: values.last ?? '' }) };
    },
  };
}

export const SESSION_EVENTS = review('events', 'session.events', 'See this conversation\'s events',
  'Shows the conversation\'s record entry by entry (messages, tool calls, approvals), newest page first.', { kind: 'tool_call', last: '20' });
export const SESSION_GROUPS = review('groups', 'session.groups', 'See this conversation turn by turn',
  'Shows the conversation\'s record grouped by turn, newest page first.', { kind: 'all' });
export const SESSION_HOTSPOTS = review('hotspots', 'session.hotspots', 'See where this conversation spent most',
  'Counts the whole record by what took the most entries.', { kind: 'tool_call' });

export const SESSION_FIND: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.find', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'find', label: 'Find words in this conversation', word: 'find',
  inputs: [
    { id: 'words', label: 'Words', help: 'What to look for', kind: 'text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'search in place, as Ctrl+F does' }, typed: { tail: true } },
    { ...KIND, typed: { flag: '--kind' } },
  ],
  sentence: 'Lists the entries of this conversation that hold the words given; with none, searches in place.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { words: 'approval', kind: 'approval_request' },
  async run(values, services, caller) { return { text: await live(services).find(values.words ?? '', values.kind || 'all', { opensScreen: caller.personAsked === true }) }; },
};

function jump(direction: 'next' | 'prev'): CapabilityDefinition<SessionsCapabilityServices> {
  return {
    capability: { id: `session.${direction}`, group: 'sessions', home: 'session', repeat: 'unsafe' },
    actionId: direction, label: direction === 'next' ? 'Jump to the next entry' : 'Jump to the previous entry', word: direction, inputs: [JUMP_KIND],
    sentence: direction === 'next' ? 'Scrolls to the next entry of the kind chosen, after where you are.' : 'Scrolls to the previous entry of the kind chosen, before where you are.',
    done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { kind: direction === 'next' ? 'error' : 'tool_result' },
    async run(values, services) { return { text: await live(services).jump(direction, values.kind || 'all') }; },
  };
}

export const SESSION_NEXT = jump('next');
export const SESSION_PREV = jump('prev');

export const SESSION_BOOKMARKS: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.bookmarks', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'bookmarks', label: 'See bookmarked blocks', word: 'bookmarks',
  inputs: [{ id: 'block', label: 'Block', help: 'A bookmarked block to move the conversation to', kind: 'text', freeTextReason: 'a bookmark\'s key', required: { default: '', defaultMeans: 'list them' }, typed: { position: 1 } }],
  sentence: 'Lists the blocks you bookmarked in this conversation, or moves the conversation to the one given.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(values, services, caller) { return { text: await live(services).bookmarks((values.block ?? '').trim(), caller.personAsked !== true) }; },
};

export const SESSION_COMPOSER: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.composer', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'composer', label: 'See what the composer waits on', word: 'composer', inputs: [],
  sentence: 'Shows the composer\'s mode, what it waits on, the turn\'s state and how full the context is.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) { return { text: await live(services).composer() }; },
};

export const SESSION_RESTORED: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.restored', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'restored', label: 'See what a resume brought back', word: 'restored', inputs: [],
  sentence: 'Lists the entries a resume restored: approvals, tasks, remote state and notices.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) { return { text: await live(services).restored() }; },
};

// ---------------------------------------------------------------------------
// The cross-session task graph: the project's one file for both terminal programs
// ---------------------------------------------------------------------------

/** A program that changes the task graph. */
function changesGraph(services: SessionsCapabilityServices): boolean {
  return services.sessions?.changesTaskGraph !== false;
}

const TASK: InputDescription = { id: 'task', label: 'Task', help: 'The task\'s id', kind: 'text', freeTextReason: 'a task id', required: true, typed: { position: 1 } };
const TASK_SESSION: InputDescription = {
  id: 'from', label: 'In session', help: 'The session the task belongs to', kind: 'text', freeTextReason: 'a session id',
  required: { default: '', defaultMeans: 'this session' }, typed: { flag: '--session' },
};
const HANDOFF: InputDescription = {
  id: 'handoff', label: 'Hand-off', help: 'Hand-offs waiting to be accepted', kind: 'choice', choices: { list: WAITING_HANDOFFS_LIST, allowOther: { reason: 'a hand-off id' } },
  required: true, typed: { position: 1 },
};

export const SESSION_GRAPH: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.graph', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'graph', label: 'See the tasks handed between sessions', word: 'graph',
  inputs: [
    { id: 'session', label: 'Session', help: 'Only one session\'s tasks', kind: 'text', freeTextReason: 'a session id or its start', required: { default: '', defaultMeans: 'every session' }, typed: { flag: '--session' } },
    { id: 'format', label: 'As', help: 'Text, or JSON for programs', kind: 'choice', choices: [{ value: 'text', label: 'Text' }, { value: 'json', label: 'JSON' }], required: { default: 'text', defaultMeans: 'text' }, typed: { flag: '--format' } },
  ],
  sentence: 'Shows the cross-session task graph of this project: the tasks linked across sessions, what each waits on, and the hand-offs waiting.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { format: 'json' },
  async run(values, services, caller) {
    const session = values.session ?? '';
    const format = values.format || 'text';
    const text = await live(services).graph({ session, format });
    if (format !== 'text' || caller.personAsked === true) return { text };
    // The words name sessions by title for a person; a model acts by id, so it also reads the graph as data, ids whole.
    const data = await live(services).graph({ session, format: 'json' });
    return { text: `${text}\n\nThe graph as data, every id whole:\n${data}` };
  },
};

export const SESSION_LINK_TASK: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.link-task', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'link-task', label: 'Add a task to the cross-session graph', word: 'link-task',
  inputs: [
    TASK, TASK_SESSION,
    { id: 'after', label: 'Waits on', help: 'A task it depends on, as session:task or a task of the same session', kind: 'text', freeTextReason: 'a task reference', required: { default: '', defaultMeans: 'nothing' }, typed: { flag: '--depends-on' } },
    { id: 'label', label: 'Label', help: 'A short name to show for it', kind: 'text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'its id' }, typed: { flag: '--label' } },
  ],
  sentence: 'Task {task} will be in this project\'s cross-session task graph, with what it waits on, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { task: 'build', after: 'other:lint' }, available: changesGraph,
  async run(values, services) {
    return { text: await live(services).linkTask({ task: (values.task ?? '').trim(), from: values.from ?? '', after: values.after ?? '', label: values.label ?? '' }) };
  },
};

export const SESSION_HAND_OFF: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.hand-off', group: 'sessions', home: 'session', repeat: 'unsafe' },
  actionId: 'hand-off', label: 'Hand a task to another session', word: 'hand-off',
  inputs: [
    TASK,
    { id: 'to', label: 'To session', help: 'The session that takes it over', kind: 'choice', choices: { list: SAVED_SESSIONS_LIST, allowOther: { reason: 'a session id' } }, required: true, typed: { flag: '--to' } },
    TASK_SESSION,
    { id: 'reason', label: 'Why', help: 'A note the other session sees', kind: 'long-text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'no note' }, typed: { flag: '--reason' } },
  ],
  sentence: 'Task {task} is handed to session {to} and waits, blocked, until that session accepts it or you take it back.', done: '',
  // The Agent hands off its own session's tasks too (its routines refuse another session's in words).
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', undoneBy: 'withdraw', example: { task: 'build', to: 'user-1a2b3c4d' }, available: changesGraph,
  async run(values, services) {
    return { text: await live(services).handOff({ task: (values.task ?? '').trim(), to: (values.to ?? '').trim(), from: values.from ?? '', reason: values.reason ?? '' }) };
  },
};

export const SESSION_ACCEPT: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.accept', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'accept', label: 'Accept a task handed to a session', word: 'accept', inputs: [HANDOFF],
  sentence: 'Hand-off {handoff} is accepted for the session it was handed to, and its task is no longer blocked.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { handoff: 'h-1' }, available: changesGraph,
  async run(values, services) { return { text: await live(services).accept((values.handoff ?? '').trim()) }; },
};

export const SESSION_WITHDRAW: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.withdraw', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'withdraw', label: 'Take back a task you handed off', word: 'withdraw', inputs: [HANDOFF],
  sentence: 'Hand-off {handoff} is taken back and its task goes back to the state it had before it was handed off.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { handoff: 'h-1' }, available: changesGraph,
  async run(values, services) { return { text: await live(services).withdraw((values.handoff ?? '').trim()) }; },
};

export const SESSION_CANCEL: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.cancel', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'cancel', label: 'Cancel tasks in the cross-session graph', word: 'cancel',
  inputs: [
    { id: 'scope', label: 'What', help: 'One task, it and what waits on it, or every task of a session', kind: 'choice', choices: [
      { value: 'task', label: 'Only this task' }, { value: 'subtree', label: 'This task and everything waiting on it' }, { value: 'session', label: 'Every task in the session' },
    ], required: { default: 'task', defaultMeans: 'only this task' }, typed: { flag: '--scope' } },
    { ...TASK, showWhen: { input: 'scope', is: 'task' } },
    { id: 'root', label: 'Task', help: 'The task whose waiting tasks go too', kind: 'text', freeTextReason: 'a task id', required: true, typed: { flag: '--task' }, showWhen: { input: 'scope', is: 'subtree' } },
    TASK_SESSION,
    { id: 'reason', label: 'Why', help: 'A note kept with each cancelled task', kind: 'long-text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'no note' }, typed: { flag: '--reason' } },
  ],
  sentence: 'Task {task} of the cross-session task graph will be cancelled, with what waits on it or every task of its session when that is chosen; a cancelled task does not start again.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { scope: 'task', task: 'build' }, available: changesGraph,
  async run(values, services) {
    return { text: await live(services).cancelTasks({ scope: values.scope || 'task', task: values.task ?? '', root: values.root ?? '', from: values.from ?? '', reason: values.reason ?? '' }) };
  },
};

function joining(services: SessionsCapabilityServices): HostedJoin {
  if (!services.hostedJoin) throw new CapabilityRefusal('Only the terminal app joins hosted sessions; this program cannot join one.', undefined, 'UNAVAILABLE');
  return services.hostedJoin;
}

export const HOSTED_STATUS: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'hosted.status', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'see-joined', label: 'See the hosted session you are in', word: 'status', inputs: [],
  sentence: 'Shows the hosted session this terminal joined, what leaving it would do, and the tool running in it.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {}, available: joinsHosted,
  async run(_values, services) { return { text: await joining(services).status() }; },
};

const HOSTED_SESSION: InputDescription = {
  id: 'session', label: 'Session', help: 'The hosted sessions the daemon has', kind: 'choice',
  choices: { list: HOSTED_SESSIONS_LIST, allowOther: { reason: 'a session id' } },
  required: true, typed: { position: 1 },
};

export const HOSTED_ATTACH: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'hosted.attach', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'join', label: 'Join a hosted session', word: 'attach', inputs: [HOSTED_SESSION],
  sentence: 'This terminal joins hosted session {session}, shows its conversation so far and follows it live.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', undoneBy: 'leave', example: { session: 'hs-1' }, available: joinsHosted,
  // Only the person's own press opens Your agents on his screen; a model's join follows the session without it.
  async run(values, services, caller) { return { text: await joining(services).join(values.session ?? '', { opensScreen: caller.personAsked === true }) }; },
};

export const HOSTED_SEND: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'hosted.send', group: 'sessions', home: 'session', repeat: 'unsafe' },
  actionId: 'send-now', label: 'Send a message now', word: 'send',
  inputs: [{ id: 'text', label: 'Message', help: 'What to tell it; a turn it is running reads it at its next step', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } }],
  sentence: '"{text}" will be sent to the hosted session now: into the turn it is running, at its next step, or as a new turn when none runs.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { text: 'focus on the failing test' }, available: joinsHosted,
  async run(values, services, caller) { return { text: await joining(services).send((values.text ?? '').trim(), caller.personAsked === true) }; },
};

export const HOSTED_LEAVE: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'hosted.leave', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'leave', label: 'Leave the hosted session', word: 'leave', inputs: [],
  sentence: 'This terminal leaves the hosted session without stopping it: it keeps running or ends, as its "when everyone leaves" setting says.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', undoneBy: 'join', example: {}, available: joinsHosted,
  async run(_values, services) { return { text: await joining(services).leave() }; },
};

/** The hosted-session record's words a person reads (sessions.hosted.create answers one). */
function startedWords(session: Readonly<Record<string, unknown>>): string {
  const title = typeof session.title === 'string' && session.title ? `"${session.title}"` : 'a hosted session';
  // The project by its folder's name: a whole path is a word a screen line cannot hold.
  const where = typeof session.workspaceRoot === 'string' && session.workspaceRoot ? ` in ${session.workspaceRoot.split('/').filter(Boolean).at(-1) ?? session.workspaceRoot}` : '';
  const leave = session.effectiveDetachPolicy === 'survive'
    ? 'It keeps running when the last one who joined it leaves.'
    : 'It ends when the last one who joined it leaves.';
  return `Started ${title}${where}. ${leave}`;
}

/** The hosted session's own needs nothing of the daemon's stores: it is the daemon's method, run as the caller. */
export type HostedCapabilityServices = Readonly<Record<never, never>>;

/** Run the daemon method that does this act, as the same caller. */
async function hostedMethod(caller: CapabilityCaller, methodId: string, body: Record<string, unknown>): Promise<Readonly<Record<string, unknown>>> {
  if (!caller.method) throw new CapabilityRefusal('This runs in the daemon, and no daemon took the request here; nothing was done.', undefined, 'UNAVAILABLE');
  const answer = await caller.method(methodId, body);
  return answer !== null && typeof answer === 'object' && !Array.isArray(answer) ? answer as Readonly<Record<string, unknown>> : {};
}

function hostedRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

/** One hosted session as a line a person reads: its title, what it is doing, who joined it, what leaving does. */
function hostedLine(session: Readonly<Record<string, unknown>>): string {
  const title = typeof session.title === 'string' && session.title ? `"${session.title}"` : 'An untitled hosted session';
  const doing = session.status === 'running' ? 'running a turn' : session.status === 'terminated'
    ? `ended (${typeof session.terminatedReason === 'string' ? session.terminatedReason : 'no reason recorded'})` : 'waiting';
  const joined = Array.isArray(session.attachedClients) && session.attachedClients.length > 0 ? `joined by ${session.attachedClients.length}` : 'nobody joined';
  const leave = session.status === 'terminated' ? '' : session.effectiveDetachPolicy === 'survive' ? '; it keeps running when the last one leaves' : '; it ends when the last one leaves';
  const where = typeof session.workspaceRoot === 'string' ? ` in ${session.workspaceRoot}` : '';
  return `${title}${where}: ${doing}, ${joined}${leave}.`;
}

export const HOSTED_LIST: CapabilityDefinition<HostedCapabilityServices> = {
  capability: { id: 'hosted.list', group: 'sessions', home: 'daemon', repeat: 'safe' },
  actionId: 'see-all', label: 'See hosted sessions', word: 'list',
  inputs: [{ id: 'ended', label: 'Ended ones too', help: 'Also the ones that have ended and are still kept', kind: 'choice', choices: [{ value: 'no', label: 'Only running ones' }, { value: 'yes', label: 'Ended ones too' }], required: { default: 'no', defaultMeans: 'only running ones' }, typed: { flag: '--all', switchOn: 'yes' } }],
  sentence: 'Lists the conversations the daemon hosts, who has joined each, and what leaving would do.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { ended: 'yes' },
  async run(values, _services, caller) {
    const ended = values.ended === 'yes';
    const answer = await hostedMethod(caller, 'sessions.hosted.list', ended ? { includeTerminated: true } : {});
    const sessions = Array.isArray(answer.sessions) ? answer.sessions.map(hostedRecord) : [];
    if (sessions.length === 0) return { text: ended ? 'The daemon hosts no conversation and keeps no ended one.' : 'The daemon hosts no conversation now.', data: { sessions } };
    return { text: [`The daemon hosts ${sessions.length} conversation${sessions.length === 1 ? '' : 's'}${ended ? ', ended ones included' : ''}:`, ...sessions.map((session) => `  ${hostedLine(session)} (id ${String(session.id)})`)].join('\n'), data: { sessions } };
  },
};

export const HOSTED_END: CapabilityDefinition<HostedCapabilityServices> = {
  capability: { id: 'hosted.end', group: 'sessions', home: 'daemon', repeat: 'safe' },
  actionId: 'end', label: 'End a hosted session', word: 'end',
  inputs: [{ ...HOSTED_SESSION, choices: { list: HOSTED_SESSIONS_LIST, allowOther: { reason: 'a session id' } } }],
  sentence: 'Hosted session {session} and the turn it is running will end, whatever its setting says.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { session: 'hs-1' },
  async run(values, _services, caller) {
    const sessionId = (values.session ?? '').trim();
    if (/^\d+$/.test(sessionId)) throw new CapabilityRefusal(`${sessionId} is a list number; ending a session takes its id, so nothing was ended.`, 'The list of hosted sessions gives each one\'s id.');
    const answer = await hostedMethod(caller, 'sessions.hosted.kill', { sessionId });
    const session = hostedRecord(answer.session);
    const title = typeof session.title === 'string' && session.title ? `"${session.title}"` : 'the hosted session';
    // `killed` is this act itself; any other reason means it had already ended before (kill returns that record).
    const reason = typeof session.terminatedReason === 'string' && session.terminatedReason !== 'killed' ? ` It had already ended (${session.terminatedReason}).` : '';
    return { text: `Ended ${title}.${reason}`, data: { session } };
  },
};

export const HOSTED_NEW: CapabilityDefinition<HostedCapabilityServices> = {
  capability: { id: 'hosted.new', group: 'sessions', home: 'daemon', repeat: 'unsafe' },
  actionId: 'start', label: 'Start a hosted session', word: 'new',
  inputs: [
    { id: 'prompt', label: 'First message', help: 'What it should start on, the way you would ask in the chat', kind: 'long-text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'nothing yet' }, typed: { tail: true } },
    { id: 'leave', label: 'When everyone leaves', help: 'Whether it keeps running once no terminal or browser has it open', kind: 'choice', choices: [
      { value: 'keep', label: 'Keep running', help: 'It waits, idle, to be joined again.' },
      { value: 'stop', label: 'Stop it', help: 'It ends when the last one leaves.' },
    ], required: { default: '', defaultMeans: 'as hostedSessions.detachPolicy says' }, typed: { flag: '--on-leave' } },
  ],
  sentence: 'A conversation will start in the daemon for this project, the folder you asked from; it lasts until you change it (ending it, or as "When everyone leaves" says).',
  done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'end',
  example: { prompt: 'summarise the open issues', leave: 'keep' },
  callerNeeds: { project: 'No project folder came with the request, so no hosted session was started. Ask from the project\'s folder, or send workingDirectory with the request.' },
  async run(values, _services, caller) {
    // The project is the caller's own folder (from context, never asked): the folder its program works in.
    if (!caller.workingDirectory) throw new CapabilityRefusal('No project folder came with the request, so no hosted session was started.', 'Ask from the project\'s folder, or send workingDirectory with the request.');
    const prompt = (values.prompt ?? '').trim();
    const detachPolicy = values.leave === 'keep' ? 'survive' : values.leave === 'stop' ? 'kill' : undefined;
    const answer = await hostedMethod(caller, 'sessions.hosted.create', {
      workspaceRoot: caller.workingDirectory,
      // The asking program's own kind of session: from the Agent one that answers as the Agent. The daemon starts an
      // Agent session only for a creator holding full operator authority (routes/hosted-sessions.ts): the Agent's own
      // press carries this machine's credential (its ownerPressBinding); its model's call is refused in the daemon's words.
      ...(caller.program === 'tui' || caller.program === 'agent' ? { originSurface: caller.program } : {}),
      ...(prompt ? { initialPrompt: prompt } : {}),
      ...(detachPolicy ? { detachPolicy } : {}),
    });
    const session = hostedRecord(answer.session);
    return { text: startedWords(session), data: { session } };
  },
};
