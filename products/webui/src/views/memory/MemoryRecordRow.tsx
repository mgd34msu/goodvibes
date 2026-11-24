import type { MemoryRecord } from '../../lib/goodvibes';
import { Row } from '../../components/ui/Row';
import { StatusDot } from '../../components/ui/StatusDot';
import { sentence } from '../library/library-data';
import { formatConfidence, isBelowRecallFloor, isFlaggedReviewState } from './memory-helpers';
import { useReviewerLabel } from './MemoryRecordDetail';

interface MemoryRecordRowProps {
  record: MemoryRecord;
  /** The wire recall floor (MemorySearchResult.recallFloor) the search that produced
   * this record ran against, so the row states the store's actual configured floor,
   * never a hardcoded number. */
  recallFloor?: number;
  selected?: boolean;
  highlighted?: boolean;
  onOpen: (record: MemoryRecord) => void;
}

/**
 * Who gave a record its rating, as the row says it: "rated by you" after a
 * review, "rated as saved" before one (the same reading as the detail's Rated).
 */
export function useRatedBy(record: MemoryRecord): string {
  const reviewer = useReviewerLabel(record.reviewedBy);
  return record.reviewedAt !== undefined ? `rated by ${reviewer || 'a reviewer'}` : 'rated as saved';
}

/**
 * One record row: summary, then kind, scope, review state and who rated it as
 * meta; on the right, the rating as a small bar with its number and, in words,
 * whether it is brought into answers ("in answers") or kept out by the recall
 * floor ("below floor"). What the rating means is said once, above the list
 * (MemoryView), in plain sight rather than on hover. Never renders `detail`
 * (the detail pane's job), so the list stays scannable.
 */
export function MemoryRecordRow({ record, recallFloor, selected = false, highlighted = false, onOpen }: MemoryRecordRowProps) {
  const belowFloor = recallFloor !== undefined && isBelowRecallFloor(record, recallFloor);
  const flagged = isFlaggedReviewState(record.reviewState);
  const ratedBy = useRatedBy(record);
  const meta = [
    sentence(record.cls),
    record.scope,
    record.reviewState !== 'fresh' ? record.reviewState : null,
    ratedBy,
  ].filter((part): part is string => Boolean(part)).join(' · ');
  const percent = Math.max(0, Math.min(100, Math.round(record.confidence)));

  return (
    <Row
      className={['memory-record-row', highlighted ? 'lib-row--highlight' : ''].filter(Boolean).join(' ')}
      leading={flagged ? <StatusDot tone={record.reviewState === 'contradicted' ? 'bad' : 'warn'} srLabel={record.reviewState} /> : undefined}
      title={record.summary}
      meta={meta}
      trailing={(
        <span className="memory-rating">
          <span className="memory-rating__bar" aria-hidden="true"><span style={{ width: `${String(percent)}%` }} /></span>
          <span className="memory-rating__value"><span className="gv-sr-only">Rated </span>{formatConfidence(record.confidence)}</span>
          {recallFloor !== undefined && (
            <span className={`memory-rating__tag${belowFloor ? ' memory-rating__tag--out' : ''}`}>
              {belowFloor ? 'below floor' : 'in answers'}
            </span>
          )}
        </span>
      )}
      selected={selected}
      onSelect={() => onOpen(record)}
    />
  );
}
