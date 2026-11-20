/**
 * `/session`, described once (command-actions/): every session action in one
 * guided list. This session and the saved ones (see, resume, save, copy,
 * rename, search, delete), the conversation's record (events, groups,
 * hotspots), saving it as a file or uploading it for a link, its branches, and
 * the cross-session task graph (link, hand off, accept, take back, cancel).
 * `/resume` and `/save` are their own single-action commands built from the
 * same action definitions `/session` lists. Both terminal apps register this
 * one description; what each app does differently is its policy, read by the
 * actions' `run`.
 */
import type { SessionManager, CancellationScope, CrossSessionTaskRef } from '@goodvibes/engine/platform/platform/sessions';
import { VALID_SCOPES } from '@goodvibes/engine/platform/platform/sessions';
import type { ShellSessionOrchestrationService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionDescription, CommandActionContext, CommandDescription, FixedChoice, InputDescription } from './command-actions/types.js';
import type { TranscriptFormat } from './session-export-format.js';
import { TRANSCRIPT_EVENT_KINDS } from './transcript-kinds.js';

interface BranchingConversation {
  listBranches?(): readonly { readonly name: string; readonly messageCount: number; readonly isCurrent: boolean }[];
}

export interface SessionCommandContext extends CommandActionContext {
  readonly session: {
    readonly sessionManager?: Pick<SessionManager, 'list'> | null | undefined;
    readonly runtime: { readonly sessionId: string };
    readonly conversationManager: unknown;
  };
  readonly ops: { readonly sessionOrchestration?: ShellSessionOrchestrationService | null | undefined };
}

/** What each app does for the actions whose work is its own. */
export interface SessionCommandPolicy<Ctx> {
  readonly workflow: {
    current(ctx: Ctx): void;
    list(ctx: Ctx): void;
    rename(ctx: Ctx, name: string): void;
    save(ctx: Ctx, input: { readonly name: string; readonly replace: boolean; readonly switchTo: boolean }): void;
    fork(ctx: Ctx, name: string): void;
    info(ctx: Ctx, target: string): void;
    search(ctx: Ctx, words: string): void;
    review(ctx: Ctx, view: 'events' | 'groups' | 'hotspots', input: { readonly kind: string; readonly start: string; readonly last: string }): Promise<void>;
    remove(ctx: Ctx, target: string): void;
  };
  readonly resume: (ctx: Ctx, input: { readonly target: string; readonly force: boolean }) => Promise<void>;
  readonly exportSaved: (ctx: Ctx, input: { readonly target: string; readonly format: TranscriptFormat; readonly path: string; readonly print: boolean }) => Promise<void>;
  /** Whether a file is at this path now (an export there would replace it). */
  readonly fileExists: (ctx: Ctx, path: string) => boolean;
  readonly saveFile: (ctx: Ctx, input: { readonly format: 'markdown' | 'text' | 'html' | 'json'; readonly path: string; readonly redact: boolean; readonly open: boolean; readonly copy: boolean }) => Promise<string | void>;
  readonly upload: (ctx: Ctx, input: { readonly format: 'html' | 'json' | 'md'; readonly redact: boolean; readonly open: boolean; readonly copy: boolean }) => Promise<void>;
  readonly branches: {
    create(ctx: Ctx, name: string): void;
    list(ctx: Ctx): void;
    switchTo(ctx: Ctx, name: string): void;
    merge(ctx: Ctx, name: string): void;
  };
  /** Looking through the open conversation. */
  readonly look: {
    /** Words found in the record; with no words, the app's in-place search when it has one. */
    find(ctx: Ctx, words: string, kind: string): Promise<void>;
    /** Scroll to the next or previous entry of a kind, or of an error (`error`). */
    jump(ctx: Ctx, direction: 'next' | 'prev', kind: string): Promise<void>;
    composer(ctx: Ctx): void;
    restored(ctx: Ctx): Promise<void>;
    blocks(ctx: Ctx, type: string, fold: boolean): void;
    bookmarks(ctx: Ctx): void;
    /** What compaction removed so far; undefined when this app keeps no such record. */
    compactions: ((ctx: Ctx) => void) | undefined;
  };
  /** Why this app may only read the cross-session task graph, or undefined when it may change it. */
  readonly graphReadOnly: string | undefined;
  readonly graph: (ctx: Ctx, input: { readonly session: string; readonly format: string }) => void;
}

// ---------------------------------------------------------------------------
// Live lists, read only when a guided step or a completion asks
// ---------------------------------------------------------------------------

const SAVED_SESSIONS = defineList<SessionCommandContext>({
  name: 'sessions.saved',
  async read(ctx) {
    const manager = ctx.session.sessionManager;
    if (!manager) return [];
    return manager.list().filter((meta) => meta.name !== ctx.session.runtime.sessionId).map((meta): ListRow => ({
      value: meta.name, label: meta.title || meta.name,
      detail: `${meta.name} · ${new Date(meta.timestamp).toLocaleString()}${meta.model ? ` · ${meta.model}` : ''}`,
      state: `${meta.messageCount} message${meta.messageCount === 1 ? '' : 's'}`,
    }));
  },
  operator: { method: 'sessions.list', input: {}, rows: { from: 'sessions', value: 'id', label: 'title' } },
});

const BRANCHES = defineList<SessionCommandContext>({
  name: 'sessions.branches',
  async read(ctx) {
    const conversation = ctx.session.conversationManager as BranchingConversation;
    return (conversation.listBranches?.() ?? []).map((branch): ListRow => ({
      value: branch.name, label: branch.name, state: `${branch.isCurrent ? 'current, ' : ''}${branch.messageCount} message${branch.messageCount === 1 ? '' : 's'}`,
    }));
  },
  operator: { terminalOnly: 'Branches belong to the conversation open in the terminal app.' },
});

const WAITING_HANDOFFS = defineList<SessionCommandContext>({
  name: 'sessions.handoffs.waiting',
  async read(ctx) {
    return (ctx.ops.sessionOrchestration?.getHandoffs() ?? []).filter((handoff) => !handoff.acknowledged).map((handoff): ListRow => ({
      value: handoff.handoffId, label: `task ${handoff.taskRef.taskId}`,
      detail: `${handoff.fromSessionId.slice(0, 8)}... to ${handoff.toSessionId.slice(0, 8)}...${handoff.reason ? `: ${handoff.reason}` : ''}`,
      state: 'waiting',
    }));
  },
  operator: { terminalOnly: 'The task graph is kept by the terminal app.' },
});

// ---------------------------------------------------------------------------
// Blanks
// ---------------------------------------------------------------------------

const SAVED: InputDescription = {
  id: 'session', label: 'Session', help: 'Your saved sessions, newest first', kind: 'choice',
  choices: { list: SAVED_SESSIONS, allowOther: { reason: 'a session id, the start of one, or its title' } }, required: true, typed: { position: 1 },
};
const NAME: InputDescription = {
  id: 'name', label: 'Name', help: 'A name you choose', kind: 'text', freeTextReason: 'a name you choose',
  required: { default: '', defaultMeans: 'the conversation\'s title' }, typed: { tail: true },
};
const BRANCH: InputDescription = {
  id: 'branch', label: 'Branch', help: 'This conversation\'s branches', kind: 'choice',
  choices: { list: BRANCHES }, required: true, typed: { position: 1 },
};
const KINDS: readonly FixedChoice[] = [
  { value: 'all', label: 'Everything' },
  ...TRANSCRIPT_EVENT_KINDS.map((kind) => ({ value: kind, label: kind.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase()) })),
];
const KIND: InputDescription = {
  id: 'kind', label: 'Kind', help: 'Only one kind of entry', kind: 'choice', choices: KINDS,
  required: { default: 'all', defaultMeans: 'everything' }, typed: { position: 1 },
};
const JUMP_KINDS: readonly FixedChoice[] = [{ value: 'error', label: 'Errors' }, ...KINDS.map((choice) => choice.value === 'all' ? { value: 'all', label: 'Any entry' } : choice)];
const JUMP_KIND: InputDescription = {
  id: 'kind', label: 'To', help: 'Which kind of entry', kind: 'choice', choices: JUMP_KINDS,
  required: { default: 'all', defaultMeans: 'any entry' }, typed: { position: 1 },
};
const BLOCK_TYPES: readonly FixedChoice[] = [
  { value: 'all', label: 'Every block' }, { value: 'thinking', label: 'Thinking' }, { value: 'tool', label: 'Tool calls' }, { value: 'code', label: 'Code' },
];
const BLOCK_TYPE: InputDescription = {
  id: 'type', label: 'Blocks', help: 'Which blocks', kind: 'choice', choices: BLOCK_TYPES,
  required: { default: 'all', defaultMeans: 'every block' }, typed: { position: 1 },
};
const START: InputDescription = {
  id: 'start', label: 'From row', help: 'The first row to show', kind: 'number', freeTextReason: 'a row number from 1',
  required: { default: '', defaultMeans: 'the newest page' }, typed: { position: 2 },
};
const LAST: InputDescription = {
  id: 'last', label: 'How many', help: 'How many rows to show', kind: 'number', freeTextReason: 'a whole number',
  required: { default: '', defaultMeans: 'one page' }, typed: { flag: '--last' },
};
const TASK_SESSION: InputDescription = {
  id: 'from', label: 'In session', help: 'The session the task belongs to', kind: 'text', freeTextReason: 'a session id',
  required: { default: '', defaultMeans: 'this session' }, typed: { flag: '--session' },
};

function orchestrationOf(ctx: SessionCommandContext): ShellSessionOrchestrationService {
  const orchestration = ctx.ops.sessionOrchestration;
  if (!orchestration) throw commandRefusal('The cross-session task graph is not available in this session.');
  return orchestration;
}

/** A `<sessionId>:<taskId>` reference, or a task id of `sessionId`. */
function parseRef(raw: string, sessionId: string): { sessionId: string; taskId: string } {
  const parts = raw.split(':', 2);
  return parts.length === 2 ? { sessionId: parts[0]!, taskId: parts[1]! } : { sessionId, taskId: raw };
}

// ---------------------------------------------------------------------------
// The actions
// ---------------------------------------------------------------------------

type SessionAction<Ctx> = ActionDescription<Ctx>;

function sessionActions<Ctx extends SessionCommandContext>(policy: SessionCommandPolicy<Ctx>) {
  const graphWrite = (ctx: Ctx): ShellSessionOrchestrationService => {
    if (policy.graphReadOnly) throw commandRefusal(policy.graphReadOnly, '/session graph shows the graph.');
    return orchestrationOf(ctx);
  };
  const resume: SessionAction<Ctx> = {
    id: 'resume', label: 'Resume a saved session', word: 'resume',
    inputs: [SAVED, {
      id: 'force', label: 'If it is open elsewhere', help: 'Another running terminal may have it open', kind: 'choice',
      choices: [{ value: 'no', label: 'Stop and say so' }, { value: 'yes', label: 'Resume it here anyway', help: 'That terminal\'s live state is forked.' }],
      required: { default: 'no', defaultMeans: 'stop and say so' }, typed: { flag: '--force', switchOn: 'yes' },
    }],
    sentence: 'This conversation is set aside and {session} continues here, with its messages, model and agent records.', done: '',
    touches: 'this-machine', lasts: 'not-a-change', risk: 'none',
    operator: { method: 'sessions.reopen', fields: { sessionId: 'session' } }, example: { session: 'my-notes' },
    async run(values, ctx) {
      await policy.resume(ctx, { target: values.session!, force: values.force === 'yes' });
    },
  };
  const save: SessionAction<Ctx> = {
    id: 'save', label: 'Save this session under a name', word: 'save',
    inputs: [
      NAME,
      { id: 'continue', label: 'Keep working in', help: 'This session, or the saved copy', kind: 'choice', choices: [
        { value: 'here', label: 'This session' },
        { value: 'copy', label: 'The saved copy', help: 'Later turns are saved under the new name.' },
      ], required: { default: 'here', defaultMeans: 'this session' }, typed: { flag: '--switch', switchOn: 'copy' } },
      { id: 'replace', label: 'If the name is taken', help: 'Another saved conversation may have it', kind: 'choice', choices: [
        { value: 'no', label: 'Stop and say so' },
        { value: 'yes', label: 'Replace it', help: 'The conversation saved under that name now is lost.', risk: 'cannot-be-undone' },
      ], required: { default: 'no', defaultMeans: 'stop and say so' }, typed: { flag: '--replace', switchOn: 'yes' } },
    ],
    sentence: 'This conversation will be saved under the name given (or its title), until you change it.', done: '',
    touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'delete',
    operator: { terminalOnly: 'The conversation is the terminal app\'s own.' }, example: { name: 'release notes' },
    async run(values, ctx) {
      policy.workflow.save(ctx, { name: values.name ?? '', replace: values.replace === 'yes', switchTo: values.continue === 'copy' });
    },
  };
  const actions: SessionAction<Ctx>[] = [
    {
      id: 'current', label: 'See this session', readsOnlyThisMachine: true, word: 'current', inputs: [],
      sentence: 'Shows this session\'s id, name, when it started, how many messages it has and its model.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'It is the terminal app\'s open session.' }, example: {},
      async run(_values, ctx) { policy.workflow.current(ctx); },
    },
    {
      id: 'list', label: 'See your saved sessions', word: 'list', inputs: [],
      async rowValue(ctx) {
        const count = ctx.session.sessionManager?.list().length ?? 0;
        return count === 0 ? 'none saved yet' : `${count} saved`;
      },
      sentence: 'Lists your saved sessions, newest first, with what each was doing when it was left.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'sessions.list', fields: {} }, example: {},
      async run(_values, ctx) { policy.workflow.list(ctx); },
    },
    resume,
    save,
    {
      id: 'fork', label: 'Continue in a copy of this session', word: 'fork',
      inputs: [{ ...NAME, required: { default: '', defaultMeans: 'fork-of- and this session\'s id' } }],
      sentence: 'A copy of this session is saved under the name given and later turns go to the copy; this session stays as it is now, until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: { terminalOnly: 'The conversation is the terminal app\'s own.' }, example: { name: 'try another way' },
      async run(values, ctx) { policy.workflow.fork(ctx, values.name ?? ''); },
    },
    {
      id: 'rename', label: 'Rename this session', word: 'rename',
      inputs: [{ ...NAME, required: true, help: 'Its new name' }],
      sentence: 'This session will be called {name} until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: { terminalOnly: 'The conversation is the terminal app\'s own.' }, example: { name: 'release notes' },
      async run(values, ctx) { policy.workflow.rename(ctx, values.name!); },
    },
    {
      id: 'info', label: 'See a saved session\'s details', word: 'info',
      inputs: [{ ...SAVED, required: { default: '', defaultMeans: 'this session' } }],
      sentence: 'Shows a saved session: its title, model, provider, date, message count, file and what it was doing.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'sessions.get', fields: { sessionId: 'session' } }, example: { session: 'my-notes' },
      async run(values, ctx) { policy.workflow.info(ctx, values.session ?? ''); },
    },
    {
      id: 'search', label: 'Search saved sessions', word: 'search',
      inputs: [{ id: 'words', label: 'Words', help: 'What to look for in their messages', kind: 'text', freeTextReason: 'your own words', required: true, typed: { tail: true } }],
      sentence: 'Finds saved sessions whose messages hold {words}, with the matching lines.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'sessions.search', fields: { query: 'words' } }, example: { words: 'release' },
      async run(values, ctx) { policy.workflow.search(ctx, values.words!); },
    },
    {
      id: 'delete', label: 'Delete a saved session', word: 'delete', inputs: [SAVED],
      sentence: 'Saved session {session} and its messages will be deleted from this project.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
      operator: { method: 'sessions.delete', fields: { sessionId: 'session' } }, example: { session: 'my-notes' },
      async run(values, ctx) { policy.workflow.remove(ctx, values.session!); },
    },
    {
      id: 'events', label: 'See this conversation\'s events', word: 'events', inputs: [KIND, START, LAST],
      sentence: 'Shows the conversation\'s record entry by entry (messages, tool calls, approvals), newest page first.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'It is the terminal app\'s open conversation.' }, example: { kind: 'tool_call', last: '20' },
      async run(values, ctx) { await policy.workflow.review(ctx, 'events', { kind: values.kind ?? '', start: values.start ?? '', last: values.last ?? '' }); },
    },
    {
      id: 'groups', label: 'See this conversation turn by turn', word: 'groups', inputs: [KIND, START, LAST],
      sentence: 'Shows the conversation\'s record grouped by turn, newest page first.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'It is the terminal app\'s open conversation.' }, example: { kind: 'all' },
      async run(values, ctx) { await policy.workflow.review(ctx, 'groups', { kind: values.kind ?? '', start: values.start ?? '', last: values.last ?? '' }); },
    },
    {
      id: 'hotspots', label: 'See where this conversation spent most', word: 'hotspots', inputs: [KIND],
      sentence: 'Counts the whole record by what took the most entries.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'It is the terminal app\'s open conversation.' }, example: { kind: 'tool_call' },
      async run(values, ctx) { await policy.workflow.review(ctx, 'hotspots', { kind: values.kind ?? '', start: '', last: '' }); },
    },
    {
      id: 'find', label: 'Find words in this conversation', word: 'find',
      inputs: [
        { id: 'words', label: 'Words', help: 'What to look for', kind: 'text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'search in place, as Ctrl+F does' }, typed: { tail: true } },
        { ...KIND, typed: { flag: '--kind' } },
      ],
      sentence: 'Lists the entries of this conversation that hold the words given; with none, searches in place.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'It is the terminal app\'s open conversation.' }, example: { words: 'approval', kind: 'approval_request' },
      async run(values, ctx) { await policy.look.find(ctx, values.words ?? '', values.kind ?? 'all'); },
    },
    {
      id: 'next', label: 'Jump to the next entry', word: 'next', inputs: [JUMP_KIND],
      sentence: 'Scrolls to the next entry of the kind chosen, after where you are.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'It moves the terminal app\'s own view.' }, example: { kind: 'error' },
      async run(values, ctx) { await policy.look.jump(ctx, 'next', values.kind ?? 'all'); },
    },
    {
      id: 'prev', label: 'Jump to the previous entry', word: 'prev', inputs: [JUMP_KIND],
      sentence: 'Scrolls to the previous entry of the kind chosen, before where you are.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'It moves the terminal app\'s own view.' }, example: { kind: 'tool_result' },
      async run(values, ctx) { await policy.look.jump(ctx, 'prev', values.kind ?? 'all'); },
    },
    {
      id: 'expand', label: 'Open folded blocks', word: 'expand', inputs: [BLOCK_TYPE],
      sentence: 'Opens the folded blocks of the kind chosen in this conversation.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'It changes the terminal app\'s own view.' }, example: { type: 'tool' },
      async run(values, ctx) { policy.look.blocks(ctx, values.type || 'all', false); },
    },
    {
      id: 'collapse', label: 'Fold blocks', word: 'collapse', inputs: [BLOCK_TYPE],
      sentence: 'Folds the blocks of the kind chosen in this conversation to one line each.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'It changes the terminal app\'s own view.' }, example: { type: 'thinking' },
      async run(values, ctx) { policy.look.blocks(ctx, values.type || 'all', true); },
    },
    {
      id: 'bookmarks', label: 'See bookmarked blocks', word: 'bookmarks', inputs: [],
      sentence: 'Lists the blocks you bookmarked (Ctrl+B) and jumps to one.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'Bookmarks belong to the terminal app\'s open conversation.' }, example: {},
      async run(_values, ctx) { policy.look.bookmarks(ctx); },
    },
    {
      id: 'composer', label: 'See what the composer waits on', word: 'composer', inputs: [],
      sentence: 'Shows the composer\'s mode, what it waits on, the turn\'s state and how full the context is.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'It is the terminal app\'s composer.' }, example: {},
      async run(_values, ctx) { policy.look.composer(ctx); },
    },
    {
      id: 'restored', label: 'See what a resume brought back', word: 'restored', inputs: [],
      sentence: 'Lists the entries a resume restored: approvals, tasks, remote state and notices.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'It is the terminal app\'s open conversation.' }, example: {},
      async run(_values, ctx) { await policy.look.restored(ctx); },
    },
    {
      id: 'compactions', label: 'See what compaction removed', word: 'compactions', inputs: [],
      sentence: 'Lists each compaction of this session: when, how much it removed and what it kept.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'It is the terminal app\'s open conversation.' }, example: {},
      async run(_values, ctx) {
        if (!policy.look.compactions) throw commandRefusal('This app keeps no record of compactions.', '/compact says what it removed when it runs.');
        policy.look.compactions(ctx);
      },
    },
    {
      id: 'save-file', label: 'Save this conversation as a file', word: 'save-file',
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
          { value: 'no', label: 'Keep it and stop' }, { value: 'yes', label: 'Write over it', risk: 'cannot-be-undone' },
        ], required: { default: 'no', defaultMeans: 'keep it and stop' }, typed: { flag: '--replace', switchOn: 'yes' } },
        { id: 'open', label: 'Then', help: 'What to do with the file', kind: 'choice', choices: [
          { value: 'nothing', label: 'Nothing more' }, { value: 'open', label: 'Open it in the browser', help: 'A web page only' }, { value: 'copy', label: 'Copy its path' },
        ], required: { default: 'nothing', defaultMeans: 'nothing more' }, typed: { flag: '--then' } },
      ],
      sentence: 'This conversation will be written to {path} as {format} on this machine, until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: { terminalOnly: 'The conversation is the terminal app\'s own.' }, example: { format: 'html', path: 'notes/session.html' },
      async run(values, ctx) {
        if (values.path && values.replace !== 'yes' && policy.fileExists(ctx, values.path)) {
          throw commandRefusal(`${values.path} already exists; nothing was written.`, `Write over it: /session save-file ${values.format || 'markdown'} ${values.path} --replace`);
        }
        return policy.saveFile(ctx, {
          format: (values.format || 'markdown') as 'markdown' | 'text' | 'html' | 'json', path: values.path ?? '',
          redact: values.redact !== 'keep', open: values.open === 'open', copy: values.open === 'copy',
        });
      },
    },
    {
      id: 'save-saved', label: 'Save a saved session as a file', word: 'save-saved',
      inputs: [
        { ...SAVED, help: 'Your saved sessions; . is this one' },
        { id: 'format', label: 'As', help: 'The kind of text', kind: 'choice', choices: [{ value: 'markdown', label: 'Markdown' }, { value: 'text', label: 'Plain text' }], required: { default: 'markdown', defaultMeans: 'Markdown' }, typed: { position: 2 } },
        { id: 'where', label: 'Where', help: 'A file, or this screen', kind: 'choice', choices: [{ value: 'file', label: 'Write it to a file' }, { value: 'here', label: 'Print it here', help: 'Shown only, never part of this conversation' }], required: { default: 'file', defaultMeans: 'a file' }, typed: { flag: '--print', switchOn: 'here' } },
        { id: 'path', label: 'File', help: 'Where to write it', kind: 'path', freeTextReason: 'a file path', required: { default: '', defaultMeans: 'a new file in ~/goodvibes-exports' }, typed: { flag: '--out' }, showWhen: { input: 'where', is: 'file' } },
      ],
      sentence: 'The redacted transcript of {session} will be written out ({format}); an existing file is never replaced.', done: '',
      touches: 'this-machine', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'Saved sessions are files of the terminal app.' }, example: { session: 'my-notes', format: 'text' },
      async run(values, ctx) {
        await policy.exportSaved(ctx, { target: values.session!, format: (values.format || 'markdown') as TranscriptFormat, path: values.where === 'here' ? '' : values.path ?? '', print: values.where === 'here' });
      },
    },
    {
      id: 'upload', label: 'Upload this conversation and get a link', word: 'upload',
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
      operator: { terminalOnly: 'The upload is made with the terminal app\'s GitHub sign-in.' }, example: { format: 'md' },
      async run(values, ctx) {
        await policy.upload(ctx, { format: (values.format || 'html') as 'html' | 'json' | 'md', redact: values.redact !== 'keep', open: values.open === 'open', copy: values.open === 'copy' });
      },
    },
    {
      id: 'branch', label: 'Branch this conversation here', word: 'branch',
      inputs: [{ ...NAME, help: 'A name for the branch', required: { default: '', defaultMeans: 'a numbered name' } }],
      sentence: 'A branch is kept of the conversation as it is now, under the name given; you go on in the current one, until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: { terminalOnly: 'Branches belong to the conversation open in the terminal app.' }, example: { name: 'before refactor' },
      async run(values, ctx) { policy.branches.create(ctx, values.name ?? ''); },
    },
    {
      id: 'branches', label: 'See this conversation\'s branches', word: 'branches', inputs: [],
      sentence: 'Lists the branches of this conversation and which one you are on.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'Branches belong to the conversation open in the terminal app.' }, example: {},
      async run(_values, ctx) { policy.branches.list(ctx); },
    },
    {
      id: 'switch-branch', label: 'Switch to a branch', word: 'switch-branch', inputs: [BRANCH],
      sentence: 'The conversation goes on from branch {branch} until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: { terminalOnly: 'Branches belong to the conversation open in the terminal app.' }, example: { branch: 'main' },
      async run(values, ctx) { policy.branches.switchTo(ctx, values.branch!); },
    },
    {
      id: 'merge-branch', label: 'Bring a branch\'s new messages in', word: 'merge-branch', inputs: [BRANCH],
      sentence: 'The messages branch {branch} gained after it was made are added to this conversation, until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: { terminalOnly: 'Branches belong to the conversation open in the terminal app.' }, example: { branch: 'before refactor' },
      async run(values, ctx) { policy.branches.merge(ctx, values.branch!); },
    },
    {
      id: 'graph', label: 'See the cross-session task graph', word: 'graph',
      inputs: [
        { id: 'session', label: 'Session', help: 'Only one session\'s tasks', kind: 'text', freeTextReason: 'a session id or its start', required: { default: '', defaultMeans: 'every session' }, typed: { flag: '--session' } },
        { id: 'format', label: 'As', help: 'Text, or JSON for programs', kind: 'choice', choices: [{ value: 'text', label: 'Text' }, { value: 'json', label: 'JSON' }], required: { default: 'text', defaultMeans: 'text' }, typed: { flag: '--format' } },
      ],
      sentence: 'Shows the tasks linked across sessions, what each waits on, and the handoffs waiting.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'The task graph is kept by the terminal app.' }, example: { format: 'json' },
      async run(values, ctx) { policy.graph(ctx, { session: values.session ?? '', format: values.format ?? 'text' }); },
    },
    {
      id: 'link-task', label: 'Add a task to the cross-session graph', word: 'link-task',
      inputs: [
        { id: 'task', label: 'Task', help: 'The task\'s id', kind: 'text', freeTextReason: 'a task id', required: true, typed: { position: 1 } },
        TASK_SESSION,
        { id: 'after', label: 'Waits on', help: 'A task it depends on, as session:task or a task of the same session', kind: 'text', freeTextReason: 'a task reference', required: { default: '', defaultMeans: 'nothing' }, typed: { flag: '--depends-on' } },
        { id: 'label', label: 'Label', help: 'A short name to show for it', kind: 'text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'its id' }, typed: { flag: '--label' } },
      ],
      sentence: 'Task {task} will be in the cross-session graph, with what it waits on, until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: { terminalOnly: 'The task graph is kept by the terminal app.' }, example: { task: 'build', after: 'other:lint' },
      async run(values, ctx) {
        const orchestration = graphWrite(ctx);
        const taskId = values.task!.trim();
        if (!taskId || taskId.includes(':')) throw commandRefusal('A task id is one word without ":" (that separates a session from a task).');
        const sessionId = values.from || ctx.session.runtime.sessionId;
        const label = values.label || undefined;
        const ref: CrossSessionTaskRef = { sessionId, taskId, title: label ?? taskId, status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), label };
        const dependsOn = values.after ? parseRef(values.after, sessionId) : undefined;
        const result = orchestration.linkTask(ref, dependsOn);
        if (!result.ok) throw commandRefusal(`Task ${taskId} was not added: ${result.error}`);
        return `Added ${sessionId.slice(0, 8)}...:${taskId}${label ? ` [${label}]` : ''}${dependsOn ? `, waiting on ${values.after}` : ''}.`;
      },
    },
    {
      id: 'hand-off', label: 'Hand a task to another session', word: 'hand-off',
      inputs: [
        { id: 'task', label: 'Task', help: 'The task\'s id', kind: 'text', freeTextReason: 'a task id', required: true, typed: { position: 1 } },
        { id: 'to', label: 'To session', help: 'The session that takes it', kind: 'text', freeTextReason: 'a session id', required: true, typed: { flag: '--to' } },
        TASK_SESSION,
        { id: 'reason', label: 'Why', help: 'A note the other session sees', kind: 'long-text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'no note' }, typed: { flag: '--reason' } },
      ],
      sentence: 'Task {task} is offered to session {to} and waits until it is accepted or taken back.', done: '',
      touches: 'this-machine', lasts: 'not-a-change', risk: 'none', undoneBy: 'withdraw',
      operator: { terminalOnly: 'The task graph is kept by the terminal app.' }, example: { task: 'build', to: 'user-1a2b3c4d' },
      async run(values, ctx) {
        const orchestration = graphWrite(ctx);
        const from = values.from || ctx.session.runtime.sessionId;
        const result = orchestration.initiateHandoff({ sessionId: from, taskId: values.task! }, from, values.to!, values.reason || undefined);
        if (!result.ok) throw commandRefusal(`Not handed off: ${result.error}`);
        return `Handoff ${result.handoffId}: the task is blocked until session ${values.to} accepts it (/session accept ${result.handoffId}) or you take it back (/session withdraw ${result.handoffId}).`;
      },
    },
    {
      id: 'accept', label: 'Accept a handoff', word: 'accept',
      inputs: [{ id: 'handoff', label: 'Handoff', help: 'Handoffs waiting to be accepted', kind: 'choice', choices: { list: WAITING_HANDOFFS }, required: true, typed: { position: 1 } }],
      sentence: 'Handoff {handoff} is accepted for its destination session and its task is no longer blocked.', done: '',
      touches: 'this-machine', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'The task graph is kept by the terminal app.' }, example: { handoff: 'h-1' },
      async run(values, ctx) {
        const orchestration = graphWrite(ctx);
        const handoff = orchestration.getHandoffs().find((record) => record.handoffId === values.handoff);
        if (!handoff) throw commandRefusal(`No handoff is ${values.handoff}; nothing was changed.`);
        if (handoff.acknowledged) throw commandRefusal(`Handoff ${values.handoff} was already accepted; nothing was changed.`);
        if (!orchestration.acknowledgeHandoff(handoff.handoffId)) throw commandRefusal(`Handoff ${values.handoff} is no longer waiting; nothing was changed.`);
        return `Session ${handoff.toSessionId} has task ${handoff.taskRef.taskId}.`;
      },
    },
    {
      id: 'withdraw', label: 'Take back a handoff', word: 'withdraw',
      inputs: [{ id: 'handoff', label: 'Handoff', help: 'Handoffs waiting to be accepted', kind: 'choice', choices: { list: WAITING_HANDOFFS }, required: true, typed: { position: 1 } }],
      sentence: 'Handoff {handoff} is withdrawn and its task goes back to the status it had before.', done: '',
      touches: 'this-machine', lasts: 'not-a-change', risk: 'none',
      operator: { terminalOnly: 'The task graph is kept by the terminal app.' }, example: { handoff: 'h-1' },
      async run(values, ctx) {
        const orchestration = graphWrite(ctx);
        const handoff = orchestration.getHandoffs().find((record) => record.handoffId === values.handoff);
        if (!handoff) throw commandRefusal(`No handoff is ${values.handoff}; nothing was changed.`);
        const result = orchestration.withdrawHandoff(handoff.handoffId);
        if (!result.ok) throw commandRefusal(result.error ?? `Handoff ${values.handoff} could not be taken back.`);
        return `Task ${handoff.taskRef.taskId} stays with session ${handoff.fromSessionId}${result.status ? ` (status ${result.status})` : ''}.`;
      },
    },
    {
      id: 'cancel', label: 'Cancel tasks in the graph', word: 'cancel',
      inputs: [
        { id: 'scope', label: 'What', help: 'One task, it and what waits on it, or every task of a session', kind: 'choice', choices: [
          { value: 'task', label: 'Only this task' }, { value: 'subtree', label: 'This task and everything waiting on it' }, { value: 'session', label: 'Every task in the session' },
        ], required: { default: 'task', defaultMeans: 'only this task' }, typed: { flag: '--scope' } },
        { id: 'task', label: 'Task', help: 'The task\'s id', kind: 'text', freeTextReason: 'a task id', required: true, typed: { position: 1 }, showWhen: { input: 'scope', is: 'task' } },
        { id: 'root', label: 'Task', help: 'The task whose waiting tasks go too', kind: 'text', freeTextReason: 'a task id', required: true, typed: { flag: '--task' }, showWhen: { input: 'scope', is: 'subtree' } },
        TASK_SESSION,
        { id: 'reason', label: 'Why', help: 'A note kept with each cancelled task', kind: 'long-text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'no note' }, typed: { flag: '--reason' } },
      ],
      sentence: 'The tasks chosen ({scope}) will be cancelled; a cancelled task does not start again.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
      operator: { terminalOnly: 'The task graph is kept by the terminal app.' }, example: { scope: 'task', task: 'build' },
      async run(values, ctx) {
        const orchestration = graphWrite(ctx);
        const scope = (values.scope || 'task') as CancellationScope;
        if (!VALID_SCOPES.includes(scope)) throw commandRefusal(`"${scope}" is not one of ${VALID_SCOPES.join(', ')}.`);
        const taskId = scope === 'session' ? undefined : (scope === 'task' ? values.task : values.root);
        const result = orchestration.cancel({ sessionId: values.from || ctx.session.runtime.sessionId, taskId, scope, reason: values.reason || undefined, requestedAt: Date.now() });
        if (!result.ok) throw commandRefusal(`Nothing was cancelled: ${result.error}`);
        return [
          `Cancelled ${result.cancelled.length} task${result.cancelled.length === 1 ? '' : 's'}:`,
          ...result.cancelled.map((task) => `  ${task.sessionId.slice(0, 8)}...:${task.taskId}  "${task.title}"`),
          ...(result.skipped.length ? [`Left ${result.skipped.length} that had already ended:`, ...result.skipped.map((task) => `  ${task.sessionId.slice(0, 8)}...:${task.taskId}  (${task.reason})`)] : []),
        ].join('\n');
      },
    },
  ];
  return { actions, resume, save };
}

/**
 * `/session`, `/resume` and `/save` for one app. `/resume` and `/save` are
 * single-action commands whose one action is the definition `/session` lists
 * (its word left out, since the command name says it).
 */
export function createSessionCommands<Ctx extends SessionCommandContext>(policy: SessionCommandPolicy<Ctx>): {
  readonly session: DescribedCommand<Ctx>;
  readonly resume: DescribedCommand<Ctx>;
  readonly save: DescribedCommand<Ctx>;
} {
  const { actions, resume, save } = sessionActions(policy);
  const session: CommandDescription<Ctx> = {
    name: 'session',
    title: 'Sessions',
    summary: 'This conversation and your saved ones: resume, save, copy, export, branch and hand off work',
    group: 'Sessions',
    report: 'current',
    firstScreenRows: [
      'current',
      'resume',
      'save',
      'list',
      { label: 'Copy, rename or delete a session', actions: ['fork', 'rename', 'info', 'search', 'delete'] },
      { label: 'Save or share the conversation', actions: ['save-file', 'save-saved', 'upload'] },
      { label: 'Branches of this conversation', actions: ['branch', 'branches', 'switch-branch', 'merge-branch'] },
      { label: 'Look through this conversation', actions: ['find', 'next', 'prev', 'events', 'groups', 'hotspots', 'expand', 'collapse', 'bookmarks', 'composer', 'restored', 'compactions'] },
      { label: 'Tasks across sessions', actions: ['graph', 'link-task', 'hand-off', 'accept', 'withdraw', 'cancel'] },
    ],
    actions,
  };
  return {
    session: defineCommand(session),
    resume: defineCommand({ name: 'resume', title: 'Resume a session', summary: 'Continue a saved session here', group: 'Sessions', actions: [{ ...resume, word: '' }] }),
    save: defineCommand({ name: 'save', title: 'Save this session', summary: 'Save this conversation under a name to come back to', group: 'Sessions', actions: [{ ...save, word: '' }] }),
  };
}
