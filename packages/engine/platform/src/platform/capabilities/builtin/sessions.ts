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
  /** Give this session a new name. */
  rename(name: string): Promise<string>;
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
  find(words: string, kind: string): Promise<string>;
  /** Move the view to the next or previous entry of a kind (`error`: an error). */
  jump(direction: 'next' | 'prev', kind: string): Promise<string>;
  /** What the composer waits on. */
  composer(): Promise<string>;
  /** What the last resume brought back. */
  restored(): Promise<string>;
  /** The bookmarked blocks, to jump to one. */
  bookmarks(): Promise<string>;
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
  status(): Promise<string>;
  join(session: string): Promise<string>;
  send(text: string): Promise<string>;
  leave(): Promise<string>;
  /** Queue a message to run after the joined session's current turn (hosted.send-later, builtin/conversation-controls.ts). */
  readonly sendLater?: ((text: string) => Promise<string>) | undefined;
}

/** The daemon's hosted sessions (the terminal's list reads them from sessions.hosted.list). */
export const HOSTED_SESSIONS_LIST = 'hosted.sessions' as ListName;

/** The saved sessions of this program in this project (terminal-shell session-command.ts reads them). */
export const SAVED_SESSIONS_LIST = 'sessions.saved' as ListName;
/** This conversation's branches. */
export const SESSION_BRANCHES_LIST = 'sessions.branches' as ListName;

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
  sentence: 'Lists your saved sessions, the past conversations kept in this project, newest first, with what each was doing when it was left.', done: '',
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

export const SESSION_RESUME: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.resume', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'resume', label: 'Resume a saved session', word: 'resume',
  inputs: [SAVED, {
    id: 'force', label: 'If it is open elsewhere', help: 'Another running terminal may have it open', kind: 'choice', choices: RESUME_FORCE,
    required: { default: 'no', defaultMeans: 'stop and say so' }, typed: { flag: '--force', switchOn: 'yes' },
  }],
  sentence: 'You go back to {session}: this conversation is set aside and that one continues here, with its messages, model and agent records.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { session: 'my-notes' },
  async run(values, services) { return { text: await live(services).resume(values.session ?? '', values.force === 'yes') }; },
};

export const SESSION_FORK: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.fork', group: 'sessions', home: 'session', repeat: 'unsafe' },
  actionId: 'fork', label: 'Continue in a copy of this session', word: 'fork',
  inputs: [{ ...NAME, required: { default: '', defaultMeans: 'fork-of- and this session\'s id' } }],
  sentence: 'A copy of this chat is saved under the name given and you keep going in the copy; this session stays as it is now, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { name: 'try another way' },
  async run(values, services) { return { text: await live(services).fork(values.name ?? '') }; },
};

export const SESSION_RENAME: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'session.rename', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'rename', label: 'Give this session a new name', word: 'rename',
  inputs: [{ ...NAME, required: true, help: 'Its new name' }],
  sentence: 'This session, the conversation you are in, will be called {name} until you change it.', done: 'This session is called {name} now.',
  touches: 'this-machine', lasts: 'kept', risk: 'none', button: 'Rename', example: { name: 'release notes' },
  async run(values, services) {
    // The done line says it; the program's own line says the same.
    await live(services).rename(values.name ?? '');
    return { text: '' };
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
  ownerOnly: { reason: 'it sends the conversation outside this machine', instead: 'Save it as a file instead: /session save-file' },
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
  async run(values, services) { return { text: await live(services).find(values.words ?? '', values.kind || 'all') }; },
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
  actionId: 'bookmarks', label: 'See bookmarked blocks', word: 'bookmarks', inputs: [],
  sentence: 'Lists the blocks you bookmarked (Ctrl+B) and jumps to one.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) { return { text: await live(services).bookmarks() }; },
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
  choices: { list: HOSTED_SESSIONS_LIST, allowOther: { reason: 'a session id, or its number in the last list of hosted sessions' } },
  required: true, typed: { position: 1 },
};

export const HOSTED_ATTACH: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'hosted.attach', group: 'sessions', home: 'session', repeat: 'safe' },
  actionId: 'join', label: 'Join a hosted session', word: 'attach', inputs: [HOSTED_SESSION],
  sentence: 'This terminal joins hosted session {session}, shows its conversation so far and follows it live.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', undoneBy: 'leave', example: { session: 'hs-1' }, available: joinsHosted,
  async run(values, services) { return { text: await joining(services).join(values.session ?? '') }; },
};

export const HOSTED_SEND: CapabilityDefinition<SessionsCapabilityServices> = {
  capability: { id: 'hosted.send', group: 'sessions', home: 'session', repeat: 'unsafe' },
  actionId: 'send-now', label: 'Send a message now', word: 'send',
  inputs: [{ id: 'text', label: 'Message', help: 'What to tell it; it reads it during the turn it is in', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } }],
  sentence: '"{text}" will be sent to the hosted session now, into the turn it is running.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { text: 'focus on the failing test' }, available: joinsHosted,
  async run(values, services) { return { text: await joining(services).send((values.text ?? '').trim()) }; },
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
  sentence: 'A conversation will start in the daemon for this project, the folder you asked from; it lasts until you change it (ending it, or as "When everyone leaves" says). The terminal app that starts it joins it.',
  done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'end',
  example: { prompt: 'summarise the open issues', leave: 'keep' },
  async run(values, _services, caller) {
    // The project is the caller's own folder (from context, never asked): the folder its program works in.
    if (!caller.workingDirectory) throw new CapabilityRefusal('No project folder came with the request, so no hosted session was started.', 'Ask from the project\'s folder, or send workingDirectory with the request.');
    const prompt = (values.prompt ?? '').trim();
    const detachPolicy = values.leave === 'keep' ? 'survive' : values.leave === 'stop' ? 'kill' : undefined;
    const answer = await hostedMethod(caller, 'sessions.hosted.create', {
      workspaceRoot: caller.workingDirectory,
      // The terminal app's own kind of session. From the Agent it is not one that answers as the Agent (that needs an
      // admin credential the Agent's connection does not hold): the daemon's ordinary hosted conversation.
      ...(caller.program === 'tui' ? { originSurface: 'tui' } : {}),
      ...(prompt ? { initialPrompt: prompt } : {}),
      ...(detachPolicy ? { detachPolicy } : {}),
    });
    const session = hostedRecord(answer.session);
    return { text: startedWords(session), data: { session } };
  },
};
