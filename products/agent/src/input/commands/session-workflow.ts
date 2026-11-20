import { formatTranscript, resolveSessionExportRequest, type TranscriptFormat } from '@goodvibes-jev/engine/terminal-shell/session-export-format';
import { createSessionWorkflowCommands } from '@goodvibes-jev/engine/terminal-shell/session-workflow-commands';
import '@goodvibes-jev/engine/terminal-shell/transcript-review';

import '@goodvibes-jev/engine/terminal-shell/transcript-kinds';

import type { CommandContext } from '../command-registry.ts';

import type { ConversationMessageSnapshot } from '../../core/conversation.ts';
import { formatReturnContextForDisplay, getReturnContextMode, maybeAssistReturnContextSummary } from '@/runtime/index.ts';
import { requireProviderApi, requireSessionManager } from './runtime-services.ts';
import { logger, redactSensitiveDataAsync, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import './confirmation.ts';
import { readConversationMessageSnapshots } from '../../core/conversation-message-snapshot.ts';
import { copySessionSidecars, moveLiveSessionArtifacts } from '../../core/session-resume-core.ts';
import { loadSavedSessionIntoLive } from './session-load.ts';
import { commandRefusal } from './confirmation.ts';

function formatSessionFailure(action: string, error: unknown): string {
  return [`Failed to ${action}`, `  error ${summarizeError(error)}`].join('\n');
}

/**
 * Format a loaded session, redact it once and print it. The export owns one
 * fact, the messages it loaded; nothing else is re-read. For the current
 * session (`.`) the live chat's revision is read before and after, and a chat
 * that moved on meanwhile is said, since the saved copy may then lag it.
 */
async function printSessionExport(
  ctx: CommandContext,
  sessionId: string,
  title: string,
  messages: readonly ConversationMessageSnapshot[],
  format: TranscriptFormat,
  current: boolean,
): Promise<void> {
  const signal = ctx.judgmentReadingOptions?.signal;
  const live = current ? ctx.session.conversationManager.revisionSource : undefined;
  const liveRevision = live?.revision();
  // The same renderer `/export` uses, so both commands give one transcript of a session.
  const formatted = formatTranscript(messages, format, {
    markdown: (all) => [...all],
    text: conversationMessageContentText,
    role: (message) => message.role,
  }, { sessionId, title: title || undefined });
  // A transcript is the one place a value the model was handed becomes a
  // durable document. The canonical redactor carries the platform's credential
  // patterns AND, in a process that has loaded the owner profile, that
  // profile's closed-tier values, his address, his contact details, the People
  // section, so an exported session cannot become the copy of the dossier that
  // the file itself is careful not to be (docs/owner-profile.md §10, §11.3).
  const redacted = await redactSensitiveDataAsync(formatted, { ...(signal ? { signal } : {}), purpose: 'export' });
  ctx.print(redacted);
  if (live && live.revision() !== liveRevision) {
    ctx.print('The chat changed while exporting: this transcript is the saved session from before the change. Run /session export . again for the newest messages.');
  }
}

function conversationMessageContentText(message: ConversationMessageSnapshot): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((part) => {
      if (part.type === 'text') return part.text;
      return `[image: ${part.mediaType}]`;
    })
    .join('\n');
}

// NOTE (core-verb pass): this file used to also export
// registerSessionWorkflowCommands(), a second top-level `/session` (alias
// `sess`) registration with its own usage text. It was NEVER called from
// startup, commands.ts only registers `sessionCommand` from ./session.ts,
// so it was dead code (would throw a CommandRegistry collision error if
// anyone ever did call it, since sessionCommand already owns the name). It
// has been deleted; there is no functional change, because sessionCommand's
// own default-branch fallback already calls handleSessionWorkflowCommand
// above for every subcommand this dead registrar advertised, including
// events/groups/hotspots, see ./session.ts's usage text, which now documents
// them too. See docs/decisions/2026-07-06-core-verb-spec.md (agent /session
// orphan, worst-class collision #4) and
// src/test/input/session-single-registration.test.ts for the regression
// guard.

export const sessionWorkflow = createSessionWorkflowCommands<CommandContext>(requireSessionManager, {
  headingSuffix: '',
  detailSeparator: ' ',
  postureSeparator: ' ',
  reviewSeparator: ' ',
  reviewDetailSeparator: ', ',
  field(view, key, value) {
    const labels: Readonly<Record<string, string>> =
      view === 'current'
        ? { id: '  id ', name: '  name ', started: '  started ', messages: '  messages ', model: '  model ' }
        : {
            heading: 'Session ',
            title: '  title ',
            model: '  model ',
            provider: '  provider ',
            date: '  date ',
            messages: '  messages ',
            file: '  file ',
          };
    return (labels[key] ?? '') + value;
  },
  renamed: (name) => 'Session renamed\n  name ' + name,
  deleted: (name, title) => ['Session deleted', '  id ' + name, ...(title ? ['  title ' + title] : [])].join('\n'),
  failed: (action, error) => formatSessionFailure(action + ' session', error),
  captureSession: (ctx) => ({
    messages: ctx.session.conversationManager.getMessageSnapshot(),
    metadata: { titleSource: ctx.session.conversationManager.getTitleSource() },
  }),
  copySidecars: (ctx, source, destination) =>
    copySessionSidecars(source, destination, ctx.session.conversationManager, ctx.session.surface),
  // The session lock follows the live session to its new id at once.
  beforeSwitch: (ctx, _operation, source, destination) => {
    if (ctx.session.surface) moveLiveSessionArtifacts(ctx.session.surface, source, destination);
  },
  afterSwitch: (ctx, operation, destination) => {
    if (operation === 'fork') ctx.session.writeLastSessionPointer?.(destination);
  },
  saved: (name, sanitized, path, _records, switched) =>
    [
      'Session saved',
      '  name ' + name,
      ...(sanitized !== name ? ['  saved as ' + sanitized] : []),
      '  path ' + path,
      ...(switched ? ['  later turns are saved to ' + sanitized] : []),
    ].join('\n'),
  forked: (id, name, source, title, count) =>
    ['Session forked', '  id ' + id, '  name ' + name, '  from ' + (title || source), '  messages ' + count].join('\n'),
});

/** Resume a saved session (`/resume`, `/session resume`): the one load, refused while a turn runs or (unless forced) while another terminal holds it. */
export async function resumeSavedSession(ctx: CommandContext, input: { readonly target: string; readonly force: boolean }): Promise<void> {
      sessionWorkflow.refuseWhileGenerating(ctx);
      const sm = requireSessionManager(ctx);
      const force = input.force;
      // An exact id reads one meta line; only a title or prefix lists the directory.
      const found = sessionWorkflow.findSaved(sm, input.target.trim());
      try {
        // The one load: refuses while a turn runs or while another terminal holds the
        // session (unless --force), moves the session lock and the last-session pointer,
        // re-resolves the model, offers a newer crash snapshot and announces the resume.
        const loaded = await loadSavedSessionIntoLive(ctx, sm, found.name, { force });
        const { meta } = loaded;
        const restoredAnchorCount = loaded.restoredAnchorCount;
        ctx.renderRequest();
        ctx.print(
          [
            'Resumed session',
            `  id ${found.name}`,
            `  name ${meta.title || '(untitled)'}`,
            `  messages ${loaded.messageCount}`,
            `  model ${ctx.session.runtime.model || meta.model}`,
            ...(restoredAnchorCount > 0 ? [`  rewind points ${restoredAnchorCount} restored from before the resume`] : []),
            ...loaded.notices.map((line) => `  ${line}`),
          ].join('\n'),
        );
        const returnContextMode = getReturnContextMode(ctx.platform.configManager);
        if (returnContextMode !== 'off' && meta.returnContext) {
          for (const line of formatReturnContextForDisplay(meta.returnContext)) {
            ctx.print(`  ${line}`);
          }
          if ((meta.returnContext.remoteRunners?.length ?? 0) > 0) {
            ctx.print(
              '  Remote re-entry. Handle remote build-host recovery outside Agent; delegate explicit build/fix/review recovery from Agent.',
            );
          }
          if ((meta.returnContext.worktreePaths?.length ?? 0) > 0) {
            ctx.print(
              '  Worktree re-entry. Open GoodVibes TUI in the target workspace; delegate explicit build/fix/review recovery from Agent.',
            );
          }
          // The runtime's one helper route: its spend is recorded like any other helper call.
          const helperModel = requireProviderApi(ctx).helperModel;
          if (returnContextMode === 'assisted' && helperModel) {
            const resumedSessionId = ctx.session.runtime.sessionId;
            void maybeAssistReturnContextSummary(ctx.platform.configManager, helperModel, meta.returnContext).then(
              (assisted) => {
                // The summary belongs to the session that was resumed; the owner may have moved on.
                if (!assisted.assistedNarrative || ctx.session.runtime.sessionId !== resumedSessionId) return;
                ctx.print(`  Assist ${assisted.assistedNarrative}`);
                ctx.renderRequest();
              },
              (error: unknown) => {
                // The assisted summary is an extra; the resume itself already succeeded.
                logger.debug('session resume: the assisted return-context summary failed', { error: summarizeError(error) });
              },
            );
          }
        }
      } catch (e) {
        throw commandRefusal(formatSessionFailure('resume session', e));
      }
}

/** Print a saved session's redacted transcript here (`/session save-saved`); the Agent writes no file for it. */
export async function exportSavedSession(ctx: CommandContext, input: { readonly target: string; readonly format: TranscriptFormat; readonly path: string; readonly print: boolean }): Promise<void> {
      if (!input.print) throw commandRefusal('The Agent prints a saved session here and writes no file.', 'Choose "Print it here", or save this conversation as a file: /session save-file');
      const sm = requireSessionManager(ctx);
      const request = resolveSessionExportRequest(
        { target: input.target || '.', format: input.format },
        ctx.session.runtime.sessionId,
        () => sm.list(),
      );
      const { target, format, sessionId, found } = request;
      const loadName = found ? found.name : sessionId;
      let loaded: ReturnType<typeof sm.load>;
      try {
        loaded = sm.load(loadName);
      } catch (error) {
        if (found || target === '.') throw commandRefusal(formatSessionFailure('export session', error));
        throw commandRefusal(`Session not found ${sessionId}`, 'Use /session list to see available sessions.');
      }
      try {
        await printSessionExport(ctx, loadName, loaded.meta.title, readConversationMessageSnapshots(loaded.messages), format, target === '.');
      } catch (error) {
        if (ctx.judgmentReadingOptions?.signal?.aborted) {
          throw commandRefusal(`Export of session ${loadName} was cancelled; nothing was printed.`);
        }
        throw commandRefusal(formatSessionFailure('export session', error));
      }
}
