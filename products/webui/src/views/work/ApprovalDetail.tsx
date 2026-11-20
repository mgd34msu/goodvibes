/**
 * One ask in Work's detail pane (ux A2.5): who asked and when, then the same
 * card the chat shows inline (AskCard: the question, what it acts on, what it
 * will do, the choices, "Why am I asked?" and "Details"), and for an approval
 * the state its reading gives ("Waiting for you", "Decided by Sam on the
 * phone", "Ended: the asking session closed").
 *
 * Everything the old pane showed as primary text (the arguments as JSON, who
 * requested it, the category, the session, the model judgment, the decision
 * trail) is inside Details. Claim is "I'll handle this", offered only when the
 * reading allows it and more than one person can answer; withdraw is "Cancel
 * this request", offered only to the person who asked (the reading's
 * `requester.mine` and allowed actions). Every action names the revision of
 * the record shown here (useApprovalActions).
 */
import { useQuery } from '@tanstack/react-query';
import { client as platformClient } from '../../lib/goodvibes';
import {
  attributionLabel,
  auditEntryLabel,
  auditTrail,
  judgmentLabel,
  judgmentVerdict,
  partialApprovalLabel,
} from '../../lib/approvals';
import { askReading, readingStateLine, type OpenAsk } from '../../lib/asks';
import { queryKeys } from '../../lib/queries';
import { DetailPane } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { StatusDot } from '../../components/ui/StatusDot';
import { AskCard, askedWhen, countdownWords, originWords } from './AskCard';
import type { ApprovalActions } from './useApprovalActions';
import type { AskActions } from './useAskActions';

export interface ApprovalDetailProps {
  ask: OpenAsk;
  approvalActions: ApprovalActions;
  askActions: AskActions;
  now: number;
  onClose?: () => void;
}

/** More than one person can answer here: claiming then tells the others someone is on it. */
function useSeveralAnswerers(enabled: boolean): boolean {
  const principals = useQuery({
    queryKey: queryKeys.principals,
    queryFn: () => platformClient.operator.principals.list(),
    enabled,
    retry: false,
  });
  const list = (principals.data as { principals?: unknown } | undefined)?.principals;
  return Array.isArray(list) && list.length > 1;
}

export function ApprovalDetail({ ask, approvalActions, askActions, now, onClose }: ApprovalDetailProps) {
  const record = ask.approval;
  const reading = askReading(ask);
  const mayClaim = Boolean(reading?.allowedActions.includes('claim')) && reading?.phase === 'waiting' && reading.reason !== 'claimed-by-you';
  const severalAnswerers = useSeveralAnswerers(mayClaim);
  const mayCancel = Boolean(reading?.allowedActions.includes('cancel') && reading.requester.mine);
  const busy = askActions.busy;

  const stateLine = reading ? readingStateLine(reading) : 'Waiting for you';
  const tone = !reading || reading.phase === 'waiting' ? 'warn' : reading.decision?.disposition === 'denied' ? 'bad' : reading.phase === 'decided' ? 'ok' : 'idle';
  const lead = [originWords(ask), askedWhen(ask, now), ask.presentation.kind === 'purchase' ? countdownWords(ask, now) : undefined].filter(Boolean).join(' · ');

  const extraDetails: { label: string; value: string }[] = [];
  if (record) {
    const attribution = attributionLabel(record.request.attribution);
    if (attribution) extraDetails.push({ label: 'Requested by', value: attribution });
    if (record.request.category) extraDetails.push({ label: 'Category', value: record.request.category });
    if (record.sessionId) extraDetails.push({ label: 'Session', value: record.sessionId });
    const verdict = judgmentVerdict(record);
    if (verdict) extraDetails.push({ label: 'Model judgment', value: judgmentLabel(verdict) });
    const partial = partialApprovalLabel(record);
    if (partial) extraDetails.push({ label: 'Applied', value: partial });
    if (record.decision?.reason) extraDetails.push({ label: 'Reason', value: record.decision.reason });
    for (const entry of auditTrail(record)) extraDetails.push({ label: 'Trail', value: `${auditEntryLabel(entry)} · ${new Date(entry.createdAt).toLocaleString()}` });
    extraDetails.push({ label: 'Request', value: record.id });
  } else if (ask.item) {
    extraDetails.push({ label: 'Request', value: ask.item.id });
  }

  const footer = record && (mayClaim && severalAnswerers || mayCancel) ? (
    <>
      {mayClaim && severalAnswerers && (
        <span className="work-claim">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => approvalActions.claim.mutate({ id: record.id, expectedRevision: record.revision })}>
            I&apos;ll handle this
          </Button>
          <span className="work-claim__why">Marks it as yours so others see someone is on it.</span>
        </span>
      )}
      <span className="work-footer__spacer" />
      {mayCancel && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => approvalActions.cancel.mutate({ id: record.id, expectedRevision: record.revision })}>
          Cancel this request
        </Button>
      )}
    </>
  ) : undefined;

  return (
    <DetailPane
      title={(
        <span className="work-status work-status--title">
          <StatusDot tone={tone} />
          {stateLine}
        </span>
      )}
      onClose={onClose}
      closeLabel="Close"
      footer={footer}
    >
      <AskCard
        key={`${ask.key}:${record?.revision ?? 0}`}
        ask={ask}
        actions={askActions}
        variant="detail"
        lead={lead ? <p className="ask-card__lead">{lead}</p> : undefined}
        extraDetails={extraDetails}
      />
    </DetailPane>
  );
}
