import { useQuery } from '@tanstack/react-query';
import { client as platformClient, type MemoryRecord } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { DetailSection, Facts } from '../../components/data-view/DataView';
import { Chip } from '../../components/ui/Chip';
import { formatConfidence, formatProvenanceLink, formatTimestamp, isBelowRecallFloor, isFlaggedReviewState } from './memory-helpers';

/**
 * Record detail: type (cls), scope, review state, confidence, timestamps, tags and
 * provenance. Renders every field verbatim (no re-interpretation, no secret-shaped
 * special-casing): a provenance `ref` that happens to look like a file path is shown as
 * plain text exactly like any other ref, never turned into a link or fetched, this view
 * has no read-file capability and never invents one.
 */
/**
 * Who reviewed a record, in words: the daemon records the reviewing credential's
 * principal ('shared-token', 'local', 'pairing:<id>', 'consolidation', a user name).
 * The owner's own credentials read as "you"; a paired device by its name.
 */
function useReviewerLabel(reviewedBy: string | undefined): string {
  const pairingId = reviewedBy?.startsWith('pairing:') ? reviewedBy.slice('pairing:'.length) : '';
  const tokens = useQuery({
    queryKey: queryKeys.pairingTokens,
    queryFn: () => platformClient.operator.pairing.tokens.list(),
    enabled: pairingId.length > 0,
    staleTime: 60_000,
    retry: false,
  });
  if (!reviewedBy) return '';
  if (reviewedBy === 'operator' || reviewedBy === 'shared-token' || reviewedBy === 'local') return 'you';
  if (reviewedBy === 'consolidation') return 'memory consolidation';
  if (pairingId) {
    const name = tokens.data?.tokens.find((token) => token.id === pairingId)?.name;
    return name ? `your device "${name}"` : 'a paired device';
  }
  return reviewedBy;
}

export function MemoryRecordDetail({ record, recallFloor }: { record: MemoryRecord; recallFloor?: number }) {
  const flagged = isFlaggedReviewState(record.reviewState);
  const reviewer = useReviewerLabel(record.reviewedBy);
  // A rating, not a measurement: who gave it (the last review, else whoever saved it),
  // and whether it keeps the record out of answers.
  const ratedBy = record.reviewedAt !== undefined
    ? `set ${reviewer ? `by ${reviewer} ` : ''}when it was reviewed`
    : 'as given when it was saved';
  const belowFloor = recallFloor !== undefined && isBelowRecallFloor(record, recallFloor);
  const rating = `${formatConfidence(record.confidence)} sure, ${ratedBy}${belowFloor ? `; below ${String(recallFloor)}%, so not brought into answers` : ''}`;

  return (
    <>
      {flagged && record.staleReason && (
        <DetailSection title="Why this is flagged">
          <p className="lib-prose" role="note">{record.staleReason}</p>
        </DetailSection>
      )}

      {record.detail && (
        <DetailSection title="Detail">
          <p className="lib-prose">{record.detail}</p>
        </DetailSection>
      )}

      <Facts
        items={[
          { label: 'Type', value: record.cls },
          { label: 'Scope', value: record.scope },
          { label: 'Review state', value: record.reviewState },
          { label: 'Rated', value: rating },
          { label: 'Created', value: formatTimestamp(record.createdAt) },
          { label: 'Updated', value: formatTimestamp(record.updatedAt) },
          {
            label: 'Reviewed',
            value: record.reviewedAt !== undefined
              ? `${formatTimestamp(record.reviewedAt)}${reviewer ? ` by ${reviewer}` : ''}`
              : undefined,
          },
        ]}
      />

      <DetailSection title="Tags">
        {record.tags.length
          ? <div className="lib-chips">{record.tags.map((tag) => <Chip key={tag} size="sm">{tag}</Chip>)}</div>
          : <p className="lib-quiet">No tags</p>}
      </DetailSection>

      <DetailSection title="Provenance">
        {record.provenance.length
          ? (
            <ul className="lib-plain-list">
              {record.provenance.map((link, index) => (
                <li key={`${link.kind}-${link.ref}-${index}`}>{formatProvenanceLink(link)}</li>
              ))}
            </ul>
          )
          : <p className="lib-quiet">No provenance recorded</p>}
      </DetailSection>
    </>
  );
}
