import { randomBytes } from 'node:crypto';
import { findSessionCandidates, type SessionManager, type SessionMeta } from '@goodvibes-jev/engine/sdk/platform/sessions';
import { formatReturnContextForDisplay } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import type { TerminalConversationManager } from './terminal-conversation.js';
import {
  captureTranscriptSource,
  transcriptReadingCanceled,
  TRANSCRIPT_UNAVAILABLE,
  type TranscriptCommandContext,
} from './transcript-reading.js';
import { parseTranscriptKind } from './transcript-kinds.js';
import { createTranscriptReviewFormatter } from './transcript-review.js';
import { requireYesFlag, stripYesFlag } from './command-confirmation.js';
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
    readonly saved: (name: string, sanitizedName: string, path: string) => string;
    readonly forked: (id: string, name: string, source: string, title: string, count: number) => string;
    readonly prepareRename: (context: Context, manager: SessionManager) => void;
    readonly productCommand: (args: string[], context: Context, manager: SessionManager, sub: string) => Promise<boolean>;
  },
) {
  const { buildTranscriptReviewLines } = createTranscriptReviewFormatter(policy.reviewSeparator, policy.reviewDetailSeparator);
  async function handleSessionWorkflowCommand(args: string[], ctx: Context): Promise<boolean> {
    const sm = requireSessionManager(ctx);
    const sub = args[0];
    if (['resume', 'save', 'fork'].includes(sub ?? '') && ctx.isGenerating?.()) {
      ctx.print('A turn is still running. Stop it with Esc or let it finish before changing sessions.');
      return true;
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
        ctx.print('Usage: /session rename <new-name>');
        return true;
      }
      try {
        policy.prepareRename(ctx, sm);
        sm.rename(ctx.session.runtime.sessionId, newName);
        ctx.session.conversationManager.title = newName;
        ctx.print(policy.renamed(newName));
        ctx.renderRequest();
      } catch (e) {
        ctx.print(policy.failed('rename', e));
      }
      return true;
    }

    if (sub === 'fork' || sub === 'save') {
      const operation = sub;
      const source = ctx.session.runtime.sessionId;
      const newId = sub === 'fork' ? 'user-' + randomBytes(4).toString('hex') : undefined;
      const snapshot = policy.captureSession(ctx);
      const currentTitle = ctx.session.conversationManager.title;
      const name = args[1] ? args.slice(1).join(' ').trim() : sub === 'fork' ? 'fork-of-' + source.slice(0, 8) : currentTitle || source;
      const metadata: SessionMeta = {
        title: sub === 'fork' ? name : currentTitle,
        model: ctx.session.runtime.model,
        provider: ctx.session.runtime.provider,
        timestamp: Date.now(),
        ...snapshot.metadata,
        saveSource: 'user',
      };
      try {
        const result = sm.save(newId ?? name, snapshot.messages, metadata);
        const destination = newId ?? result.sanitizedName;
        policy.copySidecars(ctx, source, destination);
        policy.beforeSwitch(ctx, operation, source, destination);
        ctx.session.runtime.sessionId = destination;
        policy.afterSwitch(ctx, operation, destination);
        if (sub === 'fork') {
          ctx.session.conversationManager.title = name;
          ctx.renderRequest();
          ctx.print(policy.forked(destination, name, source, currentTitle, snapshot.messages.length));
        } else ctx.print(policy.saved(name, result.sanitizedName, result.filePath));
      } catch (error) {
        ctx.print(policy.failed(operation, error));
      }
      return true;
    }

    if (sub === 'info') {
      const target = args[1] || ctx.session.runtime.sessionId;
      const sessions = sm.list();
      const candidates = findSessionCandidates(sessions, target);
      if (candidates.length > 1) {
        ctx.print(`Ambiguous session: ${target}. Use an exact ID: ${candidates.map((session) => session.name).join(', ')}`);
        return true;
      }
      const found = candidates[0];
      if (!found) {
        ctx.print(`Session not found${policy.detailSeparator}${target}`);
        return true;
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
        ctx.print('Usage: /session search <keyword>');
        return true;
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
      const kind = parseTranscriptKind(args[1]);
      const source = captureTranscriptSource(ctx);
      try {
        const lines = await buildTranscriptReviewLines(ctx, kind, sub, source);
        source.assertPublishable();
        ctx.print(lines.join('\n'));
      } catch (error) {
        try {
          source.assertPublishable();
        } catch {
          return true;
        }
        if (!transcriptReadingCanceled(error)) ctx.print(TRANSCRIPT_UNAVAILABLE);
      }
      return true;
    }

    if (sub === 'delete') {
      const parsed = policy.confirmDelete ? stripYesFlag(args) : { rest: args, yes: true };
      const target = parsed.rest[1];
      if (!target) {
        ctx.print('Usage: /session delete <session-id>' + (policy.confirmDelete ? ' --yes' : ''));
        return true;
      }
      if (!parsed.yes) {
        requireYesFlag(ctx, 'delete saved session ' + target, '/session delete <session-id> --yes');
        return true;
      }
      const sessions = sm.list();
      const candidates = findSessionCandidates(sessions, target);
      if (candidates.length > 1) {
        ctx.print(`Ambiguous session: ${target}. Use an exact ID: ${candidates.map((session) => session.name).join(', ')}`);
        return true;
      }
      const found = candidates[0];
      if (!found) {
        ctx.print(`Session not found${policy.detailSeparator}${target}`);
        return true;
      }
      if (found.name === ctx.session.runtime.sessionId) {
        ctx.print(`Cannot delete the active session (${found.name}).\nSwitch to another session first with /session resume <id>.`);
        return true;
      }
      try {
        sm.delete(found.name);
        ctx.print(policy.deleted(found.name, found.title));
      } catch (e) {
        ctx.print(policy.failed('delete', e));
      }
      return true;
    }
    return policy.productCommand(args, ctx, sm, sub ?? '');
  }
  return { handleSessionWorkflowCommand };
}
