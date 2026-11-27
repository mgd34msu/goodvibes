import { decisionModelUse } from '@goodvibes/engine/platform/platform/runtime/decision-policy';
import { isTerminalContractStatus } from '@goodvibes/engine/platform/platform/contract/types';
import type { ContractRunner, ContractStatus } from '@goodvibes/engine/platform/platform/contract';
import type { ConversationMessageSnapshot, Orchestrator, TurnFailoverMove } from '@goodvibes/engine/platform/platform/core';
import { describePermissionModeInForce, setRunAnswersEveryQuestion, setRunHoldsForOwner, type PermissionManager, type PermissionRequestHandler } from '@goodvibes/engine/platform/platform/permissions';
import { VERSION } from '@goodvibes/engine/platform/platform/version';
import { buildPersistedSessionContextFromFacts } from '@goodvibes/engine/platform/platform/runtime/operations';
import type { RuntimeEventBus } from '@goodvibes/engine/platform/platform/runtime/state';
import type { AgentManager } from '@goodvibes/engine/platform/platform/tools';
import { redactDiagnosticText } from '@goodvibes/engine/platform/platform/utils';
import { RefusalError } from '@goodvibes/engine/errors';
import { SESSION_NOT_FOUND, SESSION_OPEN_ELSEWHERE } from '../startup-lifecycle.js';
import { HEADLESS_SCHEMA_VERSION, createHeadlessPermissionInput, observeHeadlessTurn, type HeadlessTurnObserverOptions } from './headless-turn-events.js';
import { dispatchNativeConversationTurn } from './native-conversation-ingress.js';
import type { NativeConversationIntakeState } from './native-conversation-intake.js';
import type { HeadlessSessionRecovery, NativeHeadlessTurnResult } from './native-headless.js';
import { describeCrashRecovery, type CrashRecoveryReport } from '../session-crash-recovery.js';
import { holdForOwnerInHeadlessRun, type HeldThroughDaemon } from './headless-held-calls.js';
import { postHeadlessHookRunsToDaemon, type HookRunsSource } from '../places/hook-runs-poster.js';
import { programNotices } from '../program-notices.js';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import type { ConnectedHostConfigReader } from '../agent-turn/connected-host-client.js';

/** The parts of a bootstrapped terminal runtime one headless turn drives. */
export interface HeadlessTurnContext {
  readonly runtimeBus: Pick<RuntimeEventBus, 'on'>;
  readonly orchestrator: Pick<Orchestrator, 'abort' | 'handleUserInput' | 'bindNativeConversationProject'> & Partial<Pick<Orchestrator, 'onTurnFailover'>>;
  readonly runtime: { readonly sessionId: string; readonly model: string; readonly provider: string };
  /** The run's prompt; `answersHere` set for the run: its asks are answered here (its script) or held for the owner, never raised on the daemon too. */
  readonly permissionPromptRef: { requestPermission: PermissionRequestHandler; answersHere?: boolean };
  /**
   * Where this program's daemon credential is read, to hand a held capability call to the daemon (headless-held-calls.ts);
   * the hooks this run fires, posted to the daemon's one hook trace.
   */
  readonly services?: { readonly shellPaths: ShellPathService; readonly configManager: ConnectedHostConfigReader; readonly hookActivityTracker?: HookRunsSource | undefined } | undefined;
  /** The gate: calls just-vibes held during this run are reported on the result. */
  readonly permissions?: Pick<PermissionManager, 'listHeldForOwner'> | undefined;
  readonly uiServices: {
    readonly agents: {
      /** Null in a program that runs no contracts: a delegation is daemon work, followed as an agent record. */
      readonly contractRunner: Pick<ContractRunner, 'list' | 'cancel' | 'get' | 'on' | 'join'> | null;
      readonly agentManager: Pick<AgentManager, 'list' | 'cancel' | 'join' | 'getStatus'> & Partial<Pick<AgentManager, 'stopFollowingDelegatedWork'>>;
    };
  };
}

export type HeadlessTurnLimits = Pick<HeadlessTurnObserverOptions, 'maxTurns' | 'omitAccumulated'> & {
  readonly answerPermissions?: boolean | undefined;
  /** The settings the chosen mode is read from: a `PERMISSION_MODE_CHANGED` frame names it and says why the mode in force differs. */
  readonly settings?: Parameters<typeof describePermissionModeInForce>[0] | undefined;
  /**
   * The program running this turn and its call to the daemon: the hooks the turn fires reach the daemon's hook trace,
   * and the program's notices (an agent or work that ended, an approval, a budget) reach the daemon's webhook list and
   * its Slack and Discord notifier, before the run ends.
   */
  readonly daemon?: { readonly program: 'tui' | 'agent'; readonly invoke: (method: string, input: Readonly<Record<string, unknown>>) => Promise<unknown> } | undefined;
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
  const startedAt = Date.now();
  const existingAgents = new Set(agents.list().map((agent) => agent.id));
  const ownedAgents = () => agents.list().filter((agent) => !existingAgents.has(agent.id));
  // Only ids and statuses are read from these lists: the captured input manifest is left out.
  const listSession = () => runner?.list({ sessionId: ctx.runtime.sessionId, includeTerminal: true, includeInputSnapshot: false }) ?? [];
  const existing = new Set(listSession().map((contract) => contract.id));
  const owned = () => listSession().filter((contract) => !existing.has(contract.id));
  // This freshly bootstrapped executor belongs only to this invocation.
  const abort = () => {
    ctx.orchestrator.abort();
    // Work this run handed to the daemon is the daemon's: it runs on and its result waits in Work; only following it ends.
    agents.stopFollowingDelegatedWork?.();
    for (const contract of owned()) runner?.cancel(contract.id, 'Headless invocation cancelled');
    for (const agent of ownedAgents()) agents.cancel(agent.id);
  };
  const { answerPermissions, settings, daemon, ...observerLimits } = limits;
  // The hooks this run fires go to the daemon's one hook trace, as an interactive program's do (Tools and extensions, Hook runs).
  const hookRuns = daemon && ctx.services?.hookActivityTracker
    ? postHeadlessHookRunsToDaemon({ runs: ctx.services.hookActivityTracker, invoke: daemon.invoke, program: daemon.program, project: ctx.services.shellPaths.workingDirectory })
    : undefined;
  // This run's notices go through the daemon as an interactive program's do (program-notices.ts); those made while the
  // runtime started waited and go now.
  const stopNotices = daemon ? programNotices.bind({ invoke: daemon.invoke, onDaemonBack: () => () => {}, program: daemon.program }) : undefined;
  const chosenMode = settings === undefined ? undefined : (modeInForce: string): { chosen: string; reason?: string } => {
    const described = describePermissionModeInForce(settings);
    return { chosen: described.chosen, ...(described.chosen !== modeInForce && described.reason !== undefined ? { reason: described.reason } : {}) };
  };
  const observer = observeHeadlessTurn(ctx.runtimeBus, format, UNSETTLED_REASON, { ...observerLimits, stop: abort, chosenMode });
  // A provider failure moved the turn along the fallback order (providers/failover.ts): told on stderr in
  // every output format, and the result names the model that answered.
  let answeredBy: TurnFailoverMove | undefined;
  const stopFailoverWatch = ctx.orchestrator.onTurnFailover?.((move) => {
    answeredBy = move;
    process.stderr.write(`[Failover] ${move.fromRegistryKey} -> ${move.toRegistryKey}, ${move.because}; ${move.toRegistryKey} answers the rest of this turn.\n`);
  });
  const state = observer.state;
  // A script answers the owner prompts this run raises (stream-json only, checked at parse time); otherwise a headless run has nobody to ask.
  const permissionAnswers = answerPermissions
    ? createHeadlessPermissionInput({ input: process.stdin, emit: observer.frame, signal })
    : undefined;
  // One answerer per question: the script, or (nobody here) the owner in his own list, never both.
  ctx.permissionPromptRef.answersHere = true;
  // The calls this run held for the owner through the daemon, each by the approval it waits as (the result's heldForOwner).
  const heldThroughDaemon: HeldThroughDaemon[] = [];
  // The script is the run's one answerer for every question its calls raise, a method the daemon would otherwise
  // decide itself when it arrives included: this run's gate decides it, and it is sent saying so.
  if (permissionAnswers) {
    ctx.permissionPromptRef.requestPermission = permissionAnswers.prompt;
    setRunAnswersEveryQuestion(true);
  } else if (ctx.services) {
    ctx.permissionPromptRef.requestPermission = holdForOwnerInHeadlessRun(ctx.services, (call) => { heldThroughDaemon.push(call); });
    // Nobody answers this run: a call the daemon would decide by asking the owner (a natively admitted method) is
    // decided here and held for him through the daemon, never waited on (permissions/run-answerer.ts).
    setRunHoldsForOwner(true);
  }
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
      const contracts = runner ? owned().filter((contract) => !collected.has(contract.id)) : [];
      const standalone = ownedAgents().filter((agent) => !agent.contractId && !collectedAgents.has(agent.id));
      if (!contracts.length && !standalone.length) break;
      for (const contract of contracts) {
        if (!runner) break;
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
        // Work handed to the daemon that waits on the owner in Work (a question, its plan, a failed step): nobody here
        // can answer it, so the run stops waiting and says where it waits; the work stays on the daemon.
        const waitsInWork = (): string | undefined => agents.getStatus(agent.id)?.delegatedWorkWaiting;
        let stopWatch: (() => void) | undefined;
        await Promise.race([
          agents.join(agent.id),
          new Promise<void>((resolve) => {
            if (waitsInWork()) { resolve(); return; }
            stopWatch = ctx.runtimeBus.on('AGENT_PROGRESS', () => { if (waitsInWork()) resolve(); });
          }),
        ]);
        stopWatch?.();
        const waiting = waitsInWork();
        if (waiting) {
          state.exitCode = 1;
          state.stopReason = 'awaiting-owner';
          state.error = `${waiting}. The work runs on the daemon; its result waits in Work.`;
          agents.stopFollowingDelegatedWork?.();
          continue;
        }
        const current = agents.getStatus(agent.id);
        if (current?.status === 'completed' && current.fullOutput?.trim()) answers.push(current.fullOutput);
        else {
          const cancelled = signal.aborted || current?.status === 'cancelled';
          state.exitCode = cancelled ? 130 : 1;
          state.stopReason = cancelled ? 'cancelled' : 'agent-failed';
          // Work handed to the daemon runs on there whatever this run does: said so, never as a lost agent.
          state.error = current?.delegatedWorkId && cancelled
            ? `"${current.task.split('\n')[0]!.trim()}" runs on on the daemon; its result waits in Work.`
            : current?.error ?? `Delegated agent ${agent.id} did not return a completed report.`;
        }
      }
    }
    if (answers.length) {
      state.response = answers.join('\n\n');
      if (state.exitCode === 0) state.stopReason = 'completed';
    }
    const result = observer.result(signal, answeredBy
      ? { ...ctx.runtime, model: answeredBy.toRegistryKey, provider: answeredBy.toProvider }
      : ctx.runtime);
    // A just-vibes run ends with what it held for the owner; nothing was run for them.
    const held = [
      ...(ctx.permissions?.listHeldForOwner() ?? []).filter((call) => call.heldAt >= startedAt)
        .map((call) => ({ id: call.id, tool: call.toolName, summary: call.summary, reason: call.reason })),
      // What waits in Waiting for you, named by its approval: the owner's answer there runs it.
      ...heldThroughDaemon.map((call) => ({ id: call.id, tool: call.tool, summary: call.summary, reason: call.reason })),
    ];
    // Read while the run's composition still owns the policy: whether a decision model was in use, and its failure.
    const decisionModel = decisionModelUse();
    return { ...result, ...(held.length > 0 ? { heldForOwner: held } : {}), ...(decisionModel.inUse ? {} : { decisionModel }) };
  } finally {
    // Every hook run of this turn reaches the trace before the run ends (or the daemon did not take it: said in the log).
    if (hookRuns) {
      await hookRuns.settle();
      hookRuns.stop();
    }
    // Every notice of this run reached the daemon before the run ends (or the daemon did not answer: said in the log).
    if (stopNotices) {
      await programNotices.settle();
      stopNotices();
    }
    signal.removeEventListener('abort', abort);
    permissionAnswers?.dispose();
    stopFailoverWatch?.();
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
      partialReply: turn.partialReply,
    } } : {}),
    lost: report.lost,
  };
  if (format === 'stream-json') write.stdout(JSON.stringify({ schemaVersion: HEADLESS_SCHEMA_VERSION, type: 'SESSION_RECOVERED', ...recovery }));
  else if (format !== 'json') write.stderr(describeCrashRecovery(report));
  return recovery;
}

/** What the `SESSION` frame of a headless run is read from: the bootstrapped runtime. */
export interface HeadlessSessionSource {
  readonly runtime: { readonly sessionId: string; readonly model: string; readonly provider: string };
  readonly permissions: { getMode(): string };
}

/**
 * The first `stream-json` frame of a run that reached a session, written once
 * the session is final (after a resume): `{"type":"SESSION","sessionId",
 * "model","provider","workingDirectory","version","permissionMode",
 * "chosenMode"}`, with `modeReason` when the mode in force (`permissionMode`)
 * is not the chosen one. Nothing in the other formats.
 */
export function announceHeadlessSession(
  ctx: HeadlessSessionSource,
  workingDirectory: string,
  format: string,
  settings: Parameters<typeof describePermissionModeInForce>[0],
  stdout: (line: string) => void = (line) => { process.stdout.write(`${line}\n`); },
): void {
  if (format !== 'stream-json') return;
  const permissionMode = ctx.permissions.getMode();
  const described = describePermissionModeInForce(settings);
  stdout(JSON.stringify({ schemaVersion: HEADLESS_SCHEMA_VERSION, type: 'SESSION', sessionId: ctx.runtime.sessionId,
    model: ctx.runtime.model, provider: ctx.runtime.provider, workingDirectory, version: VERSION, permissionMode,
    chosenMode: described.chosen,
    ...(permissionMode !== described.chosen && described.reason !== undefined ? { modeReason: described.reason } : {}) }));
}

/**
 * The result of a run refused before it started because the session it was
 * told to resume is open in another running copy: exit `1` (a refusal, like
 * the host refusing the input), `stopReason` `session-open-elsewhere`, and the
 * refusal (state, reason, next steps) in the JSON frames. Undefined for any
 * other error, which stays the run's error.
 */
export function refusedHeadlessRun(error: unknown): NativeHeadlessTurnResult | undefined {
  if (!(error instanceof RefusalError) || (error.refusal.code !== SESSION_OPEN_ELSEWHERE && error.refusal.code !== SESSION_NOT_FOUND)) return undefined;
  const { code, state, reason, next } = error.refusal;
  return {
    exitCode: 1,
    response: '',
    error: `Refused: ${state}. ${reason} Next: ${next.join('; or ')}.`,
    stopReason: code === SESSION_NOT_FOUND ? 'session-not-found' : 'session-open-elsewhere',
    refusal: { code, state, reason, next },
  };
}
