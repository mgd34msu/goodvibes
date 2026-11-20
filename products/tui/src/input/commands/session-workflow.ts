import { exportMessageFromRecord, formatTranscript, resolveSessionExportRequest, type TranscriptFormat } from '@goodvibes-jev/engine/terminal-shell/session-export-format';
import { createSessionWorkflowCommands } from '@goodvibes-jev/engine/terminal-shell/session-workflow-commands';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
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

export const sessionWorkflow = createSessionWorkflowCommands<CommandContext>(requireSessionManager, {
  headingSuffix: ':',
  detailSeparator: ': ',
  postureSeparator: '=',
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
    if (operation === 'fork' || source !== destination) ctx.cancelSessionWork?.();
    // The session lock follows the live session to its new id at once.
    moveLiveSessionArtifacts(requireSurface(ctx), source, destination);
  },
  afterSwitch: () => {},
  saved: (name, sanitized, path, records, switched) =>
    'Session saved: ' + name + (sanitized !== name ? ' (saved as "' + sanitized + '")' : '')
    + (records > 0 ? ' [' + records + ' agent records]' : '')
    + '\n  → ' + path
    + (switched ? '\n  Later turns are saved to ' + sanitized + '.' : ''),
  // Agent records go with the session when this runtime has an agent manager.
  records: (ctx) => ctx.ops.agentManager?.exportState(),
  forked: (id, name, source, title, count) =>
    'Session forked:\n  New ID: ' + id + '\n  Name:   ' + name + '\n  From:   ' + (title || source) + '\n  Messages: ' + count,
});

/**
 * Resume a saved session (`/resume`, `/session resume`): the terminal's one
 * resume routine, with the session's saved agent records, refused while a turn
 * runs or (unless forced) while another terminal holds it open.
 */
export async function resumeSavedSession(ctx: CommandContext, input: { readonly target: string; readonly force: boolean }): Promise<void> {
      sessionWorkflow.refuseWhileGenerating(ctx);
      const sm = requireSessionManager(ctx);
      const force = input.force;
      // An exact id reads one meta line; only a title or prefix lists the directory.
      const found = sessionWorkflow.findSaved(sm, input.target.trim());
      // The session's saved agent records replace the live list, so a running agent of this session would lose its record.
      const agentManager = ctx.ops.agentManager;
      const active = agentManager?.listActive?.() ?? [];
      if (active.length > 0) {
        throw commandRefusal(
          `Not resumed: ${active.length} agent${active.length === 1 ? ' is' : 's are'} still running in this session, and resuming would drop ${active.length === 1 ? 'its record' : 'their records'}.`,
          'Wait for them to finish, or stop them in /agents, then resume again.',
        );
      }

      // Multi-instance safety: refuse (and require --force) when another
      // running terminal holds this session open right now; resuming it here
      // would fork its live state out from under that terminal. This process's
      // own hold (re-resuming the session already active here) never blocks.
      if (!force && isSessionOpenElsewhere(requireSurface(ctx), found.name)) {
        throw commandRefusal(
          'The session is open in another running terminal: resuming it here would fork its live state.',
          `Close it there, or run /resume ${found.name} --force to go ahead anyway.`,
        );
      }

      try {
        const providerApi = requireProviderApi(ctx);
        // The terminal's one resume routine also publishes the resumed session
        // (last-session pointer, shared session, daemon spine, load hook); this
        // command keeps only its own lines. A context without the routine
        // (a test harness) runs the shared restore alone.
        const outcome = ctx.resumeSession
          ? await ctx.resumeSession(found.name, { quiet: true, liveChecked: true, ...(agentManager ? { agents: agentManager } : {}) })
          : await (() => {
            ctx.cancelSessionWork?.();
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
        if (!outcome) return;
        const { meta, restoredAnchorCount, resumedMessageCount } = outcome;

        ctx.renderRequest();
        ctx.print(
          `Resumed session: ${found.name}\n  Name: ${meta.title || '(untitled)'}\n  Messages: ${resumedMessageCount}\n  Model: ${ctx.session.runtime.model || meta.model}`,
        );
        if (restoredAnchorCount > 0) {
          ctx.print(`  Rewind: restored ${restoredAnchorCount} turn anchor(s); /checkpoint rewind is available for this resumed session.`);
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
        throw commandRefusal(`Failed to resume session: ${summarizeError(e)}`);
      }
}

/** Write a saved session's redacted transcript to a file, or print it (`/session save-saved`). */
export async function exportSavedSession(ctx: CommandContext, input: { readonly target: string; readonly format: TranscriptFormat; readonly path: string; readonly print: boolean }): Promise<void> {
      const sm = requireSessionManager(ctx);
      const output = { printOnly: input.print, path: input.path || undefined };
      const request = resolveSessionExportRequest(
        { target: input.target || '.', format: input.format },
        ctx.session.runtime.sessionId,
        () => sm.list(),
      );
      const { target, format, sessionId, found } = request;
      if (!found && target !== '.') {
        let loaded: ReturnType<typeof sm.load>;
        try {
          loaded = sm.load(sessionId);
        } catch {
          throw commandRefusal(`Session not found: ${sessionId}`, 'Use /session list to see available sessions.');
        }
        try {
          await exportSessionTranscript(ctx, sessionId, loaded.meta.title, loaded.messages as Array<Record<string, unknown>>, format, output);
        } catch (e) {
          throw commandRefusal(`Failed to export session: ${summarizeError(e)}`);
        }
        return;
      }
      const loadName = found ? found.name : sessionId;
      try {
        const { meta, messages } = sm.load(loadName);
        await exportSessionTranscript(ctx, loadName, meta.title, messages as Array<Record<string, unknown>>, format, output);
      } catch (e) {
        throw commandRefusal(`Failed to export session: ${summarizeError(e)}`);
      }
}
