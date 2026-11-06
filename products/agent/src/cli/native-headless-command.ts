import { runHeadlessCommand, type HeadlessCommandRuntime } from '@goodvibes-jev/engine/terminal-shell/headless-command';
import { createShellPathService } from '@/runtime/index.ts';
import { bootstrapRuntime } from '../runtime/bootstrap.ts';
import { executeNativeHeadless, writeNativeHeadlessResult, type NativeHeadlessHost } from './native-headless.ts';
import { executeAdmittedHeadlessTurn } from './native-headless-turn.ts';
import type { NativeHeadlessMode } from './native-headless-options.ts';

import { resolveConnectedHostConnection } from '../runtime/client/daemon-verbs.ts';
import { buildPersistedSessionContext, type SessionSnapshot } from '@/runtime/index.ts';
import { conversationMessagesAsSessionRecords } from '../core/conversation-message-snapshot.ts';

export async function runNativeHeadlessCommand(runtime: HeadlessCommandRuntime, mode: NativeHeadlessMode = 'submit'): Promise<number> {
  const { cli, configManager, homeDirectory, workingDirectory } = runtime;
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  const journalPath = `${shellPaths.resolveUserPath('agent', 'native-work-submission.json')}.intake`;
  const resolveHost = (): NativeHeadlessHost => {
    const host = resolveConnectedHostConnection({ configManager, homeDirectory });
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
          try {
            return await executeAdmittedHeadlessTurn(ctx, state, signal, cli.flags.outputFormat);
          } finally {
            const messages = ctx.conversation.getMessageSnapshot();
            const snapshot: SessionSnapshot = {
              messages: conversationMessagesAsSessionRecords(messages),
              timestamp: Date.now(),
              title: ctx.conversation.title,
              ...buildPersistedSessionContext(messages, ctx.conversation.getTitleSource()),
            };
            await ctx.shutdown(snapshot);
          }
        },
      });
      return result;
    },
  });
}
