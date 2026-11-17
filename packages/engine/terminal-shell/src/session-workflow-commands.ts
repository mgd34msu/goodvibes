import { randomBytes } from 'node:crypto';
import { resolveSessionTarget, type SessionManager, type SessionMeta } from '@goodvibes-jev/engine/platform/platform/sessions';
import { formatReturnContextForDisplay } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { TerminalConversationManager } from './terminal-conversation.js';
import {
  captureTranscriptSource,
  describeTranscriptReadFailure,
  transcriptReadingCanceled,
  type TranscriptCommandContext,
} from './transcript-reading.js';
import { describeUnknownTranscriptKind, readTranscriptKind } from './transcript-kinds.js';
import { createTranscriptReviewFormatter, readTranscriptReviewArguments } from './transcript-review.js';
import { commandRefusal, requireYesFlag, stripYesFlag } from './command-confirmation.js';
import type { TerminalSlashCommand } from './command-registry.js';
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
    readonly confirmDelete: boolean;
    readonly reviewSeparator: string;
    readonly reviewDetailSeparator: string;
    readonly field: (view: 'current' | 'info', key: string, value: string) => string;
    readonly renamed: (name: string) => string;
    readonly deleted: (name: string, title: string) => string;
    readonly failed: (action: 'rename' | 'delete' | 'fork' | 'save', error: unknown) => string;
    readonly captureSession: (context: Context) => {
      readonly messages: object[];
      readonly metadata: Pick<SessionMeta, 'titleSource' | 'returnContext'>;
    };
    readonly copySidecars: (context: Context, source: string, destination: string) => void;
    readonly beforeSwitch: (context: Context, operation: 'fork' | 'save', source: string, destination: string) => void;
    readonly afterSwitch: (context: Context, operation: 'fork' | 'save', destination: string) => void;
    /** What `/save` and `/session save` print; `records` is how many agent records went with it, `switched` whether the live session moved to the saved name. */
    readonly saved: (name: string, sanitizedName: string, path: string, records: number, switched: boolean) => string;
    /** The `/save` command's description (it names where sessions are stored). */
    readonly saveDescription: string;
    /** Agent records saved with the session; null refuses the save (the product has said why), undefined saves none. */
    readonly records?: ((context: Context) => Parameters<SessionManager['save']>[3] | null) | undefined;
    readonly forked: (id: string, name: string, source: string, title: string, count: number) => string;
    readonly productCommand: (args: string[], context: Context, manager: SessionManager, sub: string) => Promise<boolean>;
  },
) {
  const { buildTranscriptReviewLines } = createTranscriptReviewFormatter(policy.reviewSeparator, policy.reviewDetailSeparator);

  /**
   * The one save behind `/save` and `/session save`. It writes the conversation
   * under the name and stays in the live session; `--switch` also makes the
   * saved name the live session id (later turns are saved there). The manager
   * refuses a name that holds another conversation unless `--replace` (or `--yes`).
   */
  function saveSession(args: readonly string[], ctx: Context): void {
    const sm = requireSessionManager(ctx);
    const confirmation = stripYesFlag([...args]);
    const replace = confirmation.yes || confirmation.rest.includes('--replace');
    const switchTo = confirmation.rest.includes('--switch');
    if (switchTo && ctx.isGenerating?.()) {
      throw commandRefusal('A turn is still running, so the session was not changed.', 'Stop it with Esc or let it finish, then run the command again.');
    }
    const source = ctx.session.runtime.sessionId;
    // Every word is the name: "/save my notes" saves "my notes".
    const requested = confirmation.rest.filter((arg) => arg !== '--replace' && arg !== '--switch').join(' ').trim();
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
        { replace, savingConversationId: source });
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

  /** `/save [name] [--replace] [--switch]`: the same save as `/session save`. */
  const saveCommand: TerminalSlashCommand<Context> = {
    name: 'save',
    effect: 'session-lifecycle',
    description: policy.saveDescription,
    usage: '[name] [--replace] [--switch]',
    argsHint: '[name] [--replace] [--switch]',
    handler(args, ctx) {
      saveSession(args, ctx);
    },
  };

  async function handleSessionWorkflowCommand(args: string[], ctx: Context): Promise<boolean> {
    const sm = requireSessionManager(ctx);
    const sub = args[0];
    if (['resume', 'fork'].includes(sub ?? '') && ctx.isGenerating?.()) {
      throw commandRefusal('A turn is still running, so the session was not changed.', 'Stop it with Esc or let it finish, then run the command again.');
    }

    if (!sub) {
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
      return true;
    }

    if (sub === 'list') {
      const sessions = sm.list();
      if (sessions.length === 0) {
        ctx.print('No saved sessions. Use /session save [name] to save the current session.');
        return true;
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
      return true;
    }

    if (sub === 'rename') {
      const newName = args.slice(1).join(' ').trim();
      if (!newName) {
        throw commandRefusal('Usage: /session rename <new-name>');
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
        ctx.print(policy.renamed(newName));
        ctx.renderRequest();
      } catch (e) {
        throw commandRefusal(policy.failed('rename', e));
      }
      return true;
    }

    if (sub === 'save') {
      saveSession(args.slice(1), ctx);
      return true;
    }

    if (sub === 'fork') {
      const source = ctx.session.runtime.sessionId;
      const newId = 'user-' + randomBytes(4).toString('hex');
      const requested = args.slice(1).join(' ').trim();
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
        sm.save(newId, snapshot.messages, metadata, undefined, undefined, ctx.session.conversationManager.branchState());
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
      return true;
    }

    if (sub === 'info') {
      const target = args[1] || ctx.session.runtime.sessionId;
      const candidates = resolveSessionTarget(sm, target);
      if (candidates.length > 1) {
        throw commandRefusal(`Ambiguous session: ${target}.`, `Use an exact ID: ${candidates.map((session) => session.name).join(', ')}`);
      }
      const found = candidates[0];
      if (!found) {
        throw commandRefusal(`Session not found${policy.detailSeparator}${target}`, 'Use /session list to see saved sessions.');
      }
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
      return true;
    }

    if (sub === 'search') {
      const query = args.slice(1).join(' ').trim();
      if (!query) {
        throw commandRefusal('Usage: /session search <keyword>');
      }
      const results = sm.search(query);
      if (results.length === 0) {
        ctx.print(`No sessions found matching${policy.detailSeparator}"${query}"`);
        return true;
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
      return true;
    }

    if (sub === 'events' || sub === 'groups' || sub === 'hotspots') {
      const parsed = readTranscriptReviewArguments(args.slice(1));
      if ('refusal' in parsed) throw commandRefusal(parsed.refusal);
      if (sub === 'hotspots' && (parsed.page.start !== undefined || parsed.page.size !== undefined)) {
        throw commandRefusal('Not shown: hotspots counts the whole transcript and takes only a kind.', 'Usage: /session hotspots [kind]');
      }
      const kind = readTranscriptKind(parsed.kindWord);
      if (kind === undefined) throw commandRefusal(describeUnknownTranscriptKind(parsed.kindWord ?? ''));
      const source = captureTranscriptSource(ctx);
      try {
        const lines = await buildTranscriptReviewLines(ctx, kind, sub, source, parsed.page);
        source.assertPublishable();
        ctx.print(lines.join('\n'));
      } catch (error) {
        try {
          source.assertPublishable();
        } catch {
          return true;
        }
        if (!transcriptReadingCanceled(error)) throw commandRefusal(describeTranscriptReadFailure(error));
      }
      return true;
    }

    if (sub === 'delete') {
      const parsed = policy.confirmDelete ? stripYesFlag(args) : { rest: args, yes: true };
      const target = parsed.rest[1];
      if (!target) {
        throw commandRefusal('Usage: /session delete <session-id>' + (policy.confirmDelete ? ' --yes' : ''));
      }
      // Resolve first, so the confirmation names the session that would be removed.
      const candidates = resolveSessionTarget(sm, target);
      if (candidates.length > 1) {
        throw commandRefusal(`Ambiguous session: ${target}.`, `Use an exact ID: ${candidates.map((session) => session.name).join(', ')}`);
      }
      const found = candidates[0];
      if (!found) {
        throw commandRefusal(`Session not found${policy.detailSeparator}${target}`, 'Use /session list to see saved sessions.');
      }
      if (found.name === ctx.session.runtime.sessionId) {
        throw commandRefusal(`Cannot delete the active session (${found.name}).`, 'Switch to another session first with /session resume <id>.');
      }
      if (!parsed.yes) {
        const described = `${found.name}${found.title ? ` ("${found.title}")` : ''}, ${found.messageCount} message${found.messageCount === 1 ? '' : 's'}`;
        requireYesFlag(ctx, 'delete saved session ' + described, `/session delete ${found.name} --yes`);
        return true;
      }
      try {
        sm.delete(found.name);
        ctx.print(policy.deleted(found.name, found.title));
      } catch (e) {
        throw commandRefusal(policy.failed('delete', e));
      }
      return true;
    }
    return policy.productCommand(args, ctx, sm, sub ?? '');
  }
  return { handleSessionWorkflowCommand, saveCommand };
}
