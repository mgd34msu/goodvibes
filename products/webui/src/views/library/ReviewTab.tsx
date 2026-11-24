/**
 * The Review tab of the Library: everything that waits for a human call, in one list.
 * Consolidation proposals (contradictions, cross-scope duplicates, stale deletes) come
 * first, then the memory review queue, then knowledge candidates. Selecting a row opens
 * it in the detail pane; selecting a proposal also highlights the queue rows it points at
 * (a jump lands on the rows, it never filters the rest of the queue away). A proposal is
 * answered in its pane with the choices its kind allows (memory.consolidation.decide);
 * the records it names are loaded by id, so a record outside the first page of the
 * queue still opens.
 */
import { ClipboardList } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { client as platformClient } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { Button } from '../../components/ui/Button';
import { CONSOLIDATION_CHOICES, consolidationProposalId, type ConsolidationAction } from '../memory/memory-helpers';
import type { MemoryConsolidationProposal, MemoryRecord } from '../../lib/goodvibes';
import { formatError } from '../../lib/errors';
import { DetailPane, DetailSection, EmptyState, ListDetail, RowGroup, SkeletonRows } from '../../components/data-view/DataView';
import { Row, RowList } from '../../components/ui/Row';
import ErrorBoundary from '../../components/feedback/ErrorBoundary';
import { ErrorState } from '../../components/feedback/ErrorState';
import { ConsolidationProposals, ConsolidationRuns, PROPOSAL_KIND_LABEL } from '../memory/ConsolidationReceipts';
import { MemoryRecordPane } from '../memory/MemoryRecordPane';
import { MemoryRecordRow } from '../memory/MemoryRecordRow';
import { KnowledgeCandidatePane, KnowledgeCandidateRows, parseCandidate } from '../knowledge/KnowledgeCandidates';
import { motionReduced } from '../../lib/ui-preferences';
import {
  candidateItems,
  includesText,
  sentence,
  useConsolidationReceipts,
  useKnowledgeCandidates,
  useMemoryRecordMutations,
  useReviewTally,
  REVIEW_PAGE_LIMIT,
  useReviewQueue,
} from './library-data';

type Selection =
  | { kind: 'record'; id: string }
  | { kind: 'proposal'; key: string; proposal: MemoryConsolidationProposal }
  | { kind: 'candidate'; id: string };

export interface ReviewTabProps {
  query?: string;
}

export function ReviewTab({ query = '' }: ReviewTabProps) {
  const queue = useReviewQueue();
  const candidates = useKnowledgeCandidates();
  const receipts = useConsolidationReceipts();
  const { count: total, capped } = useReviewTally();
  const { remove, saveReview, saveEdit } = useMemoryRecordMutations();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);

  const records = useMemo(
    () => (queue.data?.records ?? []).filter((r) => includesText([r.summary, r.detail, r.cls, r.scope, ...r.tags], query)),
    [queue.data, query],
  );
  const queueById = useMemo(() => new Map((queue.data?.records ?? []).map((r) => [r.id, r])), [queue.data]);
  const queryClient = useQueryClient();
  const proposalIds = selection?.kind === 'proposal' ? selection.proposal.ids.filter((id) => !queueById.has(id)) : [];
  const proposalRecords = useQueries({
    queries: proposalIds.map((id) => ({
      queryKey: ['memory', 'record', id] as const,
      queryFn: async (): Promise<MemoryRecord> => (await platformClient.operator.memory.get(id)).record,
      retry: false,
    })),
  });
  const recordById = (id: string): MemoryRecord | undefined => {
    const queued = queueById.get(id);
    if (queued) return queued;
    return proposalRecords[proposalIds.indexOf(id)]?.data;
  };
  const decide = useMutation({
    mutationFn: (input: { proposalId: string; action: ConsolidationAction }) => platformClient.operator.memory.consolidation.decide(input),
    onSuccess: async (result) => {
      if (result.decided) setSelection(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.memoryConsolidationReceipts });
      await queryClient.invalidateQueries({ queryKey: queryKeys.memoryReviewQueue });
    },
  });

  useEffect(() => {
    if (highlight.size === 0) return;
    listRef.current?.querySelector('.lib-row--highlight')?.scrollIntoView?.({ behavior: motionReduced() ? 'auto' : 'smooth', block: 'nearest' });
  }, [highlight]);

  const selectedRecord: MemoryRecord | undefined = selection?.kind === 'record' ? queueById.get(selection.id) : undefined;
  // The mutations are shared by every row, so an error belongs to the record it was for.
  const saveError = saveReview.error && saveReview.variables?.id === selectedRecord?.id ? saveReview.error : null;
  const removeError = remove.error && remove.variables?.id === selectedRecord?.id ? remove.error : null;
  const editError = saveEdit.error && saveEdit.variables?.id === selectedRecord?.id ? saveEdit.error : null;
  const recordError = saveError ? formatError(saveError) : removeError ? formatError(removeError) : editError ? formatError(editError) : null;
  const selectedCandidate = useMemo(() => {
    if (selection?.kind !== 'candidate') return undefined;
    return candidateItems(candidates.data).map(parseCandidate).find((c) => c.id === selection.id);
  }, [selection, candidates.data]);

  const loaded = !queue.isPending && !candidates.isPending && !receipts.isPending;

  const list = (
    <div ref={listRef}>
      <ConsolidationProposals
        query={query}
        selectedKey={selection?.kind === 'proposal' ? selection.key : null}
        onSelect={(key, proposal) => {
          setSelection({ kind: 'proposal', key, proposal });
          setHighlight(new Set(proposal.ids));
          decide.reset();
        }}
      />

      {queue.isPending && <SkeletonRows count={3} label="Loading the review queue" />}
      {queue.error && <ErrorState error={queue.error} onRetry={() => void queue.refetch()} title="Review queue unavailable" />}
      {records.length > 0 && (
        <RowGroup label="Review queue" count={records.length}>
          {records.map((record) => (
            <MemoryRecordRow
              key={record.id}
              record={record}
              highlighted={highlight.has(record.id)}
              selected={selection?.kind === 'record' && selection.id === record.id}
              onOpen={(r) => setSelection({ kind: 'record', id: r.id })}
            />
          ))}
        </RowGroup>
      )}

      <KnowledgeCandidateRows
        query={query}
        selectedId={selection?.kind === 'candidate' ? selection.id : null}
        onSelect={(id) => setSelection({ kind: 'candidate', id })}
      />

      {loaded && total === 0 && !query.trim() && (
        <EmptyState icon={<ClipboardList />} title="Nothing is waiting for review">
          Records the store prioritizes for review, consolidation proposals and knowledge candidates appear here.
        </EmptyState>
      )}
      {loaded && total > 0 && records.length === 0 && query.trim() && (
        <p className="lib-quiet">Nothing in the review queue matches this search.</p>
      )}

      {capped && (
        <p className="lib-quiet" role="note">
          Showing the first {REVIEW_PAGE_LIMIT} queued records and candidates. More may be waiting: decide some and the next ones appear.
        </p>
      )}

      <ConsolidationRuns />
    </div>
  );

  let detail: ReactNode = null;
  if (selection?.kind === 'record' && selectedRecord) {
    detail = (
      <MemoryRecordPane
        key={selectedRecord.id}
        record={selectedRecord}
        onClose={() => setSelection(null)}
        onDelete={(record) => remove.mutate(record)}
        deleting={remove.isPending && remove.variables.id === selectedRecord.id}
        onSaveReview={(id, input) => saveReview.mutate({ id, input })}
        saving={saveReview.isPending && saveReview.variables.id === selectedRecord.id}
        onSaveEdit={(id, input) => saveEdit.mutate({ id, input })}
        savingEdit={saveEdit.isPending && saveEdit.variables.id === selectedRecord.id}
        error={recordError}
      />
    );
  } else if (selection?.kind === 'proposal') {
    const { proposal } = selection;
    detail = (
      <DetailPane
        title={PROPOSAL_KIND_LABEL[proposal.kind]}
        meta={`${proposal.ids.length} record${proposal.ids.length === 1 ? '' : 's'}`}
        onClose={() => setSelection(null)}
      >
        <DetailSection title="What was found">
          <p className="lib-prose">{proposal.reason}</p>
        </DetailSection>
        <DetailSection title="Records">
          <RowList aria-label="Records this proposal points at">
            {proposal.ids.map((id, index) => {
              const record = recordById(id);
              const position = proposal.ids.length > 1 ? (index === 0 ? 'First · ' : index === 1 ? 'Second · ' : '') : '';
              return record ? (
                <Row
                  key={id}
                  title={record.summary}
                  meta={`${position}${sentence(record.cls)} · ${record.scope} · ${record.reviewState}`}
                  onSelect={queueById.has(id) ? () => setSelection({ kind: 'record', id }) : undefined}
                />
              ) : (
                <Row key={id} title={id} meta={`${position}Loading…`} />
              );
            })}
          </RowList>
        </DetailSection>
        <DetailSection title="Decide">
          <div className="lib-actions">
            {CONSOLIDATION_CHOICES[proposal.kind].map((choice) => (
              <Button
                key={choice.action}
                size="sm"
                variant={choice.action === 'delete' ? 'danger' : 'outline'}
                disabled={decide.isPending}
                onClick={() => decide.mutate({ proposalId: consolidationProposalId(proposal), action: choice.action })}
              >
                {choice.label}
              </Button>
            ))}
          </div>
          {decide.data && !decide.data.decided && decide.data.refusal && (
            <p className="lib-quiet" role="alert">{decide.data.refusal.reason}. {decide.data.refusal.next[0] ?? ''}</p>
          )}
          {decide.isError && <p className="lib-quiet" role="alert">{formatError(decide.error)}</p>}
        </DetailSection>
      </DetailPane>
    );
  } else if (selection?.kind === 'candidate' && selectedCandidate) {
    detail = <KnowledgeCandidatePane key={selectedCandidate.id} candidate={selectedCandidate} onClose={() => setSelection(null)} />;
  }

  return (
    <ErrorBoundary fallback={(err, reset) => <ErrorState error={err} onRetry={reset} title="Review failed" />}>
      <div className="lib-tab">
        <ListDetail
          mode="peek"
          list={list}
          detail={detail}
          detailOpen={detail !== null}
          onCloseDetail={() => setSelection(null)}
          listLabel="Review"
          detailLabel="Review item"
          backLabel="All review"
        />
      </div>
    </ErrorBoundary>
  );
}
