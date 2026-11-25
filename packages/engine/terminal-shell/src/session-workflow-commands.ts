import { randomBytes } from 'node:crypto';
import { resolveSessionTarget, type SessionManager, type SessionMeta } from '@goodvibes/engine/platform/platform/sessions';
import { formatReturnContextForDisplay } from '@goodvibes/engine/platform/platform/runtime/operations';
import type { TerminalConversationManager } from './terminal-conversation.js';
import {
  captureTranscriptSource,
  describeTranscriptReadFailure,
  transcriptReadingCanceled,
  type TranscriptCommandContext,
} from './transcript-reading.js';
import { describeUnknownTranscriptKind, readTranscriptKind } from './transcript-kinds.js';
import { createTranscriptReviewFormatter } from './transcript-review.js';
import { commandRefusal } from './command-confirmation.js';
export interface SessionWorkflowContext extends TranscriptCommandContext<TerminalConversationManager> {
  readonly session: {
    readonly sessionManager?: unknown;
    readonly runtime: { sessionId: string; model: string; provider: string };
    readonly conversationManager: TerminalConversationManager;
  };
  readonly isGenerating?: (() => boolean) | undefined;
  print(message: string): void;
  renderRequest(): void;
}
export function createSessionWorkflowCommands<Context extends SessionWorkflowContext>(
  requireSessionManager: (context: Context) => SessionManager,
  policy: {
    readonly headingSuffix: string;
    readonly detailSeparator: string;
    readonly postureSeparator: string;
    readonly reviewSeparator: string;
    readonly reviewDetailSeparator: string;
    readonly field: (view: 'current' | 'info', key: string, value: string) => string;
    readonly deleted: (name: string, title: string) => string;
    readonly failed: (action: 'rename' | 'delete' | 'fork' | 'save', error: unknown) => string;
    readonly captureSession: (context: Context) => {
      readonly messages: object[];
      readonly metadata: Pick<SessionMeta, 'titleSource' | 'returnContext'>;
    };
    readonly copySidecars: (context: Context, source: string, destination: string) => void;
    readonly beforeSwitch: (context: Context, operation: 'fork' | 'save', source: string, destination: string) => void;
    readonly afterSwitch: (context: Context, operation: 'fork' | 'save', destination: string) => void;
    /** What a save prints; `records` is how many agent records went with it, `switched` whether the live session moved to the saved name. */
    readonly saved: (name: string, sanitizedName: string, path: string, records: number, switched: boolean) => string;
    /** Agent records saved with the session; null refuses the save (the product has said why), undefined saves none. */
    readonly records?: ((context: Context) => Parameters<SessionManager['save']>[3] | null) | undefined;
    readonly forked: (id: string, name: string, source: string, title: string, count: number) => string;
  },
) {
  const { buildTranscriptReviewLines } = createTranscriptReviewFormatter(policy.reviewSeparator, policy.reviewDetailSeparator);

  /**
   * The one save behind `/save` and session.save. It writes the conversation
   * under the name and stays in the live session; `--switch` also makes the
   * saved name the live session id (later turns are saved there). The manager
   * refuses a name that holds another conversation unless `--replace` (or `--yes`).
   */
  function saveSession(ctx: Context, input: { readonly name: string; readonly replace: boolean; readonly switchTo: boolean }): void {
    const sm = requireSessionManager(ctx);
    const { replace, switchTo } = input;
    if (switchTo && ctx.isGenerating?.()) {
      throw commandRefusal('A turn is still running, so the session was not changed.', 'Stop it with Esc or let it finish, then run the command again.');
    }
    const source = ctx.session.runtime.sessionId;
    const requested = input.name.trim();
    const currentTitle = ctx.session.conversationManager.title;
    const name = requested || currentTitle || source;
    const records = policy.records?.(ctx);
    if (records === null) return;
    const snapshot = policy.captureSession(ctx);
    const metadata: SessionMeta = {
      title: currentTitle,
      model: ctx.session.runtime.model,
      provider: ctx.session.runtime.provider,
      timestamp: Date.now(),
      ...snapshot.metadata,
      saveSource: 'user',
      // The file records the id the conversation continues under: the saved name
      // when the live session moves there, else the live session's own id.
      conversationId: switchTo ? sm.sanitizeName(name) : source,
    };
    try {
      const result = sm.save(name, snapshot.messages, metadata, records, undefined, ctx.session.conversationManager.branchState(),
        { replace, savingConversationId: source, open: switchTo });
      if (switchTo) {
        const destination = result.sanitizedName;
        policy.copySidecars(ctx, source, destination);
        policy.beforeSwitch(ctx, 'save', source, destination);
        ctx.session.runtime.sessionId = destination;
        policy.afterSwitch(ctx, 'save', destination);
      }
      ctx.print(policy.saved(name, result.sanitizedName, result.filePath, records?.length ?? 0, switchTo));
    } catch (error) {
      throw commandRefusal(policy.failed('save', error));
    }
  }

  function refuseWhileGenerating(ctx: Context): void {
    if (ctx.isGenerating?.()) {
      throw commandRefusal('A turn is still running, so the session was not changed.', 'Stop it with Esc or let it finish, then run the command again.');
    }
  }

  function findSaved(sm: SessionManager, target: string) {
    const candidates = resolveSessionTarget(sm, target);
    if (candidates.length > 1) {
      throw commandRefusal(`Ambiguous session: ${target}.`, `Use an exact ID: ${candidates.map((session) => session.name).join(', ')}`);
    }
    const found = candidates[0];
    if (!found) throw commandRefusal(`Session not found${policy.detailSeparator}${target}`, 'The Sessions place lists your saved sessions.');
    return found;
  }

  /** This session: id, name, when it started, messages and model. */
  function current(ctx: Context): void {
    const sm = requireSessionManager(ctx);
    {
      const id = ctx.session.runtime.sessionId;
      const msgCount = ctx.session.conversationManager.getMessageCount();
      const title = ctx.session.conversationManager.title || '(untitled)';
      const meta = sm.getMeta(id);
      const started = meta ? new Date(meta.timestamp).toLocaleString() : 'this session';
      ctx.print(
        [
          'Current session',
          policy.field('current', 'id', id),
          policy.field('current', 'name', title),
          policy.field('current', 'started', started),
          policy.field('current', 'messages', String(msgCount)),
          policy.field('current', 'model', `${ctx.session.runtime.model} (${ctx.session.runtime.provider})`),
        ].join('\n'),
      );
    }
  }

  /** Every saved session, newest first. */
  function list(ctx: Context): void {
    const sm = requireSessionManager(ctx);
    {
      const sessions = sm.list();
      if (sessions.length === 0) {
        ctx.print('No saved sessions. This conversation, "Save this session under a name", saves the one open here.');
        return;
      }
      const lines = ['Sessions (most recent first)' + policy.headingSuffix, ''];
      for (const session of sessions) {
        const date = new Date(session.timestamp).toLocaleString();
        const name = session.title || session.name;
        const model = session.model ? ` [${session.model}]` : '';
        const active = session.name === ctx.session.runtime.sessionId ? ' ●' : '  ';
        lines.push(`${active} ${session.name.padEnd(28)} ${name.slice(0, 22).padEnd(22)} ${date}  ${session.messageCount} msgs${model}`);
        if (session.returnContext?.activeTasks || session.returnContext?.blockedTasks || session.returnContext?.pendingApprovals) {
          const posture = [
            session.returnContext.activeTasks ? `active${policy.postureSeparator}${session.returnContext.activeTasks}` : null,
            session.returnContext.blockedTasks ? `blocked${policy.postureSeparator}${session.returnContext.blockedTasks}` : null,
            session.returnContext.pendingApprovals ? `approvals${policy.postureSeparator}${session.returnContext.pendingApprovals}` : null,
          ]
            .filter(Boolean)
            .join('  ');
          if (posture) lines.push(`     posture${policy.detailSeparator}${posture}`);
        }
      }
      ctx.print(lines.join('\n'));
    }
  }

  /** Give a saved session a new name, or this one (saving it first when it has no file yet). */
  function rename(ctx: Context, name: string, target?: string): void {
    const sm = requireSessionManager(ctx);
    {
      const newName = name.trim();
      if (!newName) {
        throw commandRefusal('A session needs a name; nothing was renamed.');
      }
      const requested = (target ?? '').trim();
      if (requested && requested !== '.' && requested !== ctx.session.runtime.sessionId) {
        // A saved session other than the one open here: only its name in the list changes.
        const found = findSaved(sm, requested);
        if (found.name !== ctx.session.runtime.sessionId) {
          try {
            sm.rename(found.name, newName);
          } catch (e) {
            throw commandRefusal(policy.failed('rename', e));
          }
          ctx.print(`Saved session "${found.title || found.name}" is called "${newName}" now.`);
          return;
        }
      }
      try {
        const sessionId = ctx.session.runtime.sessionId;
        if (!sm.getMeta(sessionId)) {
          const snapshot = policy.captureSession(ctx);
          sm.save(sessionId, snapshot.messages, {
            title: ctx.session.conversationManager.title || '',
            model: ctx.session.runtime.model,
            provider: ctx.session.runtime.provider,
            timestamp: Date.now(),
            ...snapshot.metadata,
            // Materializing a file for an explicit rename is a user save;
            // retention must preserve this deliberately named conversation.
            saveSource: 'user',
          }, undefined, undefined, ctx.session.conversationManager.branchState());
        }
        sm.rename(sessionId, newName);
        ctx.session.conversationManager.title = newName;
        ctx.print(`This session, the one open here, is called "${newName}" now.`);
        ctx.renderRequest();
      } catch (e) {
        throw commandRefusal(policy.failed('rename', e));
      }
    }
  }

  /** A copy of this session under a new id, which becomes the live session. */
  function fork(ctx: Context, requestedName: string): void {
    refuseWhileGenerating(ctx);
    const sm = requireSessionManager(ctx);
    {
      const source = ctx.session.runtime.sessionId;
      const newId = 'user-' + randomBytes(4).toString('hex');
      const requested = requestedName.trim();
      const currentTitle = ctx.session.conversationManager.title;
      const name = requested || 'fork-of-' + source.slice(0, 8);
      const snapshot = policy.captureSession(ctx);
      const metadata: SessionMeta = {
        title: name,
        model: ctx.session.runtime.model,
        provider: ctx.session.runtime.provider,
        timestamp: Date.now(),
        ...snapshot.metadata,
        saveSource: 'user',
      };
      try {
        // The fork becomes the live session, so this terminal opens it for writing.
        sm.save(newId, snapshot.messages, metadata, undefined, undefined, ctx.session.conversationManager.branchState(), { open: true });
        policy.copySidecars(ctx, source, newId);
        policy.beforeSwitch(ctx, 'fork', source, newId);
        ctx.session.runtime.sessionId = newId;
        policy.afterSwitch(ctx, 'fork', newId);
        ctx.session.conversationManager.title = name;
        ctx.renderRequest();
        ctx.print(policy.forked(newId, name, source, currentTitle, snapshot.messages.length));
      } catch (error) {
        throw commandRefusal(policy.failed('fork', error));
      }
    }
  }

  /** A saved session's details. */
  function info(ctx: Context, requested: string): void {
    const sm = requireSessionManager(ctx);
    {
      const found = findSaved(sm, requested || ctx.session.runtime.sessionId);
      const date = new Date(found.timestamp).toLocaleString();
      ctx.print(
        [
          policy.field('info', 'heading', found.name),
          policy.field('info', 'title', String(found.title || '(untitled)')),
          policy.field('info', 'model', String(found.model || '(unknown)')),
          policy.field('info', 'provider', String(found.provider || '(unknown)')),
          policy.field('info', 'date', String(date)),
          policy.field('info', 'messages', String(found.messageCount)),
          policy.field('info', 'file', String(found.filePath)),
          ...(found.returnContext ? formatReturnContextForDisplay(found.returnContext).map((line) => `  ${line}`) : []),
        ].join('\n'),
      );
    }
  }

  /** Saved sessions whose messages hold the words. */
  function search(ctx: Context, words: string): void {
    const sm = requireSessionManager(ctx);
    {
      const query = words.trim();
      if (!query) throw commandRefusal('Give the words to look for; nothing was searched.');
      const results = sm.search(query);
      if (results.length === 0) {
        ctx.print(`No sessions found matching${policy.detailSeparator}"${query}"`);
        return;
      }
      const lines = [
        `Search results for "${query}" (${results.length} session${results.length !== 1 ? 's' : ''})${policy.headingSuffix}\n`,
      ];
      for (const result of results) {
        const date = new Date(result.session.timestamp).toLocaleString();
        lines.push(
          `  ${result.session.name}  ${result.session.title || '(untitled)'}  ${date}  (${result.matchCount} match${result.matchCount !== 1 ? 'es' : ''})`,
        );
        for (const snippet of result.snippets) {
          lines.push(`    > ${snippet}`);
        }
        lines.push('');
      }
      ctx.print(lines.join('\n'));
    }
  }

  /** The transcript as events, groups or hotspots, one kind or all, a page at a time. */
  async function review(ctx: Context, view: 'events' | 'groups' | 'hotspots', input: { readonly kind: string; readonly start: string; readonly last: string }): Promise<void> {
    {
      const number = (raw: string, what: string): number | undefined => {
        if (!raw) return undefined;
        const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isSafeInteger(value) || value < 1) throw commandRefusal(`Not shown: ${what} takes a whole number from 1, not "${raw}".`);
        return value;
      };
      const page = { start: number(input.start, 'the first row'), size: number(input.last, 'how many rows') };
      if (view === 'hotspots' && (page.start !== undefined || page.size !== undefined)) {
        throw commandRefusal('Not shown: hotspots counts the whole transcript and takes only a kind.');
      }
      const kind = readTranscriptKind(input.kind || undefined);
      if (kind === undefined) throw commandRefusal(describeUnknownTranscriptKind(input.kind));
      const source = captureTranscriptSource(ctx);
      try {
        const lines = await buildTranscriptReviewLines(ctx, kind, view, source, page);
        source.assertPublishable();
        ctx.print(lines.join('\n'));
      } catch (error) {
        try {
          source.assertPublishable();
        } catch {
          return;
        }
        if (!transcriptReadingCanceled(error)) throw commandRefusal(describeTranscriptReadFailure(error));
      }
    }
  }

  /** Delete a saved session; never the live one. The command asks before this runs. */
  function remove(ctx: Context, target: string): void {
    const sm = requireSessionManager(ctx);
    const found = findSaved(sm, target);
    if (found.name === ctx.session.runtime.sessionId) {
      throw commandRefusal(`Cannot delete the active session (${found.name}).`, 'Resume another session first: /resume');
    }
    try {
      sm.delete(found.name);
      ctx.print(policy.deleted(found.name, found.title));
    } catch (e) {
      throw commandRefusal(policy.failed('delete', e));
    }
  }

  function save(ctx: Context, input: { readonly name: string; readonly replace: boolean; readonly switchTo: boolean }): void {
    saveSession(ctx, input);
  }

  return { current, list, rename, save, fork, info, search, review, remove, findSaved, refuseWhileGenerating };
}

export type SessionWorkflow = ReturnType<typeof createSessionWorkflowCommands>;
