import { OwnedSelectionObservation } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import type { ConversationMessageSnapshot } from '../core/conversation.ts';
import { runHeadlessCommand, type HeadlessCommandRuntime } from '@goodvibes-jev/engine/terminal-shell/headless-command';
import { createShellPathService } from '@/runtime/index.ts';
import { bootstrapRuntime } from '../runtime/bootstrap.ts';
import { executeNativeHeadless, runWithHeadlessTimeout, writeNativeHeadlessResult, type NativeHeadlessHost, type NativeHeadlessResult } from './native-headless.ts';
import type { HeadlessRunFlags } from '@goodvibes-jev/engine/terminal-shell/headless-turn-events';
import { executeHeadlessTurn, headlessSessionSnapshot, settleHeadlessTurn } from './native-headless-turn.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { NativeHeadlessMode } from './native-headless-options.ts';
import { resolveGoodVibesDaemonHome } from '@goodvibes-jev/engine/platform/platform/config';
import { resolveNativeHostCredential } from '../runtime/client/native-host-credential.ts';
import { restoreHeadlessSession } from '@goodvibes-jev/engine/terminal-shell/startup-lifecycle';

export async function runNativeHeadlessCommand(runtime: HeadlessCommandRuntime, mode: NativeHeadlessMode = 'submit', limits: HeadlessRunFlags = {}): Promise<number> {
  const credentialObservation = new OwnedSelectionObservation();
  const { cli, configManager, homeDirectory, workingDirectory } = runtime;
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  const journalPath = `${shellPaths.resolveUserPath('tui', 'native-work-submission.json')}.intake`;
  const resolveHost = (): NativeHeadlessHost => {
    const credential = resolveNativeHostCredential({ configManager, homeDirectory, observation: credentialObservation });
    return credential.available
      ? {
          baseUrl: credential.baseUrl,
          token: credential.token,
          credentialIdentity: credential.identity,
          workspace: workingDirectory,
          journalPath,
        }
      : { reason: credential.reason };
  };
  return runHeadlessCommand(runtime, mode, {
    write: writeNativeHeadlessResult,
    run: (prompt, mode, outer) => runWithHeadlessTimeout(outer, limits.timeoutMs, async (signal) => {
      const runTurn = async (input: Parameters<typeof executeHeadlessTurn>[1], signal: AbortSignal) => {
        if (signal.aborted) return { exitCode: 130, response: '', stopReason: 'cancelled' };
        const ctx = await bootstrapRuntime(process.stderr, {
          configManager,
          workingDir: workingDirectory,
          homeDirectory,
          daemonHomeDirectory: resolveGoodVibesDaemonHome(homeDirectory),
        });
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
          return executeHeadlessTurn(ctx, input, signal, cli.flags.outputFormat, limits);
        }, {
          shutdown: () => {
            const snapshot = ctx.conversation.toJSON() as { messages: Array<ConversationMessageSnapshot> };
            return ctx.shutdown(headlessSessionSnapshot(
              snapshot,
              ctx.conversation.getTitleSource(),
              ctx.uiServices.readModels.session.getSnapshot().pendingApproval ? 1 : 0,
            ) as Parameters<typeof ctx.shutdown>[0]);
          },
          sessionReady: () => sessionReady,
          discardUnusedSession: () => {
            if ((ctx.conversation.toJSON() as { messages: unknown[] }).messages.length === 0) ctx.services.sessionManager.delete(ctx.runtime.sessionId);
          },
          writeSessionPointer: () => ctx._writeLastSessionPointer(ctx.runtime.sessionId),
        });
      };
      let result: NativeHeadlessResult;
      if (mode === 'submit') {
        if (prompt === undefined || !/\S/u.test(prompt)) {
          result = { exitCode: 2, response: '', error: 'A prompt is required.', stopReason: 'invalid-input' };
        } else {
          try {
            result = await runTurn(prompt, signal);
          } catch (error) {
            result = {
              exitCode: signal.aborted ? 130 : 1,
              response: '',
              error: summarizeError(error),
              stopReason: signal.aborted ? 'cancelled' : 'unexpected_error',
            };
          }
        }
      } else {
        result = await executeNativeHeadless({ mode, prompt, resolveHost, signal: signal, runTurn });
      }
      return result;
    }),
  });
}
