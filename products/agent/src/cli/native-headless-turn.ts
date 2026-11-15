import { createHeadlessPermissionInput, observeHeadlessTurn, type HeadlessTurnObserverOptions } from '@goodvibes-jev/engine/terminal-shell/headless-turn-events';
import type { BootstrapContext } from '../runtime/bootstrap.ts';
import { dispatchNativeConversationTurn } from '../runtime/native-conversation-ingress.ts';
import type { NativeConversationIntakeState } from '../runtime/native-conversation-intake.ts';
import type { NativeHeadlessTurnResult } from './native-headless.ts';

/** Fresh native turn only. Its exact permit/source enters the existing ordinary executor. */
export async function executeAdmittedHeadlessTurn(
  ctx: BootstrapContext,
  state: NativeConversationIntakeState,
  signal: AbortSignal,
  format: string,
  limits: Pick<HeadlessTurnObserverOptions, 'maxTurns' | 'omitAccumulated'> & { readonly answerPermissions?: boolean | undefined } = {},
): Promise<NativeHeadlessTurnResult> {
  const runner = ctx.uiServices.agents.contractRunner;
  const agents = ctx.uiServices.agents.agentManager;
  // Work the model delegates outlives the foreground turn; only what appeared during this invocation belongs to it.
  const existingAgents = new Set(agents.list().map((agent) => agent.id));
  const ownedAgents = () => agents.list().filter((agent) => !existingAgents.has(agent.id));
  const existing = new Set(runner.list({ sessionId: ctx.runtime.sessionId, includeTerminal: true }).map((contract) => contract.id));
  const owned = () =>
    runner.list({ sessionId: ctx.runtime.sessionId, includeTerminal: true }).filter((contract) => !existing.has(contract.id));
  // This freshly bootstrapped executor belongs only to this invocation.
  const abort = () => {
    ctx.orchestrator.abort();
    for (const contract of owned()) runner.cancel(contract.id, 'Headless invocation cancelled');
    for (const agent of ownedAgents()) agents.cancel(agent.id);
  };
  const observer = observeHeadlessTurn(ctx.runtimeBus, format, 'native-turn-unsettled', { ...limits, stop: abort });
  const settled = observer.state;
  // A script answers the owner prompts this run raises (stream-json only, checked at parse time); otherwise a headless run has nobody to ask.
  const permissionAnswers = limits.answerPermissions
    ? createHeadlessPermissionInput({ input: process.stdin, emit: observer.frame, signal })
    : undefined;
  if (permissionAnswers) ctx.permissionPromptRef.requestPermission = permissionAnswers.prompt;
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) return { exitCode: 130, response: '', stopReason: 'cancelled' };
    await dispatchNativeConversationTurn(state, ctx.orchestrator);
    // Delegation completes the foreground model turn before the delegated work.
    // Keep this invocation alive so the deliverable, or the failure, is what the run reports.
    const collected = new Set<string>();
    const answers: string[] = [];
    const collectedAgents = new Set<string>();
    for (;;) {
      const contracts = owned().filter((contract) => !collected.has(contract.id));
      const standalone = ownedAgents().filter((agent) => !agent.contractId && !collectedAgents.has(agent.id));
      if (!contracts.length && !standalone.length) break;
      for (const contract of contracts) {
        collected.add(contract.id);
        await new Promise<void>((resolve) => {
          const done = () => {
            const current = runner.get(contract.id);
            return signal.aborted || !current || ['passed', 'failed', 'cancelled', 'awaiting-owner'].includes(current.status);
          };
          const finish = () => {
            unsubscribe();
            signal.removeEventListener('abort', finish);
            resolve();
          };
          const unsubscribe = runner.on(() => {
            if (done()) finish();
          });
          signal.addEventListener('abort', finish, { once: true });
          if (done()) finish();
        });
        const current = runner.get(contract.id);
        if (current?.status === 'passed') {
          await runner.join(contract.id);
          if (current.answer) answers.push(current.answer);
        } else {
          settled.exitCode = signal.aborted || current?.status === 'cancelled' ? 130 : 1;
          settled.stopReason = current?.status === 'awaiting-owner' ? 'awaiting-owner' : 'contract-failed';
          settled.error = current?.error ?? current?.statusLine ?? 'Delegated work did not complete.';
        }
      }
      for (const agent of standalone) {
        collectedAgents.add(agent.id);
        await agents.join(agent.id);
        const current = agents.getStatus(agent.id);
        if (current?.status === 'completed' && current.fullOutput?.trim()) answers.push(current.fullOutput);
        else {
          settled.exitCode = signal.aborted || current?.status === 'cancelled' ? 130 : 1;
          settled.stopReason = 'agent-failed';
          settled.error = current?.error ?? `Delegated agent ${agent.id} did not return a completed report.`;
        }
      }
    }
    if (answers.length) {
      settled.response = answers.join('\n\n');
      if (settled.exitCode === 0) settled.stopReason = 'completed';
    }
    return observer.result(signal, ctx.runtime);
  } finally {
    signal.removeEventListener('abort', abort);
    permissionAnswers?.dispose();
    observer.dispose();
  }
}

/**
 * Runs a turn, then always shuts the runtime down and records the session
 * pointer. A cleanup failure never replaces the turn's answer or its real
 * error: it is reported on the result and turns a clean exit into exit 1.
 */
export async function settleHeadlessTurn(
  turn: () => Promise<NativeHeadlessTurnResult>,
  cleanup: {
    readonly shutdown: () => Promise<unknown>;
    readonly sessionReady: () => boolean;
    readonly writeSessionPointer: () => void;
    /**
     * Removes the session file shutdown just saved. Called only when the turn
     * never got as far as having a session (a `--resume` of a missing id, say),
     * so the empty entry is not left in the session list.
     */
    readonly discardUnusedSession?: () => void;
  },
): Promise<NativeHeadlessTurnResult> {
  let result: NativeHeadlessTurnResult | undefined;
  let turnFailure: { readonly error: unknown } | undefined;
  try {
    result = await turn();
  } catch (error) {
    turnFailure = { error };
  }
  const problems: string[] = [];
  try {
    await cleanup.shutdown();
  } catch (error) {
    problems.push(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!cleanup.sessionReady() && cleanup.discardUnusedSession) {
    try {
      cleanup.discardUnusedSession();
    } catch {
      // Already absent, or the save itself failed: there is nothing to take back.
    }
  }
  if (cleanup.sessionReady()) {
    try {
      cleanup.writeSessionPointer();
    } catch (error) {
      problems.push(`session pointer not written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (turnFailure) throw turnFailure.error;
  if (!result) throw new Error('Headless turn produced no result.');
  if (problems.length === 0) return result;
  const detail = problems.join('; ');
  return {
    ...result,
    exitCode: result.exitCode === 0 ? 1 : result.exitCode,
    error: result.error ? `${result.error}; ${detail}` : detail,
  };
}
