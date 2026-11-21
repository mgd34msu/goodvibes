import { nativeIntakeJournalPath } from '@goodvibes/engine/terminal-shell/native';
import { OwnedSelectionObservation } from '@goodvibes/engine/platform/platform/runtime/client/selection-observation';
import { buildPersistedSessionContextFromFacts } from '@goodvibes/engine/platform/platform/runtime/operations';
import { runHeadlessCommand, type HeadlessCommandRuntime } from '@goodvibes/engine/terminal-shell/headless-command';
import { createShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell-paths';
import { bootstrapRuntime } from '../runtime/bootstrap.ts';
import { executeNativeHeadless, runWithHeadlessTimeout, writeNativeHeadlessResult, type NativeHeadlessHost } from './native-headless.ts';
import type { HeadlessRunFlags } from '@goodvibes/engine/terminal-shell/headless-turn-events';
import { executeAdmittedHeadlessTurn, settleHeadlessTurn } from './native-headless-turn.ts';
import type { NativeHeadlessMode } from '@goodvibes/engine/terminal-shell/native-headless-options';

import { createAgentNativeHostSelection } from '../runtime/agent-native-host-selection.ts';
import { type SessionSnapshot } from '@/runtime/index.ts';
import { conversationMessagesAsSessionRecords } from '../core/conversation-message-snapshot.ts';
import { claimHeadlessSession, restoreHeadlessSession } from '@goodvibes/engine/terminal-shell/startup-lifecycle';
import { closeSessionHere, createSessionSurface } from '@goodvibes/engine/platform/platform/runtime/operations';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { announceHeadlessRecovery, refusedHeadlessRun } from '@goodvibes/engine/terminal-shell/headless-command';
import { keepHeadlessSessionRecoverable } from '@goodvibes/engine/terminal-shell/session-crash-recovery';

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
  const journalPath = nativeIntakeJournalPath(shellPaths, GOODVIBES_AGENT_SURFACE_ROOT);
  const resolveHost = (): NativeHeadlessHost => {
    const host = nativeHost.resolve();
    return 'reason' in host ? host : { ...host, workspace: workingDirectory, journalPath };
  };
  return runHeadlessCommand(runtime, mode, {
    write: writeNativeHeadlessResult,
    run: (prompt, mode, outer) => runWithHeadlessTimeout(outer, limits.timeoutMs, async (signal) => {
      // The session to resume is taken, or refused, before the prompt goes to native intake: a refused run
      // leaves no input record on the host.
      const surface = createSessionSurface({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, workingDirectory, homeDirectory });
      let claimed: string | undefined;
      try {
        claimed = await claimHeadlessSession(cli.flags, surface);
      } catch (error) {
        const refused = refusedHeadlessRun(error);
        if (refused) return refused;
        throw error;
      }
      try {
        const result = await executeNativeHeadless({
          mode,
          prompt,
          resolveHost,
          signal: signal,
          async runTurn(state, signal) {
            if (signal.aborted) return { exitCode: 130, response: '', stopReason: 'cancelled' };
            const ctx = await bootstrapRuntime(process.stderr, { configManager, workingDir: workingDirectory, homeDirectory });
            const sessionSnapshot = (): SessionSnapshot => {
              const messages = ctx.conversation.getMessageSnapshot();
              return {
                messages: conversationMessagesAsSessionRecords(messages),
                timestamp: Date.now(),
                title: ctx.conversation.title,
                ...buildPersistedSessionContextFromFacts(messages, ctx.conversation.getTitleSource(), {
                  pendingApprovals: ctx.uiServices.readModels.session.getSnapshot().pendingApproval ? 1 : 0,
                }),
              };
            };
            // The crash snapshot at each turn moment, as the Agent writes it, so a killed run can be resumed.
            const recoverable = keepHeadlessSessionRecoverable({
              bus: ctx.runtimeBus,
              surface: ctx.services.surface,
              runtime: ctx.runtime,
              conversation: ctx.conversation,
              snapshot: sessionSnapshot,
              title: () => ctx.conversation.title ?? '',
              writeSessionPointer: (sessionId) => ctx._writeLastSessionPointer(sessionId),
            });
            let sessionReady = false;
            return settleHeadlessTurn(async () => {
              // A session another running copy has open is refused, not written to.
              let recovered: Awaited<ReturnType<typeof restoreHeadlessSession>>;
              try {
                recovered = await restoreHeadlessSession(cli.flags, {
                  surface: ctx.services.surface, sessionManager: ctx.services.sessionManager,
                  conversation: ctx.conversation, runtime: ctx.runtime,
                  // Called as a method: the provider API's selectModel reads `this`.
                  selectModel: (model: string) => {
                    const api = ctx.commandContext.clients?.providerApi;
                    if (!api) throw new Error('no provider API in this run');
                    return api.selectModel(model);
                  },
                  canResume: () => !ctx.commandContext.isGenerating?.(),
                }, signal);
              } catch (error) {
                const refused = refusedHeadlessRun(error);
                if (refused) return refused;
                throw error;
              }
              const recovery = recovered ? announceHeadlessRecovery(recovered, cli.flags.outputFormat) : undefined;
              sessionReady = true;
              const result = await executeAdmittedHeadlessTurn(ctx, state, signal, cli.flags.outputFormat, limits);
              return recovery ? { ...result, recovery } : result;
            }, {
              shutdown: async () => {
                try {
                  await ctx.shutdown(sessionSnapshot());
                  recoverable.saved();
                } finally {
                  recoverable.dispose();
                }
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
      } finally {
        // Already released when the run moved into the session and ended; otherwise (it never got that far) here.
        if (claimed !== undefined) closeSessionHere(surface, claimed);
      }
    }),
  });
}
