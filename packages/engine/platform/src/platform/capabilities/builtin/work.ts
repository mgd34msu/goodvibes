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
 */
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type InputDescription, type ListName } from '../types.js';

/** Your work (`work.list`), the list a work input chooses from; registered in terminal-shell (native/work-command.ts). */
export const WORK_ITEMS_LIST = 'work.items' as ListName;
/** The open questions of one piece of work, after it is chosen. */
export const WORK_QUESTIONS_LIST = 'work.questions' as ListName;
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

function progressWords(snapshot: Answer): string {
  const progress = record(snapshot['progress']);
  const units = record(progress['units']);
  const criteria = record(progress['criteria']);
  if (Object.keys(progress).length === 0) {
    return snapshot['kind'] === 'pending-intent' ? 'it is starting' : snapshot['state'] === 'cancelled' ? 'it was stopped' : 'it has not started';
  }
  const status = text(progress['status']);
  const steps = typeof units['total'] === 'number' ? `${units['passed'] ?? 0} of ${units['total']} steps done` : '';
  const results = typeof criteria['total'] === 'number' ? `${criteria['met'] ?? 0} of ${criteria['total']} results met` : '';
  return [status === 'passed' ? 'done' : status === 'awaiting-owner' ? 'it needs you' : status || 'running', steps, results].filter(Boolean).join(', ');
}

type Work = CapabilityDefinition<unknown>;

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
  async run(values, _services, caller) {
    const { title, input } = await target(caller, values.work!, 'execution');
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
      return { text: `"${title}": ${progressWords(snapshot)}.`, data: snapshot };
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
  async run(values, _services, caller) {
    const { title, input } = await target(caller, values.work!, 'execution');
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
    { id: 'answer', label: 'Answer', help: 'Your answer, in your own words (retry or cancel for a failed step)', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } },
  ],
  sentence: 'Your answer "{answer}" to the question {work} asks you ({question}); the work goes on from there.', example: { work: 'work-1a2b', question: 'esc-1', answer: 'yes, keep the old setting too' },
  async run(values, _services, caller) {
    const { title, input } = await target(caller, values.work!, 'contract', { escalationId: values.question, text: values.answer });
    const reply = await runnerAct(caller, title, 'contracts.reply', input);
    return { text: `"${title}" has your answer${text(reply['action']) ? ` (read as: ${text(reply['action'])})` : ''}.`, data: reply };
  },
});

const FAILED_STEP: InputDescription = { ...STEP, help: 'The step the work stopped at when it failed', choices: { list: WORK_FAILED_STEPS_LIST, dependsOn: 'work' } };

export const WORK_RETRY: Work = daemonWork({
  id: 'work.retry', repeat: 'unsafe', actionId: 'retry', label: 'Run a failed step again', word: 'retry',
  inputs: [WORK, FAILED_STEP],
  sentence: 'Step {step} of {work} failed and runs again now with a fresh agent; the steps waiting on it run once it is done.', example: { work: 'work-1a2b', step: 'u-2' },
  async run(values, _services, caller) {
    const { title, input } = await target(caller, values.work!, 'contract', { unitId: values.step });
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
  async run(values, _services, caller) {
    const failed = await failedStepOf(caller, values.work!, values.step!);
    const { title, input } = await target(caller, values.work!, 'contract', { escalationId: text(failed?.['pause']), text: 'go on' });
    if (!failed) throw new CapabilityRefusal(`"${title}" was left as it is: that step is not one it stopped at.`);
    const step = text(failed['title']) || values.step!;
    if (failed['canGoOn'] !== true) throw new CapabilityRefusal(`"${title}" was left as it is: the steps after "${step}" need its result. Run it again or stop the work.`);
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
 * Approving a waiting plan starts the work with exactly that plan. A proposed piece of work (`work.propose`) is not
 * yet a piece of work: approving it asks for the work first (what you want done and its results, as proposed), then
 * its plan becomes that work's approved plan and the work starts with it.
 */
export const WORK_APPROVE: Work = daemonWork({
  id: 'work.approve', repeat: 'safe', actionId: 'approve', label: 'Approve a plan and start the work', word: 'approve', inputs: [WORK],
  sentence: 'The plan of {work} is approved and the work starts with exactly its steps.', undoneBy: 'cancel', example: { work: 'work-1a2b' },
  async run(values, _services, caller) {
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
    { id: 'criteria', label: 'Done when', help: 'The results that mean it is done, one per line (empty: the task done as asked)', kind: 'long-text', freeTextReason: 'what done means', required: false, typed: { flag: '--done-when' } },
  ],
  callerNeeds: { project: 'A task handed over is work in a project: the call names the project folder it is for.' },
  sentence: 'The task "{goal}" is handed over as a piece of work for this project: its plan is written and its steps run on the daemon; it shows in Work, and its result goes back to the conversation that asked.',
  undoneBy: 'cancel',
  example: { goal: 'Add retries to the uploader', criteria: 'an upload that fails twice still finishes' },
  async run(values, _services, caller) {
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

/** Every Work capability the daemon runs. */
export const WORK_METHOD_CAPABILITIES: readonly Work[] = [
  WORK_LIST, WORK_START, WORK_STATUS, WORK_CANCEL, WORK_RESUME, WORK_ANSWER, WORK_RETRY, WORK_GO_ON_WITHOUT, WORK_BUDGET,
  WORK_PLAN_REDO, WORK_STEP_EDIT, WORK_STEP_DROP, WORK_STEP_MOVE, WORK_APPROVE, WORK_PLAN_DISCARD,
  WORK_PROPOSE as unknown as Work,
];
