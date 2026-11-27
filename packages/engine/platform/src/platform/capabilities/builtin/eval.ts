/**
 * Evaluating the product on real tasks (Work and agents), home `session`: a
 * task suite is folders in the project (each a `task.json` and a `verify.sh`),
 * every task runs as one headless `goodvibes run` in a scratch copy, and the
 * baseline is a file in the project. The program holding the conversation runs
 * them in its own project folder and keeps the results of this session (the
 * terminal app; the Agent runs no suites, so these are not something it does).
 */
import { CapabilityRefusal, type CapabilityDefinition, type InputDescription } from '../types.js';

/** One suite's last result in this session, as the Work place's Evaluations list shows it. */
export interface EvalResultRow {
  readonly suite: string;
  readonly passed: number;
  readonly total: number;
  readonly at: number;
  /** The gate's verdict for the suite, when it was gated. */
  readonly gate?: 'passed' | 'failed' | undefined;
  readonly failed: readonly string[];
}

/** The program's suites: each answer is what happened, in words; a refusal says what was not done and why. */
export interface EvalSuiteServices {
  list(suite: string): Promise<string>;
  run(suite: string): Promise<string>;
  compare(baseline: string): Promise<string>;
  gate(suite: string, baseline: string, save: boolean): Promise<string>;
  /** The suites run in this session, newest result each. */
  results(): readonly EvalResultRow[];
  /** Told after every result; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export interface EvalCapabilityServices {
  /** Absent in a program that runs no task suites (the Agent). */
  readonly evalSuites?: EvalSuiteServices | undefined;
}

export const DEFAULT_TASK_SUITE_DIR = '.goodvibes/eval/tasks';
export const DEFAULT_EVAL_BASELINE = '.goodvibes/eval/baseline.json';

const SUITE: InputDescription = {
  id: 'suite', label: 'Task suite', help: `A folder with one folder per task (default ${DEFAULT_TASK_SUITE_DIR})`, kind: 'path',
  freeTextReason: 'a folder in this project', required: { default: '', defaultMeans: DEFAULT_TASK_SUITE_DIR }, typed: { position: 1 },
};
const BASELINE = (typed: InputDescription['typed']): InputDescription => ({
  id: 'baseline', label: 'Baseline', help: `A baseline file (default ${DEFAULT_EVAL_BASELINE})`, kind: 'path',
  freeTextReason: 'a file in this project', required: { default: '', defaultMeans: DEFAULT_EVAL_BASELINE }, typed,
});

type Definition = CapabilityDefinition<EvalCapabilityServices>;

function suitesOf(services: EvalCapabilityServices): EvalSuiteServices {
  if (!services.evalSuites) {
    throw new CapabilityRefusal('Nothing was run: task suites run in the terminal app, in its project folder.', 'Open the Work place in the terminal app.', 'UNAVAILABLE');
  }
  return services.evalSuites;
}

function evalCapability(fields: Omit<Definition, 'capability' | 'word' | 'done' | 'available' | 'risk'> & { readonly repeat: 'safe' | 'unsafe' }): Definition {
  const { repeat, ...rest } = fields;
  return {
    capability: { id: `eval.${fields.actionId}`, group: 'work', home: 'session', repeat },
    word: fields.actionId, done: '', risk: 'none',
    available: (services) => services.evalSuites !== undefined,
    ...rest,
  };
}

export const EVAL_LIST = evalCapability({
  actionId: 'list', label: 'See the tasks in a suite', inputs: [SUITE], repeat: 'safe', touches: 'reads', lasts: 'not-a-change',
  sentence: 'Lists the tasks in the task suite named, each with its instruction.', example: { suite: 'evals/tasks' },
  async run(values, services) { return { text: await suitesOf(services).list(values.suite ?? '') }; },
});

export const EVAL_RUN = evalCapability({
  actionId: 'run', label: 'Run a task suite to test the product', inputs: [SUITE], repeat: 'unsafe', touches: 'this-machine', lasts: 'session',
  // Its result is a row of Evaluations, kept for the session: the empty tab names this action first.
  sentence: 'Each task of the suite runs as one goodvibes run in a scratch copy, then its verify.sh says pass or fail; the suite itself is never changed, and the result is listed for this session only.',
  example: { suite: 'evals/tasks' },
  async run(values, services) { return { text: await suitesOf(services).run(values.suite ?? '') }; },
});

export const EVAL_COMPARE = evalCapability({
  actionId: 'compare', label: 'Compare the last suite run with a baseline', inputs: [BASELINE({ position: 1 })], repeat: 'safe', touches: 'reads', lasts: 'not-a-change',
  sentence: 'Compares the last suite run of this session with the baseline file, task by task.', example: { baseline: 'evals/baseline.json' },
  async run(values, services) { return { text: await suitesOf(services).compare(values.baseline ?? '') }; },
});

export const EVAL_GATE = evalCapability({
  actionId: 'gate', label: 'Run a suite and stop on a regression', repeat: 'unsafe', touches: 'this-machine', lasts: 'kept',
  inputs: [
    SUITE,
    // Written when this run is saved as the baseline or none is there yet.
    { ...BASELINE({ flag: '--baseline' }), file: 'written' },
    {
      id: 'save', label: 'Then', help: 'Whether this run becomes the baseline', kind: 'choice',
      choices: [{ value: 'no', label: 'Keep the baseline' }, { value: 'yes', label: 'Save this run as the baseline', help: 'The baseline file is written over.' }],
      required: { default: 'no', defaultMeans: 'keep the baseline (one is made when there is none)' }, typed: { flag: '--save-baseline', switchOn: 'yes' },
    },
  ],
  sentence: 'The suite runs, and the gate fails on a failed task or one worse than the baseline; a missing baseline is made from this run, until you change it.',
  example: { suite: 'evals/tasks', save: 'yes' },
  async run(values, services) { return { text: await suitesOf(services).gate(values.suite ?? '', values.baseline ?? '', values.save === 'yes') }; },
});

export const EVAL_CAPABILITIES: readonly Definition[] = [EVAL_LIST, EVAL_RUN, EVAL_COMPARE, EVAL_GATE];
