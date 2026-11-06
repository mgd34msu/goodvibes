import { formatSessionExport, resolveSessionExportRequest } from '@goodvibes-jev/engine/terminal-shell/session-export-format';
import { createSessionWorkflowCommands } from '@goodvibes-jev/engine/terminal-shell/session-workflow-commands';
import '@goodvibes-jev/engine/terminal-shell/transcript-review';

import '@goodvibes-jev/engine/terminal-shell/transcript-kinds';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { findSessionCandidates } from '@goodvibes-jev/engine/sdk/platform/sessions';
import { captureTranscriptSource, transcriptReadingCanceled } from './transcript-reading.ts';
import 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import type { CommandContext } from '../command-registry.ts';

import type { ConversationMessageSnapshot } from '../../core/conversation.ts';
import { formatReturnContextForDisplay, getReturnContextMode, maybeAssistReturnContextSummary } from '@/runtime/index.ts';
import { requireProviderApi, requireSessionManager } from './runtime-services.ts';
import { redactSensitiveDataAsync, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { captureOwnedJson, retainOwnedJson } from '@goodvibes-jev/engine/sdk/platform/gate';
import { TranscriptSourceChangedError } from '@goodvibes-jev/engine/sdk/platform/core';
import { captureJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import './confirmation.ts';
import { readConversationMessageSnapshots } from '../../core/conversation-message-snapshot.ts';
import { copySessionSidecars, restoreLoadedSession } from '../../core/session-resume-core.ts';

function formatSessionFailure(action: string, error: unknown): string {
  return [`Failed to ${action}`, `  error ${summarizeError(error)}`].join('\n');
}

async function printSessionExport(
  ctx: CommandContext,
  sessionId: string,
  title: string,
  messages: readonly ConversationMessageSnapshot[],
  format: string,
  args: readonly string[],
  filePath?: string,
): Promise<void> {
  const session = ctx.session;
  const readingOptions = ctx.judgmentReadingOptions;
  const signal = readingOptions?.signal,
    ownerCurrent = readingOptions?.assertCurrent;
  const source = captureTranscriptSource(ctx, signal);
  const manager = requireSessionManager(ctx);
  const input = retainOwnedJson({ sessionId, title, messages, format, args });
  const fileBytes = filePath === undefined ? undefined : readFileSync(filePath);
  const fileStat = filePath === undefined ? undefined : statSync(filePath, { bigint: true });
  const methods: {
    readonly key: 'print' | 'load';
    readonly owner: object;
    readonly prototype: object | null;
    readonly descriptor?: PropertyDescriptor;
  }[] = [];
  for (const [target, key] of [
    [ctx, 'print'],
    [manager, 'load'],
  ] as const) {
    for (let owner: object | null = target; owner !== null; owner = Object.getPrototypeOf(owner)) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor !== undefined && !('value' in descriptor)) throw new TranscriptSourceChangedError();
      methods.push({ key, owner, prototype: Object.getPrototypeOf(owner), ...(descriptor === undefined ? {} : { descriptor }) });
      if (descriptor !== undefined) break;
    }
  }
  const print = ctx.print,
    load = manager.load;
  const saved = filePath === undefined ? captureOwnedJson(load.call(manager, sessionId)) : undefined;
  const assertSource = () => {
    source.assertPublishable();
    try {
      input.assertCurrent();
      if (
        ctx.session !== session ||
        ctx.judgmentReadingOptions !== readingOptions ||
        readingOptions?.signal !== signal ||
        readingOptions?.assertCurrent !== ownerCurrent
      )
        throw new TranscriptSourceChangedError();
      for (const entry of methods) {
        if (
          Object.getPrototypeOf(entry.owner) !== entry.prototype ||
          !isDeepStrictEqual(Object.getOwnPropertyDescriptor(entry.owner, entry.key), entry.descriptor)
        )
          throw new TranscriptSourceChangedError();
      }
      if (filePath !== undefined && fileBytes !== undefined && fileStat !== undefined) {
        const current = statSync(filePath, { bigint: true });
        if (
          current.dev !== fileStat.dev ||
          current.ino !== fileStat.ino ||
          current.size !== fileStat.size ||
          current.mtimeNs !== fileStat.mtimeNs ||
          current.ctimeNs !== fileStat.ctimeNs ||
          !readFileSync(filePath).equals(fileBytes)
        )
          throw new TranscriptSourceChangedError();
      } else if (!isDeepStrictEqual(captureOwnedJson(load.call(manager, sessionId)), saved)) {
        throw new TranscriptSourceChangedError();
      }
    } catch {
      throw new TranscriptSourceChangedError();
    }
  };
  let readingOwner: ReturnType<typeof captureJudgmentPort> | undefined;
  const assertCurrent = () => {
    assertSource();
    let result: unknown;
    try {
      result = ownerCurrent?.();
    } catch {
      throw new TranscriptSourceChangedError();
    }
    if (result !== undefined) {
      drainOwned(result);
      throw new TranscriptSourceChangedError();
    }
    readingOwner?.assertCurrent();
    assertSource();
  };
  assertCurrent();
  try {
    readingOwner = captureJudgmentPort('agent.session-export', { signal, assertCurrent: assertSource });
  } catch (error) {
    if (!(error instanceof JudgmentPortMissingError)) throw error;
  }
  const formatted = formatSessionExport(sessionId, title, messages, format, {
    role: (message) => message.role,
    content: conversationMessageContentText,
    tool: (message) => message.toolName ?? 'tool',
  });
  // A transcript is the one place a value the model was handed becomes a
  // durable document. The canonical redactor carries the platform's credential
  // patterns AND, in a process that has loaded the owner profile, that
  // profile's closed-tier values, his address, his contact details, the People
  // section, so an exported session cannot become the copy of the dossier that
  // the file itself is careful not to be (docs/owner-profile.md §10, §11.3).
  const redacted = await redactSensitiveDataAsync(formatted, { signal, assertCurrent, purpose: 'export' });
  assertCurrent();
  print.call(ctx, redacted);
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

export const { handleSessionWorkflowCommand } = createSessionWorkflowCommands<CommandContext>(requireSessionManager, {
  headingSuffix: '',
  detailSeparator: ' ',
  postureSeparator: ' ',
  confirmDelete: true,
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
  beforeSwitch: () => {},
  afterSwitch: (ctx, operation, destination) => {
    if (operation === 'fork') ctx.session.writeLastSessionPointer?.(destination);
  },
  saved: (name, sanitized, path) =>
    ['Session saved', '  name ' + name, ...(sanitized !== name ? ['  saved as ' + sanitized] : []), '  path ' + path].join('\n'),
  forked: (id, name, source, title, count) =>
    ['Session forked', '  id ' + id, '  name ' + name, '  from ' + (title || source), '  messages ' + count].join('\n'),
  prepareRename(ctx, sm) {
    const existingMeta = sm.getMeta(ctx.session.runtime.sessionId);
    if (!existingMeta) {
      sm.save(ctx.session.runtime.sessionId, ctx.session.conversationManager.getMessageSnapshot(), {
        title: ctx.session.conversationManager.title || '',
        model: ctx.session.runtime.model,
        provider: ctx.session.runtime.provider,
        timestamp: Date.now(),
        titleSource: ctx.session.conversationManager.getTitleSource(),
        // Backfilling a save so /session rename has a file to rename is still
        // user-directed (the user typed /session rename), stamp 'user' so
        // retention never reclaims it. See saveSource's doc comment on SessionMeta.
        saveSource: 'user',
      });
    }
  },
  async productCommand(args, ctx, sm, sub) {
    if (sub === 'resume') {
      const target = args.slice(1).join(' ').trim();
      if (!target) {
        ctx.print('Usage: /session resume <session-id-or-name>');
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
        ctx.print(`Session not found ${target}\nUse /session list to see available sessions.`);
        return true;
      }
      try {
        const { meta, messages } = sm.load(found.name);
        const providerApi = requireProviderApi(ctx);
        const sourceSessionId = ctx.session.runtime.sessionId;
        let model = meta.model;
        let provider = meta.provider;
        if (model) {
          try {
            const selected = await providerApi.selectModel(model);
            model = selected.registryKey;
            provider = selected.providerId;
          } catch {
            /* The saved model may no longer exist locally. */
          }
        }
        if (ctx.isGenerating?.() || ctx.session.runtime.sessionId !== sourceSessionId) {
          throw new Error('The active session changed or a turn started while resuming. Try again when idle.');
        }
        const restoredAnchorCount = restoreLoadedSession(
          found.name,
          { meta, messages },
          {
            conversation: ctx.session.conversationManager,
            runtime: ctx.session.runtime,
            restoreTurnAnchors: ctx.session.restoreTurnAnchors,
            surface: ctx.session.surface,
          },
        );
        if (model) ctx.session.runtime.model = model;
        if (provider) ctx.session.runtime.provider = provider;
        ctx.session.writeLastSessionPointer?.(found.name);
        ctx.renderRequest();
        ctx.print(
          [
            'Resumed session',
            `  id ${found.name}`,
            `  name ${meta.title || '(untitled)'}`,
            `  messages ${messages.length}`,
            `  model ${meta.model || ctx.session.runtime.model}`,
            ...(restoredAnchorCount > 0 ? [`  rewind points ${restoredAnchorCount} restored from before the resume`] : []),
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
          if (returnContextMode === 'assisted') {
            const helperModel = providerApi.createHelperModel(ctx.platform.configManager);
            void maybeAssistReturnContextSummary(ctx.platform.configManager, helperModel, meta.returnContext).then((assisted) => {
              if (!assisted.assistedNarrative) return;
              ctx.print(`  Assist ${assisted.assistedNarrative}`);
              ctx.renderRequest();
            });
          }
        }
      } catch (e) {
        ctx.print(formatSessionFailure('resume session', e));
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
          await printSessionExport(ctx, sessionId, meta.title, readConversationMessageSnapshots(messages), format, args);
        } catch (error) {
          if (transcriptReadingCanceled(error) || ctx.judgmentReadingOptions?.signal?.aborted) return true;
          ctx.print(`Session not found ${sessionId}`);
        }
        return true;
      }
      const loadName = found ? found.name : sessionId;
      try {
        const { meta, messages } = sm.load(loadName);
        await printSessionExport(ctx, loadName, meta.title, readConversationMessageSnapshots(messages), format, args, found?.filePath);
      } catch (e) {
        if (transcriptReadingCanceled(e) || ctx.judgmentReadingOptions?.signal?.aborted) return true;
        ctx.print(formatSessionFailure('export session', e));
      }
      return true;
    }
    return false;
  },
});
