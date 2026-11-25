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
  return caller.method;
}

/** What `work.target` reads for an act on a piece of work: its title and the body the method takes. */
async function target(caller: CapabilityCaller, work: string, operation: 'execution' | 'contract', rest: Record<string, unknown> = {}): Promise<{ readonly title: string; readonly input: Record<string, unknown> }> {
  const read = record(await methodOf(caller)('work.target', { work, operation, ...rest }));
  return { title: text(read['title']) || work, input: { ...record(read['input']) } };
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
  sentence: 'Shows every piece of work, where each stands (not started, its plan waiting for you, running, needs you, done, failed, stopped), its plan and its results.',
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
    const snapshot = record(await methodOf(caller)('workLedger.execution.cancel', input));
    return { text: `Stopped "${title}".`, data: snapshot };
  },
});

export const WORK_RESUME: Work = daemonWork({
  id: 'work.resume', repeat: 'safe', actionId: 'resume', label: 'Go on with a piece of work after a stop', word: 'resume', inputs: [WORK],
  sentence: 'Carry on with the job {work} that stopped halfway: it goes on from where it stopped; a finished one has its results checked and kept.', example: { work: 'work-1a2b' },
  async run(values, _services, caller) {
    const { title, input } = await target(caller, values.work!, 'execution');
    const snapshot = record(await methodOf(caller)('workLedger.execution.resume', input));
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
  sentence: 'You reply to the question {work} (a running job) asked you, {question}: "{answer}", and it goes on from there.', example: { work: 'work-1a2b', question: 'esc-1', answer: 'yes, keep the old setting too' },
  async run(values, _services, caller) {
    const { title, input } = await target(caller, values.work!, 'contract', { escalationId: values.question, text: values.answer });
    const reply = record(await methodOf(caller)('contracts.reply', input));
    return { text: `"${title}" has your answer${text(reply['action']) ? ` (read as: ${text(reply['action'])})` : ''}.`, data: reply };
  },
});

export const WORK_RETRY: Work = daemonWork({
  id: 'work.retry', repeat: 'unsafe', actionId: 'retry', label: 'Run a failed step again', word: 'retry', inputs: [WORK, STEP],
  sentence: 'Step {step} of {work} runs again now with a fresh agent; the steps waiting on it run once it passes.', example: { work: 'work-1a2b', step: 'u-2' },
  async run(values, _services, caller) {
    const { title, input } = await target(caller, values.work!, 'contract', { unitId: values.step });
    const outcome = record(await methodOf(caller)('contracts.retryUnit', input));
    if (outcome['outcome'] === 'refused') throw new CapabilityRefusal(`Not run again: ${text(outcome['reason'])}.`);
    return { text: `Step ${values.step} of "${title}" runs again.`, data: outcome };
  },
});

export const WORK_BUDGET: Work = daemonWork({
  id: 'work.budget', repeat: 'safe', actionId: 'budget', label: 'Change what a piece of work may spend', word: 'budget', lasts: 'kept', risk: 'spends-money',
  inputs: [WORK, { id: 'dollars', label: 'Most it may spend', help: 'In US dollars, for the whole piece of work', kind: 'money', freeTextReason: 'an amount', required: true, typed: { position: 2 } }],
  sentence: '{work} may spend up to ${dollars} in all, until you change it.', example: { work: 'work-1a2b', dollars: '5' },
  // A limit, not a purchase: changing it spends nothing.
  riskDone: 'Nothing was spent by this change: the work may spend up to the new limit as it runs.',
  async run(values, _services, caller) {
    const dollars = Number(values.dollars);
    if (!Number.isFinite(dollars) || dollars < 0) throw new CapabilityRefusal(`"${values.dollars}" is not an amount in dollars.`);
    const { title, input } = await target(caller, values.work!, 'contract', { maxCostUsd: dollars });
    const answer = record(await methodOf(caller)('contracts.budget', input));
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

/** Approving a waiting plan starts the work with exactly that plan. */
export const WORK_APPROVE: Work = daemonWork({
  id: 'work.approve', repeat: 'safe', actionId: 'approve', label: 'Approve a plan and start the work', word: 'approve', inputs: [WORK],
  sentence: 'The plan of {work} is approved and the work starts with exactly its steps.', undoneBy: 'cancel', example: { work: 'work-1a2b' },
  async run(values, _services, caller) {
    const approved = record(await methodOf(caller)('work.plan.approve', { work: values.work }));
    const { title, input } = await target(caller, values.work!, 'execution');
    const snapshot = record(await methodOf(caller)('workLedger.execution.start', input));
    return { text: `Approved the plan of "${title}" (${stepCount(record(approved['plan']))}) and started it.`, data: snapshot };
  },
});

/** Every Work capability the daemon runs. */
export const WORK_METHOD_CAPABILITIES: readonly Work[] = [
  WORK_LIST, WORK_START, WORK_STATUS, WORK_CANCEL, WORK_RESUME, WORK_ANSWER, WORK_RETRY, WORK_BUDGET,
  WORK_PLAN_REDO, WORK_STEP_EDIT, WORK_STEP_DROP, WORK_STEP_MOVE, WORK_APPROVE, WORK_PLAN_DISCARD,
];
