/**
 * `/todo`, described once (command-actions/) for both terminal apps: the
 * project's to-do list (the work plan kept for this project). Items are added,
 * changed, marked and removed here; nothing on it runs by itself.
 */
import { summarizeWorkPlanCounts, summarizeWorkPlanEdit, type ProjectWorkPlan, type ProjectWorkPlanMutationResult } from '@goodvibes/engine/platform/platform/knowledge';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionDescription, CommandActionContext, CommandDescription, FixedChoice, InputDescription } from './command-actions/types.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { doAction, listInput, readAction, textInput } from './described-command-kit.js';

export interface TodoCommandContext extends CommandActionContext {
  readonly workspace: { readonly workPlan?: ProjectWorkPlan | null | undefined };
}

function storeOf(ctx: TodoCommandContext): ProjectWorkPlan {
  const store = ctx.workspace.workPlan;
  if (!store) throw commandRefusal('The to-do list is not available here: this session has no project.');
  return store;
}

/** The plan line an edit prints: counted in the edit's own transaction, with any finished items it removed. */
function planLine(result: Pick<ProjectWorkPlanMutationResult, 'counts' | 'reclaimedTaskIds'>): string {
  return ` List: ${summarizeWorkPlanEdit(result)}.`;
}

const STATES: readonly FixedChoice[] = [
  { value: 'pending', label: 'Not started' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];
const STATE_LABEL = new Map(STATES.map((state) => [state.value, state.label.toLowerCase()]));

const TODO_ITEMS = defineList<TodoCommandContext>({
  name: 'todo.items',
  async read(ctx) {
    const store = ctx.workspace.workPlan;
    if (!store) return [];
    return (await store.snapshot()).tasks.map((task): ListRow => ({
      value: task.taskId, label: task.title, state: STATE_LABEL.get(task.status) ?? task.status,
      ...(task.owner ? { detail: `for ${task.owner}` } : {}),
    }));
  },
  operator: { terminalOnly: 'The to-do list is this project\'s, kept by the terminal app that has the project open.' },
});

const ITEM: InputDescription = listInput({ id: 'item', label: 'Item', help: 'The items on your to-do list', list: TODO_ITEMS });
const OWNER: InputDescription = textInput({ id: 'owner', label: 'For whom', help: 'Who the item is for', why: 'a name you choose', typed: { flag: '--owner' }, optional: { default: '', means: 'nobody in particular' } });
const NOTES: InputDescription = textInput({ id: 'notes', label: 'Notes', help: 'Anything to remember about it', why: 'your own words', kind: 'long-text', typed: { flag: '--notes' }, optional: { default: '', means: 'no notes' } });
const SOURCE: InputDescription = textInput({ id: 'source', label: 'Where it came from', help: 'A short label for where the item came from', why: 'a label you choose', typed: { flag: '--source' }, optional: { default: '', means: 'added by hand' } });
/** What `/todo edit` takes for owner, notes or source to clear that detail; empty leaves it as it is. */
const CLEARS = '-';
const OWNER_ONLY = { reason: 'the to-do list is yours to change from the command line', instead: 'The model keeps its own plan with its work_plan tool.' } as const;

function change<Ctx>(fields: Omit<ActionDescription<Ctx>, 'touches' | 'lasts' | 'done' | 'ownerOnly' | 'operator'> & Partial<Pick<ActionDescription<Ctx>, 'done'>>): ActionDescription<Ctx> {
  return { done: '', ...fields, touches: 'this-machine', lasts: 'kept', ownerOnly: OWNER_ONLY, operator: { terminalOnly: 'The to-do list is this project\'s, kept by the terminal app that has the project open.' } };
}

function todoDescription<Ctx extends TodoCommandContext>(openPanel: (ctx: Ctx) => void): CommandDescription<Ctx> {
  return {
    name: 'todo',
    // --yes confirms only right after the action word: the same word in the text is text.
    leadingFlagsOnly: true,
    title: 'To-do list',
    summary: 'Keep this project\'s to-do list',
    group: 'Work',
    report: 'list',
    actions: [
      readAction<Ctx>({
        id: 'list', label: 'See your to-do list', word: 'list',
        sentence: 'Shows every item on the to-do list with its state.',
        async rowValue(ctx) {
          const store = ctx.workspace.workPlan;
          if (!store) return '';
          const plan = await store.snapshot();
          return plan.tasks.length === 0 ? 'empty' : summarizeWorkPlanCounts(plan.counts);
        },
        async run(_values, ctx) {
          const plan = await storeOf(ctx).snapshot();
          if (plan.tasks.length === 0) return 'Your to-do list is empty. Add one with /todo add <title>.';
          return [
            `To-do list (${summarizeWorkPlanCounts(plan.counts)})`,
            ...plan.tasks.map((item) => `  ${item.taskId}  ${(STATE_LABEL.get(item.status) ?? item.status).padEnd(11)} ${item.title}${item.owner ? ` @${item.owner}` : ''}`),
          ].join('\n');
        },
      }),
      doAction<Ctx>({
        id: 'open', label: 'Open the to-do panel', word: 'open', touches: 'reads',
        sentence: 'Opens the to-do list as a panel you can move through with the keys.',
        operator: { terminalOnly: 'It is a terminal screen.' },
        async run(_values, ctx) { storeOf(ctx); openPanel(ctx); },
      }),
      readAction<Ctx>({
        id: 'markdown', label: 'See it as a Markdown checklist', word: 'markdown',
        sentence: 'Shows the to-do list as a Markdown checklist.',
        async run(_values, ctx) { const store = storeOf(ctx); return store.toMarkdown(await store.snapshot()); },
      }),
      doAction<Ctx>({
        id: 'export', label: 'Save it as a Markdown file', word: 'export',
        sentence: 'Writes the to-do list as a Markdown checklist into this project and says where.',
        operator: { terminalOnly: 'The file is written in this project.' },
        async run(_values, ctx) { const { path } = await storeOf(ctx).exportMarkdown(); return `Saved the to-do list to ${path}.`; },
      }),
      change<Ctx>({
        id: 'add', label: 'Add an item', word: 'add',
        inputs: [textInput({ id: 'title', label: 'Title', help: 'What there is to do', why: 'your own words', typed: { tail: true } }), OWNER, NOTES, SOURCE],
        sentence: '"{title}" is added to your to-do list until you change it.',
        risk: 'none', undoneBy: 'remove',
        example: { title: 'write the release notes', owner: 'sam' },
        async run(values, ctx) {
          const added = await storeOf(ctx).add(values.title!, {
            ...(values.owner ? { owner: values.owner } : {}),
            source: values.source || 'manual',
            ...(values.notes ? { notes: values.notes } : {}),
          });
          return `Added item ${added.task.taskId}.${planLine(added)}`;
        },
      }),
      change<Ctx>({
        id: 'edit', label: 'Change an item', word: 'edit',
        inputs: [
          ITEM,
          textInput({ id: 'title', label: 'Title', help: 'What there is to do (change it or keep it)', why: 'your own words', typed: { tail: true } }),
          { ...OWNER, help: `${OWNER.help}; ${CLEARS} clears it`, required: { default: '', defaultMeans: `stays as it is; ${CLEARS} clears it` } },
          { ...NOTES, help: `${NOTES.help}; ${CLEARS} clears them`, required: { default: '', defaultMeans: `stay as they are; ${CLEARS} clears them` } },
          { ...SOURCE, help: `${SOURCE.help}; ${CLEARS} clears it`, required: { default: '', defaultMeans: `stays as it is; ${CLEARS} clears it` } },
        ],
        sentence: 'Item {item} becomes "{title}", with the other details you gave, until you change it.',
        risk: 'none',
        example: { item: 't-3f2a', title: 'write and post the release notes' },
        async run(values, ctx) {
          // Empty keeps a detail; the clear mark removes it (null is stored as cleared).
          const detail = (value: string | undefined): string | null | undefined =>
            value === undefined || value === '' ? undefined : value.trim() === CLEARS ? null : value;
          const owner = detail(values.owner), source = detail(values.source), notes = detail(values.notes);
          const patch = {
            title: values.title!,
            ...(owner !== undefined ? { owner } : {}),
            ...(source !== undefined ? { source } : {}),
            ...(notes !== undefined ? { notes } : {}),
          };
          const { task } = await storeOf(ctx).update(values.item!, patch);
          return `Changed item ${task.taskId}: ${task.title}`;
        },
      }),
      change<Ctx>({
        id: 'mark', label: 'Mark an item done, blocked or another state', word: 'mark',
        inputs: [ITEM, { id: 'state', label: 'State', help: 'Where the item stands', kind: 'choice', choices: STATES, required: true, typed: { position: 2 } }],
        sentence: 'Item {item} is marked {state} until you change it.',
        risk: 'none',
        example: { item: 't-3f2a', state: 'done' },
        async run(values, ctx) {
          const updated = await storeOf(ctx).setStatus(values.item!, values.state as Parameters<ProjectWorkPlan['setStatus']>[1]);
          return `Item ${updated.task.taskId} is ${STATE_LABEL.get(updated.task.status) ?? updated.task.status}.${planLine(updated)}`;
        },
      }),
      change<Ctx>({
        id: 'next', label: 'Move an item to its next state', word: 'next', inputs: [ITEM],
        sentence: 'Item {item} moves on one state (not started, in progress, done, then back to not started) until you change it.',
        risk: 'none',
        example: { item: 't-3f2a' },
        async run(values, ctx) {
          const cycled = await storeOf(ctx).cycle(values.item!);
          return `Item ${cycled.task.taskId} is ${STATE_LABEL.get(cycled.task.status) ?? cycled.task.status}.${planLine(cycled)}`;
        },
      }),
      change<Ctx>({
        id: 'remove', label: 'Remove an item', word: 'remove', inputs: [ITEM],
        sentence: 'Item {item} is deleted from your to-do list.',
        risk: 'cannot-be-undone',
        example: { item: 't-3f2a' },
        async run(values, ctx) {
          const removed = await storeOf(ctx).remove(values.item!);
          return `Removed item ${removed.deletedTask.taskId}: ${removed.deletedTask.title}.${planLine(removed)}`;
        },
      }),
      change<Ctx>({
        id: 'clear-done', label: 'Remove the finished items', word: 'clear-done',
        sentence: 'Every item that is done or cancelled is deleted from your to-do list.',
        risk: 'cannot-be-undone', example: {}, inputs: [],
        async run(_values, ctx) {
          const result = await storeOf(ctx).clearCompleted();
          const count = result.clearedTaskIds?.length ?? 0;
          return `Removed ${count} finished item${count === 1 ? '' : 's'}.${count > 0 ? planLine(result) : ''}`;
        },
      }),
    ],
  };
}

/** Register `/todo` (the one description); `openPanel` opens this app's to-do panel, or refuses where it has none. */
export function registerTodoCommand<Ctx extends TodoCommandContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, openPanel: (ctx: Ctx) => void): void {
  registry.register(defineCommand(todoDescription(openPanel)));
}
