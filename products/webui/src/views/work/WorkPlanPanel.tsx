/**
 * The project work plan in the Work view: the checklist the terminal app's
 * /work-plan, the Agent's todo list, the model's `work_plan` tool and contract
 * units all keep, served by the daemon (projectPlanning.workPlan.*).
 *
 * Lists the items in plan order with their status and the plan's counts, and
 * lets the owner add, edit (title, notes, owner), reorder, change status, delete
 * and clear finished items. Every edit is one daemon call that answers with the
 * plan's revision; the list is read again only when a revision other than the
 * one shown arrives, from an edit here or a planner event (an edit in another
 * program included). Deleting an item and clearing finished items confirm first.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, CheckCheck, ListChecks, Pencil, Plus, Trash2 } from 'lucide-react';
import { client as platformClient } from '../../lib/goodvibes';
import type { ClientLifetime } from '../../lib/client-lifetime';
import { formatError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { whenLabel } from '../../lib/when-label';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { EmptyState, SkeletonRows } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { IconButton } from '../../components/ui/IconButton';
import { Row, RowList } from '../../components/ui/Row';
import { Select } from '../../components/ui/Select';
import { StatusDot, type StatusTone } from '../../components/ui/StatusDot';
import { useWorkPlan, type WorkPlanEdit, type WorkPlanTask, type WorkPlanTaskStatus } from '../../hooks/useWorkPlan';

const STATUS_ORDER: readonly WorkPlanTaskStatus[] = ['pending', 'in_progress', 'blocked', 'done', 'failed', 'cancelled'];

const STATUS_LABEL: Record<WorkPlanTaskStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_TONE: Record<WorkPlanTaskStatus, StatusTone> = {
  pending: 'idle',
  in_progress: 'live',
  blocked: 'warn',
  done: 'ok',
  failed: 'bad',
  cancelled: 'idle',
};

const STATUS_OPTIONS = STATUS_ORDER.map((status) => ({ value: status, label: STATUS_LABEL[status] }));

type Counts = Readonly<Record<WorkPlanTaskStatus | 'total', number>>;

/** "12 items: 3 pending, 1 in progress, 8 done", statuses with no items left out. */
export function workPlanSummary(counts: Counts): string {
  const parts = STATUS_ORDER.filter((status) => counts[status] > 0).map((status) => `${counts[status]} ${STATUS_LABEL[status].toLowerCase()}`);
  return `${counts.total} item${counts.total === 1 ? '' : 's'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

/** What one edit did, for the toast that confirms it. */
interface PlanEdit {
  readonly label: string;
  readonly run: () => Promise<WorkPlanEdit>;
}

interface Draft {
  readonly taskId: string;
  title: string;
  notes: string;
  owner: string;
}

export function WorkPlanPanel({ lifetime }: { lifetime: ClientLifetime }) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const { query, settle } = useWorkPlan(lifetime, true);
  const [newTitle, setNewTitle] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);

  const plan = query.data;
  const tasks = useMemo(() => plan?.tasks ?? [], [plan]);
  const finished = (plan?.counts.done ?? 0) + (plan?.counts.cancelled ?? 0);

  const edit = useMutation({
    mutationFn: (request: PlanEdit) => request.run(),
    onSuccess: (result, request) => {
      settle(result);
      const reclaimed = result.reclaimedTaskIds?.length ?? 0;
      if (reclaimed > 0) {
        toast({
          title: request.label,
          description: `Also removed ${reclaimed} finished item${reclaimed === 1 ? '' : 's'} untouched for 30 days or beyond the 200 most recent.`,
          tone: 'info',
        });
      }
    },
    onError: (error: unknown, request) => {
      toast({ title: `${request.label}: not done`, description: formatError(error), tone: 'danger' });
    },
  });
  const busy = edit.isPending;

  const add = (event: FormEvent) => {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    edit.mutate({
      label: 'Item added',
      run: () => platformClient.workPlan.tasks.create({ task: { title, source: 'web' } }),
    }, { onSuccess: () => setNewTitle('') });
  };

  const setStatus = (task: WorkPlanTask, status: WorkPlanTaskStatus) => {
    if (status === task.status) return;
    edit.mutate({
      label: `“${task.title}” is ${STATUS_LABEL[status].toLowerCase()}`,
      run: () => platformClient.workPlan.tasks.status(task.taskId, { status, source: 'web' }),
    });
  };

  const move = (index: number, by: -1 | 1) => {
    const target = index + by;
    if (target < 0 || target >= tasks.length) return;
    const ids = tasks.map((task) => task.taskId);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    edit.mutate({ label: 'Item moved', run: () => platformClient.workPlan.tasks.reorder({ orderedTaskIds: ids }) });
  };

  const remove = async (task: WorkPlanTask) => {
    const ok = await confirm.ask({
      title: 'Delete this work plan item?',
      target: task.title,
      description: 'It is removed from the plan in every GoodVibes app. This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    edit.mutate({ label: 'Item deleted', run: () => platformClient.workPlan.tasks.delete(task.taskId) });
  };

  const clearDone = async () => {
    const ok = await confirm.ask({
      title: `Clear ${finished} finished item${finished === 1 ? '' : 's'}?`,
      description: 'Done and cancelled items are removed from the plan. Failed and blocked items stay.',
      confirmLabel: 'Clear',
      tone: 'danger',
    });
    if (!ok) return;
    edit.mutate({
      label: 'Finished items cleared',
      run: () => platformClient.workPlan.tasks.clearCompleted({ statuses: ['done', 'cancelled'] }),
    });
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    const task = tasks.find((entry) => entry.taskId === draft.taskId);
    if (!task) { setDraft(null); return; }
    const title = draft.title.trim();
    if (!title) return;
    const patch: Record<string, string> = {};
    if (title !== task.title) patch.title = title;
    if (draft.notes.trim() !== (task.notes ?? '')) patch.notes = draft.notes.trim();
    if (draft.owner.trim() !== (task.owner ?? '')) patch.owner = draft.owner.trim();
    if (Object.keys(patch).length === 0) { setDraft(null); return; }
    edit.mutate({
      label: 'Item saved',
      run: () => platformClient.workPlan.tasks.update(task.taskId, { patch }),
    }, { onSuccess: () => setDraft(null) });
  };

  return (
    <div className="work-plan" aria-label="Work plan">
      {confirm.element}
      {plan && <p className="work-plan__summary" aria-live="polite">{workPlanSummary(plan.counts)}</p>}

      <form className="work-plan__add" onSubmit={add}>
        <Input
          aria-label="New work plan item"
          placeholder="Add an item"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          disabled={busy}
        />
        <Button type="submit" icon={<Plus aria-hidden="true" />} disabled={busy || !newTitle.trim()}>Add</Button>
      </form>

      {query.isPending && <SkeletonRows count={4} label="Loading the work plan" />}
      {query.isError && (
        <p className="dv-notice dv-notice--bad" role="alert">
          Could not load the work plan: {formatError(query.error)}
          {' '}
          <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>Retry</Button>
        </p>
      )}
      {query.isSuccess && tasks.length === 0 && (
        <EmptyState icon={<ListChecks />}>
          The project’s work plan is empty. Items added here, with /work-plan in the terminal, by the Agent or by the model appear here.
        </EmptyState>
      )}

      {tasks.length > 0 && (
        <RowList aria-label="Work plan items">
          {tasks.map((task, index) => (draft?.taskId === task.taskId ? (
            <li key={task.taskId} className="gv-row work-plan__editor">
              <form className="work-plan__edit-form" onSubmit={save} aria-label={`Edit ${task.title}`}>
                <Field label="Title">
                  <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} disabled={busy} />
                </Field>
                <Field label="Owner" help="An agent id, a cohort name or a person; empty for none.">
                  <Input value={draft.owner} onChange={(e) => setDraft({ ...draft, owner: e.target.value })} disabled={busy} />
                </Field>
                <Field label="Notes">
                  <Textarea rows={3} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} disabled={busy} />
                </Field>
                <div className="work-plan__edit-actions">
                  <Button type="submit" variant="primary" disabled={busy || !draft.title.trim()}>Save</Button>
                  <Button variant="ghost" onClick={() => setDraft(null)} disabled={busy}>Cancel</Button>
                </div>
              </form>
            </li>
          ) : (
            <Row
              key={task.taskId}
              leading={<StatusDot tone={STATUS_TONE[task.status]} />}
              title={task.title}
              meta={[
                STATUS_LABEL[task.status],
                task.owner ? `@${task.owner}` : '',
                task.notes ?? '',
                `updated ${whenLabel(task.updatedAt)}`,
              ].filter(Boolean).join(' · ')}
              aria-label={`${task.title}, ${STATUS_LABEL[task.status]}`}
              trailing={(
                <span className="work-plan__actions">
                  <Select<WorkPlanTaskStatus>
                    aria-label={`Status of ${task.title}`}
                    value={task.status}
                    options={STATUS_OPTIONS}
                    onChange={(status) => setStatus(task, status)}
                    disabled={busy}
                    placement="bottom-end"
                  />
                  <IconButton size="sm" label={`Edit ${task.title}`} icon={<Pencil />} disabled={busy}
                    onClick={() => setDraft({ taskId: task.taskId, title: task.title, notes: task.notes ?? '', owner: task.owner ?? '' })} />
                  <IconButton size="sm" label={`Move ${task.title} up`} icon={<ArrowUp />} disabled={busy || index === 0} onClick={() => move(index, -1)} />
                  <IconButton size="sm" label={`Move ${task.title} down`} icon={<ArrowDown />} disabled={busy || index === tasks.length - 1} onClick={() => move(index, 1)} />
                  <IconButton size="sm" label={`Delete ${task.title}`} icon={<Trash2 />} disabled={busy} onClick={() => void remove(task)} />
                </span>
              )}
            />
          )))}
        </RowList>
      )}

      {plan && (
        <div className="work-plan__footer">
          <Button size="sm" variant="ghost" icon={<CheckCheck aria-hidden="true" />} disabled={busy || finished === 0} onClick={() => void clearDone()}>
            Clear finished{finished > 0 ? ` (${finished})` : ''}
          </Button>
          <p className="work-prose" role="note">
            Done and cancelled items are also removed automatically once untouched for 30 days or beyond the 200 most recent.
          </p>
        </div>
      )}
    </div>
  );
}
