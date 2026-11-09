import { OwnedSelectionObservation } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { buildPersistedSessionContextFromFacts } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { runHeadlessCommand, type HeadlessCommandRuntime } from '@goodvibes-jev/engine/terminal-shell/headless-command';
import { createShellPathService } from '@/runtime/index.ts';
import { bootstrapRuntime } from '../runtime/bootstrap.ts';
import { executeNativeHeadless, writeNativeHeadlessResult, type NativeHeadlessHost } from './native-headless.ts';
import { executeAdmittedHeadlessTurn } from './native-headless-turn.ts';
import type { NativeHeadlessMode } from './native-headless-options.ts';

import { resolveConnectedHostConnection } from '../runtime/client/daemon-verbs.ts';
import { type SessionSnapshot } from '@/runtime/index.ts';
import { conversationMessagesAsSessionRecords } from '../core/conversation-message-snapshot.ts';
import { restoreHeadlessSession } from '@goodvibes-jev/engine/terminal-shell/startup-lifecycle';

export async function runNativeHeadlessCommand(runtime: HeadlessCommandRuntime, mode: NativeHeadlessMode = 'submit'): Promise<number> {
  const { cli, configManager, homeDirectory, workingDirectory } = runtime;
  const hostSelection = { configManager, homeDirectory, observation: new OwnedSelectionObservation() };
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  const journalPath = `${shellPaths.resolveUserPath('agent', 'native-work-submission.json')}.intake`;
  const resolveHost = (): NativeHeadlessHost => {
    const host = resolveConnectedHostConnection(hostSelection);
    return 'reason' in host ? host : { ...host, workspace: workingDirectory, journalPath };
  };
  return runHeadlessCommand(runtime, mode, {
    write: writeNativeHeadlessResult,
    async run(prompt, mode, signal) {
      const result = await executeNativeHeadless({
        mode,
        prompt,
        resolveHost,
        signal: signal,
        async runTurn(state, signal) {
          if (signal.aborted) return { exitCode: 130, response: '', stopReason: 'cancelled' };
          const ctx = await bootstrapRuntime(process.stderr, { configManager, workingDir: workingDirectory, homeDirectory });
          let sessionReady = false;
          try {
            await restoreHeadlessSession(cli.flags, {
              surface: ctx.services.surface, sessionManager: ctx.services.sessionManager,
              conversation: ctx.conversation, runtime: ctx.runtime,
              selectModel: ctx.commandContext.clients?.providerApi?.selectModel,
              canResume: () => !ctx.commandContext.isGenerating?.(),
            }, signal);
            sessionReady = true;
            return await executeAdmittedHeadlessTurn(ctx, state, signal, cli.flags.outputFormat);
          } finally {
            const messages = ctx.conversation.getMessageSnapshot();
            const snapshot: SessionSnapshot = {
              messages: conversationMessagesAsSessionRecords(messages),
              timestamp: Date.now(),
              title: ctx.conversation.title,
              ...buildPersistedSessionContextFromFacts(messages, ctx.conversation.getTitleSource(), {
                pendingApprovals: ctx.uiServices.readModels.session.getSnapshot().pendingApproval ? 1 : 0,
              }),
            };
            await ctx.shutdown(snapshot);
            if (sessionReady) ctx._writeLastSessionPointer(ctx.runtime.sessionId);
          }
        },
      });
      return result;
    },
  });
}
