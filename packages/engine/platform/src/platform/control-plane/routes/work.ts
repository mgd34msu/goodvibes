/**
 * routes/work.ts, Work as every way in reads and changes it:
 *
 *  - `work.list`: every piece of work of this daemon's project, live and past,
 *    with where it stands, what done means, its plan as steps (and what each
 *    waits on), its results, the questions it waits on, its spending limit;
 *    and a plan that waits for the owner before it runs.
 *  - `work.target`: what an act on one piece of work sends, from the work
 *    alone (its attempt and revisions, or its run), so a person, an agent or a
 *    script names only the work.
 *  - `work.plan.*`: a plan that waits before it runs ("Show me the plan before
 *    it runs"): write it again, change, take out or move a step, approve it,
 *    throw it away.
 *
 * Where it stands comes from the ledger (the attempt, the reported state) and,
 * for the caller's own machine or a paired device, from the run of its current
 * attempt. A caller the native work rule does not admit still reads the works,
 * without the run.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodInvocation } from '../method-catalog-shared.js';
import type { WorkLedgerReadClient } from '../../workflow/work-ledger/index.js';
import type { NativeWorkExecutionHost, NativeWorkExecutionObservation } from '../../workflow/work-ledger/native-execution.js';
import { WorkPlanRefusal, type WorkPlans, type WorkPlanView } from '../../workflow/work-ledger/work-plans.js';
import { nativeBoundRevisions } from '../../workflow/work-ledger/service.js';
import { isTerminalContractStatus, type ContractView } from '../../contract/types.js';
import { canGoOnWithout } from '../../contract/escalation.js';
import { WORK_LEDGER_READ_SCOPE } from '../method-catalog-work-ledger.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import { requireNativeOwner } from './native-owner.js';

const EXECUTION_SCOPES = ['read:work-ledger', 'write:fleet'] as const;

/**
 * Where a piece of work stands, in the words every surface shows. `interrupted`: the daemon stopped while it was
 * starting or while parts of it ran; it waits to be gone on with (those parts run again, finished ones are kept). `step-failed`: a step failed and the work stopped
 * at it, live, asking nothing of anyone; it waits for the step to be run again, gone on without, or the work stopped.
 */
export type WorkState = 'not-started' | 'plan-waiting' | 'starting' | 'interrupted' | 'running' | 'needs-you' | 'step-failed' | 'done' | 'failed' | 'stopped';

export interface WorkStepView { readonly id: string; readonly title: string; readonly status: string; readonly role: string; readonly dependsOn: readonly string[] }
/** A question the work asks and needs an answer to before it goes on. */
export interface WorkQuestionView { readonly id: string; readonly question: string }
/** A step that failed, where the work stopped: what failed, and whether the work can go on without its result. */
export interface WorkFailedStepView {
  readonly id: string; readonly title: string; readonly reason: string; readonly canGoOn: boolean;
  /** The run's record of the stop at this step (what running it again or going on without it answers). */
  readonly pause: string;
}
export interface WorkRunView {
  readonly contractId: string;
  readonly status: string;
  readonly statusLine?: string | undefined;
  /** What last held a step's change back (a write its view refused), in words with what to do. */
  readonly held?: string | undefined;
  /** What the work found or did, in its own words, once it is done (what a conversation that handed it over receives). */
  readonly answer?: string | undefined;
  readonly steps: readonly WorkStepView[];
  readonly results: readonly { readonly text: string; readonly status: string }[];
  readonly questions: readonly WorkQuestionView[];
  readonly failedSteps: readonly WorkFailedStepView[];
  readonly budget?: { readonly maxCostUsd?: number | undefined; readonly maxTokens?: number | undefined } | undefined;
}
export interface WorkItemView {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly criteria: readonly string[];
  readonly state: WorkState;
  /** Brought in from old planning records: history, never run here. */
  readonly imported: boolean;
  readonly reported: string;
  readonly verification: { readonly state: string; readonly reason: string };
  readonly attention: readonly string[];
  readonly attempt: { readonly id: string; readonly state: string; readonly report: string | null; readonly blocker: string | null } | null;
  readonly run: WorkRunView | null;
  /** Its plan before it runs, while one is held. */
  readonly plan: WorkPlanView | null;
  /** Proposed with its plan (`work.propose`) and not yet asked for: approving it asks for the work and starts it with this plan. */
  readonly proposed?: boolean | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

type WorkExecution = Pick<NativeWorkExecutionHost, 'statusByAttempt'> & Partial<Pick<NativeWorkExecutionHost, 'planDropped'>>;

export interface WorkRouteHost {
  readonly projectId: string;
  readonly reader: WorkLedgerReadClient;
  readonly acquire: () => Promise<WorkExecution>;
  readonly plans?: WorkPlans | undefined;
}

function readable(invocation: GatewayMethodInvocation): void {
  if (!invocation.context.admin || !invocation.context.principalId
    || !invocation.context.scopes?.some((scope) => scope === WORK_LEDGER_READ_SCOPE || scope === '*')) {
    throw new GatewayVerbError('Reading your work needs owner access and read:work-ledger.', 'FORBIDDEN', 403);
  }
}

function runOf(contract: ContractView): WorkRunView {
  return {
    contractId: contract.id,
    status: contract.status,
    ...(contract.statusLine ? { statusLine: contract.statusLine } : {}),
    // What last held a step's change back, while the work is live or after it failed: in words, with what to do.
    ...(contract.heldChange && contract.status !== 'passed' && contract.status !== 'cancelled' ? { held: contract.heldChange.said } : {}),
    ...(contract.status === 'passed' && contract.answer ? { answer: contract.answer } : {}),
    steps: contract.units.map((unit) => ({ id: unit.id, title: unit.title || unit.brief || unit.id, status: unit.status, role: unit.role, dependsOn: [...unit.dependsOn] })),
    results: contract.criteria.map((criterion) => ({ text: criterion.text, status: String((criterion as { status?: unknown }).status ?? 'unshown') })),
    // Only live work waits on a question: one left open when the run ended (stopped while it asked) is history, and
    // the work is not said to ask anything.
    questions: isTerminalContractStatus(contract.status) ? [] : contract.escalations.filter((entry) => entry.resolvedAt === undefined && !isStepFailure(entry)).map((entry) => ({ id: entry.id, question: entry.question })),
    // Only live work stops at a failed step: once the run ended, its step's pause is history.
    failedSteps: isTerminalContractStatus(contract.status) ? [] : contract.escalations.filter((entry) => entry.resolvedAt === undefined && isStepFailure(entry)).map((entry) => {
      const unit = contract.units.find((candidate) => candidate.id === entry.targetId);
      return { id: entry.targetId, title: unit?.title || unit?.brief || entry.targetId, reason: unit?.failureReason ?? '', canGoOn: canGoOnWithout(contract, entry.targetId), pause: entry.id };
    }),
    ...(contract.budget ? { budget: { ...contract.budget } } : {}),
  };
}

/** A failed step's pause: the work stopped at that step; it is not a question (the Work place shows it with its controls). */
function isStepFailure(entry: ContractView['escalations'][number]): boolean {
  return entry.failurePause === true && entry.scope === 'unit';
}

function stateOf(reported: string, attemptState: string | undefined, observed: NativeWorkExecutionObservation | null, plan: WorkPlanView | null, blocker: string | null = null): WorkState {
  if (reported === 'complete') return 'done';
  if (reported === 'cancelled') return 'stopped';
  // "Blocked" in the ledger is either a run that ended failed (the blocker says "The work failed: ...") or a live run
  // waiting for the owner (a question, a failed step, cut off by a stop): the run says which; unread, the words do.
  if (reported === 'blocked' && (observed === null || (observed.kind === 'execution' && observed.contract === null))) {
    if (blocker?.startsWith('Its plan waits')) return plan && plan.state !== 'approved' ? 'plan-waiting' : 'not-started';
    return blocker !== null && !blocker.startsWith('The work failed') ? (blocker.startsWith('Cut off') ? 'interrupted' : blocker.startsWith('Stopped at the failed step') ? 'step-failed' : 'needs-you') : 'failed';
  }
  // A start cut off (by a restart of the daemon) waits to be gone on with; one still under way is starting.
  if (observed?.kind === 'intent') return observed.intent.state === 'cancelled' ? 'stopped' : observed.recovery === 'required' ? 'interrupted' : 'starting';
  if (observed?.kind === 'execution') {
    if (observed.execution.state === 'cancelled') return 'stopped';
    const contract = observed.contract;
    if (contract) {
      if (isTerminalContractStatus(contract.status)) return contract.status === 'passed' ? 'done' : contract.status === 'cancelled' ? 'stopped' : 'failed';
      const open = contract.escalations.filter((entry) => entry.resolvedAt === undefined);
      // A question the work asks needs you; a failed step alone asks nothing: the work stopped at that step.
      if (open.some((entry) => !isStepFailure(entry))) return 'needs-you';
      if (open.length > 0) return 'step-failed';
      // Its run is kept but not live here: the daemon stopped while parts of it ran. It waits to be gone on with.
      if (observed.recovery === 'required') return 'interrupted';
      return 'running';
    }
    return observed.execution.state === 'prepared' ? 'starting' : 'running';
  }
  if (attemptState === 'cancelled') return 'stopped';
  if (attemptState === 'complete') return 'done';
  if (plan && plan.state !== 'approved') return 'plan-waiting';
  return 'not-started';
}

async function observe(host: WorkRouteHost, invocation: GatewayMethodInvocation, workId: string, attemptId: string | null): Promise<NativeWorkExecutionObservation | null> {
  if (!attemptId) return null;
  let authority;
  try { authority = requireNativeOwner(invocation, EXECUTION_SCOPES, 'Reading a run'); } catch { return null; }
  try {
    const execution = await host.acquire();
    return execution.statusByAttempt(workId, attemptId, authority);
  } catch {
    // An attempt never started has no execution record; any other failure leaves the run unread, never the list.
    return null;
  }
}

async function works(host: WorkRouteHost, invocation: GatewayMethodInvocation): Promise<readonly WorkItemView[]> {
  const snapshot = await host.reader.readSnapshot();
  if (snapshot.projectId !== host.projectId) throw new GatewayVerbError('The work ledger read another project.', 'WORK_LEDGER_PROJECT_MISMATCH', 409);
  const items: WorkItemView[] = [];
  for (const view of snapshot.works) {
    const work = view.work;
    const observed = await observe(host, invocation, work.id, work.currentAttemptId);
    const contract = observed?.kind === 'execution' ? observed.contract : null;
    const plan = host.plans?.get(work.id) ?? null;
    items.push({
      id: work.id, title: work.title, goal: work.goal, criteria: [...work.criteria],
      state: stateOf(work.reportedState, view.attempt?.state, observed, plan, view.attempt?.blocker ?? null),
      imported: work.source === null,
      reported: work.reportedState,
      verification: { state: view.verification.state, reason: view.verification.reason },
      attention: view.attention.map((entry) => entry.reason),
      attempt: view.attempt ? { id: view.attempt.id, state: view.attempt.state, report: view.attempt.report, blocker: view.attempt.blocker } : null,
      run: contract ? runOf(contract) : null,
      plan,
      createdAt: work.createdAt, updatedAt: work.updatedAt,
    });
  }
  // A piece of work proposed with its plan waits beside the rest, its plan waiting for the owner.
  for (const proposal of host.plans?.proposals() ?? []) {
    const { goal, criteria, at, ...plan } = proposal;
    items.push({
      id: plan.workId, title: goal.split('\n')[0]!.trim() || goal, goal, criteria: [...criteria], state: 'plan-waiting', imported: false,
      reported: 'pending', verification: { state: 'unverified', reason: '' }, attention: [], attempt: null, run: null, plan, proposed: true,
      createdAt: at, updatedAt: at,
    });
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function workNamed(host: WorkRouteHost, workId: unknown) {
  if (typeof workId !== 'string' || workId.trim() === '') throw new GatewayVerbError('Name the work: work is required.', 'INVALID_ARGUMENT', 400, 'work');
  const snapshot = await host.reader.readSnapshot();
  const view = snapshot.works.find((entry) => entry.work.id === workId.trim());
  if (!view) throw new GatewayVerbError(`No work ${workId} in this project.`, 'WORK_NOT_FOUND', 404, 'work', { next: ['work.list names every piece of work.'] });
  return view;
}

function plansOf(host: WorkRouteHost): WorkPlans {
  if (!host.plans) throw new GatewayVerbError('This daemon holds no plans before they run.', 'WORK_PLANS_UNAVAILABLE', 503);
  return host.plans;
}

async function planAct<T>(act: () => T | Promise<T>): Promise<T> {
  try { return await act(); } catch (error) {
    if (error instanceof WorkPlanRefusal) throw new GatewayVerbError(error.message, 'WORK_PLAN_REFUSED', 409, 'work');
    throw error;
  }
}

/** Attach `work.list`, `work.target` and `work.plan.*` (method-catalog-work-ledger.ts) to the daemon's ledger, runner and plans. */
export function registerWorkGatewayMethods(catalog: GatewayMethodCatalog, host: WorkRouteHost): void {
  const attach = (id: string, handler: (invocation: GatewayMethodInvocation) => Promise<unknown>) => {
    const descriptor = catalog.get(id);
    if (!descriptor) throw new Error(`Missing work method descriptor: ${id}`);
    catalog.register(descriptor, handler, { replace: true });
  };
  attach('work.list', async (invocation) => {
    readable(invocation);
    return { projectId: host.projectId, works: await works(host, invocation) };
  });
  attach('work.target', async (invocation) => {
    readable(invocation);
    const params = readInvocationParams(invocation);
    const { work: workId, operation, zone: _zone, ...rest } = params as Record<string, unknown>;
    const view = await workNamed(host, workId);
    const work = view.work;
    const attempt = view.attempt;
    if (operation === 'execution') {
      if (!work.currentAttemptId || !attempt) throw new GatewayVerbError(`"${work.title}" has ended: it was finished or stopped, so there is nothing to start or stop.`, 'WORK_NO_ATTEMPT', 409, 'work');
      // The revisions its run is bound to: the host's own reports of where the run stands ("waits for you", "goes on")
      // are not changes a caller must catch up with (work-ledger/service.ts `nativeBoundRevisions`).
      const bound = nativeBoundRevisions(await host.reader.history(0), work, attempt);
      return {
        summary: `"${work.title}"`, title: work.title,
        input: { projectId: host.projectId, workId: work.id, attemptId: attempt.id,
          expectedRevision: { work: bound.workRevision, criteria: work.criteriaRevision, attempt: bound.attemptRevision } },
      };
    }
    if (operation === 'contract') {
      const observed = await observe(host, invocation, work.id, work.currentAttemptId);
      const contractId = observed?.kind === 'execution' ? observed.execution.receipt?.contractId : undefined;
      if (!contractId) throw new GatewayVerbError(`"${work.title}" is not running, so there is no run to act on.`, 'WORK_NOT_RUNNING', 409, 'work', { next: ['Start it first.'] });
      return { summary: `"${work.title}"`, title: work.title, input: { ...rest, contractId } };
    }
    throw new GatewayVerbError('operation is "execution" or "contract".', 'INVALID_ARGUMENT', 400, 'operation');
  });
  const subject = async (invocation: GatewayMethodInvocation) => {
    readable(invocation);
    const params = readInvocationParams(invocation);
    // A proposed piece of work is named by its proposal's id; its plan acts are the same.
    const proposed = typeof params['work'] === 'string' ? host.plans?.proposal(params['work']) : undefined;
    if (proposed) {
      const id = params['work'] as string;
      return { params, work: { id, goal: proposed.goal, criteria: proposed.criteria, title: proposed.goal.split('\n')[0]!.trim() || proposed.goal }, proposed: true };
    }
    const view = await workNamed(host, params['work']);
    return { params, work: { id: view.work.id, goal: view.work.goal, criteria: view.work.criteria, title: view.work.title } };
  };
  const text = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.trim() === '') throw new GatewayVerbError(`${field} is required.`, 'INVALID_ARGUMENT', 400, field);
    return value;
  };
  attach('work.plan.redo', async (invocation) => {
    const { work } = await subject(invocation);
    return { title: work.title, plan: await planAct(() => plansOf(host).redo(work)) };
  });
  attach('work.plan.step.edit', async (invocation) => {
    const { params, work } = await subject(invocation);
    return { title: work.title, plan: await planAct(() => plansOf(host).editStep(work.id, text(params['step'], 'step'), text(params['brief'], 'brief'))) };
  });
  attach('work.plan.step.drop', async (invocation) => {
    const { params, work } = await subject(invocation);
    return { title: work.title, plan: await planAct(() => plansOf(host).dropStep(work.id, text(params['step'], 'step'))) };
  });
  attach('work.plan.step.move', async (invocation) => {
    const { params, work } = await subject(invocation);
    const position = Number(params['position']);
    if (!Number.isInteger(position) || position < 1) throw new GatewayVerbError('position is a place in the plan, counting from 1.', 'INVALID_ARGUMENT', 400, 'position');
    return { title: work.title, plan: await planAct(() => plansOf(host).moveStep(work.id, text(params['step'], 'step'), position)) };
  });
  attach('work.plan.approve', async (invocation) => {
    const { params, work, proposed } = await subject(invocation);
    if (proposed) {
      // A proposal is approved as the piece of work it was asked for as (`as`): its plan becomes that work's.
      const as = await workNamed(host, params['as']);
      return { title: work.title, plan: await planAct(() => { plansOf(host).adopt(work.id, as.work.id); return plansOf(host).approve(as.work.id); }) };
    }
    return { title: work.title, plan: await planAct(() => plansOf(host).approve(work.id)) };
  });
  attach('work.plan.discard', async (invocation) => {
    const { work, proposed } = await subject(invocation);
    const discarded = await planAct(() => plansOf(host).discard(work.id));
    // Back to not started: the ledger says so too (it read "its plan waits" while the plan waited).
    if (!proposed) {
      const view = await workNamed(host, work.id);
      if (view.attempt) await (await host.acquire()).planDropped?.(work.id, view.attempt.id);
    }
    return { title: work.title, discarded };
  });
}
