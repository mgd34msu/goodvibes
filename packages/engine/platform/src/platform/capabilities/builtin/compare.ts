/**
 * Model comparisons (Models and providers): one prompt sent to two to four
 * models with their names hidden, the answers kept as a review artifact in the
 * daemon's artifact store, and a judgment, a model decision, a report or a
 * reviewer handoff saved from it. The daemon runs every one
 * (terminal-shell `agent-turn/model-compare-runner.ts`, which it composes), on
 * its own providers, whoever asked; switching to a winner changes the default
 * model every conversation that has not chosen its own uses.
 */
import {
  CapabilityRefusal,
  type ActionLasts,
  type ActionRisk,
  type ActionValues,
  type CapabilityCaller,
  type CapabilityDefinition,
  type CapabilityResult,
  type InputDescription,
} from '../types.js';
import { countInput, fixedInput, wordsInput } from './agent-stores.js';
import { artifactPick } from './artifacts.js';

/** The act a comparison capability names, run by the daemon. */
export interface ModelComparisonRunner {
  run(id: string, values: ActionValues, caller: CapabilityCaller): Promise<CapabilityResult>;
}

/** What these capabilities need: the daemon's comparison runner. */
export interface ModelComparisonCapabilityServices {
  readonly modelComparisons?: ModelComparisonRunner | undefined;
}

type Optional = { readonly default: string; readonly means: string };
const optional = (means: string, fallback = ''): Optional => ({ default: fallback, means });

const words = (id: string, label: string, help: string, flag: `--${string}`, means: string, why = 'your own words', kind: InputDescription['kind'] = 'text'): InputDescription =>
  wordsInput({ id, label, help, why, kind, typed: { flag }, optional: optional(means) });

const REVEAL = (help: string): InputDescription => fixedInput({
  id: 'reveal', label: 'Model names', help,
  choices: [{ value: 'no', label: 'Keep them hidden' }, { value: 'yes', label: 'Show them' }],
  typed: { flag: '--reveal', switchOn: 'yes' }, optional: optional('keep them hidden', 'no'),
});

const RUN_OPTIONS: readonly InputDescription[] = [
  words('models', 'Models', 'Which models, separated by commas', '--models', 'chosen for you', 'model names'),
  countInput('count', 'How many', 'How many models when none are named (2 to 4)', '--count', '2', '2'),
  artifactPick({ id: 'source', label: 'Source artifact', help: 'A saved text artifact given to every model with the prompt', typed: { flag: '--source' }, optional: optional('none') }),
  words('system', 'System prompt', 'Sent to every model the same way', '--system', 'none', 'your own words', 'long-text'),
  countInput('maxTokens', 'Longest answer', 'The most tokens each model may answer with', '--max-tokens', '', 'each model\'s own limit'),
  words('document', 'For draft', 'The draft id this comparison is about', '--document', 'none', 'a draft id'),
  REVEAL('Whether to show which model wrote which answer now'),
];

interface Fields {
  readonly id: string;
  readonly actionId: string;
  readonly label: string;
  readonly word: string;
  readonly inputs: readonly InputDescription[];
  readonly sentence: string;
  readonly example: ActionValues;
  readonly reads?: boolean | undefined;
  readonly risk?: ActionRisk | undefined;
  readonly riskDone?: string | undefined;
  readonly lasts?: ActionLasts | undefined;
}

function comparison(fields: Fields): CapabilityDefinition<ModelComparisonCapabilityServices> {
  return {
    capability: { id: fields.id, group: 'models', home: 'daemon', repeat: fields.reads ? 'safe' : 'unsafe' },
    actionId: fields.actionId,
    label: fields.label,
    word: fields.word,
    inputs: fields.inputs,
    sentence: fields.sentence,
    done: '',
    touches: fields.reads ? 'reads' : 'this-machine',
    lasts: fields.reads ? 'not-a-change' : fields.lasts ?? 'kept',
    risk: fields.risk ?? 'none',
    ...(fields.riskDone ? { riskDone: fields.riskDone } : {}),
    example: fields.example,
    async run(values, services, caller) {
      if (!services.modelComparisons) {
        throw new CapabilityRefusal('This daemon does not run model comparisons; nothing was done.', 'Start the GoodVibes daemon that came with this version.');
      }
      return services.modelComparisons.run(fields.id, values, caller);
    },
  };
}

/** Your saved comparisons and judgments are saved artifacts; their pick-list is the artifacts list. */
const comparisonPick = (help: string, more: Partial<Parameters<typeof artifactPick>[0]> = {}): InputDescription =>
  artifactPick({ id: 'comparison', label: 'Comparison', help, ...more });

export const COMPARE_REVIEW = comparison({
  id: 'compare.review', actionId: 'review', label: 'See your model comparisons', word: 'review', reads: true,
  inputs: [
    comparisonPick('One saved comparison to show as a review board', { optional: optional('list the recent ones') }),
    fixedInput({
      id: 'view', label: 'Show it', help: 'The answers alone, or beside related artifacts',
      choices: [{ value: 'review', label: 'The answers' }, { value: 'side-by-side', label: 'Beside related artifacts' }],
      typed: { flag: '--view' }, optional: optional('the answers', 'review'),
    }),
    words('related', 'Related artifacts', 'Artifact ids to show beside it, separated by commas', '--related', 'none', 'artifact ids'),
    countInput('bytes', 'Preview length', 'How many bytes of each related artifact (200 to 10000)', '--bytes', '2000', '2000'),
    REVEAL('Whether to show which model wrote which answer'),
  ],
  sentence: 'Shows one saved model comparison (its answers), judgment, decision or report, or lists your saved comparisons.', example: { comparison: 'artifact-123' },
});

export const COMPARE_RUN = comparison({
  id: 'compare.run', actionId: 'run', label: 'Compare models on a prompt', word: 'run', risk: 'spends-money',
  inputs: [
    wordsInput({ id: 'prompt', label: 'Prompt', help: 'Sent to every model exactly as written', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
    words('rubric', 'How to judge', 'What a good answer does, shown with the answers', '--rubric', 'none', 'your own words', 'long-text'),
    words('tag', 'Benchmark tag', 'A word to group this comparison by later', '--tag', 'none', 'a tag'),
    words('task', 'Kind of task', 'Such as writing, research or code-review', '--task', 'none', 'a task word'),
    ...RUN_OPTIONS,
  ],
  sentence: 'The prompt "{prompt}" is sent to two to four models side by side with their names hidden (a blind comparison), and the answers are kept with your comparisons to judge, until you change it.',
  example: { prompt: 'Summarize this plan in three bullets.' },
});

export const COMPARE_BENCHMARK = comparison({
  id: 'compare.benchmark', actionId: 'benchmark', label: 'Benchmark local models', word: 'benchmark', risk: 'spends-money',
  // The models on this machine charge nothing: "This spent money." would not be true of what ran.
  riskDone: 'This ran on the models on this machine: it used this machine\'s time, not money.',
  inputs: [
    wordsInput({ id: 'prompt', label: 'Task', help: 'The task every model is given', why: 'your own words', kind: 'long-text', typed: { tail: true }, optional: optional('the standard task (summarize the project, name a setup risk, propose a next step)') }),
    ...RUN_OPTIONS,
  ],
  sentence: 'The models on this machine (at least two, or the ones named) are given the same task with their names hidden, and the answers are kept with your comparisons to judge, tagged local-model-route, until you change it.',
  example: {},
});

export const COMPARE_JUDGE = comparison({
  id: 'compare.judge', actionId: 'judge', label: 'Judge a model comparison', word: 'judge',
  inputs: [
    comparisonPick('The saved comparison'),
    wordsInput({ id: 'winner', label: 'Winner', help: 'The answer you chose, such as A', why: 'a candidate letter', typed: { position: 2 } }),
    wordsInput({ id: 'reasons', label: 'Why', help: 'Why that answer won', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
    words('notes', 'Notes', 'Risks, follow-ups or rubric notes', '--notes', 'none', 'your own words', 'long-text'),
    REVEAL('Whether the judgment names the models, which a model decision needs'),
  ],
  sentence: 'Your judgment that answer {winner} won, because "{reasons}", is kept with the comparison until you change it; the model in use is unchanged.',
  example: { comparison: 'artifact-123', winner: 'A', reasons: 'Clearer and shorter.' },
});

const judgmentPick = artifactPick({ id: 'judgment', label: 'Judgment', help: 'A saved judgment that names the models' });

export const COMPARE_APPLY = comparison({
  id: 'compare.apply', actionId: 'apply', label: 'Switch to the winning model', word: 'apply',
  inputs: [judgmentPick],
  sentence: 'Every conversation that has not chosen its own model uses the winning model of this judgment from the next message, in every program, until you change it.',
  example: { judgment: 'artifact-123' },
});

export const COMPARE_RECORD_DECISION = comparison({
  id: 'compare.record-decision', actionId: 'record-decision', label: 'Keep the model and record why', word: 'record-decision',
  inputs: [judgmentPick],
  sentence: 'A record that you kept the default model after this judgment is kept with your comparisons until you change it.', example: { judgment: 'artifact-123' },
});

export const COMPARE_EXPORT = comparison({
  id: 'compare.export', actionId: 'export', label: 'Save a comparison report or handoff', word: 'export',
  inputs: [
    artifactPick({ id: 'source', label: 'Comparison or judgment', help: 'The saved comparison, judgment or handoff' }),
    fixedInput({
      id: 'as', label: 'Save it as', help: 'A report, a reviewer handoff with its evidence, or a ZIP of a handoff',
      choices: [{ value: 'report', label: 'A report' }, { value: 'handoff', label: 'A reviewer handoff' }, { value: 'archive', label: 'A ZIP of a handoff' }],
      typed: { flag: '--as' }, optional: optional('a report', 'report'),
    }),
    words('related', 'Related artifacts', 'Evidence to go with a handoff, separated by commas', '--related', 'none', 'artifact ids'),
    REVEAL('Whether a comparison report names the models (a judgment keeps its own choice)'),
  ],
  sentence: 'A report, reviewer handoff or ZIP of this model comparison is saved with your comparisons, until you change it.', example: { source: 'artifact-123' },
});

export const COMPARE_DIFF_HANDOFFS = comparison({
  id: 'compare.diff-handoffs', actionId: 'diff-handoffs', label: 'Compare two reviewer handoffs', word: 'diff-handoffs', reads: true,
  inputs: [
    artifactPick({ id: 'left', label: 'Older handoff', help: 'The first saved reviewer handoff', optional: optional('list the saved handoffs') }),
    artifactPick({ id: 'right', label: 'Newer handoff', help: 'The second saved reviewer handoff', typed: { position: 2 }, optional: optional('list the saved handoffs') }),
    fixedInput({
      id: 'section', label: 'Part', help: 'Which part to compare',
      choices: [{ value: 'metadata', label: 'Details' }, { value: 'policy', label: 'Policy' }, { value: 'related', label: 'Related evidence' }, { value: 'comparison', label: 'The comparison' }],
      typed: { flag: '--section' }, optional: optional('every part'),
    }),
  ],
  sentence: 'Shows what changed between two reviewer handoffs, side by side, or lists the saved ones.', example: { left: 'artifact-1', right: 'artifact-2' },
});

export const COMPARE_ANALYTICS = comparison({
  id: 'compare.analytics', actionId: 'analytics', label: 'See which models win', word: 'analytics', reads: true,
  inputs: [
    fixedInput({
      id: 'view', label: 'Show', help: 'Counts by winner and model, or the themes in your reasons',
      choices: [{ value: 'analytics', label: 'Counts' }, { value: 'synthesis', label: 'Themes in the reasons' }],
      typed: { flag: '--view' }, optional: optional('counts', 'analytics'),
    }),
    countInput('limit', 'At most', 'How many saved judgments to read', '--limit', '20', '20'),
    words('tag', 'Benchmark tag', 'Only comparisons with this tag', '--tag', 'every tag', 'a tag'),
    words('task', 'Kind of task', 'Only this kind of task', '--task', 'every kind', 'a task word'),
    words('document', 'For draft', 'Only judgments about this draft', '--document', 'every draft', 'a draft id'),
    fixedInput({
      id: 'reasons', label: 'Reasons', help: 'Whether to quote short reasons from recent judgments',
      choices: [{ value: 'yes', label: 'Quote them' }, { value: 'no', label: 'Counts only' }],
      typed: { flag: '--no-reasons', switchOn: 'no' }, optional: optional('quote them', 'yes'),
    }),
  ],
  sentence: 'Shows your saved model comparison judgments by winner, model, task and tag.', example: { tag: 'local-model-route' },
});

export const COMPARE_CAPABILITIES = [
  COMPARE_REVIEW, COMPARE_RUN, COMPARE_BENCHMARK, COMPARE_JUDGE, COMPARE_APPLY, COMPARE_RECORD_DECISION, COMPARE_EXPORT, COMPARE_DIFF_HANDOFFS, COMPARE_ANALYTICS,
] as const;
