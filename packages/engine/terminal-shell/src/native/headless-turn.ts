import { isTerminalContractStatus, type ContractRunner, type ContractStatus } from '@goodvibes-jev/engine/platform/platform/contract';
import type { ConversationMessageSnapshot, Orchestrator } from '@goodvibes-jev/engine/platform/platform/core';
import type { PermissionRequestHandler } from '@goodvibes-jev/engine/platform/platform/permissions';
import { buildPersistedSessionContextFromFacts } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { RuntimeEventBus } from '@goodvibes-jev/engine/platform/platform/runtime/state';
import type { AgentManager } from '@goodvibes-jev/engine/platform/platform/tools';
import { redactDiagnosticText } from '@goodvibes-jev/engine/platform/platform/utils';
import { HEADLESS_SCHEMA_VERSION, createHeadlessPermissionInput, observeHeadlessTurn, type HeadlessTurnObserverOptions } from './headless-turn-events.js';
import { dispatchNativeConversationTurn } from './native-conversation-ingress.js';
import type { NativeConversationIntakeState } from './native-conversation-intake.js';
import type { HeadlessSessionRecovery, NativeHeadlessTurnResult } from './native-headless.js';
import { describeCrashRecovery, type CrashRecoveryReport } from '../session-crash-recovery.js';

/** The parts of a bootstrapped terminal runtime one headless turn drives. */
export interface HeadlessTurnContext {
  readonly runtimeBus: Pick<RuntimeEventBus, 'on'>;
  readonly orchestrator: Pick<Orchestrator, 'abort' | 'handleUserInput' | 'bindNativeConversationProject'>;
  readonly runtime: { readonly sessionId: string; readonly model: string; readonly provider: string };
  readonly permissionPromptRef: { requestPermission: PermissionRequestHandler };
  readonly uiServices: {
    readonly agents: {
      readonly contractRunner: Pick<ContractRunner, 'list' | 'cancel' | 'get' | 'on' | 'join'>;
      readonly agentManager: Pick<AgentManager, 'list' | 'cancel' | 'join' | 'getStatus'>;
    };
  };
}

export type HeadlessTurnLimits = Pick<HeadlessTurnObserverOptions, 'maxTurns' | 'omitAccumulated'> & {
  readonly answerPermissions?: boolean | undefined;
};

/** Stop reason a headless run reports, in both terminal apps, when the turn ends without a settling event. */
const UNSETTLED_REASON = 'turn-unsettled';

/** Delegated contract work a headless run stops waiting for: ended, or paused on an owner question nobody here can answer. */
function settlesHeadlessWait(status: ContractStatus): boolean {
  return isTerminalContractStatus(status) || status === 'awaiting-owner';
}

/**
 * One headless turn on a freshly bootstrapped runtime. A string goes to the model as an ordinary
 * prompt; an admitted native intake state keeps its permit. Work the model delegates outlives the
 * foreground turn, so the run waits for the contracts and agents that appeared during this
 * invocation and reports their deliverable, or their failure, as the result.
 */
export async function executeHeadlessTurn(
  ctx: HeadlessTurnContext,
  input: string | NativeConversationIntakeState,
  signal: AbortSignal,
  format: string,
  limits: HeadlessTurnLimits = {},
): Promise<NativeHeadlessTurnResult> {
  const runner = ctx.uiServices.agents.contractRunner;
  const agents = ctx.uiServices.agents.agentManager;
  const existingAgents = new Set(agents.list().map((agent) => agent.id));
  const ownedAgents = () => agents.list().filter((agent) => !existingAgents.has(agent.id));
  // Only ids and statuses are read from these lists: the captured input manifest is left out.
  const listSession = () => runner.list({ sessionId: ctx.runtime.sessionId, includeTerminal: true, includeInputSnapshot: false });
  const existing = new Set(listSession().map((contract) => contract.id));
  const owned = () => listSession().filter((contract) => !existing.has(contract.id));
  // This freshly bootstrapped executor belongs only to this invocation.
  const abort = () => {
    ctx.orchestrator.abort();
    for (const contract of owned()) runner.cancel(contract.id, 'Headless invocation cancelled');
    for (const agent of ownedAgents()) agents.cancel(agent.id);
  };
  const { answerPermissions, ...observerLimits } = limits;
  const observer = observeHeadlessTurn(ctx.runtimeBus, format, UNSETTLED_REASON, { ...observerLimits, stop: abort });
  const state = observer.state;
  // A script answers the owner prompts this run raises (stream-json only, checked at parse time); otherwise a headless run has nobody to ask.
  const permissionAnswers = answerPermissions
    ? createHeadlessPermissionInput({ input: process.stdin, emit: observer.frame, signal })
    : undefined;
  if (permissionAnswers) ctx.permissionPromptRef.requestPermission = permissionAnswers.prompt;
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) return { exitCode: 130, response: '', stopReason: 'cancelled' };
    if (typeof input === 'string') await ctx.orchestrator.handleUserInput(input);
    else await dispatchNativeConversationTurn(input, ctx.orchestrator);
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
          let finished = false;
          const finish = () => {
            if (finished) return;
            finished = true;
            unsubscribe();
            signal.removeEventListener('abort', finish);
            resolve();
          };
          // The status the runner moved to is on the event: no store read per contract event.
          const unsubscribe = runner.on((event) => {
            if (event.type === 'CONTRACT_STATUS_CHANGED' && event.contractId === contract.id && settlesHeadlessWait(event.to)) finish();
          });
          signal.addEventListener('abort', finish, { once: true });
          // It may have settled before the subscription: one read of its state.
          const now = runner.get(contract.id);
          if (signal.aborted || !now || settlesHeadlessWait(now.status)) finish();
        });
        const current = runner.get(contract.id);
        if (current?.status === 'passed') {
          await runner.join(contract.id);
          if (current.answer) answers.push(current.answer);
        } else {
          const cancelled = signal.aborted || current?.status === 'cancelled';
          state.exitCode = cancelled ? 130 : 1;
          // A cancellation this run issued (Ctrl-C, --timeout) is reported as one, not as the delegate's failure.
          state.stopReason = cancelled ? 'cancelled' : current?.status === 'awaiting-owner' ? 'awaiting-owner' : 'contract-failed';
          state.error = current?.error ?? current?.statusLine ?? 'Delegated work did not complete.';
        }
      }
      for (const agent of standalone) {
        collectedAgents.add(agent.id);
        await agents.join(agent.id);
        const current = agents.getStatus(agent.id);
        if (current?.status === 'completed' && current.fullOutput?.trim()) answers.push(current.fullOutput);
        else {
          const cancelled = signal.aborted || current?.status === 'cancelled';
          state.exitCode = cancelled ? 130 : 1;
          state.stopReason = cancelled ? 'cancelled' : 'agent-failed';
          state.error = current?.error ?? `Delegated agent ${agent.id} did not return a completed report.`;
        }
      }
    }
    if (answers.length) {
      state.response = answers.join('\n\n');
      if (state.exitCode === 0) state.stopReason = 'completed';
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
    readonly discardUnusedSession?: (() => void) | undefined;
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
  if (turnFailure) {
    // The turn's own error stays the error; a cleanup failure is added to it, never dropped.
    if (problems.length > 0 && turnFailure.error instanceof Error) turnFailure.error.message = `${turnFailure.error.message}; ${problems.join('; ')}`;
    else if (problems.length > 0) throw new Error(`${String(turnFailure.error)}; ${problems.join('; ')}`, { cause: turnFailure.error });
    throw turnFailure.error;
  }
  if (!result) throw new Error('Headless turn produced no result.');
  if (problems.length === 0) return result;
  const detail = problems.join('; ');
  return {
    ...result,
    exitCode: result.exitCode === 0 ? 1 : result.exitCode,
    error: result.error ? `${result.error}; ${detail}` : detail,
  };
}

/** The saved session of a headless run carries the same return context an interactive exit saves. */
export function headlessSessionSnapshot<T extends { readonly messages: readonly ConversationMessageSnapshot[] }>(
  snapshot: T,
  titleSource: Parameters<typeof buildPersistedSessionContextFromFacts>[1],
  pendingApprovals: number,
) {
  return { ...snapshot, ...buildPersistedSessionContextFromFacts(snapshot.messages, titleSource, { pendingApprovals }) };
}

const MAX_RECOVERED_PROMPT_CHARS = 1000;

/**
 * Say what a resumed run restored from its session's crash snapshot, before the
 * first request: a `SESSION_RECOVERED` frame in `stream-json`, one line on
 * stderr in text mode (stdout stays the answer), nothing yet in `json`. The
 * returned object is the final frame's `recovery` field in both JSON formats.
 * The recovered prompt is masked and bounded like other free text in frames.
 */
export function announceHeadlessRecovery(
  report: CrashRecoveryReport,
  format: string,
  write: { readonly stdout: (line: string) => void; readonly stderr: (line: string) => void } = {
    stdout: (line) => { process.stdout.write(`${line}\n`); },
    stderr: (line) => { process.stderr.write(`${line}\n`); },
  },
): HeadlessSessionRecovery {
  const turn = report.interruptedTurn;
  const masked = turn ? redactDiagnosticText(turn.prompt) : '';
  const recovery: HeadlessSessionRecovery = {
    sessionId: report.sessionId,
    applied: report.applied,
    ...(report.refusal ? { refusal: report.refusal } : {}),
    snapshotAt: new Date(report.snapshotAt).toISOString(),
    snapshotKept: !report.retired,
    messages: report.messageCount,
    turns: report.turns,
    ...(turn ? { interruptedTurn: {
      prompt: masked.length > MAX_RECOVERED_PROMPT_CHARS ? `${masked.slice(0, MAX_RECOVERED_PROMPT_CHARS)}...` : masked,
      toolResults: turn.toolResults,
      interruptedToolCalls: turn.interruptedToolCalls,
    } } : {}),
    lost: report.lost,
  };
  if (format === 'stream-json') write.stdout(JSON.stringify({ schemaVersion: HEADLESS_SCHEMA_VERSION, type: 'SESSION_RECOVERED', ...recovery }));
  else if (format !== 'json') write.stderr(describeCrashRecovery(report));
  return recovery;
}
