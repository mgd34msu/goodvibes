import { mkdirSync, existsSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ExportMessage } from '@goodvibes-jev/engine/platform/platform/export';
import { redactSensitiveDataAsync } from '@goodvibes-jev/engine/platform/platform/utils';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import type { TerminalSlashCommand } from './command-registry.js';
import { commandRefusal } from './command-confirmation.js';
import { readRefusal } from '@goodvibes-jev/engine/errors';
import { formatTranscript, type TranscriptFormat } from './session-export-format.js';
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
  /**
   * Write this conversation to a file inside the working directory, redacted
   * like every export (a failed redaction writes nothing). With no path, a new
   * timestamped file. The command asks first when the file is already there.
   */
  async function exportConversation(ctx: Context, input: { readonly format: TranscriptFormat; readonly path: string }): Promise<string> {
    const shellPaths = policy.paths(ctx);
    const format = input.format;
    const outPath = input.path || './conversation-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + (format === 'markdown' ? '.md' : '.txt');
    const resolvedPath = shellPaths.resolveWorkspacePath(outPath);
    if (!shellPaths.isWithinWorkingDirectory(resolvedPath)) throw commandRefusal(policy.invalidPath);
    try {
      const messages = policy.capture(ctx);
      let fileContent = formatTranscript(messages, format, policy, {
        model: ctx.session.runtime.model,
        provider: ctx.session.runtime.provider,
        sessionId: ctx.session.runtime.sessionId,
        title: ctx.session.conversationManager.title || undefined,
      });
      fileContent = await (policy.redact ? policy.redact(fileContent, ctx) : redactSensitiveDataAsync(fileContent, { purpose: 'export' }));
      const dir = dirname(resolvedPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      await writeFile(resolvedPath, fileContent, 'utf-8');
      return policy.exported(messages.length, resolvedPath);
    } catch (error) {
      if (readRefusal(error)) throw error;
      throw commandRefusal(policy.failed('export conversation', error));
    }
  }
  /** Whether an export to `path` would replace a file that is there. */
  function exportReplaces(ctx: Context, path: string): boolean {
    if (!path) return false;
    try { return statSync(policy.paths(ctx).resolveWorkspacePath(path)).isFile(); } catch { return false; }
  }
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
  return { exportConversation, exportReplaces, titleCommand, retryCommand };
}
