/**
 * The memory store's point-in-time copies (daily, before a migration, before a
 * restore) and the owner's restore of one. A restore replaces every record,
 * so it asks once; the daemon takes it only as the owner's explicit request,
 * copies the records it replaces first and names that copy, which this panel
 * shows so the restore can be undone from the same list.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client as platformClient, type MemoryRestoreOutcome } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { formatError } from '../../lib/errors';
import { Button } from '../../components/ui/Button';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { SkeletonRows } from '../../components/data-view/DataView';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const REASON_LABEL: Record<string, string> = {
  daily: 'Daily copy',
  'pre-migration': 'Before an upgrade',
  'pre-restore': 'Before a restore',
  tripwire: 'Before a memory-pressure stop',
};

function describeRestore(result: MemoryRestoreOutcome): string {
  return `Restored ${result.restored}: ${result.recordsBefore} records before, ${result.recordsAfter} now. `
    + `The records it replaced were copied to ${result.undoSnapshot}; restore that copy to undo. `
    + (result.vectorIndex === 'updating' ? 'Semantic search catches up in the background.' : '');
}

export function MemoryCopiesPanel() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [outcome, setOutcome] = useState<string | null>(null);
  const copies = useQuery({
    queryKey: queryKeys.memoryCopies,
    queryFn: ({ signal }) => platformClient.operator.memory.snapshots.list(signal),
  });
  const restore = useMutation({
    mutationFn: (name: string) => platformClient.operator.memory.snapshots.restore(name),
    onSuccess: async (result) => {
      setOutcome(describeRestore(result));
      await queryClient.invalidateQueries({ queryKey: ['memory'] });
    },
  });

  async function restoreCopy(name: string, label: string) {
    const ok = await confirm.ask({
      title: 'Replace all memory with this copy?',
      target: `${label}: ${name}`,
      description: 'Every memory record, link and pending consolidation proposal is replaced by those in this copy. The records you have now are copied first, and that copy is listed here so you can put them back.',
      confirmLabel: 'Restore',
      tone: 'danger',
    });
    if (ok) restore.mutate(name);
  }

  return (
    <section className="lib-copies" aria-label="Memory copies">
      {copies.isPending && <SkeletonRows count={3} label="Loading memory copies" />}
      {copies.error && <div className="dv-notice dv-notice--bad" role="alert"><span>{formatError(copies.error)}</span></div>}
      {copies.data && copies.data.length === 0 && (
        <p className="lib-copies__empty">No copies yet: the first daily copy is taken within an hour of the daemon starting.</p>
      )}
      {copies.data && copies.data.length > 0 && (
        <ul className="lib-copies__list">
          {copies.data.map((copy) => {
            const label = REASON_LABEL[copy.reason] ?? copy.reason;
            return (
              <li key={copy.name} className="lib-copies__item">
                <span className="lib-copies__when">{new Date(copy.createdAt).toLocaleString()}</span>
                <span className="lib-copies__reason">{label}</span>
                <span className="lib-copies__count">{copy.recordCount === null ? 'unreadable' : `${copy.recordCount} records`}</span>
                <span className="lib-copies__size">{formatSize(copy.sizeBytes)}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={restore.isPending || copy.recordCount === null}
                  onClick={() => { void restoreCopy(copy.name, label); }}
                >
                  {restore.isPending && restore.variables === copy.name ? 'Restoring…' : 'Restore'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <div aria-live="polite">
        {restore.error && <div className="dv-notice dv-notice--bad" role="alert"><span>{formatError(restore.error)}</span></div>}
        {outcome && !restore.error && <div className="dv-notice" role="status"><span>{outcome}</span></div>}
      </div>
      {confirm.element}
    </section>
  );
}
