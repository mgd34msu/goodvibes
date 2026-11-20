/**
 * `/workstream`, described once (command-actions/) for both terminal apps:
 * see, follow, stop and answer workstreams; run one step again or change a
 * running workstream's spending limit; and plan work before it runs (plan it,
 * see it, change its steps, approve and launch it). Each app says how a
 * request starts work directly (`start`).
 */
import { isTerminalContractStatus } from '@goodvibes-jev/engine/platform/platform/contract/types';
import type { ContractOperatorService, ContractView } from '@goodvibes-jev/engine/platform/platform/contract';
import type { WorkstreamDraft, WorkstreamDraftService } from '@goodvibes-jev/engine/platform/platform/orchestration';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext, CommandDescription, InputDescription } from './command-actions/types.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { listInput, readAction, textInput } from './described-command-kit.js';

/** IDs may be abbreviated only when they identify exactly one recorded contract. */
export function resolveWorkstreamContract(service: ContractOperatorService, reference: string, sessionId: string): ContractView | null {
  const records = service.list({ sessionId, includeTerminal: true });
  const exact = records.find(record => record.id === reference);
  if (exact) return exact;
  const matches = records.filter(record => record.id.startsWith(reference));
  return matches.length === 1 ? matches[0]! : null;
}

export function renderContractStatus(contract: ContractView): string {
  const lines = [`${contract.id}: ${contract.status}`, contract.ask];
  if (contract.statusLine) lines.push(contract.statusLine);
  if (contract.budget) lines.push(`Budget: ${budgetText(contract.budget)}`);
  if (contract.commit) lines.push(`Changes ${contract.commit.status}: ${contract.commit.note}`);
  for (const group of contract.groups) lines.push(`Group ${group.id}: ${group.status}`);
  for (const unit of contract.units) {
    lines.push(`Unit ${unit.id}: ${unit.status}`);
    for (const criterion of unit.criteria) lines.push(`  ${criterion.id}: ${criterion.text}`);
  }
  for (const escalation of contract.escalations) {
    if (escalation.resolvedAt === undefined) lines.push(`Owner question ${escalation.id}: ${escalation.question}`);
  }
  return lines.join('\n');
}

function budgetText(budget: { readonly maxCostUsd?: number | undefined; readonly maxTokens?: number | undefined }): string {
  return [budget.maxCostUsd === undefined ? '' : `$${budget.maxCostUsd}`, budget.maxTokens === undefined ? '' : `${budget.maxTokens} tokens`]
    .filter(Boolean).join(', ') || 'no ceiling';
}

/** A draft id, or an unambiguous prefix of one. */
function resolveDraft(drafts: WorkstreamDraftService, reference: string | undefined): WorkstreamDraft | null {
  if (!reference) return null;
  const all = drafts.listDrafts();
  const exact = all.find(draft => draft.id === reference);
  if (exact) return exact;
  const matches = all.filter(draft => draft.id.startsWith(reference));
  return matches.length === 1 ? matches[0]! : null;
}

export function renderWorkstreamDraft(draft: WorkstreamDraft): string {
  const provenance = draft.provenance;
  const how = provenance.kind === 'agent' ? 'split by a planning agent'
    : provenance.kind === 'heuristic-configured' ? 'kept as one item (planner.decomposition is heuristic)'
      : provenance.kind === 'gate-declined' ? 'kept as one item (the planner judged it one piece of work)'
        : `kept as one item${provenance.fallbackReason ? ` (${provenance.fallbackReason})` : ''}`;
  const lines = [
    `${draft.id}: ${draft.approved ? 'approved, ready to launch' : 'not approved'}${draft.journaled === false ? ' (held in memory only; it could not be saved)' : ''}`,
    draft.task,
    `Plan ${how}; isolation ${draft.spec.isolation ?? 'the contract default'}${draft.spec.budget ? `; budget ${budgetText(draft.spec.budget)}` : ''}.`,
  ];
  draft.spec.items.forEach((item, index) => {
    const extra = [
      item.dependsOn?.length ? `after ${item.dependsOn.join(', ')}` : '',
      item.attempts !== undefined && item.attempts > 1 ? `${item.attempts} attempts` : '',
      item.files?.length ? `files ${item.files.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    lines.push(`${index + 1}. [${item.id ?? `item-${index + 1}`}] ${item.title}${extra ? ` (${extra})` : ''}`);
    if (item.task !== item.title) lines.push(`   ${item.task}`);
  });
  lines.push(draft.approved
    ? `Launch it with /workstream launch ${draft.id}.`
    : `Edit it, then approve it with /workstream approve ${draft.id}.`);
  return lines.join('\n');
}


// ---------------------------------------------------------------------------
// The description
// ---------------------------------------------------------------------------

export interface WorkstreamCommandContext extends CommandActionContext {
  readonly renderRequest: () => void;
  readonly session: {
    readonly runtime: { readonly sessionId: string };
    readonly contractOperator?: ContractOperatorService | undefined;
    readonly workstreamDrafts?: WorkstreamDraftService | undefined;
  };
}

function contractsOf(ctx: WorkstreamCommandContext): ContractOperatorService {
  const service = ctx.session.contractOperator;
  if (!service) throw commandRefusal('Workstreams are not available in this session.');
  return service;
}
function draftsOf(ctx: WorkstreamCommandContext): WorkstreamDraftService {
  const drafts = ctx.session.workstreamDrafts;
  if (!drafts) throw commandRefusal('Workstream plans are not available in this session.');
  return drafts;
}
function contractFor(ctx: WorkstreamCommandContext, reference: string): ContractView {
  const contract = resolveWorkstreamContract(contractsOf(ctx), reference, ctx.session.runtime.sessionId);
  if (!contract) throw commandRefusal(`No workstream in this session matches ${reference}.`, '/workstream list shows them.');
  return contract;
}
function draftFor(ctx: WorkstreamCommandContext, reference: string): WorkstreamDraft {
  const draft = resolveDraft(draftsOf(ctx), reference);
  if (!draft) throw commandRefusal(`No plan matches ${reference}.`, '/workstream plans shows them.');
  return draft;
}
function edited(draft: WorkstreamDraft, result: WorkstreamDraft | { readonly error: string } | undefined): string {
  if (result === undefined) throw commandRefusal(`Plan ${draft.id} is no longer held.`);
  if ('error' in result) throw commandRefusal(result.error);
  return renderWorkstreamDraft(result);
}

const SESSION_ONLY = 'Workstreams belong to the terminal session that runs them.';

const WORKSTREAMS = defineList<WorkstreamCommandContext>({
  name: 'workstreams',
  async read(ctx) {
    const service = ctx.session.contractOperator;
    if (!service) return [];
    return service.list({ sessionId: ctx.session.runtime.sessionId, includeTerminal: true })
      .map((record): ListRow => ({ value: record.id, label: record.ask, state: record.status }));
  },
  operator: { terminalOnly: SESSION_ONLY },
});
const OPEN_QUESTIONS = defineList<WorkstreamCommandContext>({
  name: 'workstreams.questions',
  async read(ctx, earlier) {
    const service = ctx.session.contractOperator;
    const contract = service && earlier.workstream ? resolveWorkstreamContract(service, earlier.workstream, ctx.session.runtime.sessionId) : null;
    return (contract?.escalations ?? []).filter((entry) => entry.resolvedAt === undefined)
      .map((entry): ListRow => ({ value: entry.id, label: entry.question }));
  },
  operator: { terminalOnly: SESSION_ONLY },
});
const UNITS = defineList<WorkstreamCommandContext>({
  name: 'workstreams.steps',
  async read(ctx, earlier) {
    const service = ctx.session.contractOperator;
    const contract = service && earlier.workstream ? resolveWorkstreamContract(service, earlier.workstream, ctx.session.runtime.sessionId) : null;
    return (contract?.units ?? []).map((unit): ListRow => ({ value: unit.id, label: unit.id, state: unit.status }));
  },
  operator: { terminalOnly: SESSION_ONLY },
});
const PLANS = defineList<WorkstreamCommandContext>({
  name: 'workstreams.plans',
  async read(ctx) {
    return (ctx.session.workstreamDrafts?.listDrafts() ?? [])
      .map((draft): ListRow => ({ value: draft.id, label: draft.task, state: `${draft.approved ? 'approved' : 'not approved'}, ${draft.spec.items.length} step${draft.spec.items.length === 1 ? '' : 's'}` }));
  },
  operator: { terminalOnly: SESSION_ONLY },
});
const PLAN_STEPS = defineList<WorkstreamCommandContext>({
  name: 'workstreams.plan-steps',
  async read(ctx, earlier) {
    const drafts = ctx.session.workstreamDrafts;
    const draft = drafts && earlier.plan ? resolveDraft(drafts, earlier.plan) : null;
    return (draft?.spec.items ?? []).map((item, index): ListRow => ({ value: item.id ?? `item-${index + 1}`, label: item.title, detail: item.task !== item.title ? item.task : undefined }));
  },
  operator: { terminalOnly: SESSION_ONLY },
});

const WORKSTREAM: InputDescription = listInput({ id: 'workstream', label: 'Workstream', help: 'The workstreams of this session', list: WORKSTREAMS });
const PLAN: InputDescription = listInput({ id: 'plan', label: 'Plan', help: 'The plans you have made', list: PLANS });
const PLAN_STEP: InputDescription = listInput({ id: 'step', label: 'Step', help: 'The steps of this plan', list: PLAN_STEPS, position: 2, dependsOn: 'plan' });
const GOAL: InputDescription = textInput({ id: 'goal', label: 'Goal', help: 'What the work should achieve, in your own words', why: 'your own words', kind: 'long-text', typed: { tail: true } });

/** How a request starts work in this app: dispatched as a native turn (terminal app), or refused with the way it does start (Agent). */
export type StartWorkstream<Ctx> = (request: string, ctx: Ctx) => Promise<string | void>;

function workstreamDescription<Ctx extends WorkstreamCommandContext>(start: StartWorkstream<Ctx>): CommandDescription<Ctx> {
  return {
    name: 'workstream',
    // --yes confirms only right after the action word: the same word in the text is text.
    leadingFlagsOnly: true,
    title: 'Workstreams',
    summary: 'Plan, start, follow and steer work that runs in steps',
    group: 'Work',
    report: 'list',
    firstScreenRows: [
      'list', 'start', 'plan', 'plans', 'status',
      { label: 'Steer a running workstream', actions: ['answer', 'retry', 'budget', 'stop'] },
      { label: 'Change a plan before it runs', actions: ['show', 'replan', 'edit-step', 'drop-step', 'move-step', 'approve', 'launch', 'discard'] },
    ],
    actions: [
      readAction<Ctx>({
        id: 'list', label: 'See your workstreams', word: 'list',
        sentence: 'Shows every workstream of this session with its state.',
        async run(_values, ctx) {
          const records = contractsOf(ctx).list({ sessionId: ctx.session.runtime.sessionId, includeTerminal: true });
          return records.length ? records.map((record) => `${record.id}: ${record.status} — ${record.ask}`).join('\n') : 'No workstreams in this session. Plan one with /workstream plan <goal>.';
        },
      }),
      readAction<Ctx>({
        id: 'status', label: 'See how a workstream is going', word: 'status', inputs: [WORKSTREAM],
        sentence: 'Shows {workstream}\'s steps, their state, its spending limit and any question it is waiting on.',
        example: { workstream: 'c-4f9c21' },
        async run(values, ctx) { return renderContractStatus(contractFor(ctx, values.workstream!)); },
      }),
      {
        id: 'start', label: 'Start work on a request', word: 'start',
        inputs: [textInput({ id: 'request', label: 'Request', help: 'What to do, the way you would ask in the chat', why: 'your own words', kind: 'long-text', typed: { tail: true } })],
        sentence: 'Starts a workstream for "{request}" now; it runs in steps until it finishes or you stop it.',
        done: '', touches: 'this-machine', lasts: 'not-a-change', risk: 'none', undoneBy: 'stop',
        operator: { terminalOnly: 'A request starts from the terminal session that runs it.' },
        example: { request: 'add a dark mode toggle to settings' },
        async run(values, ctx) { return start(values.request!, ctx); },
      },
      {
        id: 'stop', label: 'Stop a workstream', word: 'stop', inputs: [WORKSTREAM],
        sentence: '{workstream} will stop; steps that are running are cancelled and it cannot be resumed.',
        done: '', touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
        operator: { terminalOnly: SESSION_ONLY }, example: { workstream: 'c-4f9c21' },
        async run(values, ctx) {
          const contract = contractFor(ctx, values.workstream!);
          const stopped = contractsOf(ctx).cancel(contract.id, 'Stopped by the user from /workstream');
          ctx.renderRequest();
          return stopped ? `Stopped workstream ${contract.id}.` : `Workstream ${contract.id} has already ended.`;
        },
      },
      {
        id: 'answer', label: 'Answer a workstream\'s question', word: 'answer',
        inputs: [
          WORKSTREAM,
          listInput({ id: 'question', label: 'Question', help: 'The questions it is waiting on', list: OPEN_QUESTIONS, position: 2, dependsOn: 'workstream' }),
          textInput({ id: 'answer', label: 'Answer', help: 'Your answer, in your own words (retry or cancel for a failed step)', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
        ],
        sentence: '{workstream} gets your answer to {question}: "{answer}". It goes on from there until you change it.',
        done: '', touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { method: 'contracts.reply', fields: { id: 'workstream', escalationId: 'question', text: 'answer' } },
        example: { workstream: 'c-4f9c21', question: 'esc-1', answer: 'yes, keep the old setting too' },
        async run(values, ctx) {
          const contract = contractFor(ctx, values.workstream!);
          const asked = contract.escalations.find((entry) => entry.id === values.question && entry.resolvedAt === undefined);
          if (isTerminalContractStatus(contract.status) || asked === undefined) throw commandRefusal('That question is no longer open.', `/workstream status ${contract.id} shows what it is waiting on.`);
          const reply = await contractsOf(ctx).reply(contract.id, asked.id, values.answer!);
          const current = contractsOf(ctx).get(contract.id);
          // A failed-step question is answered retry or cancel; "amended" would say the requirement changed.
          const read = asked.failurePause === true ? (reply.action === 'stopped' ? 'cancelled' : 'retrying') : reply.action;
          return [`Your answer was read as: ${read}.`, ...(current ? [renderContractStatus(current)] : [])].join('\n');
        },
      },
      {
        id: 'retry', label: 'Run a step of a workstream again', word: 'retry',
        inputs: [WORKSTREAM, listInput({ id: 'step', label: 'Step', help: 'The steps of this workstream', list: UNITS, position: 2, dependsOn: 'workstream' })],
        sentence: 'Step {step} of {workstream} runs again now.',
        done: '', touches: 'this-machine', lasts: 'not-a-change', risk: 'none',
        operator: { method: 'contracts.retryUnit', fields: { id: 'workstream', unitId: 'step' } },
        example: { workstream: 'c-4f9c21', step: 'u-2' },
        async run(values, ctx) {
          const contract = contractFor(ctx, values.workstream!);
          const outcome = await contractsOf(ctx).retryUnit(contract.id, values.step!);
          if (outcome.outcome === 'refused') throw commandRefusal(`Not run again: ${outcome.reason}.`);
          return `${outcome.reason[0]!.toUpperCase()}${outcome.reason.slice(1)}.`;
        },
      },
      {
        id: 'budget', label: 'Change a workstream\'s spending limit', word: 'budget',
        inputs: [WORKSTREAM, { id: 'dollars', label: 'Most it may spend', help: 'In US dollars, for the whole workstream', kind: 'money', freeTextReason: 'an amount', required: true, typed: { position: 2 } }],
        sentence: '{workstream} may spend up to ${dollars} in all, until you change it.',
        done: '', touches: 'this-machine', lasts: 'kept', risk: 'spends-money',
        operator: { method: 'contracts.budget', fields: { id: 'workstream', maxCostUsd: 'dollars' } },
        example: { workstream: 'c-4f9c21', dollars: '5' },
        async run(values, ctx) {
          const dollars = Number(values.dollars);
          if (!Number.isFinite(dollars) || dollars < 0) throw commandRefusal(`"${values.dollars}" is not an amount in dollars.`);
          const contract = contractFor(ctx, values.workstream!);
          const { budget } = contractsOf(ctx).raiseBudget(contract.id, { ...contract.budget, maxCostUsd: dollars });
          const current = contractsOf(ctx).get(contract.id);
          return [`Workstream ${contract.id}'s limit is now ${budgetText(budget)}.`, ...(current ? [renderContractStatus(current)] : [])].join('\n');
        },
      },
      {
        id: 'plan', label: 'Plan work before it runs', word: 'plan', inputs: [GOAL],
        sentence: 'A plan for "{goal}" is made and kept until you change it; nothing runs until you approve and launch it.',
        done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'discard',
        operator: { terminalOnly: SESSION_ONLY }, example: { goal: 'move the settings page to the new layout' },
        async run(values, ctx) {
          ctx.print('Planning the workstream; nothing runs until you approve and launch it.');
          return renderWorkstreamDraft(await draftsOf(ctx).proposeDraft(values.goal!));
        },
      },
      readAction<Ctx>({
        id: 'plans', label: 'See your plans', word: 'plans',
        sentence: 'Shows every plan, whether it is approved, and how many steps it has.',
        async run(_values, ctx) {
          const all = draftsOf(ctx).listDrafts();
          return all.length ? all.map((draft) => `${draft.id}: ${draft.approved ? 'approved' : 'not approved'}, ${draft.spec.items.length} step${draft.spec.items.length === 1 ? '' : 's'} — ${draft.task}`).join('\n') : 'No plans. Make one with /workstream plan <goal>.';
        },
      }),
      readAction<Ctx>({
        id: 'show', label: 'See a plan', word: 'show', inputs: [PLAN],
        sentence: 'Shows {plan}\'s steps and how it was split.', example: { plan: 'd-7b21' },
        async run(values, ctx) { return renderWorkstreamDraft(draftFor(ctx, values.plan!)); },
      }),
      {
        id: 'replan', label: 'Plan again from a new goal', word: 'replan', inputs: [PLAN, { ...GOAL, label: 'New goal' }],
        sentence: '{plan} is planned again from "{goal}", replacing its steps, until you change it.',
        done: '', touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { terminalOnly: SESSION_ONLY }, example: { plan: 'd-7b21', goal: 'only the settings page, not the profile page' },
        async run(values, ctx) {
          const draft = draftFor(ctx, values.plan!);
          ctx.print('Planning the workstream again from the new goal.');
          return edited(draft, await draftsOf(ctx).editDraft(draft.id, values.goal!));
        },
      },
      {
        id: 'edit-step', label: 'Change a step of a plan', word: 'edit',
        inputs: [PLAN, PLAN_STEP, textInput({ id: 'brief', label: 'What the step does', help: 'The step\'s new brief', why: 'your own words', kind: 'long-text', typed: { tail: true } })],
        sentence: 'Step {step} of {plan} will do "{brief}", until you change it.',
        done: '', touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { terminalOnly: SESSION_ONLY }, example: { plan: 'd-7b21', step: 'item-2', brief: 'update the tests for the new layout' },
        async run(values, ctx) {
          const draft = draftFor(ctx, values.plan!);
          return edited(draft, draftsOf(ctx).editItem(draft.id, values.step!, values.brief!));
        },
      },
      {
        id: 'drop-step', label: 'Take a step out of a plan', word: 'drop', inputs: [PLAN, PLAN_STEP],
        sentence: 'Step {step} is taken out of {plan}, until you change it.',
        done: '', touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { terminalOnly: SESSION_ONLY }, example: { plan: 'd-7b21', step: 'item-3' },
        async run(values, ctx) {
          const draft = draftFor(ctx, values.plan!);
          return edited(draft, draftsOf(ctx).removeItem(draft.id, values.step!));
        },
      },
      {
        id: 'move-step', label: 'Move a step of a plan', word: 'move',
        inputs: [PLAN, PLAN_STEP, { id: 'position', label: 'New position', help: 'Its place in the plan, counting from 1', kind: 'number', freeTextReason: 'a position number', required: true, typed: { flag: '--to' } }],
        sentence: 'Step {step} of {plan} moves to position {position}, until you change it.',
        done: '', touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { terminalOnly: SESSION_ONLY }, example: { plan: 'd-7b21', step: 'item-3', position: '1' },
        async run(values, ctx) {
          const position = Number(values.position);
          if (!Number.isInteger(position)) throw commandRefusal(`"${values.position}" is not a position number.`);
          const draft = draftFor(ctx, values.plan!);
          return edited(draft, draftsOf(ctx).moveItem(draft.id, values.step!, position));
        },
      },
      {
        id: 'approve', label: 'Approve a plan', word: 'approve', inputs: [PLAN],
        sentence: '{plan} is marked approved, ready to launch, until you change it.',
        done: '', touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { terminalOnly: SESSION_ONLY }, example: { plan: 'd-7b21' },
        async run(values, ctx) {
          const draft = draftFor(ctx, values.plan!);
          return edited(draft, draftsOf(ctx).approveDraft(draft.id));
        },
      },
      {
        id: 'launch', label: 'Launch an approved plan', word: 'launch', inputs: [PLAN],
        sentence: '{plan} starts now as a workstream; it runs in steps until it finishes or you stop it.',
        done: '', touches: 'this-machine', lasts: 'not-a-change', risk: 'none', undoneBy: 'stop',
        operator: { terminalOnly: SESSION_ONLY }, example: { plan: 'd-7b21' },
        async run(values, ctx) {
          const draft = draftFor(ctx, values.plan!);
          if (!draft.approved) throw commandRefusal(`Plan ${draft.id} is not approved.`, `Approve it with /workstream approve ${draft.id}, then launch it.`);
          const started = await draftsOf(ctx).launchDraft(draft.id);
          if (started === null) throw commandRefusal(`Plan ${draft.id} could not launch: it is no longer held or no longer approved.`);
          ctx.renderRequest();
          return `Launched plan ${draft.id} as workstream ${started.contractId}. Follow it with /workstream status ${started.contractId}.`;
        },
      },
      {
        id: 'discard', label: 'Throw a plan away', word: 'discard', inputs: [PLAN],
        sentence: '{plan} and its steps are deleted.',
        done: '', touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
        operator: { terminalOnly: SESSION_ONLY }, example: { plan: 'd-7b21' },
        async run(values, ctx) {
          const draft = draftFor(ctx, values.plan!);
          if (!draftsOf(ctx).removeDraft(draft.id)) throw commandRefusal(`Plan ${draft.id} is no longer held.`);
          return `Discarded plan ${draft.id}.`;
        },
      },
    ],
  };
}

/** Register `/workstream` (the one description) with how this app starts work from a request. */
export function registerWorkstreamCommand<Ctx extends WorkstreamCommandContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, start: StartWorkstream<Ctx>): void {
  registry.register(defineCommand(workstreamDescription(start)));
}

