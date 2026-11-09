import { formatSessionExport, resolveSessionExportRequest } from '@goodvibes-jev/engine/terminal-shell/session-export-format';
import { createSessionWorkflowCommands } from '@goodvibes-jev/engine/terminal-shell/session-workflow-commands';
import '@goodvibes-jev/engine/terminal-shell/transcript-review';

import '@goodvibes-jev/engine/terminal-shell/transcript-kinds';
import { findSessionCandidates } from '@goodvibes-jev/engine/platform/platform/sessions';
import './transcript-reading.ts';
import 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import type { CommandContext } from '../command-registry.ts';

import type { ConversationTitleSource } from '../../core/conversation';
import type { SessionReturnContextSummary } from '@/runtime/index.ts';
import {
  formatReturnContextForDisplay,
  getReturnContextMode,
  loadedReturnContext,
  maybeAssistReturnContextSummary,
} from '@/runtime/index.ts';
import { requireProviderApi, requireSessionManager, requireSurface } from './runtime-services.ts';
import { resumeSessionCore } from '../../core/session-resume-core.ts';
import { checkSessionLiveness } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
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

function printSessionExport(
  ctx: { print: (text: string) => void },
  sessionId: string,
  title: string,
  messages: Array<Record<string, unknown>>,
  format: string,
): void {
  const formatted = formatSessionExport(sessionId, title, messages, format, {
    role: (message) => String(message.role ?? 'unknown'),
    content: (message) => String(message.content ?? ''),
    tool: (message) => String(message.toolName ?? 'tool'),
  });
  ctx.print(formatted);
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
  confirmDelete: false,
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
      const sessions = sm.list();
      const candidates = findSessionCandidates(sessions, target);
      if (candidates.length > 1) {
        ctx.print(`Ambiguous session: ${target}\nUse an exact session ID: ${candidates.map((session) => session.name).join(', ')}`);
        return true;
      }
      const found = candidates[0];
      if (!found) {
        ctx.print(`Session not found: ${target}\nUse /session list to see available sessions.`);
        return true;
      }

      // Multi-instance safety: warn (and require --force) when this session
      // looks open in another still-running terminal right now, resuming it
      // here would fork its live state out from under that other instance.
      // Best-effort: a missing/stale marker (or this process's OWN marker,
      // e.g. re-resuming the session already active here) never blocks anything.
      const liveness = checkSessionLiveness(requireSurface(ctx), found.name);
      if (liveness.live && liveness.pid !== process.pid && !force) {
        ctx.print(
          `Session appears open in another terminal (pid ${liveness.pid}): resuming will fork its live state.\n` +
            `Re-run \`/session resume ${found.name} --force\` to proceed anyway.`,
        );
        return true;
      }

      try {
        const providerApi = requireProviderApi(ctx);
        ctx.cancelPendingRecovery?.();
        const outcome = await resumeSessionCore(found.name, {
          sessionManager: sm,
          conversation: ctx.session.conversationManager,
          runtime: ctx.session.runtime,
          surface: requireSurface(ctx),
          selectModel: (model) => providerApi.selectModel(model),
          hydrateSessionUsage: ctx.session.hydrateSessionUsage,
          canResume: () => !ctx.isGenerating?.(),
        });
        const { meta, journalReplay, restoredAnchorCount, resumedMessageCount } = outcome;

        ctx.renderRequest();
        ctx.print(
          `Resumed session: ${found.name}\n  Name: ${meta.title || '(untitled)'}\n  Messages: ${resumedMessageCount}\n  Model: ${meta.model || ctx.session.runtime.model}`,
        );
        if (restoredAnchorCount > 0) {
          ctx.print(`  Rewind: restored ${restoredAnchorCount} turn anchor(s); /rewind is available for this resumed session.`);
        }
        if (journalReplay.replayed > 0) {
          ctx.print(`  [Recovery] Replayed ${journalReplay.replayed} journal record(s): restored turns since last snapshot.`);
        }
        if (journalReplay.hadCorruptTail && journalReplay.replayed === 0) {
          ctx.print('  [Recovery] Journal tail was corrupt or unrecognised (quarantined). Proceeding with snapshot only.');
        } else if (journalReplay.hadCorruptTail) {
          ctx.print('  [Recovery] Journal tail was partially corrupt (quarantined). Replay stopped at last good record.');
        }
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
          if (returnContextMode === 'assisted') {
            const helperModel = providerApi.createHelperModel(ctx.platform.configManager);
            void maybeAssistReturnContextSummary(ctx.platform.configManager, helperModel, meta.returnContext).then((assisted) => {
              if (!assisted.assistedNarrative) return;
              ctx.print(`  Assist: ${assisted.assistedNarrative}`);
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
      const request = resolveSessionExportRequest(
        args,
        ctx.session.runtime.sessionId,
        () => sm.list(),
        (text) => ctx.print(text),
      );
      if (!request) return true;
      const { target, format, sessionId, found } = request;
      if (!found && target !== '.') {
        try {
          const { meta, messages } = sm.load(sessionId);
          printSessionExport(ctx, sessionId, meta.title, messages as Array<Record<string, unknown>>, format);
        } catch {
          ctx.print(`Session not found: ${sessionId}`);
        }
        return true;
      }
      const loadName = found ? found.name : sessionId;
      try {
        const { meta, messages } = sm.load(loadName);
        printSessionExport(ctx, loadName, meta.title, messages as Array<Record<string, unknown>>, format);
      } catch (e) {
        ctx.print(`Failed to export session: ${summarizeError(e)}`);
      }
      return true;
    }
    return false;
  },
});
