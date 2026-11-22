import type { MemoryRecord } from '../../lib/goodvibes';
import { Row } from '../../components/ui/Row';
import { StatusDot } from '../../components/ui/StatusDot';
import { sentence } from '../library/library-data';
import { confidenceMeaning, confidenceRating, isBelowRecallFloor, isFlaggedReviewState } from './memory-helpers';

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

/** One record row: summary, then kind, scope and review state as meta (and "not brought
 * into answers" below the recall floor), the rating on the right ("Rated 82% sure", its
 * meaning on hover). Never renders `detail` (the detail pane's job), so the list stays scannable. */
export function MemoryRecordRow({ record, recallFloor, selected = false, highlighted = false, onOpen }: MemoryRecordRowProps) {
  const belowFloor = recallFloor !== undefined && isBelowRecallFloor(record, recallFloor);
  const flagged = isFlaggedReviewState(record.reviewState);
  const meta = [
    sentence(record.cls),
    record.scope,
    record.reviewState !== 'fresh' ? record.reviewState : null,
    belowFloor ? 'not brought into answers' : null,
  ].filter((part): part is string => Boolean(part)).join(' · ');
  const rating = confidenceRating(record.confidence);

  return (
    <Row
      className={['memory-record-row', highlighted ? 'lib-row--highlight' : ''].filter(Boolean).join(' ')}
      leading={flagged ? <StatusDot tone={record.reviewState === 'contradicted' ? 'bad' : 'warn'} srLabel={record.reviewState} /> : undefined}
      title={record.summary}
      meta={meta}
      trailing={<span className="dv-value" title={confidenceMeaning(recallFloor)}>{rating.charAt(0).toUpperCase()}{rating.slice(1)}</span>}
      selected={selected}
      onSelect={() => onOpen(record)}
    />
  );
}
