/**
 * `/session`, described once (command-actions/): every session action in one
 * guided list. This session and the saved ones (see, resume, save, copy,
 * rename, search, delete), the conversation's record (events, groups,
 * hotspots), saving it as a file or uploading it for a link, its branches, and
 * the cross-session task graph (link, hand off, accept, take back, cancel).
 * `/resume` is its own single-action command built from the same action
 * definition `/session` lists. Both terminal apps register this
 * one description; what each app does differently is its policy, read by the
 * actions' `run`.
 */
import type { SessionManager, CancellationScope, CrossSessionTaskRef } from '@goodvibes/engine/platform/platform/sessions';
import { VALID_SCOPES } from '@goodvibes/engine/platform/platform/sessions';
import type { ShellSessionOrchestrationService } from '@goodvibes/engine/platform/platform/runtime/shell';
import {
  SESSION_BRANCHES, SESSION_CURRENT, SESSION_DELETE, SESSION_FORK, SESSION_INFO, SESSION_LIST, SESSION_MERGE_BRANCH, SESSION_RENAME,
  SESSION_RESUME, SESSION_SAVE_SAVED, SESSION_SEARCH, SESSION_SWITCH_BRANCH, SESSION_UPLOAD,
  SESSION_BOOKMARKS, SESSION_COMPOSER, SESSION_EVENTS, SESSION_FIND, SESSION_GROUPS, SESSION_HOTSPOTS, SESSION_NEXT, SESSION_PREV, SESSION_RESTORED,
  type CapabilityDefinition, type LiveSessions, type SessionsCapabilityServices,
} from '@goodvibes/engine/platform/platform/capabilities';
import {
  SESSION_BRANCH, SESSION_COLLAPSE, SESSION_COMPACTIONS, SESSION_EXPAND, SESSION_SAVE, SESSION_SAVE_FILE,
  type ConversationRecord, type RecordServices,
} from '@goodvibes/engine/platform/platform/capabilities';
import { commandRefusal } from './command-confirmation.js';
import { sessionCapabilityAction } from './command-actions/capability-actions.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionDescription, CommandActionContext, CommandDescription, InputDescription } from './command-actions/types.js';
import type { TranscriptFormat } from './session-export-format.js';

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
  /** A turn is running now (the conversation's record controls read it). */
  readonly isGenerating?: (() => boolean) | undefined;
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
  /** False when this app keeps one line of conversation (its branch actions are no controls of the Sessions place). */
  readonly keepsBranches?: false | undefined;
  /** False when this app uploads no conversation. */
  readonly uploads?: false | undefined;
  /** Why this app may only read the cross-session task graph, or undefined when it may change it. */
  readonly graphReadOnly: string | undefined;
  readonly graph: (ctx: Ctx, input: { readonly session: string; readonly format: string }) => void;
}

// ---------------------------------------------------------------------------
// Live lists, read only when a guided step or a completion asks
// ---------------------------------------------------------------------------

/** The saved sessions (capabilities/builtin/sessions.ts names it `sessions.saved`). */
export const SAVED_SESSIONS = defineList<SessionCommandContext>({
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

/** This conversation's branches (`sessions.branches` in capabilities/builtin/sessions.ts). */
export const BRANCHES = defineList<SessionCommandContext>({
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

/**
 * What one of the app's session routines says, as words: what it prints while
 * it runs is its answer (a line it prints later, such as a resume's assisted
 * summary arriving afterwards, goes to the screen as before).
 */
async function said<Ctx extends SessionCommandContext>(ctx: Ctx, run: (ctx: Ctx) => unknown): Promise<string> {
  const lines: string[] = [];
  let answering = true;
  const print = (message: string): void => { if (answering) lines.push(message); else ctx.print(message); };
  const answeringCtx = { ...ctx, print, printLive: undefined } as Ctx;
  try {
    const returned = await run(answeringCtx);
    if (typeof returned === 'string' && returned.trim() !== '') lines.push(returned);
  } finally {
    answering = false;
  }
  return lines.join('\n');
}

/** The app's session routines as the session capabilities take them (capabilities/builtin/sessions.ts). */
export function liveSessionsOf<Ctx extends SessionCommandContext>(policy: SessionCommandPolicy<Ctx>, ctx: Ctx): LiveSessions {
  return {
    keepsBranches: policy.keepsBranches !== false,
    uploads: policy.uploads !== false,
    current: () => said(ctx, (c) => policy.workflow.current(c)),
    list: () => said(ctx, (c) => policy.workflow.list(c)),
    info: (target) => said(ctx, (c) => policy.workflow.info(c, target)),
    search: (words) => said(ctx, (c) => policy.workflow.search(c, words)),
    remove: (target) => said(ctx, (c) => policy.workflow.remove(c, target)),
    resume: (target, force) => said(ctx, (c) => policy.resume(c, { target, force })),
    fork: (name) => said(ctx, (c) => policy.workflow.fork(c, name)),
    rename: (name) => said(ctx, (c) => policy.workflow.rename(c, name)),
    exportSaved: (input) => said(ctx, (c) => policy.exportSaved(c, input)),
    upload: (input) => said(ctx, (c) => policy.upload(c, input)),
    branches: () => said(ctx, (c) => policy.branches.list(c)),
    switchBranch: (name) => said(ctx, (c) => policy.branches.switchTo(c, name)),
    mergeBranch: (name) => said(ctx, (c) => policy.branches.merge(c, name)),
    review: (view, input) => said(ctx, (c) => policy.workflow.review(c, view, input)),
    find: (words, kind) => said(ctx, (c) => policy.look.find(c, words, kind)),
    jump: (direction, kind) => said(ctx, (c) => policy.look.jump(c, direction, kind)),
    composer: () => said(ctx, (c) => policy.look.composer(c)),
    restored: () => said(ctx, (c) => policy.look.restored(c)),
    bookmarks: () => said(ctx, (c) => policy.look.bookmarks(c)),
  };
}

/**
 * The app's routines for the conversation's record, as the conversation's controls take them
 * (capabilities/builtin/conversation-controls.ts: session.save, save-file, branch, expand, collapse, compactions).
 */
export function conversationRecordOf<Ctx extends SessionCommandContext>(policy: SessionCommandPolicy<Ctx>, ctx: Ctx): ConversationRecord {
  const compactions = policy.look.compactions;
  return {
    save: (input) => said(ctx, (c) => policy.workflow.save(c, input)),
    fileExists: (path) => policy.fileExists(ctx, path),
    saveFile: (input) => said(ctx, (c) => policy.saveFile(c, input)),
    branch: (name) => said(ctx, (c) => policy.branches.create(c, name)),
    blocks: (type, fold) => said(ctx, (c) => policy.look.blocks(c, type, fold)),
    compactions: compactions ? () => said(ctx, (c) => compactions(c)) : undefined,
  };
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
  // The moved actions run their capability (capabilities/builtin/sessions.ts) with this app's session routines.
  const moved = (definition: CapabilityDefinition<SessionsCapabilityServices>, terminalOnly: string): SessionAction<Ctx> =>
    sessionCapabilityAction<Ctx, SessionsCapabilityServices>(definition, (ctx) => ({ sessions: liveSessionsOf(policy, ctx) }), { terminalOnly });
  const OWN_CONVERSATION = 'The conversation is the terminal program\'s own.';
  const OWN_FILES = 'Saved sessions are files the terminal program keeps in this project.';
  const OWN_RECORD = 'It is the terminal program\'s open conversation.';
  const OWN_VIEW = 'It moves the terminal program\'s own view.';
  const resume: SessionAction<Ctx> = moved(SESSION_RESUME, OWN_CONVERSATION);
  // The conversation's record is a control on the conversation (capabilities/builtin/conversation-controls.ts), run with this app's routines.
  const recorded = (definition: CapabilityDefinition<RecordServices>, terminalOnly: string): SessionAction<Ctx> =>
    sessionCapabilityAction<Ctx, RecordServices>(definition, (ctx) => ({
      conversation: { isGenerating: () => ctx.isGenerating?.() === true }, record: conversationRecordOf(policy, ctx),
    }), { terminalOnly });
  const save: SessionAction<Ctx> = recorded(SESSION_SAVE, OWN_CONVERSATION);
  const actions: SessionAction<Ctx>[] = [
    { ...moved(SESSION_CURRENT, 'It is the terminal program\'s open session.'), readsOnlyThisMachine: true },
    {
      ...moved(SESSION_LIST, OWN_FILES),
      async rowValue(ctx) {
        const count = ctx.session.sessionManager?.list().length ?? 0;
        return count === 0 ? 'none saved yet' : `${count} saved`;
      },
    },
    resume,
    save,
    moved(SESSION_FORK, OWN_CONVERSATION),
    moved(SESSION_RENAME, OWN_CONVERSATION),
    moved(SESSION_INFO, OWN_FILES),
    moved(SESSION_SEARCH, OWN_FILES),
    moved(SESSION_DELETE, OWN_FILES),
    moved(SESSION_EVENTS, OWN_RECORD),
    moved(SESSION_GROUPS, OWN_RECORD),
    moved(SESSION_HOTSPOTS, OWN_RECORD),
    moved(SESSION_FIND, OWN_RECORD),
    moved(SESSION_NEXT, OWN_VIEW),
    moved(SESSION_PREV, OWN_VIEW),
    recorded(SESSION_EXPAND, 'It changes the terminal program\'s own view.'),
    recorded(SESSION_COLLAPSE, 'It changes the terminal program\'s own view.'),
    moved(SESSION_BOOKMARKS, 'Bookmarks belong to the terminal program\'s open conversation.'),
    moved(SESSION_COMPOSER, 'It is the terminal program\'s composer.'),
    moved(SESSION_RESTORED, OWN_RECORD),
    recorded(SESSION_COMPACTIONS, OWN_CONVERSATION),
    recorded(SESSION_SAVE_FILE, OWN_CONVERSATION),
    moved(SESSION_SAVE_SAVED, OWN_FILES),
    moved(SESSION_UPLOAD, 'The upload is made with the terminal app\'s GitHub sign-in.'),
    recorded(SESSION_BRANCH, 'Branches belong to the conversation open in the terminal app.'),
    moved(SESSION_BRANCHES, 'Branches belong to the conversation open in the terminal app.'),
    moved(SESSION_SWITCH_BRANCH, 'Branches belong to the conversation open in the terminal app.'),
    moved(SESSION_MERGE_BRANCH, 'Branches belong to the conversation open in the terminal app.'),
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
  return { actions, resume };
}

/**
 * `/session` and `/resume` for one app. `/resume` is a single-action command
 * whose one action is the definition `/session` lists (its word left out,
 * since the command name says it). Saving this session under a name is a
 * control on the conversation (session.save), not a command of its own.
 */
export function createSessionCommands<Ctx extends SessionCommandContext>(policy: SessionCommandPolicy<Ctx>): {
  readonly session: DescribedCommand<Ctx>;
  readonly resume: DescribedCommand<Ctx>;
  /** The app's session routines for the session capabilities (the model's capability_run and the Sessions place). */
  readonly live: (ctx: Ctx) => LiveSessions;
  /** The app's routines for the conversation's record, for its controls (the conversation's list and the model's capability_run). */
  readonly record: (ctx: Ctx) => ConversationRecord;
} {
  const { actions, resume } = sessionActions(policy);
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
    live: (ctx) => liveSessionsOf(policy, ctx),
    record: (ctx) => conversationRecordOf(policy, ctx),
  };
}
