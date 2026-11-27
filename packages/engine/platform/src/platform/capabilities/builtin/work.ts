/**
 * Work: the pieces of work the daemon holds and runs, one runner for every
 * program, the web UI and an agent. Each piece of work has what you asked for,
 * what done means, and its plan of steps; while it runs it may wait on your
 * answer, one failed step can be run again and its spending limit changed.
 * With "Show me the plan before it runs" on, its plan waits for you first: a
 * step can be changed, moved or taken out, the plan written again, then
 * approved (that starts it) or thrown away.
 *
 * Each act is a daemon method (`workLedger.execution.*`, `contracts.*`,
 * `work.plan.*`), run as the same caller (`caller.method`): the capability
 * names only the work, `work.target` reads from it what the method takes, and
 * the outcome is said with the work's own title.
 *
 * Each act that makes a piece of work run (hand over, start, approve, go on, run a step again, go on without one) first
 * keeps on the work's record who caused it (`caller.cause`, workflow/work-ledger/work-plans.ts `WorkCause`): its turns
 * are the owner's own only when the owner in person asked for it or approved it; anyone else's work runs reads only and no
 * command outside a real sandbox until the owner does. Approving a plan is the owner's own answer. Handing work over is decided
 * under the owner's mode as an item of their list; a caller below an admin (a paired device, the outside agent, a member)
 * hands it over, starts, changes and stops work only in a project given to it, and only work it caused itself
 * (routes/work.ts `ownWork`, routes/native-work-execution.ts).
 */
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type InputDescription, type ListName } from '../types.js';
import type { WorkCause } from '../../workflow/work-ledger/work-plans.js';
import { stampExposure } from '../../security/conversation-exposure.js';

/** Your work (`work.list`), the list a work input chooses from; registered in terminal-shell (native/work-command.ts). */
export const WORK_ITEMS_LIST = 'work.items' as ListName;
/** The open questions of one piece of work, after it is chosen. */
export const WORK_QUESTIONS_LIST = 'work.questions' as ListName;
/** The answers the chosen question takes as choices (the stuck conflict's three); empty for a question answered in words. */
export const WORK_ANSWERS_LIST = 'work.answers' as ListName;
/** The steps of one piece of work's plan (its run's, or its waiting plan's), after it is chosen. */
export const WORK_STEPS_LIST = 'work.steps' as ListName;
/** The failed steps of one piece of work's run, after it is chosen: what "run a failed step again" chooses from. */
export const WORK_FAILED_STEPS_LIST = 'work.failed-steps' as ListName;

const WORK: InputDescription = {
  id: 'work', label: 'Work', help: 'Your work, by what you asked for', kind: 'choice', choices: { list: WORK_ITEMS_LIST }, required: true, typed: { position: 1 },
};
const STEP: InputDescription = {
  id: 'step', label: 'Step', help: 'The steps of its plan', kind: 'choice', choices: { list: WORK_STEPS_LIST, dependsOn: 'work' }, required: true, typed: { position: 2 },
};

type Answer = Readonly<Record<string, unknown>>;
const record = (value: unknown): Answer => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Answer : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';

function methodOf(caller: CapabilityCaller): (methodId: string, body: Record<string, unknown>) => Promise<unknown> {
  if (!caller.method) throw new CapabilityRefusal('This runs on the daemon, through capabilities.run.');
  const method = caller.method;
  // Work is kept per project: each Work method is served from the caller's project (control-plane/project-routing.ts).
  const folder = caller.workingDirectory;
  return folder ? (methodId, body) => method(methodId, { ...body, workingDirectory: folder }) : method;
}

/** What `work.target` reads for an act on a piece of work: its title and the body the method takes. */
async function target(caller: CapabilityCaller, work: string, operation: 'execution' | 'contract', rest: Record<string, unknown> = {}): Promise<{ readonly title: string; readonly input: Record<string, unknown> }> {
  const read = record(await methodOf(caller)('work.target', { work, operation, ...rest }));
  return { title: text(read['title']) || work, input: { ...record(read['input']) } };
}

/** What the runner's refusals mean, in the words of the Work place (work, plan, step, result). */
const RUNNER_WORDS: Readonly<Record<string, string>> = {
  NATIVE_EXECUTION_STALE: 'it changed meanwhile; look at it again and try once more',
  NATIVE_EXECUTION_CONFLICT: 'it changed meanwhile; look at it again and try once more',
  NATIVE_EXECUTION_RECOVERY_REQUIRED: 'its run cannot be picked up from here; stop it and ask for the work again',
  NATIVE_EXECUTION_PENDING_INTENT: 'it is still starting',
  NATIVE_EXECUTION_CLOSED: 'the daemon is stopping',
  NATIVE_EXECUTION_UNAVAILABLE: 'the daemon cannot run work right now',
  NATIVE_EXECUTION_UNSUPPORTED_AUTHORITY: 'work runs only for the daemon\'s own computer or a paired device',
  PAIRED_OWNER_REQUIRED: 'work runs only for the daemon\'s own computer or a paired device',
  CONTRACT_ENDED: 'it has ended',
  CONTRACT_NOT_RUNNING: 'it is not running',
  CONTRACT_NATIVE: 'that step has not failed, and a step runs again only after it failed',
  ESCALATION_NOT_OPEN: 'that question has its answer already',
};

/** Run one act of the runner, saying a refusal in the place's words; the rest pass as they are. */
async function runnerAct(caller: CapabilityCaller, title: string, methodId: string, input: Record<string, unknown>): Promise<Answer> {
  try {
    return record(await methodOf(caller)(methodId, input));
  } catch (error) {
    const words = RUNNER_WORDS[text(record(error)['code'])];
    if (words) throw new CapabilityRefusal(`"${title}" was left as it is: ${words}.`);
    throw error;
  }
}

/**
 * An act on work stopped at a failed step. After a restart of the daemon its run is kept, waiting, but not yet live
 * here: it is picked up again (its execution resumes it, still waiting at that step) and the act runs on it.
 */
async function liveRunnerAct(caller: CapabilityCaller, work: string, title: string, methodId: string, input: Record<string, unknown>): Promise<Answer> {
  try {
    return record(await methodOf(caller)(methodId, input));
  } catch (error) {
    if (text(record(error)['code']) !== 'CONTRACT_NOT_RUNNING') {
      const words = RUNNER_WORDS[text(record(error)['code'])];
      if (words) throw new CapabilityRefusal(`"${title}" was left as it is: ${words}.`);
      throw error;
    }
    const execution = await target(caller, work, 'execution');
    await runnerAct(caller, title, 'workLedger.execution.resume', execution.input);
    return runnerAct(caller, title, methodId, input);
  }
}

/** The piece of work as the Work place reads it (`work.list`): its state there and the line its run says. */
interface WorkReading { readonly state: string; readonly statusLine: string; readonly question: string }

async function workReading(caller: CapabilityCaller, work: string): Promise<WorkReading | undefined> {
  try {
    const listed = record(await methodOf(caller)('work.list', {}));
    const works = Array.isArray(listed['works']) ? listed['works'].map(record) : [];
    const found = works.find((entry) => text(entry['id']) === work || text(entry['title']) === work);
    if (!found) return undefined;
    const run = record(found['run']);
    const questions = Array.isArray(run['questions']) ? run['questions'].map(record) : [];
    return { state: text(found['state']), statusLine: text(run['statusLine']), question: text(questions[0]?.['question']).split('\n')[0] ?? '' };
  } catch {
    return undefined;
  }
}

/**
 * Where a piece of work stands, in the Work place's words: done when every step is done and its results are met and
 * kept; "you stopped it" when it was stopped; waiting for you only when something waits for you, saying what; then how
 * far its steps and results came. The runner's own state names (queued, cancelled, awaiting-owner) are never shown.
 */
function progressWords(snapshot: Answer, reading: WorkReading | undefined): string {
  const progress = record(snapshot['progress']);
  const units = record(progress['units']);
  const criteria = record(progress['criteria']);
  const status = text(progress['status']);
  const stepsTotal = typeof units['total'] === 'number' ? units['total'] : 0;
  const steps = stepsTotal > 0 ? `${units['passed'] ?? 0} of ${stepsTotal} steps done${typeof units['failed'] === 'number' && units['failed'] > 0 ? `, ${units['failed']} failed` : ''}` : '';
  const results = stepsTotal > 0 && typeof criteria['total'] === 'number' ? `${criteria['met'] ?? 0} of ${criteria['total']} results met` : '';
  const how = [steps, results].filter(Boolean).join(', ');
  const said = (line: string): string => line.replace(/\.\s*$/u, '');
  const stopped = snapshot['state'] === 'cancelled' || status === 'cancelled' || reading?.state === 'stopped';
  const where = (() => {
    if (stopped) return 'you stopped it';
    if (Object.keys(progress).length === 0) return snapshot['kind'] === 'pending-intent' ? 'it is starting' : 'it has not started';
    if (status === 'passed' || reading?.state === 'done') return 'done';
    if (status === 'failed' || reading?.state === 'failed') return reading?.statusLine ? said(reading.statusLine) : 'it failed';
    if (status === 'awaiting-owner' || reading?.state === 'needs-you' || reading?.state === 'step-failed' || reading?.state === 'interrupted') {
      const what = reading?.statusLine || reading?.question;
      return what ? `it waits for you: ${said(what)}` : 'it waits for you in Work';
    }
    if (stepsTotal === 0) return 'its plan is being written';
    return 'it runs';
  })();
  return how ? `${where}; ${how}` : where;
}

/** Where who caused a piece of work to run is kept: on its record in the caller's project's Work (work-plans.ts). */
export interface WorkCauseCapabilityServices {
  readonly workCauses?: { note(project: string | undefined, workId: string, cause: WorkCause, options?: { readonly made?: boolean | undefined }): Promise<void> } | undefined;
}

/**
 * Keep on the work's record who made it run, before it runs: the caller's cause (set by `capabilities.run`); a caller
 * that names none is someone else. The owner's own act makes the work theirs; anyone else's never takes it from them.
 * `made`: the caller handed this work over just now (work.delegate); any other act of someone else's on work with no
 * cause recorded (made before causes were kept, so the owner's) is refused (work-plans.ts `noteCause`).
 */
async function noteCause(services: WorkCauseCapabilityServices, caller: CapabilityCaller, workId: string, made = false): Promise<void> {
  if (!workId) return;
  // Work handed over from a conversation that read text from outside starts with what it read: what its steps make that
  // runs later, sends, spends or loosens is asked of the owner (security/conversation-exposure.ts).
  stampExposure(`work:${workId}`);
  if (!services.workCauses) return;
  try {
    await services.workCauses.note(caller.workingDirectory, workId, caller.cause ?? { party: 'other', who: 'a caller that is not the owner in person' },
      made ? { made: true } : undefined);
  } catch (error) {
    // Work made before causes were kept is the owner's: it waits on the owner's answer in Waiting for you, or only the
    // owner starts it.
    if (error instanceof Error && error.name === 'WorkPlanRefusal') throw new CapabilityRefusal(error.message, 'Only the owner starts this work, from their own screen.');
    throw error;
  }
}

type Work = CapabilityDefinition<WorkCauseCapabilityServices>;

function daemonWork(fields: Omit<Work, 'capability' | 'done' | 'lasts' | 'touches' | 'risk'> & Partial<Pick<Work, 'lasts' | 'touches' | 'risk'>> & { readonly id: string; readonly repeat: 'safe' | 'unsafe' }): Work {
  const { id, repeat, ...rest } = fields;
  return { capability: { id, group: 'work', home: 'daemon', repeat }, done: '', touches: 'this-machine', lasts: 'not-a-change', risk: 'none', ...rest };
}

export const WORK_LIST: Work = daemonWork({
  id: 'work.list', repeat: 'safe', actionId: 'list', label: 'See your work', word: 'list', inputs: [], touches: 'reads',
  sentence: 'Shows what work is going on right now and every piece of work before it: where each stands (not started, its plan waiting for you, running, needs you, stopped at a failed step, done, failed, stopped), its plan and its results.',
  example: {},
  async run(_values, _services, caller) {
    const answer = record(await methodOf(caller)('work.list', {}));
    const works = Array.isArray(answer['works']) ? answer['works'].map(record) : [];
    if (works.length === 0) return { text: 'No work yet.', data: answer };
    return { text: works.map((work) => `"${text(work['title'])}": ${text(work['state']).replace('-', ' ')}`).join('\n'), data: answer };
  },
});

export const WORK_START: Work = daemonWork({
  id: 'work.start', repeat: 'safe', actionId: 'start', label: 'Start a piece of work', word: 'start', inputs: [WORK],
  sentence: '{work} starts (kick off the job you asked for): its plan is written and its steps run on the daemon until it is done or you stop it.', undoneBy: 'cancel',
  example: { work: 'work-1a2b' },
  async run(values, services, caller) {
    const { title, input } = await target(caller, values.work!, 'execution');
    await noteCause(services, caller, text(input['workId']) || values.work!);
    try {
      const snapshot = record(await methodOf(caller)('workLedger.execution.start', input));
      return { text: snapshot['kind'] === 'pending-intent' ? `"${title}" is starting.` : `Started "${title}".`, data: snapshot };
    } catch (error) {
      const code = text(record(error)['code']);
      if (code === 'NATIVE_EXECUTION_PLAN_WAITING') {
        return { text: `The plan of "${title}" is being written; it waits for you in Work, where you can change it and approve it to start the work.`, data: { planWaiting: true } };
      }
      const words = RUNNER_WORDS[code];
      if (words) throw new CapabilityRefusal(`"${title}" was not started: ${words}.`);
      throw error;
    }
  },
});

export const WORK_STATUS: Work = daemonWork({
  id: 'work.status', repeat: 'safe', actionId: 'status', label: 'Check on a piece of work', word: 'status', inputs: [WORK], touches: 'reads',
  sentence: 'Shows how far along {work} is (the job you asked for): whether it runs, how many of its steps are done and how many of its results are met.',
  example: { work: 'work-1a2b' },
  async run(values, _services, caller) {
    const { title, input } = await target(caller, values.work!, 'execution');
    try {
      const snapshot = record(await methodOf(caller)('workLedger.execution.status', input));
      return { text: `"${title}": ${progressWords(snapshot, await workReading(caller, values.work!))}.`, data: snapshot };
    } catch (error) {
      // No run yet is an answer, not a failure: the work was never started.
      if (text(record(error)['code']) === 'NATIVE_EXECUTION_NOT_FOUND') return { text: `"${title}": not started.`, data: { started: false } };
      throw error;
    }
  },
});

export const WORK_CANCEL: Work = daemonWork({
  id: 'work.cancel', repeat: 'safe', actionId: 'cancel', label: 'Stop a piece of work', word: 'cancel', inputs: [WORK], risk: 'cannot-be-undone',
  sentence: 'Stop the job {work}, for one going the wrong way: it is called off and the steps running are cancelled.', example: { work: 'work-1a2b' },
  async run(values, _services, caller) {
    const { title, input } = await target(caller, values.work!, 'execution');
    const snapshot = await runnerAct(caller, title, 'workLedger.execution.cancel', input);
    return { text: `Stopped "${title}".`, data: snapshot };
  },
});

export const WORK_RESUME: Work = daemonWork({
  id: 'work.resume', repeat: 'safe', actionId: 'resume', label: 'Go on with a piece of work after a stop', word: 'resume', inputs: [WORK],
  sentence: 'Carry on with the job {work} that stopped halfway: it goes on from where it stopped; a finished one has its results checked and kept.', example: { work: 'work-1a2b' },
  async run(values, services, caller) {
    const { title, input } = await target(caller, values.work!, 'execution');
    await noteCause(services, caller, text(input['workId']) || values.work!);
    const snapshot = await runnerAct(caller, title, 'workLedger.execution.resume', input);
    const settled = text(record(snapshot['settlement'])['state']) === 'published';
    return { text: settled ? `The results of "${title}" were checked and kept.` : `"${title}" goes on.`, data: snapshot };
  },
});

export const WORK_ANSWER: Work = daemonWork({
  id: 'work.answer', repeat: 'unsafe', actionId: 'answer', label: 'Answer a question a piece of work asks', word: 'answer', lasts: 'kept',
  inputs: [
    WORK,
    { id: 'question', label: 'Question', help: 'The questions it is waiting on', kind: 'choice', choices: { list: WORK_QUESTIONS_LIST, dependsOn: 'work' }, required: true, typed: { position: 2 } },
    // A question that takes only certain answers (the stuck conflict: keep the first change, keep the second, stop) offers
    // them to choose; any other is answered in your own words.
    { id: 'answer', label: 'Answer', help: 'Choose its answer, or answer in your own words', kind: 'choice', choices: { list: WORK_ANSWERS_LIST, dependsOn: 'question', allowOther: { reason: 'your own words' } }, required: true, typed: { tail: true } },
  ],
  sentence: 'Your answer "{answer}" to the question {work} asks you ({question}); the work goes on from there.', example: { work: 'work-1a2b', question: 'esc-1', answer: 'yes, keep the old setting too' },
  async run(values, _services, caller) {
    const { title, input } = await target(caller, values.work!, 'contract', { escalationId: values.question, text: values.answer });
    const reply = await runnerAct(caller, title, 'contracts.reply', input);
    // What the work did with it, in words (the runner's own word for it stays in the data).
    const did: Readonly<Record<string, string>> = {
      approved: 'it goes on as it is', amended: 'it goes on with your answer', stopped: 'the work is stopped',
      'asked-again': 'it asks again, in other words', refused: 'it was not taken',
    };
    const said = did[text(reply['action'])];
    return { text: `"${title}" has your answer${said ? `: ${said}` : ''}.`, data: reply };
  },
});

const FAILED_STEP: InputDescription = { ...STEP, help: 'The step the work stopped at when it failed', choices: { list: WORK_FAILED_STEPS_LIST, dependsOn: 'work' } };

export const WORK_RETRY: Work = daemonWork({
  id: 'work.retry', repeat: 'unsafe', actionId: 'retry', label: 'Run a failed step again', word: 'retry',
  inputs: [WORK, FAILED_STEP],
  sentence: 'Step {step} of {work} failed and runs again now with a fresh agent; the steps waiting on it run once it is done.', example: { work: 'work-1a2b', step: 'u-2' },
  async run(values, services, caller) {
    const { title, input } = await target(caller, values.work!, 'contract', { unitId: values.step });
    await noteCause(services, caller, values.work!);
    const outcome = await liveRunnerAct(caller, values.work!, title, 'contracts.retryUnit', input);
    if (outcome['outcome'] === 'refused') throw new CapabilityRefusal(`Not run again: ${text(outcome['reason'])}.`);
    return { text: `The failed step of "${title}" runs again; the steps waiting on it run once it is done.`, data: outcome };
  },
});

/** The step a piece of work stopped at when it failed, as `work.list` answers it. */
async function failedStepOf(caller: CapabilityCaller, work: string, step: string): Promise<Answer | undefined> {
  const listed = record(await methodOf(caller)('work.list', {}));
  const works = Array.isArray(listed['works']) ? listed['works'].map(record) : [];
  const run = record(works.find((entry) => entry['id'] === work)?.['run']);
  const failed = Array.isArray(run['failedSteps']) ? run['failedSteps'].map(record) : [];
  return failed.find((entry) => entry['id'] === step);
}

/**
 * Going on without a failed step: only where the plan lets the rest run without that step's result (nothing still to
 * run waits on it). The step is left out, and the work goes on to what follows and to the check of its results.
 */
export const WORK_GO_ON_WITHOUT: Work = daemonWork({
  id: 'work.go-on-without', repeat: 'safe', actionId: 'go-on-without', label: 'Go on without a failed step', word: 'go-on-without',
  inputs: [WORK, FAILED_STEP], lasts: 'kept',
  sentence: 'Step {step} of {work} failed; the work goes on without it and its result, where no step still to run needs that result. Its results are checked as usual.',
  example: { work: 'work-1a2b', step: 'u-3' },
  async run(values, services, caller) {
    const failed = await failedStepOf(caller, values.work!, values.step!);
    const { title, input } = await target(caller, values.work!, 'contract', { escalationId: text(failed?.['pause']), text: 'go on' });
    if (!failed) throw new CapabilityRefusal(`"${title}" was left as it is: that step is not one it stopped at.`);
    const step = text(failed['title']) || values.step!;
    if (failed['canGoOn'] !== true) throw new CapabilityRefusal(`"${title}" was left as it is: the steps after "${step}" need its result. Run it again or stop the work.`);
    await noteCause(services, caller, values.work!);
    const reply = await liveRunnerAct(caller, values.work!, title, 'contracts.reply', input);
    return { text: `"${title}" goes on without the step "${step}".`, data: reply };
  },
});

export const WORK_BUDGET: Work = daemonWork({
  id: 'work.budget', repeat: 'safe', actionId: 'budget', label: 'Change what a piece of work may spend', word: 'budget', lasts: 'kept', risk: 'spends-money',
  inputs: [WORK, { id: 'dollars', label: 'Most it may spend', help: 'In US dollars, for the whole piece of work', kind: 'money', freeTextReason: 'an amount', required: true, typed: { position: 2 } }],
  sentence: 'Let the work {work} spend up to {dollars} US dollars in all on its model calls, until you change it.', example: { work: 'work-1a2b', dollars: '5' },
  // A limit, not a purchase: changing it spends nothing.
  riskDone: 'Nothing was spent by this change: the work may spend up to the new limit as it runs.',
  async run(values, _services, caller) {
    const dollars = Number(values.dollars);
    if (!Number.isFinite(dollars) || dollars < 0) throw new CapabilityRefusal(`"${values.dollars}" is not an amount in dollars.`);
    const { title, input } = await target(caller, values.work!, 'contract', { maxCostUsd: dollars });
    const answer = await runnerAct(caller, title, 'contracts.budget', input);
    return { text: `Budget for "${title}" is now $${dollars}.`, data: answer };
  },
});

/** A plan act: the method's answer carries the work's title and the plan now. */
function planAct(id: string, actionId: string, label: string, sentence: string, inputs: readonly InputDescription[], example: Record<string, string>,
  method: string, body: (values: Readonly<Record<string, string>>) => Record<string, unknown>, said: (title: string, plan: Answer) => string,
  extra: Partial<Pick<Work, 'risk' | 'undoneBy'>> & { readonly repeat?: 'safe' | 'unsafe' } = {}): Work {
  const { repeat, ...rest } = extra;
  return daemonWork({
    id, repeat: repeat ?? 'safe', actionId, label, word: actionId, inputs, sentence, example, lasts: 'kept', ...rest,
    async run(values, _services, caller) {
      const answer = record(await methodOf(caller)(method, { work: values.work, ...body(values) }));
      return { text: said(text(answer['title']) || values.work!, record(answer['plan'])), data: answer };
    },
  });
}

const stepCount = (plan: Answer): string => {
  const count = Array.isArray(plan['steps']) ? plan['steps'].length : 0;
  return `${count} step${count === 1 ? '' : 's'}`;
};

export const WORK_PLAN_REDO = planAct('work.plan-redo', 'plan-redo', 'Write a plan again', 'The plan of {work} is written again from what you asked for; it waits for you again.',
  [WORK], { work: 'work-1a2b' }, 'work.plan.redo', () => ({}),
  (title, plan) => plan['state'] === 'failed' ? `The plan of "${title}" could not be written: ${text(plan['reason'])}.` : `The plan of "${title}" was written again: ${stepCount(plan)}, waiting for you.`,
  { repeat: 'unsafe' });

export const WORK_STEP_EDIT = planAct('work.step-edit', 'step-edit', 'Change a step of a plan', 'Step {step} of {work}\'s plan will do "{brief}"; the plan waits for you again.',
  [WORK, STEP, { id: 'brief', label: 'What the step does', help: 'The step\'s new brief', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } }],
  { work: 'work-1a2b', step: 'item-2', brief: 'update the tests for the new layout' }, 'work.plan.step.edit', (values) => ({ step: values.step, brief: values.brief }),
  (title) => `Changed a step of the plan of "${title}".`);

export const WORK_STEP_DROP = planAct('work.step-drop', 'step-drop', 'Take a step out of a plan', 'Step {step} is taken out of {work}\'s plan; the plan waits for you again.',
  [WORK, STEP], { work: 'work-1a2b', step: 'item-3' }, 'work.plan.step.drop', (values) => ({ step: values.step }),
  (title, plan) => `Took a step out of the plan of "${title}": ${stepCount(plan)} left.`);

export const WORK_STEP_MOVE = planAct('work.step-move', 'step-move', 'Move a step of a plan', 'Step {step} of {work}\'s plan moves to place {position}; the plan waits for you again.',
  [WORK, STEP, { id: 'position', label: 'New place', help: 'Its place in the plan, counting from 1', kind: 'number', freeTextReason: 'a position number', required: true, typed: { flag: '--to' } }],
  { work: 'work-1a2b', step: 'item-3', position: '1' }, 'work.plan.step.move', (values) => ({ step: values.step, position: Number(values.position) }),
  (title) => `Moved a step of the plan of "${title}".`);

export const WORK_PLAN_DISCARD = planAct('work.plan-discard', 'plan-discard', 'Throw a plan away', 'The waiting plan of {work} is thrown away; the work stays, not started.',
  [WORK], { work: 'work-1a2b' }, 'work.plan.discard', () => ({}), (title) => `Threw away the plan of "${title}"; it stays, not started.`, { risk: 'cannot-be-undone' });

/**
 * An ended piece of work whose commits are not in the project's branch keeps them on a branch of its own: merge it in
 * (the work's changes land in the project's branch, and its branch and folder go), or discard it (they are deleted).
 */
export const WORK_BRANCH_MERGE: Work = daemonWork({
  id: 'work.branch-merge', repeat: 'safe', actionId: 'branch-merge', label: 'Merge a work\'s kept branch in', word: 'branch-merge', inputs: [WORK], lasts: 'kept',
  sentence: 'The changes {work} kept on its own branch are merged into the project\'s branch; that branch and the work\'s folder are then removed.',
  example: { work: 'work-1a2b' },
  async run(values, _services, caller) {
    const answer = record(await methodOf(caller)('work.branch.merge', { work: values.work }));
    const title = text(answer['title']) || values.work!;
    return { text: `Merged the changes of "${title}" into ${text(answer['into']) || 'the project\'s branch'}${text(answer['commit']) ? ` (commit ${text(answer['commit'])})` : ''}; its own branch was removed.`, data: answer };
  },
});

export const WORK_BRANCH_DISCARD: Work = daemonWork({
  id: 'work.branch-discard', repeat: 'safe', actionId: 'branch-discard', label: 'Discard a work\'s kept branch', word: 'branch-discard', inputs: [WORK], lasts: 'kept',
  sentence: 'Every change {work} kept on its own branch is thrown away, with the work\'s own folder, and the other side of a conflict it kept on a branch of its own.',
  example: { work: 'work-1a2b' }, risk: 'cannot-be-undone', button: 'Discard it',
  async run(values, _services, caller) {
    const answer = record(await methodOf(caller)('work.branch.discard', { work: values.work }));
    const title = text(answer['title']) || values.work!;
    const branch = text(answer['branch']);
    const left = Array.isArray(answer['left']) ? answer['left'].filter((path): path is string => typeof path === 'string') : [];
    const others = Array.isArray(answer['others']) ? answer['others'].filter((name): name is string => typeof name === 'string') : [];
    // Both branches named: the work's own, and the other change of its conflict, which goes with it.
    const both = others.length > 0
      ? ` on its own branch${branch ? ` ${branch}` : ''}, and the other change of its conflict on ${others.join(', ')} with ${others.length === 1 ? 'it' : 'them'}; nothing of the work is left on disk.`
      : ' on its own branch.';
    return { text: `Discarded the changes "${title}" kept${both}${left.length > 0 ? ` ${left.join(', ')} ${left.length === 1 ? 'was' : 'were'} changed since and ${left.length === 1 ? 'stays' : 'stay'} as ${left.length === 1 ? 'it is' : 'they are'}.` : ''}`, data: answer };
  },
});

/**
 * Approving a waiting plan starts the work with exactly that plan. A proposed piece of work (`work.propose`) is not
 * yet a piece of work: approving it asks for the work first (what you want done and its results, as proposed), then
 * its plan becomes that work's approved plan and the work starts with it.
 */
export const WORK_APPROVE: Work = daemonWork({
  id: 'work.approve', repeat: 'safe', actionId: 'approve', label: 'Approve a plan and start the work', word: 'approve', inputs: [WORK],
  sentence: 'The plan of {work} is approved and the work starts with exactly its steps.', undoneBy: 'cancel', example: { work: 'work-1a2b' },
  // Approving is the owner's own act: anyone but the person (a model, a device, a member, a script) is put to the owner,
  // opening on No, and what the owner approves runs as their own.
  ownerOnly: { reason: 'approving a plan starts the work as yours', instead: 'the owner approves it in Work, or answers yes when it is put to them' },
  ownersAct: true,
  async run(values, services, caller) {
    const method = methodOf(caller);
    const listed = record(await method('work.list', {}));
    const works = Array.isArray(listed['works']) ? listed['works'].map(record) : [];
    const proposed = works.find((work) => work['id'] === values.work && work['proposed'] === true);
    let workId = values.work!;
    let approved: Answer;
    if (proposed) {
      const snapshot = record(await method('workLedger.snapshot', { projectId: listed['projectId'] }));
      const criteria = Array.isArray(proposed['criteria']) ? proposed['criteria'].filter((entry): entry is string => typeof entry === 'string') : [];
      const submitted = record(await method('workLedger.submit', {
        requestId: `proposal-${values.work}`, inputId: `proposal-${values.work}`, expectedRevision: snapshot['revision'], goal: text(proposed['goal']), criteria,
      }));
      workId = text(record(submitted['receipt'])['workId']);
      if (!workId) throw new CapabilityRefusal('The work was not taken, so its plan was not approved.');
      approved = record(await method('work.plan.approve', { work: values.work, as: workId }));
    } else {
      approved = record(await method('work.plan.approve', { work: values.work }));
    }
    const { title, input } = await target(caller, workId, 'execution');
    await noteCause(services, caller, text(input['workId']) || workId);
    const snapshot = record(await method('workLedger.execution.start', input));
    return { text: `Approved the plan of "${title}" (${stepCount(record(approved['plan']))}) and started it.`, data: { ...snapshot, work: workId } };
  },
});

/** One step of a proposed plan, as a person or a model writes it. */
export interface ProposedStep { readonly title: string; readonly brief: string; readonly after: readonly number[] }
/** A piece of work proposed with its plan, before anything of it exists or runs. */
export interface WorkProposal { readonly goal: string; readonly criteria: readonly string[]; readonly steps: readonly ProposedStep[] }
/** Where a proposed piece of work waits: the daemon's plans before they run (workflow/work-ledger/work-plans.ts). */
export interface WorkProposalCapabilityServices {
  /** `project`: the caller's project folder; the proposal waits among that project's plans. */
  readonly workProposals?: { propose(proposal: WorkProposal, project: string | undefined): Promise<{ readonly id: string; readonly title: string; readonly steps: number }> } | undefined;
}

/**
 * The steps of a plan written one per line, numbered or not, each "Title: what it does" or just what it does,
 * ending "(after 1, 2)" for the steps it waits on: the same form the Work place shows a plan in.
 */
export function parseProposedSteps(textValue: string): readonly ProposedStep[] {
  return textValue.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    let rest = line.replace(/^(?:\d+[.)]|[-*•])\s*/u, '');
    const after: number[] = [];
    const waits = /\s*\((?:after|waits on)\s+([\d,\s and]+)\)\s*$/iu.exec(rest);
    if (waits) {
      for (const part of waits[1]!.split(/[,\s]+|and/u)) { const n = Number(part); if (Number.isInteger(n) && n > 0) after.push(n); }
      rest = rest.slice(0, waits.index).trim();
    }
    const colon = rest.indexOf(': ');
    const title = colon > 0 && colon <= 80 ? rest.slice(0, colon).trim() : rest.length > 80 ? `${rest.slice(0, 77)}...` : rest;
    const brief = colon > 0 && colon <= 80 ? rest.slice(colon + 2).trim() || rest : rest;
    return { title, brief, after };
  });
}

/**
 * Propose a piece of work with its plan, for the person to approve. Classed as a read: nothing is asked for, written
 * into your work or run; the proposal waits in Work exactly as a plan held by "Show me the plan before it runs" does
 * (changed, reordered, trimmed, written again, approved or thrown away there), and approving it starts the work with
 * that plan. What plan mode offers in place of acting.
 */
export const WORK_PROPOSE: CapabilityDefinition<WorkProposalCapabilityServices> = {
  capability: { id: 'work.propose', group: 'work', home: 'daemon', repeat: 'unsafe' },
  actionId: 'propose', label: 'Propose a piece of work with its plan', word: 'propose', touches: 'reads', lasts: 'not-a-change', risk: 'none', done: '',
  inputs: [
    { id: 'goal', label: 'What you want done', help: 'The work, in a sentence or two', kind: 'long-text', freeTextReason: 'your own words for the work', required: true, typed: { tail: true } },
    { id: 'criteria', label: 'Done when', help: 'The results that mean it is done, one per line (1 to 100)', kind: 'long-text', freeTextReason: 'what done means', required: true, typed: { flag: '--done-when' } },
    { id: 'steps', label: 'Plan', help: 'Its steps, one per line, in order: "Title: what it does", ending "(after 1, 2)" for the steps it waits on', kind: 'long-text', freeTextReason: 'the steps of the plan', required: true, typed: { flag: '--steps' } },
  ],
  sentence: 'Proposes the work "{goal}" with its plan of steps for you to approve: it waits in Work, where you can change, move, take out or rewrite a step, approve it (that starts the work) or throw it away. Nothing runs until you approve.',
  example: { goal: 'Add retries to the uploader', criteria: 'an upload that fails twice still finishes', steps: '1. Find the uploader: read where uploads are sent\n2. Add retries: retry a failed upload twice with a pause (after 1)\n3. Test it: a test where the first two uploads fail (after 2)' },
  noControl: 'It is what a model in plan mode offers in place of acting; a person asks for work with New work in the Work place, and approves, changes or throws away a proposal there.',
  async run(values, services, caller) {
    if (!services.workProposals) throw new CapabilityRefusal('This daemon holds no plans before they run, so nothing was proposed.', undefined, 'UNAVAILABLE');
    const criteria = (values.criteria ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const steps = parseProposedSteps(values.steps ?? '');
    if (!values.goal?.trim()) throw new CapabilityRefusal('Nothing was proposed: say what the work is.');
    if (criteria.length === 0 || criteria.length > 100) throw new CapabilityRefusal('Nothing was proposed: give 1 to 100 results that mean it is done, one per line.');
    if (steps.length === 0) throw new CapabilityRefusal('Nothing was proposed: give the plan\'s steps, one per line.');
    const late = steps.findIndex((step, index) => step.after.some((n) => n >= index + 1 || n > steps.length));
    if (late >= 0) throw new CapabilityRefusal(`Nothing was proposed: step ${late + 1} waits on a step that does not come before it.`);
    const proposed = await services.workProposals.propose({ goal: values.goal.trim(), criteria, steps }, caller.workingDirectory);
    return {
      text: `Proposed "${proposed.title}" with a plan of ${proposed.steps} step${proposed.steps === 1 ? '' : 's'}. It waits in Work for you to approve: nothing runs until you do.`,
      data: { work: proposed.id, steps: proposed.steps },
    };
  },
};

/** One task handed over, the way a model's delegation or an outside agent words it: a line or two, then what done means. */
const DELEGATED_TITLE_LENGTH = 120;

/**
 * A task handed to the daemon as a piece of work and started at once: what a terminal program's model hands off
 * (its `agent` tool, with a decision model set, where it once started a contract in the program), and what an outside
 * agent hands over. The work is the caller's project's (the call names its folder) and the conversation that asked
 * (the call names it); it shows in Work, runs on the daemon whatever happens to the program, and the program that
 * asked follows it and gives its result to that conversation. Under "Show me the plan before it runs" its plan waits
 * in Work first, as any work's does. Each act is the daemon method a person's New work and Start run, as this caller.
 */
export const WORK_DELEGATE: Work = daemonWork({
  id: 'work.delegate', repeat: 'unsafe', actionId: 'delegate', label: 'Hand a task over as a piece of work', word: 'delegate', lasts: 'kept',
  inputs: [
    { id: 'goal', label: 'The task', help: 'What is to be done, in a sentence or a few', kind: 'long-text', freeTextReason: 'the task in words', required: true, typed: { tail: true } },
    { id: 'criteria', label: 'Done when', help: 'The results that mean it is done, one per line (empty: the task done as asked)', kind: 'long-text', freeTextReason: 'what done means', required: { default: '', defaultMeans: 'the task done as asked' }, typed: { flag: '--done-when' } },
  ],
  callerNeeds: { project: 'A task handed over is work in a project: the call names the project folder it is for.' },
  sentence: 'The task "{goal}" is handed over as a piece of work for this project: its plan is written and its steps run on the daemon; it shows in Work, and its result goes back to the conversation that asked.',
  undoneBy: 'cancel',
  example: { goal: 'Add retries to the uploader', criteria: 'an upload that fails twice still finishes' },
  noControl: 'It is how a model or an outside agent hands a task over; a person asks for work with New work in the Work place (in the web view, New, "Ask for work to be done", runs this act as their own), or in the conversation.',
  // Work handed over runs as whoever caused it: anyone but the person (a model, a device, a member, an outside agent, in a
  // project given to it) is decided under the owner's mode as an item of the owner's list, and its work runs as that caller's,
  // reads only, until the owner adopts it; a model's delegation from the owner's own conversation is decided under their mode
  // as an agent spawn (routes/capabilities.ts conversationDelegation) and carries that conversation's party.
  ownerOnly: { reason: 'work handed over runs on your machine', instead: 'the owner hands the task over in person, or answers yes when it is put to them' },
  async run(values, services, caller) {
    const method = methodOf(caller);
    const goal = (values.goal ?? '').trim();
    if (!goal) throw new CapabilityRefusal('Nothing was handed over: say what the task is.');
    const firstLine = goal.split('\n').map((line) => line.trim()).find(Boolean) ?? goal;
    const given = (values.criteria ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    // A task handed over with no results named is done when it is done as asked.
    const criteria = given.length > 0 ? given.slice(0, 100)
      : [`Done as asked: ${firstLine.length > DELEGATED_TITLE_LENGTH ? `${firstLine.slice(0, DELEGATED_TITLE_LENGTH - 3)}...` : firstLine}`];
    const listed = record(await method('work.list', {}));
    // One request id for this hand-over: a submit that lost a race with other work is sent again as the same request.
    const requestId = `delegated-${crypto.randomUUID()}`;
    let workId = '';
    for (let attempt = 0; attempt < 5 && !workId; attempt += 1) {
      const snapshot = record(await method('workLedger.snapshot', { projectId: listed['projectId'] }));
      try {
        const submitted = record(await method('workLedger.submit', { requestId, inputId: requestId, expectedRevision: snapshot['revision'], goal, criteria }));
        workId = text(record(submitted['receipt'])['workId']);
        if (!workId) throw new CapabilityRefusal('The daemon did not take the task as a piece of work; nothing was started.');
      } catch (error) {
        // Other work changed the ledger at the same moment: read it again and send the same request once more.
        const code = text(record(error)['code']);
        if ((code === 'NATIVE_SUBMISSION_STALE' || code === 'NATIVE_SUBMISSION_CONFLICT') && attempt < 4) continue;
        throw error;
      }
    }
    // Who handed it over is on its record before anything of it runs: work this caller made just now.
    await noteCause(services, caller, workId, true);
    let title = workId;
    try {
      // Started as it is now: a start that met the work a moment after it changed reads it again and starts it.
      for (let attempt = 0; ; attempt += 1) {
        const read = await target(caller, workId, 'execution');
        title = read.title;
        try {
          const snapshot = record(await method('workLedger.execution.start', read.input));
          return { text: `Handed over as the work "${title}"; it ${snapshot['kind'] === 'pending-intent' ? 'is starting' : 'runs'} on the daemon and shows in Work.`, data: { work: workId, title, started: true } };
        } catch (error) {
          const code = text(record(error)['code']);
          if ((code === 'NATIVE_EXECUTION_STALE' || code === 'NATIVE_EXECUTION_CONFLICT') && attempt < 4) continue;
          throw error;
        }
      }
    } catch (error) {
      const code = text(record(error)['code']);
      if (code === 'NATIVE_EXECUTION_PLAN_WAITING') {
        return { text: `Handed over as the work "${title}"; its plan is being written and waits for you in Work before it runs.`, data: { work: workId, title, planWaiting: true } };
      }
      const words = RUNNER_WORDS[code];
      if (words) throw new CapabilityRefusal(`"${title}" is in Work but was not started: ${words}.`);
      throw error;
    }
  },
});

/**
 * The acts that change one piece of work (start, stop, go on, a step run again or left out, its plan, its kept branch): a
 * caller below an admin makes them only on work it caused itself. Read before anything is decided (`refusedBefore`), so
 * nobody is asked about an act on someone else's work that is refused whatever the answer (routes/work.ts `ownWork`,
 * the method's own check stands besides).
 */
const OWN_WORK_ACTS: ReadonlySet<string> = new Set([
  'work.start', 'work.cancel', 'work.resume', 'work.retry', 'work.go-on-without', 'work.plan-redo', 'work.step-edit',
  'work.step-drop', 'work.step-move', 'work.plan-discard', 'work.branch-merge', 'work.branch-discard',
]);

async function ownWorkFirst(values: Readonly<Record<string, string>>, _services: WorkCauseCapabilityServices, caller: CapabilityCaller): Promise<CapabilityRefusal | undefined> {
  if (!values.work) return undefined;
  try {
    await methodOf(caller)('work.target', { work: values.work, operation: 'own' });
    return undefined;
  } catch (error) {
    // Only the answer that it is someone else's work refuses here; any other failure is the act's own to meet.
    if (text(record(error)['code']) === 'WORK_NOT_YOURS') return new CapabilityRefusal(error instanceof Error ? error.message : 'It is not work this caller asked for. Nothing was changed.', undefined, 'WORK_NOT_YOURS', 403);
    return undefined;
  }
}

/** Every Work capability the daemon runs. */
export const WORK_METHOD_CAPABILITIES: readonly Work[] = [
  WORK_LIST, WORK_START, WORK_STATUS, WORK_CANCEL, WORK_RESUME, WORK_ANSWER, WORK_RETRY, WORK_GO_ON_WITHOUT, WORK_BUDGET,
  WORK_PLAN_REDO, WORK_STEP_EDIT, WORK_STEP_DROP, WORK_STEP_MOVE, WORK_APPROVE, WORK_PLAN_DISCARD,
  WORK_BRANCH_MERGE, WORK_BRANCH_DISCARD,
  WORK_PROPOSE as unknown as Work,
].map((definition) => OWN_WORK_ACTS.has(definition.capability.id) ? { ...definition, refusedBefore: ownWorkFirst } : definition);
