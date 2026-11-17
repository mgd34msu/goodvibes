import { OwnedSelectionObservation } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { buildPersistedSessionContextFromFacts } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { runHeadlessCommand, type HeadlessCommandRuntime } from '@goodvibes-jev/engine/terminal-shell/headless-command';
import { createShellPathService } from '@/runtime/index.ts';
import { bootstrapRuntime } from '../runtime/bootstrap.ts';
import { executeNativeHeadless, runWithHeadlessTimeout, writeNativeHeadlessResult, type NativeHeadlessHost } from './native-headless.ts';
import type { HeadlessRunFlags } from '@goodvibes-jev/engine/terminal-shell/headless-turn-events';
import { executeAdmittedHeadlessTurn, settleHeadlessTurn } from './native-headless-turn.ts';
import type { NativeHeadlessMode } from './native-headless-options.ts';

import { createAgentNativeHostSelection } from '../runtime/agent-native-host-selection.ts';
import { type SessionSnapshot } from '@/runtime/index.ts';
import { conversationMessagesAsSessionRecords } from '../core/conversation-message-snapshot.ts';
import { restoreHeadlessSession } from '@goodvibes-jev/engine/terminal-shell/startup-lifecycle';

/**
 * A run that could not start (for example `--resume` named a session that is not
 * there) still tears the runtime down through `shutdown`, which saves the
 * conversation under the fresh session id. Nothing was said in it, so the saved
 * file is only an empty entry in the session list; take it back out.
 */
export function discardUnusedSession(
  sessionManager: { delete(name: string): void },
  sessionId: string,
  sessionReady: boolean,
  messageCount: number,
): boolean {
  if (sessionReady || messageCount > 0) return false;
  try {
    sessionManager.delete(sessionId);
    return true;
  } catch {
    // Already absent, or the save itself failed: there is nothing to take back.
    return false;
  }
}

export async function runNativeHeadlessCommand(runtime: HeadlessCommandRuntime, mode: NativeHeadlessMode = 'submit', limits: HeadlessRunFlags = {}): Promise<number> {
  const { cli, configManager, homeDirectory, workingDirectory } = runtime;
  const nativeHost = createAgentNativeHostSelection({ configManager, homeDirectory, observation: new OwnedSelectionObservation() });
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  const journalPath = `${shellPaths.resolveUserPath('agent', 'native-work-submission.json')}.intake`;
  const resolveHost = (): NativeHeadlessHost => {
    const host = nativeHost.resolve();
    return 'reason' in host ? host : { ...host, workspace: workingDirectory, journalPath };
  };
  return runHeadlessCommand(runtime, mode, {
    write: writeNativeHeadlessResult,
    run: (prompt, mode, outer) => runWithHeadlessTimeout(outer, limits.timeoutMs, async (signal) => {
      const result = await executeNativeHeadless({
        mode,
        prompt,
        resolveHost,
        signal: signal,
        async runTurn(state, signal) {
          if (signal.aborted) return { exitCode: 130, response: '', stopReason: 'cancelled' };
          const ctx = await bootstrapRuntime(process.stderr, { configManager, workingDir: workingDirectory, homeDirectory });
          let sessionReady = false;
          return settleHeadlessTurn(async () => {
            await restoreHeadlessSession(cli.flags, {
              surface: ctx.services.surface, sessionManager: ctx.services.sessionManager,
              conversation: ctx.conversation, runtime: ctx.runtime,
              // Called as a method: the provider API's selectModel reads `this`.
              selectModel: (model: string) => {
                const api = ctx.commandContext.clients?.providerApi;
                if (!api) throw new Error('No provider API in this run; the saved model id stands.');
                return api.selectModel(model);
              },
              canResume: () => !ctx.commandContext.isGenerating?.(),
            }, signal);
            sessionReady = true;
            return executeAdmittedHeadlessTurn(ctx, state, signal, cli.flags.outputFormat, limits);
          }, {
            shutdown: () => {
              const messages = ctx.conversation.getMessageSnapshot();
              const snapshot: SessionSnapshot = {
                messages: conversationMessagesAsSessionRecords(messages),
                timestamp: Date.now(),
                title: ctx.conversation.title,
                ...buildPersistedSessionContextFromFacts(messages, ctx.conversation.getTitleSource(), {
                  pendingApprovals: ctx.uiServices.readModels.session.getSnapshot().pendingApproval ? 1 : 0,
                }),
              };
              return ctx.shutdown(snapshot);
            },
            sessionReady: () => sessionReady,
            discardUnusedSession: () => {
              discardUnusedSession(ctx.services.sessionManager, ctx.runtime.sessionId, sessionReady, ctx.conversation.getMessageSnapshot().length);
            },
            writeSessionPointer: () => ctx._writeLastSessionPointer(ctx.runtime.sessionId),
          });
        },
      });
      return result;
    }),
  });
}
