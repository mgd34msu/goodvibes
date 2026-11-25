/**
 * Your conversations, as both terminal programs hold them: this session and
 * the saved ones (see, resume, copy, rename, search, delete, write out,
 * upload), this conversation's branches and record, and the project's
 * cross-session task graph (link, hand off, accept, take back, cancel). Each is
 * a session capability (capabilities/builtin/sessions.ts) run with this app's
 * routines (`liveSessionsOf`): the Sessions place, the model's
 * `capability_run` and the two commands that stay typed, `/resume` and
 * `/fork`, run the same ones. What each app does differently is its policy.
 */
import type { SessionManager, CancellationScope, CrossSessionTaskRef } from '@goodvibes/engine/platform/platform/sessions';
import { VALID_SCOPES } from '@goodvibes/engine/platform/platform/sessions';
import type { ShellSessionOrchestrationService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { SESSION_FORK, SESSION_RESUME, type LiveSessions, type SessionsCapabilityServices } from '@goodvibes/engine/platform/platform/capabilities';
import type { ConversationRecord } from '@goodvibes/engine/platform/platform/capabilities';
import { commandRefusal } from './command-confirmation.js';
import { sessionCapabilityAction } from './command-actions/capability-actions.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext } from './command-actions/types.js';
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
    /** Rename a saved session (`target`), or this one when `target` is empty. */
    rename(ctx: Ctx, name: string, target?: string): void;
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
    /** `opensScreen` false: a model's call, which opens nothing on the person's display. */
    find(ctx: Ctx, words: string, kind: string, options?: { readonly opensScreen?: boolean | undefined }): Promise<void>;
    /** Scroll to the next or previous entry of a kind, or of an error (`error`). */
    jump(ctx: Ctx, direction: 'next' | 'prev', kind: string): Promise<void>;
    composer(ctx: Ctx): void;
    restored(ctx: Ctx): Promise<void>;
    blocks(ctx: Ctx, type: string, fold: boolean): void;
    /** The bookmarked blocks; with a block's key, the conversation is moved to it. `asWords`: listed as the answer, no picker. */
    bookmarks(ctx: Ctx, block: string, asWords: boolean): void;
    /** What compaction removed so far; undefined when this app keeps no such record. */
    compactions: ((ctx: Ctx) => void) | undefined;
  };
  /** False when this app keeps one line of conversation (its branch actions are no controls of the Sessions place). */
  readonly keepsBranches?: false | undefined;
  /** False when this app uploads no conversation. */
  readonly uploads?: false | undefined;
  /**
   * Why this app changes only its own session's part of the cross-session task graph (adds and cancels its own tasks,
   * hands off its own tasks, accepts one handed to it, takes back one handed off from it), or undefined when it changes any.
   */
  readonly graphOwnTasksOnly: string | undefined;
  readonly graph: (ctx: Ctx, input: { readonly session: string; readonly format: string }) => void;
}

// ---------------------------------------------------------------------------
// Live lists, read only when a form or a completion asks
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

/** The hand-offs waiting to be accepted (`sessions.handoffs.waiting` in capabilities/builtin/sessions.ts). */
export const WAITING_HANDOFFS = defineList<SessionCommandContext>({
  name: 'sessions.handoffs.waiting',
  async read(ctx) {
    return (ctx.ops.sessionOrchestration?.getHandoffs() ?? []).filter((handoff) => !handoff.acknowledged).map((handoff): ListRow => ({
      value: handoff.handoffId, label: `task ${handoff.taskRef.taskId}`,
      detail: `${handoff.fromSessionId.slice(0, 8)}... to ${handoff.toSessionId.slice(0, 8)}...${handoff.reason ? `: ${handoff.reason}` : ''}`,
      state: 'waiting',
    }));
  },
  operator: { terminalOnly: 'The task graph is kept in the project by the terminal programs.' },
});

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

/** A session as a person reads it: this one, a saved one by its title, else its id. */
function sessionName(ctx: SessionCommandContext, id: string): string {
  if (id === ctx.session.runtime.sessionId) return 'this session';
  try {
    const title = (ctx.session.sessionManager?.list() ?? []).find((meta) => meta.name === id)?.title;
    if (title) return `"${title}"`;
  } catch {
    // The id names it when the saved sessions cannot be read.
  }
  return `session ${id}`;
}

/** The cross-session task graph's changes; in a program that changes only its own session's part, the rest is refused. */
function taskGraphOf<Ctx extends SessionCommandContext>(policy: SessionCommandPolicy<Ctx>) {
  const graphWrite = (ctx: Ctx): ShellSessionOrchestrationService => orchestrationOf(ctx);
  /** Refused unless `session` is this one, in a program that changes only its own session's part. */
  const ownOnly = (ctx: Ctx, session: string, what: string): void => {
    if (policy.graphOwnTasksOnly && session !== ctx.session.runtime.sessionId) throw commandRefusal(`${what}: ${policy.graphOwnTasksOnly}`);
  };
  const waiting = (ctx: Ctx, id: string) => {
    const orchestration = graphWrite(ctx);
    // The id or its start (the graph's text shows the first characters).
    const handoff = orchestration.getHandoffs().find((record) => record.handoffId === id)
      ?? (id.length >= 6 ? orchestration.getHandoffs().find((record) => record.handoffId.startsWith(id)) : undefined);
    if (!handoff) throw commandRefusal(`No hand-off is ${id}; nothing was changed.`);
    return { orchestration, handoff };
  };
  return {
    linkTask(ctx: Ctx, input: { readonly task: string; readonly from: string; readonly after: string; readonly label: string }): string {
      const orchestration = graphWrite(ctx);
      const taskId = input.task.trim();
      if (!taskId || taskId.includes(':')) throw commandRefusal('A task id is one word without ":" (that separates a session from a task); nothing was added.');
      const sessionId = input.from || ctx.session.runtime.sessionId;
      ownOnly(ctx, sessionId, `Task ${taskId} was not added`);
      const label = input.label || undefined;
      const ref: CrossSessionTaskRef = { sessionId, taskId, title: label ?? taskId, status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), label };
      const dependsOn = input.after ? parseRef(input.after, sessionId) : undefined;
      const result = orchestration.linkTask(ref, dependsOn);
      if (!result.ok) throw commandRefusal(`Task ${taskId} was not added: ${result.error}`);
      return `Task ${taskId}${label ? ` (${label})` : ''} is in the cross-session task graph${dependsOn ? `, waiting on ${input.after}` : ''}.`;
    },
    handOff(ctx: Ctx, input: { readonly task: string; readonly to: string; readonly from: string; readonly reason: string }): string {
      const orchestration = graphWrite(ctx);
      const from = input.from || ctx.session.runtime.sessionId;
      // A program that changes only its own session's part hands off its own session's tasks, and no other's.
      ownOnly(ctx, from, `Task ${input.task} was not handed off (it belongs to another session)`);
      const result = orchestration.initiateHandoff({ sessionId: from, taskId: input.task }, from, input.to, input.reason || undefined);
      if (!result.ok) throw commandRefusal(`Not handed off: ${result.error}`);
      return `Task ${input.task} is handed to ${sessionName(ctx, input.to)}: it is blocked until that session accepts it or you take it back.`;
    },
    accept(ctx: Ctx, id: string): string {
      const { orchestration, handoff } = waiting(ctx, id);
      ownOnly(ctx, handoff.toSessionId, `Task ${handoff.taskRef.taskId} was not accepted (it was handed to another session)`);
      if (handoff.acknowledged) throw commandRefusal(`Task ${handoff.taskRef.taskId} was already accepted; nothing was changed.`);
      if (!orchestration.acknowledgeHandoff(handoff.handoffId)) throw commandRefusal(`The hand-off of task ${handoff.taskRef.taskId} is no longer waiting; nothing was changed.`);
      const to = sessionName(ctx, handoff.toSessionId);
      return `${to.charAt(0).toUpperCase()}${to.slice(1)} has task ${handoff.taskRef.taskId} now.`;
    },
    withdraw(ctx: Ctx, id: string): string {
      const { orchestration, handoff } = waiting(ctx, id);
      ownOnly(ctx, handoff.fromSessionId, `Task ${handoff.taskRef.taskId} was not taken back (another session handed it off)`);
      const result = orchestration.withdrawHandoff(handoff.handoffId);
      if (!result.ok) throw commandRefusal(result.error ?? `The hand-off of task ${handoff.taskRef.taskId} could not be taken back.`);
      return `Task ${handoff.taskRef.taskId} is taken back and stays with ${sessionName(ctx, handoff.fromSessionId)}${result.status ? `, ${result.status} again` : ''}.`;
    },
    cancel(ctx: Ctx, input: { readonly scope: string; readonly task: string; readonly root: string; readonly from: string; readonly reason: string }): string {
      const orchestration = graphWrite(ctx);
      const scope = (input.scope || 'task') as CancellationScope;
      if (!VALID_SCOPES.includes(scope)) throw commandRefusal(`"${scope}" is not one of ${VALID_SCOPES.join(', ')}; nothing was cancelled.`);
      const taskId = scope === 'session' ? undefined : (scope === 'task' ? input.task : input.root);
      ownOnly(ctx, input.from || ctx.session.runtime.sessionId, 'Nothing was cancelled');
      const result = orchestration.cancel({ sessionId: input.from || ctx.session.runtime.sessionId, taskId, scope, reason: input.reason || undefined, requestedAt: Date.now() });
      if (!result.ok) throw commandRefusal(`Nothing was cancelled: ${result.error}`);
      if (result.cancelled.length === 1 && result.skipped.length === 0) return `Task ${result.cancelled[0]!.taskId} is cancelled; it does not start again.`;
      return [
        `Cancelled ${result.cancelled.length} task${result.cancelled.length === 1 ? '' : 's'}${result.cancelled.length > 0 ? ':' : '.'}`,
        ...result.cancelled.map((task) => `  ${task.taskId}  "${task.title}"`),
        ...(result.skipped.length ? [`Left ${result.skipped.length} that had already ended:`, ...result.skipped.map((task) => `  ${task.taskId}  (${task.reason})`)] : []),
      ].join('\n');
    },
  };
}

/** The app's session routines as the session capabilities take them (capabilities/builtin/sessions.ts). */
export function liveSessionsOf<Ctx extends SessionCommandContext>(policy: SessionCommandPolicy<Ctx>, ctx: Ctx): LiveSessions {
  const graph = taskGraphOf(policy);
  return {
    keepsBranches: policy.keepsBranches !== false,
    uploads: policy.uploads !== false,
    changesTaskGraph: true,
    ownTasksOnly: policy.graphOwnTasksOnly !== undefined,
    // A saved session by its title, for an ask that names it (capabilities/ask-words.ts): never by its id.
    titleOf: (id) => {
      try { return ctx.session.sessionManager?.list().find((meta) => meta.name === id)?.title || undefined; } catch { return undefined; }
    },
    current: () => said(ctx, (c) => policy.workflow.current(c)),
    list: () => said(ctx, (c) => policy.workflow.list(c)),
    info: (target) => said(ctx, (c) => policy.workflow.info(c, target)),
    search: (words) => said(ctx, (c) => policy.workflow.search(c, words)),
    remove: (target) => said(ctx, (c) => policy.workflow.remove(c, target)),
    resume: (target, force) => said(ctx, (c) => policy.resume(c, { target, force })),
    fork: (name) => said(ctx, (c) => policy.workflow.fork(c, name)),
    rename: (target, name) => said(ctx, (c) => policy.workflow.rename(c, name, target)),
    graph: (input) => said(ctx, (c) => policy.graph(c, input)),
    linkTask: (input) => said(ctx, (c) => graph.linkTask(c, input)),
    handOff: (input) => said(ctx, (c) => graph.handOff(c, input)),
    accept: (handoff) => said(ctx, (c) => graph.accept(c, handoff)),
    withdraw: (handoff) => said(ctx, (c) => graph.withdraw(c, handoff)),
    cancelTasks: (input) => said(ctx, (c) => graph.cancel(c, input)),
    exportSaved: (input) => said(ctx, (c) => policy.exportSaved(c, input)),
    upload: (input) => said(ctx, (c) => policy.upload(c, input)),
    branches: () => said(ctx, (c) => policy.branches.list(c)),
    switchBranch: (name) => said(ctx, (c) => policy.branches.switchTo(c, name)),
    mergeBranch: (name) => said(ctx, (c) => policy.branches.merge(c, name)),
    review: (view, input) => said(ctx, (c) => policy.workflow.review(c, view, input)),
    find: (words, kind, options) => said(ctx, (c) => policy.look.find(c, words, kind, options)),
    jump: (direction, kind) => said(ctx, (c) => policy.look.jump(c, direction, kind)),
    composer: () => said(ctx, (c) => policy.look.composer(c)),
    restored: () => said(ctx, (c) => policy.look.restored(c)),
    bookmarks: (block, asWords) => said(ctx, (c) => policy.look.bookmarks(c, block, asWords)),
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

/**
 * The two commands of your conversations that stay typed: `/resume` (continue a saved session here) and `/fork`
 * (continue in a copy of this one), each the session capability the Sessions place and the model run, with its
 * word left out since the command's name says it.
 */
export function createSessionCommands<Ctx extends SessionCommandContext>(policy: SessionCommandPolicy<Ctx>): {
  readonly resume: DescribedCommand<Ctx>;
  readonly fork: DescribedCommand<Ctx>;
  /** The app's session routines for the session capabilities (the model's capability_run and the Sessions place). */
  readonly live: (ctx: Ctx) => LiveSessions;
  /** The app's routines for the conversation's record, for its controls (the conversation's list and the model's capability_run). */
  readonly record: (ctx: Ctx) => ConversationRecord;
} {
  const moved = (definition: typeof SESSION_RESUME, terminalOnly: string) =>
    sessionCapabilityAction<Ctx, SessionsCapabilityServices>(definition, (ctx) => ({ sessions: liveSessionsOf(policy, ctx) }), { terminalOnly });
  const OWN_CONVERSATION = 'The conversation is the terminal program\'s own.';
  return {
    resume: defineCommand({ name: 'resume', title: 'Resume a session', summary: 'Continue a saved session here', group: 'Sessions', actions: [{ ...moved(SESSION_RESUME, OWN_CONVERSATION), word: '' }] }),
    fork: defineCommand({ name: 'fork', title: 'Continue in a copy', summary: 'Save a copy of this session and go on in the copy', group: 'Sessions', actions: [{ ...moved(SESSION_FORK, OWN_CONVERSATION), word: '' }] }),
    live: (ctx) => liveSessionsOf(policy, ctx),
    record: (ctx) => conversationRecordOf(policy, ctx),
  };
}
