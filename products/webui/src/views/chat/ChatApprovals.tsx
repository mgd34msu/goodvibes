/**
 * The approvals a chat's own turn is waiting on, shown in that chat above the
 * composer: what is asked and Approve or Deny (this once). An ask that needs
 * more than a yes or no (an answer for a running command, a choice of edit
 * hunks) opens in Work. Reads the approvals list the shell already holds and
 * refreshes on `approval-update` frames, so it adds no request.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldQuestion } from 'lucide-react';
import { client as platformClient } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { isActionableApproval, isEditApproval, readExecPromptAsk, sortApprovalsNewestFirst } from '../../lib/approvals';
import { Button } from '../../components/ui/Button';
import { useApprovalActions } from '../work/useApprovalActions';

export function ChatApprovals({ sessionId }: { sessionId: string }) {
  const approvals = useQuery({
    queryKey: queryKeys.approvals,
    queryFn: () => platformClient.operator.approvals.list(),
  });
  const actions = useApprovalActions({ pushHandoff: false });
  const waiting = useMemo(
    () => sortApprovalsNewestFirst(approvals.data?.approvals ?? [])
      .filter((record) => record.sessionId === sessionId && isActionableApproval(record))
      .reverse(),
    [approvals.data, sessionId],
  );
  if (waiting.length === 0) return null;
  const busy = actions.approve.isPending || actions.deny.isPending;
  return (
    <div className="chat-approvals" role="region" aria-label="Waiting for your approval">
      {waiting.map((record) => {
        const summary = record.request.analysis.summary.trim() || record.request.tool;
        const needsWork = readExecPromptAsk(record) !== null || isEditApproval(record);
        return (
          <div key={record.id} className="chat-approval">
            <ShieldQuestion className="chat-approval__icon" size={16} aria-hidden="true" />
            <div className="chat-approval__text">
              <span className="chat-approval__title">Waiting for your approval</span>
              <span className="chat-approval__summary">{summary}</span>
            </div>
            <div className="chat-approval__actions">
              {needsWork ? (
                <a className="chat-approval__link" href={`/?view=work#approval-action=approve&approval-id=${encodeURIComponent(record.id)}`}>
                  Answer in Work
                </a>
              ) : (
                <>
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => actions.approve.mutate({ id: record.id, expectedRevision: record.revision })}>
                    Approve
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => actions.deny.mutate({ id: record.id, expectedRevision: record.revision })}>
                    Deny
                  </Button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
