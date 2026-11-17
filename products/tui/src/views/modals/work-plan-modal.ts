import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalView,
} from '../../input/config-modal-types.ts';
import type { ProjectWorkPlan, ProjectWorkPlanTask, ProjectWorkPlanTaskStatus } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { runModalCommand } from './modal-surface-helpers.ts';
import { contractNodeId } from '@goodvibes-jev/engine/platform/platform/runtime/fleet';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { formatRefusal, readRefusal } from '@goodvibes-jev/engine/errors';

// ---------------------------------------------------------------------------
// Work Plan modal. Lists the project work plan's tasks (the planning service's
// rows, the same plan the work_plan tool and the operator methods keep) with a
// progress summary and status counts. Every change runs through the
// `/work-plan` command. Status changes, delete and clear keep the modal open;
// add and edit close it and leave the command in the composer to finish
// (`/work-plan add `, `/work-plan edit <id> <title>`), and export closes it so
// the written path is visible. Owner, source, notes and links are folded into
// each row label.
// ---------------------------------------------------------------------------

type WorkPlanItemStatus = ProjectWorkPlanTaskStatus;

const STATUS_LABEL: Record<WorkPlanItemStatus, string> = {
  pending: '[ ]', in_progress: '[>]', blocked: '[!]', done: '[x]', failed: '[✕]', cancelled: '[-]',
};

/** `/work-plan <subcommand> <id>` for each status. */
const STATUS_COMMAND: Record<WorkPlanItemStatus, string> = {
  pending: 'pending', in_progress: 'start', blocked: 'block', done: 'done', failed: 'fail', cancelled: 'cancel',
};

const STATUS_ORDER: readonly WorkPlanItemStatus[] = ['pending', 'in_progress', 'blocked', 'done', 'failed', 'cancelled'];

export type WorkPlanItemLike = Pick<ProjectWorkPlanTask, 'taskId' | 'title' | 'status' | 'owner' | 'source' | 'notes' | 'agentId' | 'contractId' | 'sessionId' | 'updatedAt'>;

export interface WorkPlanModalDeps {
  readonly workPlanStore: Pick<ProjectWorkPlan, 'projectRoot'> & { snapshot(): Promise<{ readonly tasks: readonly WorkPlanItemLike[] }> };
}

function compactDate(value: number): string { return new Date(value).toISOString().replace('T', ' ').slice(0, 16); }

function progressBar(pct: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${pct}%`;
}

function linkedSegments(item: WorkPlanItemLike): string {
  return [
    item.agentId ? `agent:${item.agentId}` : null,
    item.contractId ? `contract:${item.contractId}` : null,
    item.sessionId ? `session:${item.sessionId}` : null,
  ].filter((s): s is string => s !== null).join('  ');
}

/**
 * Close the modal, then run `/work-plan <args>` so what it prints (or leaves in
 * the composer) is in front of the user rather than behind the modal.
 */
function closeAndRun(ctx: ConfigModalActionContext, args: string[]): void {
  const run = ctx.executeCommand;
  const label = `/work-plan ${args.join(' ')}`;
  if (!run) { ctx.setStatus(`Not run: ${label} (this session has no command runner).`); return; }
  ctx.close();
  let started: Promise<unknown>;
  try { started = Promise.resolve(run('work-plan', args)); } catch (error) { started = Promise.reject(error); }
  void started.then(
    (found) => { if (found === false) ctx.print(`Not a command: /work-plan (${label} was not run).`); },
    (error: unknown) => {
      const refused = readRefusal(error);
      ctx.print(`Failed: ${label}: ${refused ? formatRefusal(refused) : summarizeError(error)}`);
    },
  );
}

class WorkPlanModalSurface implements ConfigModalSurface {
  readonly name = 'work-plan-modal';
  readonly title = 'Work Plan';
  private items: WorkPlanItemLike[] = [];
  private loading = false;
  private loadError: string | null = null;
  private requestRender: (() => void) | null = null;
  /** Each load is numbered; only the newest one's answer is shown. */
  private loadSequence = 0;

  constructor(private readonly deps: WorkPlanModalDeps) {}

  private readonly hasRow = (row: ConfigModalRow | null): boolean => row !== null;

  /** 'i'/'w' open the Agents modal on the selected item's linked agent or
   *  contract. Gated on the link actually being present. */
  private readonly hasAgentLink = (row: ConfigModalRow | null): boolean =>
    !!(row && this.itemFrom(row.id)?.agentId);
  private readonly hasContractLink = (row: ConfigModalRow | null): boolean =>
    !!(row && this.itemFrom(row.id)?.contractId);

  readonly actions = [
    { key: 'enter', id: 'cycleStatus', label: 'cycle status', enabledFor: this.hasRow },
    { key: '1', id: 'setPending', label: 'pending', enabledFor: this.hasRow },
    { key: '2', id: 'setInProgress', label: 'start', enabledFor: this.hasRow },
    { key: '3', id: 'setBlocked', label: 'block', enabledFor: this.hasRow },
    { key: '4', id: 'setDone', label: 'done', enabledFor: this.hasRow },
    { key: '5', id: 'setFailed', label: 'fail', enabledFor: this.hasRow },
    { key: '6', id: 'setCancelled', label: 'cancel', enabledFor: this.hasRow },
    { key: 'd', id: 'remove', label: 'delete', confirm: true, enabledFor: this.hasRow },
    { key: 'c', id: 'clearCompleted', label: 'clear done', confirm: true },
    { key: 'a', id: 'add', label: 'add' },
    { key: 'e', id: 'edit', label: 'edit', enabledFor: this.hasRow },
    { key: 'x', id: 'export', label: 'export' },
    { key: 'i', id: 'jumpAgent', label: 'jump agent', enabledFor: this.hasAgentLink },
    { key: 'w', id: 'jumpContract', label: 'jump contract', enabledFor: this.hasContractLink },
    { key: 'r', id: 'refresh', label: 'refresh' },
  ];

  onOpen(requestRender: () => void): void { this.requestRender = requestRender; this.refresh(); }

  onClose(): void { this.requestRender = null; this.loadSequence++; }

  /** Reads the plan's rows (one snapshot read) and redraws when they arrive. */
  private refresh(): void {
    const sequence = ++this.loadSequence;
    this.loading = true;
    this.deps.workPlanStore.snapshot().then((plan) => {
      if (sequence !== this.loadSequence) return;
      this.items = [...plan.tasks];
      this.loadError = null;
    }, (error: unknown) => {
      if (sequence !== this.loadSequence) return;
      this.loadError = summarizeError(error);
    }).finally(() => {
      if (sequence !== this.loadSequence) return;
      this.loading = false;
      this.requestRender?.();
    });
  }

  private itemFrom(id: string): WorkPlanItemLike | undefined { return this.items.find((i) => i.taskId === id); }

  buildView(): ConfigModalView {
    const counts = new Map<WorkPlanItemStatus, number>();
    for (const status of STATUS_ORDER) counts.set(status, 0);
    for (const item of this.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
    const total = this.items.length;
    const done = (counts.get('done') ?? 0) + (counts.get('cancelled') ?? 0);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    const header = [
      `Project ${this.deps.workPlanStore.projectRoot}`,
      progressBar(pct),
      `pending ${counts.get('pending') ?? 0}  active ${counts.get('in_progress') ?? 0}  blocked ${counts.get('blocked') ?? 0}  done ${counts.get('done') ?? 0}  failed ${counts.get('failed') ?? 0}  cancelled ${counts.get('cancelled') ?? 0}`,
      ...(this.loadError ? [`The work plan could not be read: ${this.loadError}. Press r to read it again.`] : []),
    ];

    const rows: ConfigModalRow[] = this.items.map((item) => {
      const owner = item.owner ? ` @${item.owner}` : '';
      const source = item.source ? ` (${item.source})` : '';
      const notes = item.notes ? ` · ${item.notes}` : '';
      const linked = linkedSegments(item);
      const linkPart = linked ? ` · ${linked}` : '';
      return { id: item.taskId, label: `${STATUS_LABEL[item.status]} ${item.title}${owner}${source}  updated ${compactDate(item.updatedAt)}${notes}${linkPart}` };
    });

    return { title: 'Work Plan', tabs: [{ id: 'items', label: 'Items', header, rows, emptyText: this.loading ? 'Reading the work plan...' : 'No work plan items yet.', hints: ['enter cycle status', '1-6 set status', 'd delete', 'c clear done', 'a add', 'e edit', 'x export'] }] };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') { this.refresh(); ctx.setStatus('Reading the work plan again.'); return; }
    const reload = (): void => this.refresh();
    if (id === 'clearCompleted') { runModalCommand(ctx, 'work-plan', ['clear-done'], '/work-plan clear-done', { afterSettle: reload }); return; }
    if (id === 'add') { closeAndRun(ctx, ['add']); return; }
    if (id === 'export') { closeAndRun(ctx, ['export']); return; }
    const item = ctx.row ? this.itemFrom(ctx.row.id) : undefined;
    if (!item) return;
    if (id === 'edit') { closeAndRun(ctx, ['edit', item.taskId]); return; }
    if (id === 'cycleStatus') { runModalCommand(ctx, 'work-plan', ['cycle', item.taskId], `/work-plan cycle ${item.taskId}`, { afterSettle: reload }); return; }
    if (id === 'remove') { runModalCommand(ctx, 'work-plan', ['remove', item.taskId], `/work-plan remove ${item.taskId}`, { afterSettle: reload }); return; }
    if (id === 'jumpAgent') {
      const agentId = item.agentId;
      if (!agentId) return;
      // 'agent' matches the platform's ProcessKind for a live agent node, which
      // AgentsModal.reveal matches on id and kind.
      runModalCommand(ctx, 'agents', ['--target', `${agentId}:agent`], `/agents --target ${agentId}:agent`, { pending: `Opening Agents on agent ${agentId}.`, done: `Opened Agents on agent ${agentId}.` });
      return;
    }
    if (id === 'jumpContract') {
      const contractId = item.contractId;
      if (!contractId) return;
      runModalCommand(ctx, 'agents', ['--target', `${contractNodeId(contractId)}:contract`], `/agents --target ${contractNodeId(contractId)}:contract`, { pending: `Opening Agents on contract ${contractId}.`, done: `Opened Agents on contract ${contractId}.` });
      return;
    }
    const status: WorkPlanItemStatus | null =
      id === 'setPending' ? 'pending' : id === 'setInProgress' ? 'in_progress' : id === 'setBlocked' ? 'blocked'
      : id === 'setDone' ? 'done' : id === 'setFailed' ? 'failed' : id === 'setCancelled' ? 'cancelled' : null;
    if (!status) return;
    runModalCommand(ctx, 'work-plan', [STATUS_COMMAND[status], item.taskId], `/work-plan ${STATUS_COMMAND[status]} ${item.taskId}`, { afterSettle: reload });
  }
}

export function createWorkPlanModalSurface(deps: WorkPlanModalDeps): ConfigModalSurface {
  return new WorkPlanModalSurface(deps);
}
