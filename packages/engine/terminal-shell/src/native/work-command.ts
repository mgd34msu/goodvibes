/**
 * `/work`, described once (command-actions/) for both terminal apps. Typed
 * bare it opens the Work place; its actions are the Work place's controls and
 * what find and run reach:
 *
 *  - your work on the daemon's one runner (builtin/work.ts): see it, start,
 *    check, stop and resume a piece of work, answer what it asks, run a failed
 *    step again, change what it may spend. Each runs through its daemon method
 *    as the person's own request; nothing of it runs in this program.
 *  - asking for work: in your own words (the host decides whether it is an
 *    answer or a piece of work), as a goal with what done means, or from a
 *    file; this program keeps the journal that makes a lost answer safe to
 *    send again, and the input waiting to be admitted.
 *  - the project's checklist (builtin/checklist.ts), kept by this program in
 *    the shared file.
 */
import {
  CHECKLIST_CAPABILITIES, CHECKLIST_ITEMS_LIST, TASKS_CAPABILITIES, WORK_INTAKE_CAPABILITIES, WORK_ITEMS_LIST, WORK_METHOD_CAPABILITIES, WORK_QUESTIONS_LIST,
  WORK_STEPS_LIST, checklistStateWords,
  type CapabilityDefinition, type ChecklistCapabilityServices, type TasksCapabilityServices, type WorkIntakeCapabilityServices,
} from '@goodvibes/engine/platform/platform/capabilities';
import { tasksServices } from '../tasks-runtime-commands.js';
import {
  nativeConversationIntakeLines,
  type NativeConversationIntakeActions,
  type NativeConversationIntakeState,
} from './native-conversation-intake.js';
import { nativeWorkSubmissionLines } from './native-work-submission.js';
import { NATIVE_SUBMISSION_MAX_BYTES, NativeWorkSourceError, validateNativeWorkSource, type NativeWorkSource } from './native-work-submission-source.js';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '@goodvibes/engine/platform/platform/utils';
import type { NativeWorkLedgerView } from './work-ledger-view.js';
import { commandRefusal } from '../command-confirmation.js';
import type { TerminalCommandRegistry } from '../command-registry.js';
import { defineCommand } from '../command-actions/define.js';
import { defineList, type ListRow } from '../command-actions/lists.js';
import { daemonCapabilityAction, runDaemonCapability, sessionCapabilityAction, type DaemonCapabilityBinding } from '../command-actions/capability-actions.js';
import type { ActionDescription, CommandActionContext, CommandDescription } from '../command-actions/types.js';

/** What one app does for `/work`. */
export interface WorkHost<Ctx> {
  /** The submission and intake view of this app's link to the host, or undefined where this shell has none. */
  readonly view: (ctx: Ctx) => NativeWorkLedgerView | undefined;
  /** Whether a hosted turn found by an intake step may be resumed in this app. */
  readonly allowHostedDispatch: boolean;
  /** Asking for work in your own words, or why this app cannot. */
  readonly requests: { readonly unavailable: string } | { submit(ctx: Ctx, goal: string): Promise<void> };
}

interface IntakeContext {
  readonly nativeConversationIntake?: NativeConversationIntakeActions | undefined;
  readonly dispatchNativeIntakeTurn?: ((state: NativeConversationIntakeState) => void | Promise<void>) | undefined;
}
interface ChecklistContext { readonly workspace?: { readonly workPlan?: ChecklistCapabilityServices['checklist'] } | undefined }

let installed: WorkHost<CommandActionContext> | undefined;
let binding: DaemonCapabilityBinding<CommandActionContext> | undefined;
function hostOf(): WorkHost<CommandActionContext> {
  if (!installed) throw commandRefusal('Work is not available in this session.');
  return installed;
}
function requestsOf() {
  const requests = hostOf().requests;
  if ('unavailable' in requests) throw commandRefusal(requests.unavailable);
  return requests;
}
const clean = (lines: readonly string[]): string => lines.map((line) => line.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ')).join('\n');

async function submission(ctx: CommandActionContext, act: 'submit' | 'status' | 'retry' | 'discard', path: string): Promise<string> {
  const view = hostOf().view(ctx);
  if (!view?.submitFile || !view.submissionStatus || !view.retrySubmission || !view.discardSubmission) throw commandRefusal('Submitting work from a file is not available in this shell.');
  const result = act === 'submit' ? await view.submitFile(path)
    : act === 'status' ? await view.submissionStatus()
      : act === 'retry' ? await view.retrySubmission() : await view.discardSubmission();
  return clean(nativeWorkSubmissionLines(result));
}

/** A path typed in quotes ("my file.json" or 'my file.json') is the path without them. */
function unquote(path: string): string {
  const trimmed = path.trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

/**
 * The New work form: the goal and its criteria become the same JSON a file
 * takes, checked by the same rule (1 to 100 criteria, each and the goal at
 * most 20,000 characters, 262,144 bytes in all), kept in a private file, and
 * submitted the way a file is.
 */
async function submitNewWork(ctx: CommandActionContext, goal: string, criteriaText: string): Promise<string> {
  const criteria = criteriaText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  let source: NativeWorkSource;
  try {
    source = validateNativeWorkSource({ goal: goal.trim(), criteria });
    const json = `${JSON.stringify(source, null, 2)}\n`;
    if (new TextEncoder().encode(json).byteLength > NATIVE_SUBMISSION_MAX_BYTES) throw new NativeWorkSourceError('The work is longer than 262,144 bytes.');
    const path = join(tmpdir(), 'goodvibes-new-work', `${randomUUID()}.json`);
    writeFileAtomic(path, json, { mkdirp: true, mode: 0o600 });
    return await submission(ctx, 'submit', path);
  } catch (error) {
    if (error instanceof NativeWorkSourceError) throw commandRefusal(`Nothing was sent: ${error.message}`);
    throw error;
  }
}

/** Asking for work and its journal (builtin/work-intake.ts), over this program's host link, for one command context. */
export function workIntakeServices(ctx: CommandActionContext): NonNullable<WorkIntakeCapabilityServices['workIntake']> | undefined {
  if (!installed) return undefined;
  return {
    async request(goal) { await requestsOf().submit(ctx, goal); return ''; },
    newWork: (goal, criteria) => submitNewWork(ctx, goal, criteria),
    submitFile: (path) => submission(ctx, 'submit', unquote(path)),
    submission: (act) => submission(ctx, act, ''),
    async intake(act) { await intake(ctx, act); return ''; },
  };
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

// ---------------------------------------------------------------------------
// The lists a Work input chooses from
// ---------------------------------------------------------------------------

interface ListedWork {
  readonly id?: unknown; readonly title?: unknown; readonly state?: unknown;
  readonly run?: { readonly questions?: readonly { readonly id?: unknown; readonly question?: unknown }[]; readonly steps?: readonly { readonly id?: unknown; readonly title?: unknown; readonly status?: unknown }[] } | null;
  readonly plan?: { readonly steps?: readonly { readonly id?: unknown; readonly title?: unknown }[] } | null;
}
const text = (value: unknown): string => typeof value === 'string' ? value : '';

async function listedWork(ctx: CommandActionContext): Promise<readonly ListedWork[]> {
  if (!binding) return [];
  const answer = await runDaemonCapability('work.list', {}, ctx, binding);
  const works = (answer.data as { readonly works?: unknown } | undefined)?.works;
  return Array.isArray(works) ? works as ListedWork[] : [];
}

defineList<CommandActionContext>({
  name: WORK_ITEMS_LIST,
  async read(ctx) {
    return (await listedWork(ctx)).filter((work) => text(work.id)).map((work): ListRow => ({ value: text(work.id), label: text(work.title) || text(work.id), state: text(work.state).replace('-', ' ') }));
  },
  operator: { method: 'capabilities.run', input: { id: 'work.list' }, rows: { from: 'data.works', value: 'id', label: 'title', state: 'state' } },
});
defineList<CommandActionContext>({
  name: WORK_QUESTIONS_LIST,
  async read(ctx, earlier) {
    const work = (await listedWork(ctx)).find((entry) => text(entry.id) === earlier.work);
    return (work?.run?.questions ?? []).filter((entry) => text(entry.id)).map((entry): ListRow => ({ value: text(entry.id), label: text(entry.question) }));
  },
  operator: { method: 'capabilities.run', input: { id: 'work.list' }, rows: { from: 'data.works', where: { field: 'id', equals: '{work}' }, each: 'run.questions', value: 'id', label: 'question' } },
});
defineList<CommandActionContext>({
  name: WORK_STEPS_LIST,
  async read(ctx, earlier) {
    const work = (await listedWork(ctx)).find((entry) => text(entry.id) === earlier.work);
    // A running work's steps, else the steps of its plan waiting for you.
    const steps: readonly { readonly id?: unknown; readonly title?: unknown; readonly status?: unknown }[] = work?.run?.steps ?? work?.plan?.steps ?? [];
    return steps.filter((entry) => text(entry.id)).map((entry): ListRow => ({ value: text(entry.id), label: text(entry.title) || text(entry.id), ...(text(entry.status) ? { state: text(entry.status) } : {}) }));
  },
  operator: { method: 'capabilities.run', input: { id: 'work.list' }, rows: { from: 'data.works', where: { field: 'id', equals: '{work}' }, each: 'run.steps', value: 'id', label: 'title', state: 'status' } },
});
defineList<CommandActionContext>({
  name: CHECKLIST_ITEMS_LIST,
  async read(ctx) {
    const store = (ctx as CommandActionContext & ChecklistContext).workspace?.workPlan;
    if (!store) return [];
    return (await store.snapshot()).tasks.map((task): ListRow => ({
      value: task.taskId, label: task.title, state: checklistStateWords(task.status), ...(task.owner ? { detail: `for ${task.owner}` } : {}),
    }));
  },
  operator: { terminalOnly: 'The checklist is read by the program holding the conversation in its project.' },
});

// ---------------------------------------------------------------------------
// The description
// ---------------------------------------------------------------------------

type WorkAction = ActionDescription<CommandActionContext>;

/** Asking for work and its journal, run here through this program's link to the host. */
function onIntake(definition: CapabilityDefinition<WorkIntakeCapabilityServices>): WorkAction {
  return sessionCapabilityAction<CommandActionContext, WorkIntakeCapabilityServices>(definition, (ctx) => ({ workIntake: workIntakeServices(ctx) }),
    { terminalOnly: 'It runs through this program\'s link to the host, which keeps the journal that makes a resend safe.' });
}

/** A Work capability that runs on the daemon: through `capabilities.run`, as the person's own request. */
function onDaemon(definition: CapabilityDefinition<unknown>): WorkAction {
  return daemonCapabilityAction<CommandActionContext>(definition as CapabilityDefinition<never>, {
    daemon: (ctx) => { if (!binding) throw commandRefusal('Work is not available in this session.'); return binding.daemon(ctx); },
    caller: (ctx) => binding?.caller(ctx) ?? {},
  });
}

/** A task capability, run here on this program's tasks (and the daemon's through its methods). */
function onTasks(definition: CapabilityDefinition<TasksCapabilityServices>): WorkAction {
  return sessionCapabilityAction<CommandActionContext, TasksCapabilityServices>(definition, (ctx) => ({ tasks: tasksServices(ctx) }),
    { terminalOnly: 'Tasks are run by the program that started them; the daemon\'s are reached through it.' });
}

/** A checklist capability, run here on this program's view of the shared file. */
function onChecklist(definition: CapabilityDefinition<ChecklistCapabilityServices>): WorkAction {
  return sessionCapabilityAction<CommandActionContext, ChecklistCapabilityServices>(definition,
    (ctx) => ({ checklist: (ctx as CommandActionContext & ChecklistContext).workspace?.workPlan }),
    { terminalOnly: 'The checklist is kept by the program holding the conversation, in its project.' });
}

export const WORK_COMMAND: CommandDescription<CommandActionContext> = {
  name: 'work',
  // --yes confirms only right after the action word: the same word in the text is text.
  leadingFlagsOnly: true,
  title: 'Work',
  // Bare `/work` opens the Work place; every action is a control there.
  opens: 'work',
  summary: 'Your work: ask for it, start, check, stop or resume it, answer what it asks, run a failed step again, its spending limit, and the project\'s checklist',
  group: 'Agents and work',
  firstScreenRows: [
    'list', 'new', 'request',
    { label: 'Start, check, stop or resume work…', actions: ['start', 'status', 'cancel', 'resume'] },
    { label: 'Answer it, run a step again, its spending limit…', actions: ['answer', 'retry', 'budget'] },
    { label: 'A plan waiting for you…', actions: ['approve', 'step-edit', 'step-drop', 'step-move', 'plan-redo', 'plan-discard'] },
    { label: 'Tasks running in the background…', actions: TASKS_CAPABILITIES.map((definition) => definition.actionId) },
    { label: 'Submit work from a file…', actions: ['submit-file', 'submission', 'submission-retry', 'submission-discard'] },
    { label: 'Input waiting to be admitted…', actions: ['intake', 'intake-retry', 'intake-resume', 'intake-cancel'] },
    { label: 'The checklist…', actions: CHECKLIST_CAPABILITIES.map((definition) => definition.actionId) },
  ],
  actions: [
    ...WORK_METHOD_CAPABILITIES.map(onDaemon),
    ...WORK_INTAKE_CAPABILITIES.map(onIntake),
    ...CHECKLIST_CAPABILITIES.map(onChecklist),
    ...TASKS_CAPABILITIES.map(onTasks),
  ],
};

const WORK_SLASH_COMMAND = defineCommand(WORK_COMMAND);

/** Register `/work` (the one description) with this app's host and its way to the daemon. */
export function registerWorkCommand<Ctx extends CommandActionContext>(
  registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, host: WorkHost<Ctx>, daemon: DaemonCapabilityBinding<Ctx>,
): void {
  installed = host as unknown as WorkHost<CommandActionContext>;
  binding = daemon as unknown as DaemonCapabilityBinding<CommandActionContext>;
  registry.register(WORK_SLASH_COMMAND as never);
}
