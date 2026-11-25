/**
 * The checklist: the project's running list of things to do that the model
 * keeps while it works, and a person adds to, marks and clears. It is the
 * model's own list: these capabilities are not the owner's alone, a model
 * runs them with nothing asked, and they write the same store, through the
 * same ProjectWorkPlan, as the model's work_plan and agent_work_plan tools
 * (one path to one store). It is one shared file every program reads (the terminal app,
 * the Agent and the daemon keep one list per project), and it belongs to the
 * project the conversation is in, so these run in the program holding the
 * conversation (home `session`), on that program's own view of the file.
 * Nothing on it runs by itself. It is called a checklist, never a plan: a
 * piece of work has its plan.
 */
import type { ProjectWorkPlan } from '../../knowledge/project-planning/work-plan.js';
import { summarizeWorkPlanCounts, summarizeWorkPlanEdit } from '../../knowledge/project-planning/work-plan.js';
import type { ProjectWorkPlanMutationResult, ProjectWorkPlanTaskStatus } from '../../knowledge/project-planning/types.js';
import { CapabilityRefusal, type CapabilityDefinition, type FixedChoice, type InputDescription, type ListName } from '../types.js';

/** What the checklist capabilities need: the project's checklist as the program holding the conversation reads it. */
export interface ChecklistCapabilityServices {
  readonly checklist?: Pick<ProjectWorkPlan, 'snapshot' | 'add' | 'update' | 'setStatus' | 'cycle' | 'remove' | 'clearCompleted' | 'toMarkdown' | 'exportMarkdown'> | null | undefined;
}

/** The items on the checklist (the list is registered in terminal-shell, native/work-command.ts). */
export const CHECKLIST_ITEMS_LIST = 'work.checklist' as ListName;

const STATES: readonly FixedChoice[] = [
  { value: 'pending', label: 'Not started' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];
const STATE_WORDS = new Map(STATES.map((state) => [state.value, state.label.toLowerCase()]));
export const checklistStateWords = (status: string): string => STATE_WORDS.get(status) ?? status;

/** What an edit with an owner, notes or source of this mark does: clears that detail; empty leaves it. */
const CLEARS = '-';

const ITEM: InputDescription = {
  id: 'item', label: 'Item', help: 'The items on the checklist', kind: 'choice', choices: { list: CHECKLIST_ITEMS_LIST }, required: true, typed: { position: 1 },
};
const OWNER: InputDescription = { id: 'owner', label: 'For whom', help: 'Who the item is for', kind: 'text', freeTextReason: 'a name you choose', required: { default: '', defaultMeans: 'nobody in particular' }, typed: { flag: '--owner' } };
const NOTES: InputDescription = { id: 'notes', label: 'Notes', help: 'Anything to remember about it', kind: 'long-text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'no notes' }, typed: { flag: '--notes' } };
const SOURCE: InputDescription = { id: 'source', label: 'Where it came from', help: 'A short label for where the item came from', kind: 'text', freeTextReason: 'a label you choose', required: { default: '', defaultMeans: 'added by hand' }, typed: { flag: '--source' } };

function storeOf(services: ChecklistCapabilityServices): NonNullable<ChecklistCapabilityServices['checklist']> {
  if (!services.checklist) throw new CapabilityRefusal('There is no checklist here: this conversation has no project.');
  return services.checklist;
}

const counted = (result: Pick<ProjectWorkPlanMutationResult, 'counts' | 'reclaimedTaskIds'>): string => ` Checklist: ${summarizeWorkPlanEdit(result)}.`;

type Checklist = CapabilityDefinition<ChecklistCapabilityServices>;

export const CHECKLIST_SHOW: Checklist = {
  capability: { id: 'work.checklist', group: 'work', home: 'session', repeat: 'safe' },
  actionId: 'checklist', label: 'See the checklist', word: 'checklist', inputs: [],
  sentence: 'Shows every item on this project\'s checklist (the things to do the model and you keep) with where each stands.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const plan = await storeOf(services).snapshot();
    const items = plan.tasks.map((task) => ({ id: task.taskId, title: task.title, state: task.status, ...(task.owner ? { owner: task.owner } : {}), ...(task.notes ? { notes: task.notes } : {}) }));
    if (plan.tasks.length === 0) return { text: 'The checklist is empty.', data: { items } };
    return {
      text: [`Checklist (${summarizeWorkPlanCounts(plan.counts)})`,
        ...plan.tasks.map((task) => `  ${task.taskId}  ${checklistStateWords(task.status).padEnd(11)} ${task.title}${task.owner ? ` for ${task.owner}` : ''}`)].join('\n'),
      data: { items },
    };
  },
};

export const CHECKLIST_MARKDOWN: Checklist = {
  capability: { id: 'work.checklist-markdown', group: 'work', home: 'session', repeat: 'safe' },
  actionId: 'checklist-markdown', label: 'See the checklist as Markdown', word: 'checklist-markdown', inputs: [],
  sentence: 'Shows this project\'s checklist as a Markdown checklist.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) { const store = storeOf(services); return { text: store.toMarkdown(await store.snapshot()) }; },
};

export const CHECKLIST_EXPORT: Checklist = {
  capability: { id: 'work.checklist-export', group: 'work', home: 'session', repeat: 'safe' },
  actionId: 'checklist-export', label: 'Save the checklist as a Markdown file', word: 'checklist-export', inputs: [],
  sentence: 'Writes this project\'s checklist as a Markdown file in your GoodVibes folder and says where.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: {},
  async run(_values, services) { const { path } = await storeOf(services).exportMarkdown(); return { text: `Saved the checklist to ${path}.`, data: { path } }; },
};

export const CHECKLIST_ADD: Checklist = {
  capability: { id: 'work.checklist-add', group: 'work', home: 'session', repeat: 'unsafe' },
  ownWorkingState: true,
  actionId: 'checklist-add', label: 'Put an item on the checklist', word: 'checklist-add',
  inputs: [{ id: 'title', label: 'Title', help: 'What there is to do', kind: 'text', freeTextReason: 'your own words', required: true, typed: { tail: true } }, OWNER, NOTES, SOURCE],
  sentence: '"{title}" is put on the checklist (your to-do list of things to do in this project) as a new item, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'checklist-remove',
  example: { title: 'write the release notes', owner: 'sam' },
  async run(values, services) {
    const added = await storeOf(services).add(values.title!, {
      ...(values.owner ? { owner: values.owner } : {}),
      source: values.source || 'manual',
      ...(values.notes ? { notes: values.notes } : {}),
    });
    return { text: `Added "${added.task.title}".${counted(added)}`, data: { item: added.task.taskId } };
  },
};

export const CHECKLIST_EDIT: Checklist = {
  capability: { id: 'work.checklist-edit', group: 'work', home: 'session', repeat: 'safe' },
  ownWorkingState: true,
  actionId: 'checklist-edit', label: 'Change a checklist item', word: 'checklist-edit',
  inputs: [
    ITEM,
    { id: 'title', label: 'Title', help: 'What there is to do (change it or keep it)', kind: 'text', freeTextReason: 'your own words', required: true, typed: { tail: true } },
    { ...OWNER, help: `${OWNER.help}; ${CLEARS} clears it`, required: { default: '', defaultMeans: `stays as it is; ${CLEARS} clears it` } },
    { ...NOTES, help: `${NOTES.help}; ${CLEARS} clears them`, required: { default: '', defaultMeans: `stay as they are; ${CLEARS} clears them` } },
    { ...SOURCE, help: `${SOURCE.help}; ${CLEARS} clears it`, required: { default: '', defaultMeans: `stays as it is; ${CLEARS} clears it` } },
  ],
  sentence: 'Item {item} becomes "{title}", with the other details you gave, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none',
  example: { item: 't-3f2a', title: 'write and post the release notes' },
  async run(values, services) {
    // Empty keeps a detail; the clear mark removes it (null is stored as cleared).
    const detail = (value: string | undefined): string | null | undefined => value === undefined || value === '' ? undefined : value.trim() === CLEARS ? null : value;
    const owner = detail(values.owner), source = detail(values.source), notes = detail(values.notes);
    const { task } = await storeOf(services).update(values.item!, {
      title: values.title!, ...(owner !== undefined ? { owner } : {}), ...(source !== undefined ? { source } : {}), ...(notes !== undefined ? { notes } : {}),
    });
    return { text: `Changed "${task.title}".`, data: { item: task.taskId } };
  },
};

export const CHECKLIST_MARK: Checklist = {
  capability: { id: 'work.checklist-mark', group: 'work', home: 'session', repeat: 'safe' },
  ownWorkingState: true,
  actionId: 'checklist-mark', label: 'Mark a checklist item done, blocked or another state', word: 'checklist-mark',
  inputs: [ITEM, { id: 'state', label: 'State', help: 'Where the item stands', kind: 'choice', choices: STATES, required: true, typed: { position: 2 } }],
  sentence: 'Item {item} is marked {state} until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none',
  example: { item: 't-3f2a', state: 'done' },
  async run(values, services) {
    const updated = await storeOf(services).setStatus(values.item!, values.state as ProjectWorkPlanTaskStatus);
    return { text: `"${updated.task.title}" is ${checklistStateWords(updated.task.status)}.${counted(updated)}`, data: { item: updated.task.taskId, state: updated.task.status } };
  },
};

export const CHECKLIST_NEXT: Checklist = {
  capability: { id: 'work.checklist-next', group: 'work', home: 'session', repeat: 'unsafe' },
  ownWorkingState: true,
  actionId: 'checklist-next', label: 'Move a checklist item to its next state', word: 'checklist-next', inputs: [ITEM],
  sentence: 'Item {item} moves on one state (not started, in progress, done, then back to not started) until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none',
  example: { item: 't-3f2a' },
  async run(values, services) {
    const cycled = await storeOf(services).cycle(values.item!);
    return { text: `"${cycled.task.title}" is ${checklistStateWords(cycled.task.status)}.${counted(cycled)}`, data: { item: cycled.task.taskId, state: cycled.task.status } };
  },
};

export const CHECKLIST_REMOVE: Checklist = {
  capability: { id: 'work.checklist-remove', group: 'work', home: 'session', repeat: 'safe' },
  ownWorkingState: true,
  actionId: 'checklist-remove', label: 'Take an item off the checklist', word: 'checklist-remove', inputs: [ITEM],
  sentence: 'Item {item} is deleted from the checklist.', done: '',
  // An item of the model's own running list: taken off with nothing asked, as the model's work_plan tool takes one off.
  touches: 'this-machine', lasts: 'kept', risk: 'none',
  example: { item: 't-3f2a' },
  async run(values, services) {
    const removed = await storeOf(services).remove(values.item!);
    return { text: `Removed "${removed.deletedTask.title}".${counted(removed)}`, data: { item: removed.deletedTask.taskId } };
  },
};

export const CHECKLIST_CLEAR_DONE: Checklist = {
  capability: { id: 'work.checklist-clear-done', group: 'work', home: 'session', repeat: 'safe' },
  ownWorkingState: true,
  actionId: 'checklist-clear-done', label: 'Clear the finished checklist items', word: 'checklist-clear-done', inputs: [],
  sentence: 'Every checklist item that is done or cancelled is deleted.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: {},
  async run(_values, services) {
    const result = await storeOf(services).clearCompleted();
    const count = result.clearedTaskIds?.length ?? 0;
    return { text: `Removed ${count} finished item${count === 1 ? '' : 's'}.${count > 0 ? counted(result) : ''}`, data: { removed: count } };
  },
};

/** Every checklist capability, in the order the Work place and the typed line show them. */
export const CHECKLIST_CAPABILITIES: readonly Checklist[] = [
  CHECKLIST_SHOW, CHECKLIST_MARKDOWN, CHECKLIST_EXPORT, CHECKLIST_ADD, CHECKLIST_EDIT, CHECKLIST_MARK, CHECKLIST_NEXT, CHECKLIST_REMOVE, CHECKLIST_CLEAR_DONE,
];
