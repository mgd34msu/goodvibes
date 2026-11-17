import { exportMessageFromRecord, formatTranscript, resolveSessionExportRequest, type TranscriptFormat } from '@goodvibes-jev/engine/terminal-shell/session-export-format';
import { createSessionWorkflowCommands } from '@goodvibes-jev/engine/terminal-shell/session-workflow-commands';
import { resolveSessionTarget } from '@goodvibes-jev/engine/platform/platform/sessions';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { CommandContext } from '../command-registry.ts';

import type { ConversationTitleSource } from '../../core/conversation';
import type { SessionReturnContextSummary } from '@/runtime/index.ts';
import {
  formatReturnContextForDisplay,
  getReturnContextMode,
  loadedReturnContext,
  maybeAssistReturnContextSummary,
} from '@/runtime/index.ts';
import { requireProviderApi, requireSessionManager, requireShellPaths, requireSurface } from './runtime-services.ts';
import { resumeSessionCore } from '../../core/session-resume-core.ts';
import { isSessionOpenElsewhere } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { moveLiveSessionArtifacts } from '../../core/session-resume-core.ts';
import { redactSensitiveDataAsync, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { clearTurnAnchors, getTurnAnchors, persistTurnAnchors, recordTurnAnchor } from '@goodvibes-jev/engine/platform/platform/rewind';
import { saveWorkTreeFolds } from '../../core/work-tree-fold-store.ts';

function copySessionSidecars(ctx: CommandContext, destination: string): void {
  const source = ctx.session.runtime.sessionId;
  if (source === destination) return;
  clearTurnAnchors(destination);
  for (const anchor of getTurnAnchors(source)) recordTurnAnchor(destination, anchor);
  const surface = requireSurface(ctx);
  if (getTurnAnchors(destination).length === 0) {
    rmSync(join(surface.sessionsDir, `${destination}.anchors.json`), { force: true });
  }
  persistTurnAnchors(destination, surface);
  const tree = ctx.session.conversationManager.workTree;
  saveWorkTreeFolds(surface.sessionsDir, destination, tree.foldState(), tree.turnOutcomes());
}

/** Text of a message whose content is a string or an array of parts; non-text parts show as a labelled placeholder, never `[object Object]`. */
function flattenMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content
    .map((part: unknown) => {
      if (typeof part === 'string') return part;
      if (typeof part === 'object' && part !== null) {
        const record = part as { type?: unknown; text?: unknown };
        if (typeof record.text === 'string') return record.text;
        return `[${typeof record.type === 'string' ? record.type : 'non-text'} part omitted]`;
      }
      return String(part);
    })
    .join('\n');
}

/**
 * `/session export` writes the transcript to a file (redacted like every
 * export), and prints it only with `--print`; the printed copy is display-only
 * and never becomes part of this conversation.
 */
async function exportSessionTranscript(
  ctx: Pick<CommandContext, 'print' | 'workspace'>,
  sessionId: string,
  title: string,
  messages: Array<Record<string, unknown>>,
  format: TranscriptFormat,
  output: { readonly printOnly: boolean; readonly path: string | undefined },
): Promise<void> {
  // The same renderer `/export` uses, so both commands give one transcript of a session.
  const formatted = formatTranscript(messages, format, {
    markdown: (all) => all.map(exportMessageFromRecord),
    text: (message) => flattenMessageContent(message.content),
    role: (message) => String(message.role ?? 'unknown'),
  }, { sessionId, title: title || undefined });
  // A failed redaction writes and prints nothing.
  const redacted = await redactSensitiveDataAsync(formatted, { purpose: 'export' });
  if (output.printOnly) {
    ctx.print(redacted);
    return;
  }
  const paths = requireShellPaths(ctx);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = output.path
    ? paths.resolveWorkspacePath(output.path)
    : join(paths.homeDirectory, 'goodvibes-exports', `session-${sessionId}-${stamp}.${format === 'text' ? 'txt' : 'md'}`);
  mkdirSync(dirname(target), { recursive: true });
  // Never replaces an existing file.
  writeFileSync(target, redacted, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
  ctx.print(`Exported session ${sessionId} (${messages.length} messages, redacted) to ${target}`);
}

/** `--print` and `--out <path>` of `/session export`, with the remaining words. */
function readExportOutput(args: readonly string[]): { readonly rest: string[]; readonly printOnly: boolean; readonly path: string | undefined } | string {
  const rest: string[] = [];
  let printOnly = false;
  let path: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--print') printOnly = true;
    else if (token === '--out') {
      path = args[i + 1];
      if (!path || path.startsWith('--')) return 'Usage: /session export <session-id|.> [markdown|text] [--out <path>] [--print]';
      i++;
    } else if (token.startsWith('--')) return `Unknown option ${token}. Options: --out <path>, --print. Nothing was exported.`;
    else rest.push(token);
  }
  if (printOnly && path) return 'Choose one of --out and --print. Nothing was exported.';
  return { rest, printOnly, path };
}

// session-mgmt / smgmt was removed in TASK-032.
// All session lifecycle operations are now first-class subcommands of /session.
// Use /session list, /session resume, /session save, etc.
//
// CommandRegistry.register() throws on duplicate names/aliases, so this
// registration was intentionally deleted rather than left as dead code.

interface SessionExportData {
  readonly messages: object[];
  readonly timestamp?: number;
  readonly titleSource?: ConversationTitleSource;
  readonly returnContext?: SessionReturnContextSummary;
}

export const { handleSessionWorkflowCommand } = createSessionWorkflowCommands<CommandContext>(requireSessionManager, {
  headingSuffix: ':',
  detailSeparator: ': ',
  postureSeparator: '=',
  confirmDelete: true,
  reviewSeparator: ': ',
  reviewDetailSeparator: ': ',
  field(view, key, value) {
    const labels: Readonly<Record<string, string>> =
      view === 'current'
        ? { id: '  ID:       ', name: '  Name:     ', started: '  Started:  ', messages: '  Messages: ', model: '  Model:    ' }
        : {
            heading: 'Session: ',
            title: '  Title:    ',
            model: '  Model:    ',
            provider: '  Provider: ',
            date: '  Date:     ',
            messages: '  Messages: ',
            file: '  File:     ',
          };
    return (labels[key] ?? '') + value;
  },
  renamed: (name) => 'Session renamed to: ' + name,
  deleted: (name, title) => 'Session deleted: ' + name + (title ? ' (' + title + ')' : ''),
  failed: (action, error) => 'Failed to ' + (action === 'rename' ? 'rename' : action + ' session') + ': ' + summarizeError(error),
  captureSession(ctx) {
    const snapshot = ctx.session.conversationManager.toJSON() as SessionExportData;
    return {
      messages: snapshot.messages ?? [],
      metadata: { titleSource: snapshot.titleSource, returnContext: loadedReturnContext(snapshot.returnContext) },
    };
  },
  copySidecars: (ctx, _source, destination) => copySessionSidecars(ctx, destination),
  beforeSwitch: (ctx, operation, source, destination) => {
    if (operation === 'fork' || source !== destination) ctx.cancelPendingRecovery?.();
    // The session lock follows the live session to its new id at once.
    moveLiveSessionArtifacts(requireSurface(ctx), source, destination);
  },
  afterSwitch: () => {},
  saved: (name, sanitized, path) =>
    'Session saved: ' + name + (sanitized !== name ? ' (saved as "' + sanitized + '")' : '') + '\n  → ' + path,
  forked: (id, name, source, title, count) =>
    'Session forked:\n  New ID: ' + id + '\n  Name:   ' + name + '\n  From:   ' + (title || source) + '\n  Messages: ' + count,
  async productCommand(args, ctx, sm, sub) {
    if (sub === 'resume') {
      // '--force' bypasses the multi-instance liveness confirm below, never a
      // session-id/name token itself (session ids never start with '--').
      const rawArgs = args.slice(1);
      const force = rawArgs.includes('--force');
      const target = rawArgs
        .filter((a) => a !== '--force')
        .join(' ')
        .trim();
      if (!target) {
        ctx.print('Usage: /session resume <session-id-or-name> [--force]');
        return true;
      }
      // An exact id reads one meta line; only a title or prefix lists the directory.
      const candidates = resolveSessionTarget(sm, target);
      if (candidates.length > 1) {
        ctx.print(`Ambiguous session: ${target}\nUse an exact session ID: ${candidates.map((session) => session.name).join(', ')}`);
        return true;
      }
      const found = candidates[0];
      if (!found) {
        ctx.print(`Session not found: ${target}\nUse /session list to see available sessions.`);
        return true;
      }

      // Multi-instance safety: refuse (and require --force) when another
      // running terminal holds this session open right now; resuming it here
      // would fork its live state out from under that terminal. This process's
      // own hold (re-resuming the session already active here) never blocks.
      if (!force && isSessionOpenElsewhere(requireSurface(ctx), found.name)) {
        ctx.print(
          `Session is open in another running terminal: resuming will fork its live state.\n` +
            `Close it there, or re-run \`/session resume ${found.name} --force\` to proceed anyway.`,
        );
        return true;
      }

      try {
        const providerApi = requireProviderApi(ctx);
        // The terminal's one resume routine also publishes the resumed session
        // (last-session pointer, shared session, daemon spine, load hook); this
        // command keeps only its own lines. A context without the routine
        // (a test harness) runs the shared restore alone.
        const outcome = ctx.resumeSession
          ? await ctx.resumeSession(found.name, { quiet: true, liveChecked: true })
          : await (() => {
            ctx.cancelPendingRecovery?.();
            return resumeSessionCore(found.name, {
              sessionManager: sm,
              conversation: ctx.session.conversationManager,
              runtime: ctx.session.runtime,
              surface: requireSurface(ctx),
              selectModel: (model) => providerApi.selectModel(model),
              hydrateSessionUsage: ctx.session.hydrateSessionUsage,
              canResume: () => !ctx.isGenerating?.(),
            });
          })();
        if (!outcome) return true;
        const { meta, restoredAnchorCount, resumedMessageCount } = outcome;

        ctx.renderRequest();
        ctx.print(
          `Resumed session: ${found.name}\n  Name: ${meta.title || '(untitled)'}\n  Messages: ${resumedMessageCount}\n  Model: ${ctx.session.runtime.model || meta.model}`,
        );
        if (restoredAnchorCount > 0) {
          ctx.print(`  Rewind: restored ${restoredAnchorCount} turn anchor(s); /rewind is available for this resumed session.`);
        }
        for (const line of outcome.notices) ctx.print(`  ${line}`);
        for (const warning of outcome.warnings ?? []) ctx.print(`  [Resume] ${warning}; the resumed conversation stands.`);
        const returnContextMode = getReturnContextMode(ctx.platform.configManager);
        if (returnContextMode !== 'off' && meta.returnContext) {
          // The platform's session loader already dropped any legacy open-view list from a
          // session saved by an older TUI, so the loaded return context is shown as-is.
          for (const line of formatReturnContextForDisplay(meta.returnContext)) {
            ctx.print(`  ${line}`);
          }
          if ((meta.returnContext.remoteRunners?.length ?? 0) > 0) {
            ctx.print(`  Remote re-entry: /remote recover ${meta.returnContext.remoteRunners![0]}`);
          }
          if ((meta.returnContext.worktreePaths?.length ?? 0) > 0) {
            ctx.print(`  Worktree re-entry: /worktree review`);
          }
          // The runtime's one helper route: its spend is recorded like any other helper call.
          const helperModel = providerApi.helperModel;
          if (returnContextMode === 'assisted' && helperModel) {
            const resumedSessionId = ctx.session.runtime.sessionId;
            void maybeAssistReturnContextSummary(ctx.platform.configManager, helperModel, meta.returnContext).then((assisted) => {
              if (!assisted.assistedNarrative) return;
              // The helper answers late; do not print its line into a different session.
              if (ctx.session.runtime.sessionId !== resumedSessionId) return;
              ctx.print(`  Assist: ${assisted.assistedNarrative}`);
              ctx.renderRequest();
            }).catch((error: unknown) => {
              if (ctx.session.runtime.sessionId !== resumedSessionId) return;
              ctx.print(`  Assist: summary unavailable (${summarizeError(error)}).`);
              ctx.renderRequest();
            });
          }
        }
      } catch (e) {
        ctx.print(`Failed to resume session: ${summarizeError(e)}`);
      }
      return true;
    }

    if (sub === 'export') {
      const output = readExportOutput(args);
      if (typeof output === 'string') {
        ctx.print(output);
        return true;
      }
      const request = resolveSessionExportRequest(
        output.rest,
        ctx.session.runtime.sessionId,
        () => sm.list(),
        (text) => ctx.print(text),
      );
      if (!request) return true;
      const { target, format, sessionId, found } = request;
      if (!found && target !== '.') {
        let loaded: ReturnType<typeof sm.load>;
        try {
          loaded = sm.load(sessionId);
        } catch {
          ctx.print(`Session not found: ${sessionId}`);
          return true;
        }
        try {
          await exportSessionTranscript(ctx, sessionId, loaded.meta.title, loaded.messages as Array<Record<string, unknown>>, format, output);
        } catch (e) {
          ctx.print(`Failed to export session: ${summarizeError(e)}`);
        }
        return true;
      }
      const loadName = found ? found.name : sessionId;
      try {
        const { meta, messages } = sm.load(loadName);
        await exportSessionTranscript(ctx, loadName, meta.title, messages as Array<Record<string, unknown>>, format, output);
      } catch (e) {
        ctx.print(`Failed to export session: ${summarizeError(e)}`);
      }
      return true;
    }
    return false;
  },
});
