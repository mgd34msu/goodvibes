/**
 * Waiting for you: the web view of the Waiting for you place (terminal-shell
 * places/waiting-place.ts). Everything that waits on your answer, each with
 * its own answers (the cards the Work board and a chat show: questions,
 * approvals, held calls, purchase windows, answered on the press); what was
 * answered before and the calls Jev decided (OwnerQuestions); the Telegram
 * messages held for you, each with the actions that apply to it (the
 * `telegram.*` capabilities, run through `capabilities.run` as the owner's
 * own request); and what each kind of approval asks about. Every list is read
 * from the daemon and read again when it says one changed (the inbox's and the
 * approval broker's frames; LIST_CHANGED `telegram-intake`).
 */
import { useOpenAsks } from '../../../hooks/useOpenAsks';
import { asArray, asRecord } from '../../../lib/object';
import { AskCard } from '../../../views/work/AskCard';
import { OwnerQuestions } from '../../../views/work/OwnerQuestions';
import { useApprovalActions } from '../../../views/work/useApprovalActions';
import { useAskActions } from '../../../views/work/useAskActions';
import { Row, RowList } from '../../ui/Row';
import { StatusDot } from '../../ui/StatusDot';
import { ActionButtons } from '../ActionButtons';
import { CommandScreen, ReadState, useCommandRead, useRefreshCommandScreens } from './CommandScreen';
import '../../../styles/components/ask-card.css';

const REVIEW_ID_PREFIX = 'external-review-';
const SHORT = 8;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

function when(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toLocaleString() : 'not said';
}

/** Everything open in the owner inbox, each with its own answers. */
function OpenAsks() {
  const { asks } = useOpenAsks(true);
  const approvals = useApprovalActions({ pushHandoff: false });
  const actions = useAskActions(approvals);
  return (
    <section aria-label="Waiting on you">
      <div className="gv-command-screen__subhead"><h4>Waiting on you</h4></div>
      {asks.length === 0 ? <p className="gv-command-screen__state">Nothing is waiting on you.</p> : (
        <div className="chat-asks" role="region" aria-label="Waiting for your answer">
          {asks.map((ask) => (
            <AskCard key={`${ask.key}:${ask.approval?.revision ?? 0}`} ask={ask} actions={actions} variant="detail" />
          ))}
        </div>
      )}
    </section>
  );
}

/** The Telegram messages held for you: waiting for your decision, or in the review queue. */
function Telegram({ onDone }: { readonly onDone: () => void }) {
  const read = useCommandRead('waiting-telegram', 'inbound.telegram.list');
  const answer = asRecord(read.data);
  const pending = asArray(answer.pending).map(asRecord).filter((entry) => text(entry.approvalId));
  const records = asArray(answer.records).map(asRecord).filter((entry) => text(entry.id) && entry.state !== 'cancelled');
  return (
    <section aria-label="Telegram">
      <div className="gv-command-screen__subhead">
        <h4>Telegram</h4>
        <ActionButtons command="telegram" actions={['configure']} onDone={onDone} />
      </div>
      <ReadState read={read} isEmpty={pending.length === 0 && records.length === 0} empty="No Telegram message is held for you." />
      {pending.length > 0 || records.length > 0 ? (
        <RowList aria-label="Telegram messages held for you">
          {pending.map((entry) => {
            const id = text(entry.approvalId).slice(0, SHORT);
            return (
              <Row
                key={`pending-${id}`}
                leading={<StatusDot tone="warn" srLabel="Waiting for your decision" />}
                title={`A held message, kept until ${when(entry.sourceExpiresAt)}`}
                meta="Waiting for your decision; nothing in it is run."
                trailing={<ActionButtons command="telegram" short actions={['approve', 'deny']} menu={['status']} menuLabel="More for this message" prefill={{ message: id }} onDone={onDone} />}
              />
            );
          })}
          {records.map((entry) => {
            const raw = text(entry.id);
            const id = (raw.startsWith(REVIEW_ID_PREFIX) ? raw.slice(REVIEW_ID_PREFIX.length) : raw).slice(0, SHORT);
            const configuration = text(entry.configurationId);
            const seen = entry.state === 'reviewed';
            return (
              <Row
                key={`review-${id}`}
                leading={<StatusDot tone={seen ? 'ok' : 'info'} srLabel={seen ? 'Read' : 'Not read yet'} />}
                title={`A message you accepted ${when(entry.acceptedAt)}`}
                meta={[seen ? 'read' : 'not read yet', `original kept until ${when(entry.sourceExpiresAt)}`, `review kept until ${when(entry.recordExpiresAt)}`].join(' · ')}
                trailing={(
                  <ActionButtons
                    command="telegram" short actions={['read', 'cancel']} menu={['status', 'revoke', 'release']} menuLabel="More for this message"
                    prefill={{ message: id, ...(configuration ? { configuration, chat: configuration } : {}) }} onDone={onDone}
                  />
                )}
              />
            );
          })}
        </RowList>
      ) : null}
    </section>
  );
}

/** What each kind of approval asks about, and what to check before you answer one. */
function Kinds() {
  const read = useCommandRead('waiting-kinds', 'capabilities.run', { id: 'approval.kinds' });
  const kinds = asArray(asRecord(asRecord(read.data).data).kinds).map(asRecord).filter((kind) => text(kind.kind));
  return (
    <section aria-label="Kinds of approval">
      <div className="gv-command-screen__subhead"><h4>Kinds of approval</h4></div>
      <ReadState read={read} isEmpty={kinds.length === 0} empty="No kind of approval is described." />
      {kinds.length > 0 ? (
        <RowList aria-label="Kinds of approval">
          {kinds.map((kind) => <Row key={text(kind.kind)} title={text(kind.label)} meta={`Check before you answer: ${text(kind.check)}`} />)}
        </RowList>
      ) : null}
    </section>
  );
}

export function WaitingPanel() {
  const refresh = useRefreshCommandScreens();
  return (
    <CommandScreen
      command="waiting"
      title="Waiting for you"
      summary="What waits on your answer, what was decided for you, and the Telegram messages held for you."
      testId="waiting"
    >
      <OpenAsks />
      <section aria-label="Answered and decided">
        <OwnerQuestions enabled />
      </section>
      <Telegram onDone={refresh} />
      <Kinds />
    </CommandScreen>
  );
}
