import { nativeIntakeJournalPath } from '@goodvibes/engine/terminal-shell/native';
import { OwnedSelectionObservation } from '@goodvibes/engine/platform/platform/runtime/client/selection-observation';
import type { ConversationMessageSnapshot } from '../core/conversation.ts';
import { runHeadlessCommand, type HeadlessCommandRuntime } from '@goodvibes/engine/terminal-shell/headless-command';
import { createShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell-paths';
import { bootstrapRuntime } from '../runtime/bootstrap.ts';
import { executeNativeHeadless, runWithHeadlessTimeout, writeNativeHeadlessResult, type NativeHeadlessHost, type NativeHeadlessResult } from './native-headless.ts';
import type { HeadlessRunFlags } from '@goodvibes/engine/terminal-shell/headless-turn-events';
import { executeHeadlessTurn, headlessSessionSnapshot, settleHeadlessTurn } from './native-headless-turn.ts';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import type { NativeHeadlessMode } from '@goodvibes/engine/terminal-shell/native-headless-options';
import { resolveGoodVibesDaemonHome } from '@goodvibes/engine/platform/platform/config/goodvibes-home';
import { resolveNativeHostCredential } from '../runtime/client/native-host-credential.ts';
import { createDaemonVerbCaller } from '../runtime/client/operator-endpoint.ts';
import { claimHeadlessSession, restoreHeadlessSession } from '@goodvibes/engine/terminal-shell/startup-lifecycle';
import { closeSessionHere, createSessionSurface } from '@goodvibes/engine/platform/platform/runtime/operations';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';
import { announceHeadlessRecovery, announceHeadlessSession, readFolderTrustFacts, refusedHeadlessRun, settleHeadlessFolderTrust } from '@goodvibes/engine/terminal-shell/headless-command';
import { keepHeadlessSessionRecoverable } from '@goodvibes/engine/terminal-shell/session-crash-recovery';

export async function runNativeHeadlessCommand(runtime: HeadlessCommandRuntime, mode: NativeHeadlessMode = 'submit', limits: HeadlessRunFlags = {}): Promise<number> {
  const credentialObservation = new OwnedSelectionObservation();
  const { cli, configManager, homeDirectory, workingDirectory } = runtime;
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  const journalPath = nativeIntakeJournalPath(shellPaths, GOODVIBES_TUI_SURFACE_ROOT);
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
        const sessionSnapshot = () => headlessSessionSnapshot(
          ctx.conversation.toJSON() as { messages: Array<ConversationMessageSnapshot> },
          ctx.conversation.getTitleSource(),
          ctx.uiServices.readModels.session.getSnapshot().pendingApproval ? 1 : 0,
        );
        // The crash snapshot at each turn moment, as the TUI writes it, so a killed run can be resumed.
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
          // A folder with no trust decision and nothing of its own to run is trusted as the interactive start does
          // (recorded the same way); one that brings hooks or tool servers is not trusted in this run: what needs trust is refused at once.
          await settleHeadlessFolderTrust(ctx.commandContext.workspace?.workspaceTrustManager,
            () => readFolderTrustFacts(workingDirectory, homeDirectory, String(configManager.get('tools.hooksFile') ?? '')));
          announceHeadlessSession(ctx, workingDirectory, cli.flags.outputFormat, configManager);
          const recovery = recovered ? announceHeadlessRecovery(recovered, cli.flags.outputFormat) : undefined;
          // The local daemon is found, or started when it is installed and stopped, before the turn; nothing is asked.
          await ctx.daemonReady;
          const missing = ctx.daemonMissing?.();
          if (missing) process.stderr.write(`${missing}\n`);
          sessionReady = true;
          // The hooks this run fires reach the daemon's one hook trace (Tools and extensions, Hook runs), and its notices the
          // daemon's webhook list and Slack and Discord notifier, as the interactive app's do.
          const verbs = createDaemonVerbCaller({ configManager, homeDirectory });
          const result = await executeHeadlessTurn(ctx, input, signal, cli.flags.outputFormat, {
            ...limits, settings: configManager,
            daemon: { program: 'tui', invoke: (method, input) => verbs.invoke(method, input) },
          });
          return recovery ? { ...result, recovery } : result;
        }, {
          shutdown: async () => {
            try {
              await ctx.shutdown(sessionSnapshot() as Parameters<typeof ctx.shutdown>[0]);
              recoverable.saved();
            } finally {
              recoverable.dispose();
            }
          },
          sessionReady: () => sessionReady,
          discardUnusedSession: () => {
            if ((ctx.conversation.toJSON() as { messages: unknown[] }).messages.length === 0) ctx.services.sessionManager.delete(ctx.runtime.sessionId);
          },
          writeSessionPointer: () => ctx._writeLastSessionPointer(ctx.runtime.sessionId),
        });
      };
      // The session to resume is taken, or refused, before anything is sent anywhere (native intake included).
      const surface = createSessionSurface({ surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT, workingDirectory, homeDirectory });
      let claimed: string | undefined;
      try {
        claimed = await claimHeadlessSession(cli.flags, surface);
      } catch (error) {
        const refused = refusedHeadlessRun(error);
        if (refused) return refused;
        throw error;
      }
      try {
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
      } finally {
        // Already released when the run moved into the session and ended; otherwise (it never got that far) here.
        if (claimed !== undefined) closeSessionHere(surface, claimed);
      }
    }),
  });
}
