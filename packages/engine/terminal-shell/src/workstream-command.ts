/**
 * The `/workstream` verbs both terminal apps share: list, inspect, stop and
 * answer contracts; run one unit again or raise a running contract's budget;
 * and the plan-review flow over workstream drafts (propose a plan, show it,
 * edit its items, approve and launch it as a contract). Each app adds its own
 * way to start work directly (`start`).
 */
import { isTerminalContractStatus } from '@goodvibes-jev/engine/platform/platform/contract/types';
import type { ContractOperatorService, ContractView } from '@goodvibes-jev/engine/platform/platform/contract';
import type { WorkstreamDraft, WorkstreamDraftService } from '@goodvibes-jev/engine/platform/platform/orchestration';
import { commandRefusal } from './command-confirmation.js';

export const WORKSTREAM_SHARED_USAGE = [
  'list | status <id> | cancel <id> | reply <id> <question-id> <answer>',
  'retry <id> <unit> | budget <id> <dollars>',
  'propose <goal> | drafts | show <draft> | retask <draft> <goal> | edit <draft> <item> <brief>',
  'drop <draft> <item> | move <draft> <item> <position> | approve <draft> | launch <draft> | discard <draft>',
].join(' | ');

/**
 * Where `/workstream`'s free text starts (a goal, a request, a brief, an
 * answer), so it reaches the plan as typed, quotes and spacing included.
 */
export function workstreamRawRest(args: readonly string[]): number | undefined {
  const action = args[0];
  if (action === 'start' || action === 'propose') return 1;
  if (action === 'retask') return 2;
  if (action === 'edit' || action === 'reply') return 3;
  return undefined;
}

export interface WorkstreamCommandDeps {
  readonly print: (text: string) => void;
  readonly sessionId: string;
  readonly contracts?: ContractOperatorService | undefined;
  readonly drafts?: WorkstreamDraftService | undefined;
}

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

/**
 * Runs one shared `/workstream` verb. True when `action` is one of them (it
 * printed its result or refusal); false for a verb the app handles itself.
 */
export async function runWorkstreamCommand(action: string, args: readonly string[], deps: WorkstreamCommandDeps): Promise<boolean> {
  const { print } = deps;
  if (['propose', 'drafts', 'show', 'retask', 'edit', 'drop', 'move', 'approve', 'launch', 'discard'].includes(action)) {
    const drafts = deps.drafts;
    if (!drafts) { print('Workstream plans are not available in this session.'); return true; }
    if (action === 'propose') {
      const goal = args.join(' ').trim();
      if (!goal) throw commandRefusal('Usage: /workstream propose <goal>');
      print('Planning the workstream; nothing runs until you approve and launch it.');
      print(renderWorkstreamDraft(await drafts.proposeDraft(goal)));
      return true;
    }
    if (action === 'drafts') {
      const all = drafts.listDrafts();
      print(all.length ? all.map(draft => `${draft.id}: ${draft.approved ? 'approved' : 'not approved'}, ${draft.spec.items.length} item${draft.spec.items.length === 1 ? '' : 's'} — ${draft.task}`).join('\n') : 'No workstream drafts. Start one with /workstream propose <goal>.');
      return true;
    }
    const draft = resolveDraft(drafts, args[0]);
    if (!draft) { print('Choose one exact or unambiguous draft ID from /workstream drafts.'); return true; }
    const edited = (result: WorkstreamDraft | { readonly error: string } | undefined): void => {
      if (result === undefined) print(`Draft ${draft.id} is no longer held.`);
      else if ('error' in result) print(result.error);
      else print(renderWorkstreamDraft(result));
    };
    switch (action) {
      case 'show': print(renderWorkstreamDraft(draft)); return true;
      case 'retask': {
        const goal = args.slice(1).join(' ').trim();
        if (!goal) throw commandRefusal('Usage: /workstream retask <draft> <goal>');
        print('Planning the workstream again from the new goal.');
        edited(await drafts.editDraft(draft.id, goal));
        return true;
      }
      case 'edit': {
        const brief = args.slice(2).join(' ').trim();
        if (!args[1] || !brief) throw commandRefusal('Usage: /workstream edit <draft> <item> <brief>');
        edited(drafts.editItem(draft.id, args[1], brief));
        return true;
      }
      case 'drop':
        if (!args[1]) throw commandRefusal('Usage: /workstream drop <draft> <item>');
        edited(drafts.removeItem(draft.id, args[1]));
        return true;
      case 'move': {
        const position = Number(args[2]);
        if (!args[1] || !Number.isInteger(position)) throw commandRefusal('Usage: /workstream move <draft> <item> <position>');
        edited(drafts.moveItem(draft.id, args[1], position));
        return true;
      }
      case 'approve': edited(drafts.approveDraft(draft.id)); return true;
      case 'discard':
        print(drafts.removeDraft(draft.id) ? `Discarded draft ${draft.id}.` : `Draft ${draft.id} is no longer held.`);
        return true;
      case 'launch': {
        if (!draft.approved) { print(`Draft ${draft.id} is not approved. Approve it with /workstream approve ${draft.id}, then launch it.`); return true; }
        const started = await drafts.launchDraft(draft.id);
        print(started === null
          ? `Draft ${draft.id} could not launch: it is no longer held or no longer approved.`
          : `Launched draft ${draft.id} as contract ${started.contractId}. Follow it with /workstream status ${started.contractId}.`);
        return true;
      }
    }
  }

  if (!['list', 'status', 'cancel', 'reply', 'retry', 'budget'].includes(action)) return false;
  const service = deps.contracts;
  if (!service) { print('Workstreams are not available in this session.'); return true; }
  if (action === 'list') {
    const records = service.list({ sessionId: deps.sessionId, includeTerminal: true });
    print(records.length ? records.map(record => `${record.id}: ${record.status} — ${record.ask}`).join('\n') : 'No workstreams in this session.');
    return true;
  }
  const contract = args[0] ? resolveWorkstreamContract(service, args[0], deps.sessionId) : null;
  if (!contract) { print('Choose one exact or unambiguous workstream ID from /workstream list.'); return true; }
  if (action === 'status') { print(renderContractStatus(contract)); return true; }
  if (action === 'cancel') {
    const stopped = service.cancel(contract.id, 'Stopped by the user from /workstream');
    print(stopped ? `Stopped workstream ${contract.id}.` : `Workstream ${contract.id} has already ended.`);
    return true;
  }
  if (action === 'retry') {
    if (!args[1]) throw commandRefusal(`Usage: /workstream retry <id> <unit>; units: ${contract.units.map(unit => `${unit.id} (${unit.status})`).join(', ') || 'none planned yet'}`);
    const outcome = await service.retryUnit(contract.id, args[1]);
    if (outcome.outcome === 'refused') throw commandRefusal(`Not retried: ${outcome.reason}.`);
    print(`${outcome.reason[0]!.toUpperCase()}${outcome.reason.slice(1)}.`);
    return true;
  }
  if (action === 'budget') {
    const dollars = Number(args[1]);
    if (!args[1] || !Number.isFinite(dollars) || dollars < 0) throw commandRefusal('Usage: /workstream budget <id> <dollars>');
    const { budget } = service.raiseBudget(contract.id, { ...contract.budget, maxCostUsd: dollars });
    print(`Workstream ${contract.id} budget is now ${budgetText(budget)}.`);
    const current = service.get(contract.id);
    if (current) print(renderContractStatus(current));
    return true;
  }
  const escalationId = args[1];
  const answer = args.slice(2).join(' ').trim();
  if (!escalationId || !answer) throw commandRefusal('Usage: /workstream reply <id> <question-id> <answer>');
  const asked = contract.escalations.find(entry => entry.id === escalationId && entry.resolvedAt === undefined);
  if (isTerminalContractStatus(contract.status) || asked === undefined) {
    print('That owner question is no longer open. Inspect /workstream status before answering.');
    return true;
  }
  const reply = await service.reply(contract.id, escalationId, answer);
  // A failed-turn question is answered retry or cancel; "amended" would say the requirement changed.
  print(`Owner reply: ${asked.failurePause === true ? (reply.action === 'stopped' ? 'cancelled' : 'retrying') : reply.action}.`);
  const current = service.get(contract.id);
  if (current) print(renderContractStatus(current));
  return true;
}
