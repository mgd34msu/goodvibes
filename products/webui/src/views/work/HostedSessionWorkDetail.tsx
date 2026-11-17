/**
 * A daemon-hosted session's one detail pane in the Work view.
 *
 * A hosted session is also a session on the union list, so it used to be two
 * rows with two panes: one attached live (transcript as it streams, Leave,
 * End session), the other held Changes, Rewind and Checkpoints with Close and
 * Delete. This pane carries all of it for the one row: the live attachment
 * (useHostedAttachment) on the Transcript tab, the session's Changes, Rewind
 * and Checkpoints tabs, Leave, and one verb for ending it, End session. Delete
 * permanently is offered once the session has ended.
 */
import { LogOut, MoreHorizontal, OctagonX } from 'lucide-react';
import type { UnionSessionRecord } from '../../lib/sessions-union';
import { effectiveDetachPolicyLabel, hostedAttachedClientCount, hostedStatusLabel, hostedTerminationLabel } from '../../lib/hosted-sessions';
import { nonEmpty } from '../../lib/non-empty';
import { useSessionLifecycle } from '../../hooks/useSessionLifecycle';
import { DetailPane, DetailSection, Facts, SkeletonRows } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { IconButton } from '../../components/ui/IconButton';
import { Menu, MenuItem } from '../../components/ui/Menu';
import { Segmented } from '../../components/ui/Segmented';
import { StatusDot } from '../../components/ui/StatusDot';
import { SteerComposer } from '../sessions/SteerComposer';
import { SessionChanges } from '../sessions/SessionChanges';
import { SessionRewind } from '../sessions/SessionRewind';
import { CheckpointsPanel } from './CheckpointsPanel';
import { HostedTurnStop, type HostedAttachment } from './HostedSessionDetail';
import type { SessionTab } from './SessionDetail';
import { sentenceCase } from './work-items';

const TABS: readonly { value: SessionTab; label: string }[] = [
  { value: 'transcript', label: 'Transcript' },
  { value: 'changes', label: 'Changes' },
  { value: 'rewind', label: 'Rewind' },
  { value: 'checkpoints', label: 'Checkpoints' },
];

export interface HostedSessionWorkDetailProps {
  readonly sessionId: string;
  readonly attachment: HostedAttachment;
  /** The session's union-list record, when the daemon lists it there yet. */
  readonly record?: UnionSessionRecord | undefined;
  /** The list row's title while attaching. */
  readonly fallbackTitle: string;
  readonly tab: SessionTab;
  readonly onTabChange: (tab: SessionTab) => void;
  readonly streamPaused: boolean;
  readonly onClose: () => void;
}

export function HostedSessionWorkDetail({ sessionId, attachment, record, fallbackTitle, tab, onTabChange, streamPaused, onClose }: HostedSessionWorkDetailProps) {
  const lifecycle = useSessionLifecycle(sessionId, onClose);
  const { session } = attachment;
  const ended = session?.status === 'terminated';

  const actions = session ? (
    <>
      {!ended && (
        <Button size="sm" variant="danger" icon={<OctagonX aria-hidden="true" />} onClick={attachment.kill} disabled={attachment.killPending}>
          {attachment.killPending ? 'Ending…' : 'End session'}
        </Button>
      )}
      <Button size="sm" icon={<LogOut aria-hidden="true" />} onClick={attachment.leave}>Leave</Button>
      {ended && (
        <Menu
          label="More session actions"
          placement="bottom-end"
          trigger={(props) => <IconButton {...props} label="More session actions" icon={<MoreHorizontal />} />}
        >
          <MenuItem danger onSelect={() => lifecycle.ask('delete')} disabled={lifecycle.disabled}>
            {lifecycle.phase === 'pending' && lifecycle.action === 'delete' ? 'Deleting…' : 'Delete permanently'}
          </MenuItem>
        </Menu>
      )}
    </>
  ) : undefined;

  return (
    <DetailPane
      title={nonEmpty(session?.title) ?? nonEmpty(record?.title) ?? fallbackTitle}
      status={session ? (
        <span className="work-status">
          <StatusDot tone={ended ? 'idle' : session.status === 'running' ? 'live' : 'ok'} />
          {sentenceCase(hostedStatusLabel(session.status))}
        </span>
      ) : undefined}
      meta={session ? `Hosted · ${session.workspaceRoot}` : 'Hosted session'}
      actions={actions}
      onClose={onClose}
      closeLabel="Close session detail"
      tabs={<Segmented<SessionTab> label="Session sections" value={tab} onChange={onTabChange} options={TABS} />}
    >
      {attachment.confirmElement}
      <ConfirmDialog
        open={lifecycle.phase === 'confirming' && lifecycle.action === 'delete'}
        title="Delete this session?"
        target={session?.title ?? record?.title ?? sessionId}
        description="The session record is removed for good and cannot be reopened."
        confirmLabel="Delete"
        tone="danger"
        onConfirm={lifecycle.confirm}
        onCancel={lifecycle.dismiss}
      />
      {lifecycle.notice && <p className="dv-notice dv-notice--bad" role="alert">
        {lifecycle.notice}
        {lifecycle.phase === 'no-answer' && <>{' '}<Button size="sm" variant="ghost" onClick={lifecycle.retry}>Retry</Button></>}
      </p>}
      {attachment.streamError && <p className="dv-notice dv-notice--bad" role="status">{attachment.streamError}</p>}
      {attachment.attaching && <SkeletonRows count={4} label="Attaching" />}
      {!attachment.attaching && (Boolean(attachment.attachError) || !session) && (
        <p className="dv-notice dv-notice--bad" role="alert">
          Could not attach: {attachment.attachError ?? 'Could not attach to this session.'}
        </p>
      )}

      {tab === 'transcript' && !attachment.attaching && session && (
        <>
          <p className="work-prose">{effectiveDetachPolicyLabel(session.effectiveDetachPolicy)}</p>
          {ended && <p className="dv-notice" role="status">{hostedTerminationLabel(session) ?? 'terminated'}</p>}
          <Facts
            items={[
              { label: 'Turns', value: String(session.turnCount) },
              { label: 'Messages', value: String(session.messageCount) },
              { label: 'Waiting inputs', value: record && record.pendingInputCount > 0 ? String(record.pendingInputCount) : '' },
              { label: 'Attached clients', value: String(hostedAttachedClientCount(session)) },
              { label: 'When the last client leaves', value: session.effectiveDetachPolicy === 'kill' ? 'It ends' : 'It keeps running' },
            ]}
          />
          <DetailSection title="Transcript">
            <ol className="work-transcript" aria-label="Transcript">
              {attachment.history.map((message, index) => (
                <li key={`history-${String(index)}`} className="work-transcript__message">
                  <span className="work-transcript__role">{message.role}</span>
                  <span className="work-transcript__body">{message.content}</span>
                </li>
              ))}
              {attachment.liveMessages.map((message, index) => (
                <li key={`live-${String(index)}`} className="work-transcript__message">
                  <span className="work-transcript__role">{message.role}</span>
                  <span className="work-transcript__body">{message.content}</span>
                </li>
              ))}
              {attachment.liveText && (
                <li className="work-transcript__message work-transcript__message--streaming">
                  <span className="work-transcript__role">assistant, writing</span>
                  <span className="work-transcript__body">{attachment.liveText}</span>
                </li>
              )}
            </ol>
            {attachment.history.length === 0 && attachment.liveMessages.length === 0 && !attachment.liveText && (
              <p className="work-prose work-prose--quiet">No messages yet.</p>
            )}
          </DetailSection>
          {attachment.activeToolCalls.length > 0 && (
            <ul className="work-list" aria-label="Running tools">
              {attachment.activeToolCalls.map((call) => <li key={call.callId}>Running: {call.tool}</li>)}
            </ul>
          )}
          <DetailSection title="Continue session">
            {!ended && session.status === 'running' && <HostedTurnStop sessionId={sessionId} attachment={attachment} />}
            <SteerComposer sessionId={sessionId} canSteer={!ended} closed={ended} streamPaused={streamPaused} />
          </DetailSection>
        </>
      )}

      {tab === 'changes' && <SessionChanges sessionId={sessionId} canSteer={!ended} closed={ended} streamPaused={streamPaused} />}
      {tab === 'rewind' && <SessionRewind sessionId={sessionId} closed={ended} />}
      {tab === 'checkpoints' && <CheckpointsPanel />}
    </DetailPane>
  );
}
