/**
 * `/work`, described once (command-actions/) for both terminal apps: native
 * work on the host. Open the work view at a project; start, read, cancel or
 * resume a piece of work; submit source from a file and settle it; recover
 * input waiting to be admitted; import old planning records with safe retry
 * of a lost request; and, in the terminal app, ask for work in your own words
 * and read the planner and past planning records. Each app installs its host:
 * where the work view is, whether a hosted turn may resume here, how an
 * import reaches the host, and the requests it can take.
 */
import {
  nativeConversationIntakeLines,
  type NativeConversationIntakeActions,
  type NativeConversationIntakeState,
} from './native-conversation-intake.js';
import { nativeWorkSubmissionLines } from './native-work-submission.js';
import { nativeWorkExecutionLines, type NativeWorkExecutionAction } from './native-work-execution.js';
import type { NativeWorkLedgerView } from './work-ledger-view.js';
import { commandRefusal } from '../command-confirmation.js';
import type { TerminalCommandRegistry } from '../command-registry.js';
import { defineCommand } from '../command-actions/define.js';
import type { ActionDescription, CommandActionContext, CommandDescription, FixedChoice, InputDescription } from '../command-actions/types.js';
import { choiceInput, doAction, readAction, textInput } from '../described-command-kit.js';
import { runLegacyImportStep, type LegacyImportStep } from '../legacy-work-ledger-import-command.js';
import type { LegacyImportOperatorSession } from '../legacy-work-ledger-import-operator.js';

/** What the planner does with work it is asked for; the terminal app keeps the planner. */
export type PlannerAct = 'status' | 'explain' | 'mode' | 'override' | 'clear';

/** What one app does for `/work`. */
export interface WorkHost<Ctx> {
  /** The native work view, or undefined where this shell has none. */
  readonly view: (ctx: Ctx) => NativeWorkLedgerView | undefined;
  /** Open the work view (at a project when one is named); throws a refusal when it cannot. */
  readonly open: (ctx: Ctx, project: string) => void;
  /** Whether a hosted turn found by an intake step may be resumed in this app. */
  readonly allowHostedDispatch: boolean;
  /** An import session for one project on this app's host. */
  readonly openImport: (ctx: Ctx, projectId: string) => Promise<LegacyImportOperatorSession>;
  /** Requests in your own words, the planner and past planning records, or why this app has none. */
  readonly requests: { readonly unavailable: string } | {
    submit(ctx: Ctx, goal: string): Promise<void>;
    openHistory(ctx: Ctx): void;
    plans(ctx: Ctx): string;
    plan(ctx: Ctx, id: string): string;
    planner(ctx: Ctx, act: PlannerAct, value: string): string;
  };
}

interface IntakeContext {
  readonly nativeConversationIntake?: NativeConversationIntakeActions | undefined;
  readonly dispatchNativeIntakeTurn?: ((state: NativeConversationIntakeState) => void | Promise<void>) | undefined;
}

let installed: WorkHost<CommandActionContext> | undefined;
function hostOf(): WorkHost<CommandActionContext> {
  if (!installed) throw commandRefusal('Native work is not available in this session.');
  return installed;
}
function requestsOf() {
  const requests = hostOf().requests;
  if ('unavailable' in requests) throw commandRefusal(requests.unavailable);
  return requests;
}
const clean = (lines: readonly string[]): string => lines.map((line) => line.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')).join('\n');

async function execute(ctx: CommandActionContext, act: NativeWorkExecutionAction, workId: string): Promise<string> {
  const view = hostOf().view(ctx);
  if (!view?.execute) throw commandRefusal(`Nothing was run: this host has no native work controls, so /work ${act} cannot run here.`, undefined, 'COMMAND_FAILED');
  const result = await view.execute(act, workId);
  const lines = result
    ? nativeWorkExecutionLines(result)
    : [view.state.status !== 'ready' ? view.state.reason : 'No new result: a request may already be pending, or this one was replaced by a newer one.'];
  return clean(lines.length ? lines : ['No native work binding is available.']);
}

async function submission(ctx: CommandActionContext, act: 'submit' | 'status' | 'retry' | 'discard', path: string): Promise<string> {
  const view = hostOf().view(ctx);
  if (!view?.submitFile || !view.submissionStatus || !view.retrySubmission || !view.discardSubmission) throw commandRefusal('Submitting work from a file is not available in this shell.');
  const result = act === 'submit' ? await view.submitFile(path)
    : act === 'status' ? await view.submissionStatus()
      : act === 'retry' ? await view.retrySubmission() : await view.discardSubmission();
  return clean(nativeWorkSubmissionLines(result));
}

async function intake(context: CommandActionContext, act: 'status' | 'retry' | 'resume' | 'cancel'): Promise<void> {
  const ctx = context as CommandActionContext & IntakeContext;
  const actions = ctx.nativeConversationIntake;
  if (!actions) throw commandRefusal('Input admission is not available in this shell.');
  const result = await (act === 'status' ? actions.status() : act === 'retry' ? actions.retry() : act === 'resume' ? actions.resume() : actions.cancel());
  ctx.print(nativeConversationIntakeLines(result).join('\n'));
  if (result?.turnReady || (hostOf().allowHostedDispatch && result?.hostedTurn)) {
    await ctx.dispatchNativeIntakeTurn?.(result);
    // A local turn dispatched here has ended: its intake record has nothing left to fence.
    if (result.turnReady && ctx.dispatchNativeIntakeTurn) await result.finishTurn?.();
  }
}

function importStep(step: LegacyImportStep) {
  return (values: Readonly<Record<string, string>>, ctx: CommandActionContext) => runLegacyImportStep(step, values.project!, values.request ?? '', ctx, (context, project) => hostOf().openImport(context, project));
}

const WORK: InputDescription = textInput({ id: 'work', label: 'Work', help: 'The work id the work view shows', why: 'a work id from the work view', typed: { position: 1 } });
const PROJECT: InputDescription = textInput({ id: 'project', label: 'Project', help: 'The daemon project id, exactly', why: 'a project id from the host', typed: { position: 1 } });
const REQUEST: InputDescription = textInput({ id: 'request', label: 'Request', help: 'The saved request id, to be sure it is that one', why: 'a request id the import printed', typed: { position: 2 }, optional: { default: '', means: 'the saved one' } });
const STRATEGIES: readonly FixedChoice[] = [
  { value: 'auto', label: 'Let the planner choose' },
  { value: 'single', label: 'One agent at a time' },
  { value: 'cohort', label: 'A group of agents together' },
  { value: 'background', label: 'In the background' },
  { value: 'remote', label: 'On a remote runner' },
];

type WorkAction = ActionDescription<CommandActionContext>;
const HOST_ONLY = { terminalOnly: 'It runs through this terminal app\'s link to the host.' } as const;

function hostChange(fields: Pick<WorkAction, 'id' | 'label' | 'word' | 'inputs' | 'sentence' | 'example' | 'run'> & Partial<Pick<WorkAction, 'risk' | 'lasts'>>): WorkAction {
  return { done: '', touches: 'another-machine', lasts: 'not-a-change', risk: 'none', operator: HOST_ONLY, ...fields };
}

export const WORK_COMMAND: CommandDescription<CommandActionContext> = {
  name: 'work',
  // --yes confirms only right after the action word: the same word in the text is text.
  leadingFlagsOnly: true,
  title: 'Native work',
  summary: 'Work on the host: open it, start, cancel or resume it, submit it from a file, recover input, import old records, and ask for work',
  group: 'Agents and work',
  firstScreenRows: [
    'open', 'request',
    { label: 'Start, check, cancel or resume work…', actions: ['start', 'status', 'cancel', 'resume'] },
    { label: 'Submit work from a file…', actions: ['submit-file', 'submission', 'submission-retry', 'submission-discard'] },
    { label: 'Input waiting to be admitted…', actions: ['intake', 'intake-retry', 'intake-resume', 'intake-cancel'] },
    { label: 'Import old planning records…', actions: ['import-preview', 'import', 'import-status', 'import-reconsider', 'import-recover', 'import-cancel', 'import-restart'] },
    { label: 'The planner and past plans…', actions: ['planner', 'planner-explain', 'planner-mode', 'planner-override', 'planner-reset', 'history', 'plans', 'plan'] },
  ],
  actions: [
    doAction<CommandActionContext>({
      id: 'open', label: 'Open native work', word: 'open', touches: 'reads',
      inputs: [{ ...PROJECT, help: 'A daemon project to select first', required: { default: '', defaultMeans: 'the project already selected' } }],
      sentence: 'Opens the native work view, at the project named.', example: { project: 'proj-1a2b' },
      operator: { terminalOnly: 'It is a terminal screen.' },
      async run(values, ctx) { hostOf().open(ctx, values.project ?? ''); },
    }),
    hostChange({
      id: 'request', label: 'Ask for work in your own words', word: 'request',
      inputs: [textInput({ id: 'goal', label: 'What you want done', help: 'In your own words, as you would ask in the chat', why: 'your own words for the work', kind: 'long-text', typed: { tail: true } })],
      sentence: '"{goal}" is sent to the host as a new work request; nothing else starts until the host admits it.', example: { goal: 'add retries to the uploader' },
      async run(values, ctx) { await requestsOf().submit(ctx, values.goal!); },
    }),
    hostChange({ id: 'start', label: 'Start a piece of work', word: 'start', inputs: [WORK], sentence: 'Work {work} starts on the host.', example: { work: 'work-1a2b' }, run: (values, ctx) => execute(ctx, 'start', values.work!) }),
    readAction<CommandActionContext>({ id: 'status', label: 'See a piece of work', word: 'status', inputs: [WORK], sentence: 'Shows where work {work} stands on the host.', example: { work: 'work-1a2b' }, operator: HOST_ONLY, run: (values, ctx) => execute(ctx, 'status', values.work!) }),
    hostChange({ id: 'cancel', label: 'Cancel a piece of work', word: 'cancel', inputs: [WORK], sentence: 'Work {work} is cancelled on the host.', example: { work: 'work-1a2b' }, risk: 'cannot-be-undone', run: (values, ctx) => execute(ctx, 'cancel', values.work!) }),
    hostChange({ id: 'resume', label: 'Resume a piece of work', word: 'resume', inputs: [WORK], sentence: 'Work {work} goes on from where it stopped on the host.', example: { work: 'work-1a2b' }, run: (values, ctx) => execute(ctx, 'resume', values.work!) }),
    hostChange({
      id: 'submit-file', label: 'Submit work from a file', word: 'submit-file',
      inputs: [textInput({ id: 'path', label: 'File', help: 'A JSON file describing the work', why: 'a file on this machine', kind: 'path', typed: { position: 1 } })],
      sentence: 'The work described in {path} is sent to the host; it is kept here until the host has it.', example: { path: 'work.json' },
      run: (values, ctx) => submission(ctx, 'submit', values.path!),
    }),
    readAction<CommandActionContext>({ id: 'submission', label: 'See the submitted file\'s state', word: 'submission', sentence: 'Shows whether the work last submitted from a file reached the host.', operator: HOST_ONLY, run: (_values, ctx) => submission(ctx, 'status', '') }),
    hostChange({ id: 'submission-retry', label: 'Send the submitted file again', word: 'submission-retry', inputs: [], sentence: 'The work last submitted from a file is sent to the host again; the host keeps it once.', example: {}, run: (_values, ctx) => submission(ctx, 'retry', '') }),
    hostChange({ id: 'submission-discard', label: 'Drop the submitted file', word: 'submission-discard', inputs: [], sentence: 'The saved submission the host has no record of is dropped, so a corrected one can be sent.', example: {}, risk: 'cannot-be-undone', run: (_values, ctx) => submission(ctx, 'discard', '') }),
    readAction<CommandActionContext>({ id: 'intake', label: 'See input waiting to be admitted', word: 'intake', sentence: 'Shows the input you typed that waits for the host to admit it, and what happens next.', operator: HOST_ONLY, run: (_values, ctx) => intake(ctx, 'status') }),
    hostChange({ id: 'intake-retry', label: 'Try admitting the input again', word: 'intake-retry', inputs: [], sentence: 'The waiting input is sent to the host again; the host admits it once.', example: {}, run: (_values, ctx) => intake(ctx, 'retry') }),
    hostChange({ id: 'intake-resume', label: 'Go on with the admitted input', word: 'intake-resume', inputs: [], sentence: 'The input the host admitted goes on to its turn.', example: {}, run: (_values, ctx) => intake(ctx, 'resume') }),
    hostChange({ id: 'intake-cancel', label: 'Drop the input waiting to be admitted', word: 'intake-cancel', inputs: [], sentence: 'The waiting input is dropped and nothing starts from it.', example: {}, risk: 'cannot-be-undone', run: (_values, ctx) => intake(ctx, 'cancel') }),
    readAction<CommandActionContext>({ id: 'import-preview', label: 'Preview importing old planning records', word: 'import-preview', inputs: [PROJECT], sentence: 'Shows what importing the old planning records of project {project} would bring in; nothing is sent.', example: { project: 'proj-1a2b' }, operator: HOST_ONLY, run: importStep('preview') }),
    hostChange({ id: 'import', label: 'Import old planning records', word: 'import', inputs: [PROJECT], sentence: 'The old planning records of project {project} are sent to the host as historical work; the sources stay where they are and no work starts.', example: { project: 'proj-1a2b' }, run: importStep('submit') }),
    readAction<CommandActionContext>({ id: 'import-status', label: 'See an import\'s state', word: 'import-status', inputs: [PROJECT], sentence: 'Shows where the saved import of project {project} stands and the step that moves it on.', example: { project: 'proj-1a2b' }, operator: HOST_ONLY, run: importStep('status') }),
    hostChange({ id: 'import-reconsider', label: 'Ask the host again about an import', word: 'import-reconsider', inputs: [PROJECT, REQUEST], sentence: 'The host is asked again whether it admits the waiting import of project {project}.', example: { project: 'proj-1a2b' }, run: importStep('reconsider') }),
    hostChange({ id: 'import-recover', label: 'Resend an import whose answer was lost', word: 'import-recover', inputs: [PROJECT, REQUEST], sentence: 'The import of project {project} is sent again with the same request, which the host applies once.', example: { project: 'proj-1a2b' }, run: importStep('recover') }),
    hostChange({ id: 'import-cancel', label: 'Drop a waiting import', word: 'import-cancel', inputs: [PROJECT, REQUEST], sentence: 'The import of project {project} that waits for the host is dropped.', example: { project: 'proj-1a2b' }, risk: 'cannot-be-undone', run: importStep('cancel') }),
    hostChange({ id: 'import-restart', label: 'Prepare a fresh import', word: 'import-restart', inputs: [PROJECT, REQUEST], sentence: 'A fresh import of project {project} is prepared; the ended one stays in the history.', example: { project: 'proj-1a2b' }, run: importStep('restart') }),
    readAction<CommandActionContext>({ id: 'planner', label: 'See how work is spread', word: 'planner', sentence: 'Shows the planner\'s mode, any forced way of spreading work, and its latest choice.', operator: { terminalOnly: 'The planner runs in the terminal app.' }, run: async (_values, ctx) => requestsOf().planner(ctx, 'status', '') }),
    readAction<CommandActionContext>({ id: 'planner-explain', label: 'See why the planner chose', word: 'planner-explain', sentence: 'Explains the planner\'s latest choice of how to spread work.', operator: { terminalOnly: 'The planner runs in the terminal app.' }, run: async (_values, ctx) => requestsOf().planner(ctx, 'explain', '') }),
    {
      id: 'planner-mode', label: 'Choose how work is spread', word: 'planner-mode',
      inputs: [choiceInput({ id: 'strategy', label: 'How', help: 'How the planner spreads work', choices: STRATEGIES, typed: { position: 1 } })],
      sentence: 'The planner spreads work as {strategy} until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'planner-reset', operator: { terminalOnly: 'The planner runs in the terminal app.' }, example: { strategy: 'cohort' },
      run: async (values, ctx) => requestsOf().planner(ctx, 'mode', values.strategy!),
    },
    {
      id: 'planner-override', label: 'Force one way of spreading work', word: 'planner-override',
      inputs: [choiceInput({ id: 'strategy', label: 'How', help: 'The way every piece of work is spread, whatever the planner would choose', choices: STRATEGIES, typed: { position: 1 } })],
      sentence: 'Every piece of work is spread as {strategy}, whatever the planner would choose, until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'planner-reset', operator: { terminalOnly: 'The planner runs in the terminal app.' }, example: { strategy: 'single' },
      run: async (values, ctx) => requestsOf().planner(ctx, 'override', values.strategy!),
    },
    {
      id: 'planner-reset', label: 'Let the planner choose again', word: 'planner-reset', inputs: [],
      sentence: 'The planner\'s mode and any forced way are reset, so it chooses again, until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none', operator: { terminalOnly: 'The planner runs in the terminal app.' }, example: {},
      run: async (_values, ctx) => requestsOf().planner(ctx, 'clear', ''),
    },
    doAction<CommandActionContext>({ id: 'history', label: 'Open past planning records', word: 'history', touches: 'reads', sentence: 'Opens the saved planning records from before native work, read only.', operator: { terminalOnly: 'It is a terminal screen.' }, async run(_values, ctx) { requestsOf().openHistory(ctx); } }),
    readAction<CommandActionContext>({ id: 'plans', label: 'See past plans', word: 'plans', sentence: 'Lists the saved plans from before native work, read only.', operator: { terminalOnly: 'Past plans are kept by the terminal app.' }, run: async (_values, ctx) => requestsOf().plans(ctx) }),
    readAction<CommandActionContext>({
      id: 'plan', label: 'See one past plan', word: 'plan',
      inputs: [textInput({ id: 'plan', label: 'Plan', help: 'Its id, or the start of it', why: 'a plan id from the list', typed: { position: 1 } })],
      sentence: 'Shows saved plan {plan} in full.', example: { plan: '1a2b3c4d' }, operator: { terminalOnly: 'Past plans are kept by the terminal app.' },
      run: async (values, ctx) => requestsOf().plan(ctx, values.plan!),
    }),
  ],
};

const WORK_SLASH_COMMAND = defineCommand(WORK_COMMAND);

/** Register `/work` (the one description) with this app's host. */
export function registerWorkCommand<Ctx extends CommandActionContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, host: WorkHost<Ctx>): void {
  installed = host as unknown as WorkHost<CommandActionContext>;
  registry.register(WORK_SLASH_COMMAND as never);
}
