/**
 * `/compare`, described once (command-actions/): blind model comparisons. The
 * same prompt goes to two to four models with their names hidden, the
 * answers are kept as a review artifact, and a judgment, a decision about the
 * model, a report, a reviewer handoff or a ZIP of it can be saved from it.
 * Each action is one call of the `agent_model_compare` tool, run as the
 * owner's own act (owner-tool-call.ts).
 */
import { defineCommand, type ActionDescription, type InputDescription } from '@goodvibes/engine/terminal-shell/command-actions';
import { choiceInput, readAction, textInput } from '@goodvibes/engine/terminal-shell/described-command-kit';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { artifactInput } from './artifacts-runtime.ts';
import { given, ownerRead, ownerToolCall, positiveNumber, runOwnerToolCall, splitWords } from './owner-tool-call.ts';

const TOOL = 'agent_model_compare';
const LOCAL_ONLY = { terminalOnly: 'Comparisons run from this Agent and are kept in its artifacts.' } as const;

/** The task a local-route benchmark sets when no prompt is given. */
const BENCHMARK_PROMPT = 'Benchmark this local route on one practical task: 1. summarize the current project goal in five bullets, 2. identify one likely setup risk, 3. propose one next action with a command or route.';
const BENCHMARK_RUBRIC = 'Prefer fast first useful output, correct project context, concrete setup-risk identification, and one actionable next route or command.';

const opt = (id: string, label: string, help: string, flag: `--${string}`, means: string, why = 'your own words', kind: InputDescription['kind'] = 'text'): InputDescription =>
  textInput({ id, label, help, why, kind, typed: { flag }, optional: { default: '', means } });
const number = (id: string, label: string, help: string, flag: `--${string}`, means: string, defaultValue = ''): InputDescription =>
  ({ id, label, help, kind: 'number', freeTextReason: 'a whole number', required: { default: defaultValue, defaultMeans: means }, typed: { flag } });
const REVEAL = (help: string): InputDescription => choiceInput({
  id: 'reveal', label: 'Model names', help,
  choices: [{ value: 'no', label: 'Keep them hidden' }, { value: 'yes', label: 'Show them' }],
  typed: { flag: '--reveal', switchOn: 'yes' }, optional: { default: 'no', means: 'keep them hidden' },
});
const RUN_OPTIONS: readonly InputDescription[] = [
  opt('models', 'Models', 'Which models, separated by commas', '--models', 'chosen for you', 'model names'),
  number('count', 'How many', 'How many models when none are named (2 to 4)', '--count', '2', '2'),
  artifactInput({ id: 'source', label: 'Source artifact', help: 'A saved text artifact given to every model with the prompt', typed: { flag: '--source' }, optional: { default: '', means: 'none' } }),
  opt('system', 'System prompt', 'Sent to every model the same way', '--system', 'none', 'your own words', 'long-text'),
  number('maxTokens', 'Longest answer', 'The most tokens each model may answer with', '--max-tokens', 'each model\'s own limit'),
  opt('document', 'For draft', 'The draft id this comparison is about', '--document', 'none', 'a draft id'),
  REVEAL('Whether to show which model wrote which answer now'),
];

type CompareAction = ActionDescription<CommandContext>;
function keep(fields: Pick<CompareAction, 'id' | 'label' | 'word' | 'inputs' | 'sentence' | 'example' | 'run'> & Partial<Pick<CompareAction, 'risk'>>): CompareAction {
  return { done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', operator: LOCAL_ONLY, ownerOnly: ownerToolCall(TOOL), ...fields };
}

function runArgs(values: Readonly<Record<string, string>>, prompt: string, rubric: string, tag: string, task: string): Record<string, unknown> {
  const models = splitWords(values.models);
  const count = positiveNumber(values.count);
  const maxTokens = positiveNumber(values.maxTokens);
  return {
    mode: 'run', prompt,
    ...(values.source ? { artifactId: values.source } : {}),
    ...(models.length > 0 ? { modelRefs: models } : count ? { candidateCount: count } : {}),
    ...(rubric ? { rubric } : {}), ...(values.system ? { systemPrompt: values.system } : {}), ...(maxTokens ? { maxTokens } : {}),
    ...(tag ? { benchmarkKind: tag } : {}), ...(task ? { taskType: task } : {}), ...(values.document ? { documentId: values.document } : {}),
    reveal: values.reveal === 'yes', confirm: true, explicitUserRequest: `Compare models on: ${prompt.slice(0, 200)}`,
  };
}

export function registerCompareRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'compare',
    // --yes confirms only right after the action word: the same word in the prompt is text.
    leadingFlagsOnly: true,
    title: 'Model comparisons',
    summary: 'Send one prompt to several models with their names hidden, judge the answers, and decide whether to change models',
    group: 'Models',
    report: 'review',
    firstScreenRows: [
      'review', 'run', 'benchmark', 'judge',
      { label: 'Decide about the model…', actions: ['apply', 'record-decision'] },
      { label: 'Report and hand off…', actions: ['export', 'diff-handoffs', 'analytics'] },
    ],
    actions: [
      ownerRead(TOOL, readAction<CommandContext>({
        id: 'review', label: 'See your comparisons', word: 'review', operator: LOCAL_ONLY,
        inputs: [
          artifactInput({ id: 'comparison', label: 'Comparison', help: 'One saved comparison to show as a review board', optional: { default: '', means: 'list the recent ones' } }),
          choiceInput({
            id: 'view', label: 'Show it', help: 'The answers alone, or beside related artifacts',
            choices: [{ value: 'review', label: 'The answers' }, { value: 'side-by-side', label: 'Beside related artifacts' }],
            typed: { flag: '--view' }, optional: { default: 'review', means: 'the answers' },
          }),
          opt('related', 'Related artifacts', 'Artifact ids to show beside it, separated by commas', '--related', 'none', 'artifact ids'),
          number('bytes', 'Preview length', 'How many bytes of each related artifact (200 to 10000)', '--bytes', '2000', '2000'),
          REVEAL('Whether to show which model wrote which answer'),
        ],
        sentence: 'Shows comparison {comparison} as a review board, or lists the recent comparisons.', example: { comparison: 'artifact-123' },
        async run(values, ctx) {
          const related = splitWords(values.related);
          const previewBytes = positiveNumber(values.bytes);
          return runOwnerToolCall(ctx, TOOL, {
            mode: values.view === 'side-by-side' ? 'sideBySide' : 'review', ...(values.comparison ? { artifactId: values.comparison } : {}),
            ...(related.length > 0 ? { relatedArtifactIds: related } : {}), ...(previewBytes ? { previewBytes } : {}), reveal: values.reveal === 'yes',
          }, 'show model comparisons');
        },
      })),
      keep({
        id: 'run', label: 'Compare models on a prompt', word: 'run', risk: 'spends-money',
        inputs: [
          textInput({ id: 'prompt', label: 'Prompt', help: 'Sent to every model exactly as written', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
          opt('rubric', 'How to judge', 'What a good answer does, shown with the answers', '--rubric', 'none', 'your own words', 'long-text'),
          opt('tag', 'Benchmark tag', 'A word to group this comparison by later', '--tag', 'none', 'a tag'),
          opt('task', 'Kind of task', 'Such as writing, research or code-review', '--task', 'none', 'a task word'),
          ...RUN_OPTIONS,
        ],
        sentence: 'The prompt "{prompt}" is sent to two to four models with their names hidden, and the answers are kept as a review artifact until you change it.',
        example: { prompt: 'Summarize this plan in three bullets.' },
        async run(values, ctx) { return runOwnerToolCall(ctx, TOOL, runArgs(values, values.prompt!, values.rubric ?? '', values.tag ?? '', values.task ?? ''), 'compare models'); },
      }),
      keep({
        id: 'benchmark', label: 'Benchmark local models', word: 'benchmark', risk: 'spends-money',
        inputs: [
          textInput({ id: 'prompt', label: 'Task', help: 'The task every model is given', why: 'your own words', kind: 'long-text', typed: { tail: true }, optional: { default: '', means: 'the standard task (summarize the project, name a setup risk, propose a next step)' } }),
          ...RUN_OPTIONS,
        ],
        sentence: 'The models on this machine (at least two, or the ones named) are given the same task with their names hidden, and the answers are kept as a review artifact tagged local-model-route, until you change it.',
        example: {},
        async run(values, ctx) {
          return runOwnerToolCall(ctx, TOOL, runArgs(values, values.prompt || BENCHMARK_PROMPT, BENCHMARK_RUBRIC, 'local-model-route', 'local-model-route'), 'benchmark local models');
        },
      }),
      keep({
        id: 'judge', label: 'Judge a comparison', word: 'judge',
        inputs: [
          artifactInput({ id: 'comparison', label: 'Comparison', help: 'The saved comparison' }),
          textInput({ id: 'winner', label: 'Winner', help: 'The answer you chose, such as A', why: 'a candidate letter', typed: { position: 2 } }),
          textInput({ id: 'reasons', label: 'Why', help: 'Why that answer won', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
          opt('notes', 'Notes', 'Risks, follow-ups or rubric notes', '--notes', 'none', 'your own words', 'long-text'),
          REVEAL('Whether the judgment names the models, which a model decision needs'),
        ],
        sentence: 'Your judgment that answer {winner} of comparison {comparison} won, because "{reasons}", is kept until you change it; the model in use is unchanged.',
        example: { comparison: 'artifact-123', winner: 'A', reasons: 'Clearer and shorter.' },
        async run(values, ctx) {
          return runOwnerToolCall(ctx, TOOL, {
            mode: 'judge', artifactId: values.comparison, winnerBlindId: values.winner, reasons: values.reasons, ...given(values, 'notes'),
            reveal: values.reveal === 'yes', confirm: true, explicitUserRequest: `Judge comparison ${values.comparison}: ${values.winner} won.`,
          }, `judge comparison ${values.comparison}`);
        },
      }),
      keep({
        id: 'apply', label: 'Switch to the winning model', word: 'apply',
        inputs: [artifactInput({ id: 'judgment', label: 'Judgment', help: 'A saved judgment that names the models' })],
        sentence: 'The Agent\'s main model becomes the winner of judgment {judgment}, until you change it.', example: { judgment: 'artifact-123' },
        async run(values, ctx) {
          return runOwnerToolCall(ctx, TOOL, { mode: 'apply', artifactId: values.judgment, confirm: true, explicitUserRequest: `Switch to the winner of judgment ${values.judgment}.` }, `switch to the winner of ${values.judgment}`);
        },
      }),
      keep({
        id: 'record-decision', label: 'Keep the model and record why', word: 'record-decision',
        inputs: [artifactInput({ id: 'judgment', label: 'Judgment', help: 'A saved judgment that names the models' })],
        sentence: 'A record that judgment {judgment} left the main model as it is is kept until you change it.', example: { judgment: 'artifact-123' },
        async run(values, ctx) {
          return runOwnerToolCall(ctx, TOOL, { mode: 'routeDecision', artifactId: values.judgment, decision: 'left-unchanged', confirm: true, explicitUserRequest: `Record that judgment ${values.judgment} left the model unchanged.` }, `record a model decision for ${values.judgment}`);
        },
      }),
      keep({
        id: 'export', label: 'Save a comparison report or handoff', word: 'export',
        inputs: [
          artifactInput({ id: 'source', label: 'Comparison or judgment', help: 'The saved comparison, judgment or handoff' }),
          choiceInput({
            id: 'as', label: 'Save it as', help: 'A report, a reviewer handoff with its evidence, or a ZIP of a handoff',
            choices: [{ value: 'report', label: 'A report' }, { value: 'handoff', label: 'A reviewer handoff' }, { value: 'archive', label: 'A ZIP of a handoff' }],
            typed: { flag: '--as' }, optional: { default: 'report', means: 'a report' },
          }),
          opt('related', 'Related artifacts', 'Evidence to go with a handoff, separated by commas', '--related', 'none', 'artifact ids'),
          REVEAL('Whether a comparison report names the models (a judgment keeps its own choice)'),
        ],
        sentence: 'A report, reviewer handoff or ZIP is saved from {source} as an artifact, until you change it.', example: { source: 'artifact-123' },
        async run(values, ctx) {
          const related = splitWords(values.related);
          return runOwnerToolCall(ctx, TOOL, {
            mode: values.as === 'handoff' ? 'handoff' : values.as === 'archive' ? 'handoffArchive' : 'export', artifactId: values.source,
            ...(related.length > 0 ? { relatedArtifactIds: related } : {}), reveal: values.reveal === 'yes', confirm: true, explicitUserRequest: `Save a ${values.as || 'report'} from ${values.source}.`,
          }, `save a ${values.as || 'report'} from ${values.source}`);
        },
      }),
      ownerRead(TOOL, readAction<CommandContext>({
        id: 'diff-handoffs', label: 'Compare two reviewer handoffs', word: 'diff-handoffs', operator: LOCAL_ONLY,
        inputs: [
          artifactInput({ id: 'left', label: 'Older handoff', help: 'The first saved reviewer handoff', optional: { default: '', means: 'list the saved handoffs' } }),
          artifactInput({ id: 'right', label: 'Newer handoff', help: 'The second saved reviewer handoff', typed: { position: 2 }, optional: { default: '', means: 'list the saved handoffs' } }),
          choiceInput({
            id: 'section', label: 'Part', help: 'Which part to compare',
            choices: [{ value: 'metadata', label: 'Details' }, { value: 'policy', label: 'Policy' }, { value: 'related', label: 'Related evidence' }, { value: 'comparison', label: 'The comparison' }],
            typed: { flag: '--section' }, optional: { default: '', means: 'every part' },
          }),
        ],
        sentence: 'Shows what changed between reviewer handoffs {left} and {right}, side by side.', example: { left: 'artifact-1', right: 'artifact-2' },
        async run(values, ctx) {
          return runOwnerToolCall(ctx, TOOL, { mode: 'handoffDiff', ...(values.left ? { leftArtifactId: values.left } : {}), ...(values.right ? { rightArtifactId: values.right } : {}), ...given(values, 'section') }, 'compare reviewer handoffs');
        },
      })),
      ownerRead(TOOL, readAction<CommandContext>({
        id: 'analytics', label: 'See which models win', word: 'analytics', operator: LOCAL_ONLY,
        inputs: [
          choiceInput({
            id: 'view', label: 'Show', help: 'Counts by winner and model, or the themes in your reasons',
            choices: [{ value: 'analytics', label: 'Counts' }, { value: 'synthesis', label: 'Themes in the reasons' }],
            typed: { flag: '--view' }, optional: { default: 'analytics', means: 'counts' },
          }),
          number('limit', 'At most', 'How many saved judgments to read', '--limit', '20', '20'),
          opt('tag', 'Benchmark tag', 'Only comparisons with this tag', '--tag', 'every tag', 'a tag'),
          opt('task', 'Kind of task', 'Only this kind of task', '--task', 'every kind', 'a task word'),
          opt('document', 'For draft', 'Only judgments about this draft', '--document', 'every draft', 'a draft id'),
          choiceInput({
            id: 'reasons', label: 'Reasons', help: 'Whether to quote short reasons from recent judgments',
            choices: [{ value: 'yes', label: 'Quote them' }, { value: 'no', label: 'Counts only' }],
            typed: { flag: '--no-reasons', switchOn: 'no' }, optional: { default: 'yes', means: 'quote them' },
          }),
        ],
        sentence: 'Shows your saved judgments by winner, model, task and tag.', example: { tag: 'local-model-route' },
        async run(values, ctx) {
          const limit = positiveNumber(values.limit);
          return runOwnerToolCall(ctx, TOOL, {
            mode: values.view === 'synthesis' ? 'synthesis' : 'analytics', ...(limit ? { limit } : {}),
            ...(values.tag ? { benchmarkKind: values.tag } : {}), ...(values.task ? { taskType: values.task } : {}), ...(values.document ? { documentId: values.document } : {}),
            includeReasons: values.reasons !== 'no',
          }, 'see comparison judgments');
        },
      })),
    ],
  }));
}
