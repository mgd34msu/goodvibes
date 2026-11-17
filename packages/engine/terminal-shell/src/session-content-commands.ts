import { mkdirSync, existsSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ExportMessage } from '@goodvibes-jev/engine/platform/platform/export';
import { redactSensitiveDataAsync } from '@goodvibes-jev/engine/platform/platform/utils';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import type { TerminalSlashCommand } from './command-registry.js';
import { commandRefusal, requireYesFlag, stripYesFlag } from './command-confirmation.js';
import { formatTranscript, parseTranscriptFormat, type TranscriptFormat } from './session-export-format.js';
interface ContentContext {
  readonly session: {
    readonly runtime: { readonly model: string; readonly provider: string; readonly sessionId: string };
    readonly conversationManager: {
      title: string;
      getLastUserMessage(): string | null | undefined;
      undo(): boolean;
      branchState?(): { readonly branches: Readonly<Record<string, readonly object[]>>; readonly currentBranch: string };
    };
  };
  print(message: string): void;
  renderRequest(): void;
  readonly submitInput?: ((message: string) => void) | undefined;
  /** Resends a message exactly as it was sent, without the composer's grammar. */
  readonly submitTurn?: ((message: string) => void) | undefined;
}
export function createSessionContentCommands<Context extends ContentContext, Message>(policy: {
  readonly paths: (context: Context) => Pick<ShellPathService, 'resolveWorkspacePath' | 'isWithinWorkingDirectory'>;
  readonly capture: (context: Context) => readonly Message[];
  readonly markdown: (messages: readonly Message[]) => ExportMessage[];
  readonly text: (message: Message) => string;
  readonly role: (message: Message) => string;
  readonly confirmExport: boolean;
  readonly invalidPath: string;
  readonly exported: (count: number, path: string) => string;
  readonly failed: (action: string, error: unknown) => string;
  readonly title: (title: string) => string;
  readonly titleSet: (title: string) => string;
  readonly retryDescription: string;
  readonly retryRemovesLastTurn: boolean;
  /**
   * Redacts the transcript before it becomes a file. Defaults to the platform's
   * export redactor; a product passes its own when it needs to bind the
   * redaction to its own cancellation and source-lifetime checks.
   */
  readonly redact?: ((text: string, context: Context) => Promise<string>) | undefined;
}) {
  const exportCommand: TerminalSlashCommand<Context> = {
    name: 'export',
    effect: 'local-state',
    description: 'Export conversation to a Markdown file',
    usage: '[format] [path]' + (policy.confirmExport ? ' --yes' : ' [--yes]'),
    argsHint: '[markdown] [path]',
    async handler(args, ctx) {
      const shellPaths = policy.paths(ctx);
      const { rest, yes } = stripYesFlag(args);
      let format: TranscriptFormat = 'markdown',
        outPath: string | undefined;
      for (const arg of rest) {
        const named = parseTranscriptFormat(arg);
        if (named) format = named;
        else outPath = arg;
      }
      if (!outPath) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        outPath = './conversation-' + timestamp + (format === 'markdown' ? '.md' : '.txt');
      }
      const resolvedPath = shellPaths.resolveWorkspacePath(outPath);
      if (!shellPaths.isWithinWorkingDirectory(resolvedPath)) {
        ctx.print(policy.invalidPath);
        return;
      }
      // Replacing a file that is already there needs --yes in every product;
      // a new file needs it only where the product asks for every export.
      let replacing = false;
      try { replacing = statSync(resolvedPath).isFile(); } catch { /* nothing there yet */ }
      if (replacing && !yes) {
        ctx.print(`${resolvedPath} already exists, so nothing was written. Run ${['/export', ...rest, '--yes'].join(' ')} to replace it, or give another path.`);
        return;
      }
      if (policy.confirmExport && !yes) {
        requireYesFlag(ctx, 'export conversation to ' + resolvedPath, '/export [format] [path] --yes');
        return;
      }
      try {
        const messages = policy.capture(ctx);
        let fileContent = formatTranscript(messages, format, policy, {
          model: ctx.session.runtime.model,
          provider: ctx.session.runtime.provider,
          sessionId: ctx.session.runtime.sessionId,
          title: ctx.session.conversationManager.title || undefined,
        });
        // The file is the durable copy of a transcript, so it is redacted like
        // the printed `/session export`. A failed redaction writes nothing.
        fileContent = await (policy.redact ? policy.redact(fileContent, ctx) : redactSensitiveDataAsync(fileContent, { purpose: 'export' }));
        const dir = dirname(resolvedPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        await writeFile(resolvedPath, fileContent, 'utf-8');
        ctx.print(policy.exported(messages.length, resolvedPath));
      } catch (error) {
        throw commandRefusal(policy.failed('export conversation', error));
      }
    },
  };
  const titleCommand: TerminalSlashCommand<Context> = {
    name: 'title',
    effect: 'session-lifecycle',
    description: 'Show or set the conversation title',
    usage: '[text]',
    argsHint: '[text]',
    // The title is the rest of the line exactly as typed.
    rawRest: 0,
    handler(args, ctx) {
      if (!args.length)
        ctx.print(ctx.session.conversationManager.title ? policy.title(ctx.session.conversationManager.title) : 'No title set.');
      else {
        ctx.session.conversationManager.title = args.join(' ');
        ctx.print(policy.titleSet(ctx.session.conversationManager.title));
        ctx.renderRequest();
      }
    },
  };
  const retryCommand: TerminalSlashCommand<Context> = {
    name: 'retry',
    effect: 'session-lifecycle',
    aliases: ['r'],
    description: policy.retryDescription,
    usage: '[modified text]',
    argsHint: '[modified text]',
    // The modified message is sent exactly as typed.
    rawRest: 0,
    handler(args, ctx) {
      const last = ctx.session.conversationManager.getLastUserMessage();
      if (!last) {
        throw commandRefusal('No message to retry.');
      }
      if (!ctx.submitTurn) {
        throw commandRefusal('Retry is unavailable here: this surface cannot resubmit a message, so the conversation was left unchanged.');
      }
      // Remove the old turn only when the message can be sent again, and send
      // nothing if it could not be removed (that would duplicate the turn).
      if (policy.retryRemovesLastTurn && !ctx.session.conversationManager.undo()) {
        throw commandRefusal('Nothing was retried: the last turn could not be removed, and sending it again would duplicate it. Type the message as a new prompt if you still want an answer.');
      }
      ctx.submitTurn(args.length ? args.join(' ') : last);
    },
  };
  return { exportCommand, titleCommand, retryCommand };
}

export function createSessionListCommand<
  Context extends ContentContext & {
    readonly openSelection?: import('./selection-modal.js').OpenSelection | undefined;
  },
>(policy: {
  readonly manager: (context: Context) => import('@goodvibes-jev/engine/platform/platform/sessions').SessionManager;
  readonly forward: (args: string[], context: Context) => void | Promise<void>;
  readonly emptyDetail: string;
  readonly actions: string;
  readonly options: Parameters<import('./selection-modal.js').OpenSelection>[2];
  readonly selected: (
    context: Context,
    manager: import('@goodvibes-jev/engine/platform/platform/sessions').SessionManager,
    sessions: ReturnType<import('@goodvibes-jev/engine/platform/platform/sessions').SessionManager['list']>,
    result: import('./selection-modal.js').SelectionResult,
  ) => void;
  readonly heading: string;
}): TerminalSlashCommand<Context> {
  return {
    name: 'sessions',
    effect: 'session-lifecycle',
    description: 'List saved sessions',
    usage: '[resume <id|name>]',
    argsHint: '[resume <id|name>]',
    async handler(args, ctx) {
      if (args.length) {
        await policy.forward(args, ctx);
        return;
      }
      const manager = policy.manager(ctx);
      const sessions = manager.list();
      if (ctx.openSelection) {
        const items =
          sessions.length === 0
            ? [{ id: '_empty', label: 'No saved sessions', detail: policy.emptyDetail }]
            : sessions.map((session) => ({
                id: session.name,
                label: session.name,
                detail: session.title || '(untitled)',
                actions: policy.actions,
              }));
        ctx.openSelection('Sessions', items, policy.options, (result) => {
          if (result && result.item.id !== '_empty') policy.selected(ctx, manager, sessions, result);
        });
        return;
      }
      const lines = [policy.heading, ''];
      for (const session of sessions)
        lines.push(
          `  ${session.name.padEnd(30)} ${(session.title || '(untitled)').padEnd(24)} ${new Date(session.timestamp).toLocaleString()}  (${session.messageCount} msgs)`,
        );
      ctx.print(lines.join('\n'));
    },
  };
}
