import { OwnedSelectionObservation } from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import { runHeadlessCommand, type HeadlessCommandRuntime } from '@goodvibes-jev/engine/terminal-shell/headless-command';
import { createShellPathService } from '@/runtime/index.ts';
import { bootstrapRuntime } from '../runtime/bootstrap.ts';
import { executeNativeHeadless, writeNativeHeadlessResult, type NativeHeadlessHost, type NativeHeadlessResult } from './native-headless.ts';
import { executeHeadlessTurn } from './native-headless-turn.ts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { NativeHeadlessMode } from './native-headless-options.ts';
import { resolveGoodVibesDaemonHome } from '@goodvibes-jev/engine/sdk/platform/config';
import { resolveNativeHostCredential } from '../runtime/client/native-host-credential.ts';
import { restoreHeadlessSession } from '@goodvibes-jev/engine/terminal-shell/startup-lifecycle';

export async function runNativeHeadlessCommand(runtime: HeadlessCommandRuntime, mode: NativeHeadlessMode = 'submit'): Promise<number> {
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
    async run(prompt, mode, signal) {
      const runTurn = async (input: Parameters<typeof executeHeadlessTurn>[1], signal: AbortSignal) => {
        if (signal.aborted) return { exitCode: 130, response: '', stopReason: 'cancelled' };
        const ctx = await bootstrapRuntime(process.stderr, {
          configManager,
          workingDir: workingDirectory,
          homeDirectory,
          daemonHomeDirectory: resolveGoodVibesDaemonHome(homeDirectory),
        });
        let sessionReady = false;
        try {
          await restoreHeadlessSession(cli.flags, {
            surface: ctx.services.surface, sessionManager: ctx.services.sessionManager,
            conversation: ctx.conversation, runtime: ctx.runtime,
            selectModel: ctx.commandContext.clients?.providerApi?.selectModel,
            canResume: () => !ctx.commandContext.isGenerating?.(),
          }, signal);
          sessionReady = true;
          return await executeHeadlessTurn(ctx, input, signal, cli.flags.outputFormat);
        } finally {
          await ctx.shutdown(ctx.conversation.toJSON() as Parameters<typeof ctx.shutdown>[0]);
          if (sessionReady) ctx._writeLastSessionPointer(ctx.runtime.sessionId);
        }
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
    },
  });
}
