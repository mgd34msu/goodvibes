/**
 * Work: everything working for you and everything waiting for you, grouped by
 * what you would do about it (ux A3.1): Waiting for you, Running now,
 * Scheduled, Finished, then one line for the platform's own background
 * services, which become rows only while one is unhealthy. The groups, their
 * rows, their words and every count are the work board's (work-items.ts over
 * contracts/src/work-board.ts); this view draws them and opens a row's detail.
 *
 * Header: "Work" and, while anything waits, the chip "2 waiting for you", then
 * "New". A search narrows the rows; Show switches to the fleet archive. On
 * desktop the first row waiting for you opens in the detail by itself; on a
 * phone the detail is a full-screen pane with Back. An ask opens its card
 * (ApprovalDetail, ux A2.5).
 *
 * Deep links: a push notification's `#approval-action=…` opens that approval
 * for review (Allow) or denies it (Deny) on mount (useApprovalActions);
 * `#fleet-node=…` opens that process. `?tab=checkpoints` (the old Checkpoints
 * page) opens the first session on its Checkpoints tab, or the workspace
 * checkpoints when there is no session; `?tab=plan` opens the project work plan.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, History, Inbox, ListChecks, RefreshCw, Search } from 'lucide-react';
import type { BoardRow } from '@goodvibes/engine/contracts';
import { client as platformClient } from '../../lib/goodvibes';
import { firstArray, firstString } from '../../lib/object';
import { queryKeys } from '../../lib/queries';
import type { WorkTab } from '../../lib/router';
import { WORK } from '../../components/shell/nav';
import { parseFleetFocusFromHash, stripFleetFocusFragment } from '../../lib/push/fleet-focus-link';
import { formatError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { approvalAsk } from '../../lib/asks';
import { isClosedStatus } from '../../lib/sessions-union';
import { useOpenAsks } from '../../hooks/useOpenAsks';
import {
  DataPage,
  DetailPane,
  Disclosure,
  EmptyState,
  ListDetail,
  SkeletonRows,
} from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { Chip } from '../../components/ui/Chip';
import { IconButton } from '../../components/ui/IconButton';
import { Input } from '../../components/ui/Field';
import { Row, RowList } from '../../components/ui/Row';
import { Select } from '../../components/ui/Select';
import { PHONE_QUERY, useMediaQuery } from '../../components/ui/overlay';
import { ApprovalDetail } from './ApprovalDetail';
import { AttemptGroupDetail } from './AttemptGroupDetail';
import { CheckpointsPanel } from './CheckpointsPanel';
import { CiWatchDetail } from './CiWatchDetail';
import { useHostedAttachment } from './HostedSessionDetail';
import { HostedSessionWorkDetail } from './HostedSessionWorkDetail';
import { NewWorkMenu } from './NewWorkMenu';
import { CommandScreenDrawer } from '../../components/command/screens/CommandScreens';
import { findCommandAction } from '../../components/command/ActionSheet';

/** The Scheduled group's management, in /schedule's own words. */
const seeSchedules = findCommandAction('schedule', 'see-schedules')?.action.label;
import { OwnerQuestions } from './OwnerQuestions';
import { useContractScope } from '../../hooks/useContracts';
import type { ClientLifetime } from '../../lib/client-lifetime';
import { ContractDetail } from './ContractDetail';
import { ProcessDetail } from './ProcessDetail';
import { SessionDetail, type SessionTab } from './SessionDetail';
import { TaskDetail } from './TaskDetail';
import { WorkPlanPanel } from './WorkPlanPanel';
import { useApprovalActions } from './useApprovalActions';
import { useAskActions } from './useAskActions';
import { useWorkData } from './useWorkData';
import { archivedRows, fleetStatePhrase, matchesQuery, readWork, workKeyOf } from './work-items';
import '../../styles/components/work.css';
import { nonEmpty } from '../../lib/non-empty';

/** The workspace checkpoints detail, for when no session exists. */
const WORKSPACE_CHECKPOINTS_KEY = 'workspace:checkpoints';
/** The project work plan detail. */
const WORK_PLAN_KEY = 'workspace:work-plan';

type ShowScope = 'active' | 'archived';

export interface WorkViewProps {
  tab?: string;
  onTabChange: (tab: WorkTab) => void;
  /** The fleet subscription is live (the poll recedes to a safety cadence). */
  subscriptionActive?: boolean;
  /** The shared session stream owns ordinary and hosted list updates. */
  sessionSubscriptionActive?: boolean;
  /** The session-update stream is paused (steer confirmations may lag). */
  streamPaused?: boolean;
  /** Open a session in the Chat view. */
  onOpenSession?: (sessionId: string) => void;
}

/** A hosted session is a session: its one row and pane live under `session:<id>`, so an older `hosted:<id>` key opens the same. */
function workKey(key: string): string {
  return key.startsWith('hosted:') ? `session:${key.slice('hosted:'.length)}` : key;
}

/**
 * The clock the rows' words read ("started 15 s ago", "goes ahead in 9 min"):
 * re-read every 10 s while something runs or counts down, every minute
 * otherwise. Rendering only; no request.
 */
function useNow(fast: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), fast ? 10_000 : 60_000);
    return () => window.clearInterval(timer);
  }, [fast]);
  return now;
}

function BoardRowItem({ row, selected, child, onSelect }: { row: BoardRow; selected: boolean; child: boolean; onSelect: () => void }) {
  return (
    <Row
      className={child ? 'work-row work-row--board work-row--child' : 'work-row work-row--board'}
      selected={selected}
      onSelect={onSelect}
      title={row.title}
      meta={row.meta.full || undefined}
      aria-label={[row.title, row.meta.full].filter(Boolean).join(', ')}
    />
  );
}

function BoardGroup({ label, rows, selectedKey, onOpen, action }: {
  label: string; rows: readonly BoardRow[]; selectedKey: string; onOpen: (key: string) => void;
  /** The group's own management, beside its heading (the Scheduled group opens the schedules screen). */
  action?: { readonly label: string; readonly run: () => void } | undefined;
}) {
  if (rows.length === 0) return null;
  const ids = new Set(rows.map((row) => row.ref.id));
  return (
    <section className="work-board__group" aria-label={`${label}, ${rows.length}`}>
      <div className="work-board__head">
        <h3 className="work-board__label">{label} · {rows.length}</h3>
        {action ? <Button size="sm" variant="ghost" onClick={action.run}>{action.label}</Button> : null}
      </div>
      <RowList aria-label={label}>
        {rows.map((row) => {
          const key = workKeyOf(row);
          return (
            <BoardRowItem
              key={key}
              row={row}
              child={row.parentId !== undefined && ids.has(row.parentId)}
              selected={key === selectedKey}
              onSelect={() => onOpen(key)}
            />
          );
        })}
      </RowList>
    </section>
  );
}

export function WorkView(props: WorkViewProps) {
  const contractScope = useContractScope();
  // Reset selection and drafts synchronously on identity change. A remembered
  // contract id must never be replayed against a newly signed-in account.
  return <WorkViewContent key={contractScope.revision} {...props} contractScope={contractScope} />;
}

function WorkViewContent({ contractScope, tab, subscriptionActive = true, sessionSubscriptionActive = false, streamPaused = false, onOpenSession }: WorkViewProps & { contractScope: ClientLifetime }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const phone = useMediaQuery(PHONE_QUERY);
  const [query, setQuery] = useState('');
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const [scope, setScope] = useState<ShowScope>('active');
  const [archiving, setArchiving] = useState(false);
  const [servicesOpen, setServicesOpen] = useState(false);

  // A needs-input push opens the app at #fleet-node=<id>: read it once, then scrub it.
  const [initialFocus] = useState(() => (typeof window !== 'undefined' ? parseFleetFocusFromHash(window.location.hash) : null));
  useEffect(() => {
    if (initialFocus) stripFleetFocusFragment();
  }, [initialFocus]);

  const [selectedKey, setSelectedKey] = useState<string>(() => (initialFocus ? `fleet:${initialFocus.nodeId}` : tab === 'plan' ? WORK_PLAN_KEY : ''));
  // After the person closes a detail, the first waiting row does not reopen by itself.
  const dismissedRef = useRef(Boolean(initialFocus) || tab === 'plan');
  const [sessionTab, setSessionTab] = useState<SessionTab>(tab === 'checkpoints' ? 'checkpoints' : 'transcript');

  const archived = scope === 'archived';
  const data = useWorkData({
    contractScope,
    subscriptionActive,
    archived,
    // Finished work is a group of the board (the newest ten), so finished hosted sessions are read too.
    includeFinished: !archived,
    hostedStreamConnected: sessionSubscriptionActive,
  });
  const { asks, inboxError, retryInbox } = useOpenAsks(!archived);
  const closeDetail = useCallback(() => {
    dismissedRef.current = true;
    setSelectedKey('');
  }, []);
  // The hosted sessions that open in the live pane. That pane needs an attach,
  // which the daemon refuses once a session has ended and cannot make once it
  // has retired one, so an ended or no-longer-listed hosted session that has a
  // session record opens the session pane instead (stored transcript, Close,
  // Reopen, Delete, Open in chat). An ended one with no session record keeps
  // the live pane, the only place it is shown. Before the hosted list has
  // answered, an open record of kind hosted is taken as live.
  const hostedListPending = data.hosted.isPending;
  const hostedPaneIds = useMemo(() => {
    const recordIds = new Set(data.sessionRecords.map((record) => record.id));
    const ids = new Set(data.hostedRecords
      .filter((session) => session.status !== 'terminated' || !recordIds.has(session.id))
      .map((session) => session.id));
    if (hostedListPending) {
      for (const record of data.sessionRecords) {
        if (record.kind === 'hosted' && !isClosedStatus(record.status)) ids.add(record.id);
      }
    }
    return ids;
  }, [data.hostedRecords, data.sessionRecords, hostedListPending]);
  const selectedSessionId = selectedKey.startsWith('session:') ? selectedKey.slice('session:'.length) : null;
  // A pane that attached keeps its live attachment until it is closed, even when
  // the session ends in view and the hosted list stops showing it.
  const [keptHostedId, setKeptHostedId] = useState<string | null>(null);
  const selectedHostedId = selectedSessionId !== null
    && (hostedPaneIds.has(selectedSessionId) || keptHostedId === selectedSessionId) ? selectedSessionId : null;
  const hostedAttachment = useHostedAttachment(selectedHostedId, data.hostedRecords, closeDetail);
  const attachedHostedId = hostedAttachment.session?.id ?? null;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- follows the attachment's own state, which settles after render
    setKeptHostedId(attachedHostedId !== null && attachedHostedId === selectedSessionId ? attachedHostedId : null);
  }, [attachedHostedId, selectedSessionId]);
  // A push notification's "Allow" opens the approval for review; it never approves by itself.
  const approvalActions = useApprovalActions({
    onOpenApproval: (id) => {
      dismissedRef.current = true;
      setSelectedKey(`approval:${id}`);
    },
  });
  const askActions = useAskActions(approvalActions);

  // The chat list the sidebar already reads (same key and request), for each chat's current title.
  const chatList = useQuery({
    queryKey: ['companion-chat', 'sessions'],
    queryFn: () => platformClient.chat.sessions.list({ limit: 100 }),
  });
  const chatTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const session of firstArray(chatList.data, ['sessions'])) {
      const id = firstString(session, ['id', 'sessionId']);
      const title = firstString(session, ['title']);
      if (id && title) titles.set(id, title);
    }
    return titles;
  }, [chatList.data]);

  const running = data.nodes.some((node) => node.state !== 'idle' && node.state !== 'paused') || asks.some((ask) => ask.presentation.countdown !== undefined);
  const now = useNow(running);
  const work = useMemo(() => readWork({
    asks,
    nodes: data.nodes,
    attemptGroups: data.attemptGroups,
    sessions: data.sessionRecords,
    chatTitles,
    hosted: data.hostedRecords,
    tasks: data.taskRecords,
    ciWatches: data.watchRecords,
    contracts: data.contractRecords,
  }, now), [asks, data.nodes, data.attemptGroups, data.sessionRecords, chatTitles, data.hostedRecords, data.taskRecords, data.watchRecords, data.contractRecords, now]);
  const board = work.board;
  const archive = useMemo(() => (archived ? archivedRows(data.nodes, now) : []), [archived, data.nodes, now]);
  const filter = (rows: readonly BoardRow[]) => rows.filter((row) => matchesQuery(row, query));
  const groups = {
    waiting: filter(board.groups.waiting),
    running: filter(board.groups.running),
    scheduled: filter(board.groups.scheduled),
    finished: filter(board.groups.finished),
    unhealthy: filter(board.services.unhealthy),
    archive: filter(archive),
  };
  const systemNodes = useMemo(
    () => data.liveNodes.filter((node) => (node as { serves?: unknown }).serves === 'system'),
    [data.liveNodes],
  );
  const openSessions = work.openSessions.filter((session) => !query.trim() || session.title.toLowerCase().includes(query.trim().toLowerCase()));

  const openItem = useCallback((raw: string) => {
    const key = workKey(raw);
    setSelectedKey(key);
    if (key.startsWith('session:')) setSessionTab((current) => (tab === 'checkpoints' ? 'checkpoints' : current));
  }, [tab]);

  // Desktop: the first row waiting for you opens by itself, until the person closes a detail.
  const firstWaiting = archived ? undefined : groups.waiting[0];
  useEffect(() => {
    if (phone || selectedKey || dismissedRef.current || !firstWaiting) return;
    setSelectedKey(workKeyOf(firstWaiting));
  }, [phone, selectedKey, firstWaiting]);

  // The old Checkpoints page: a session's Checkpoints tab, or the workspace checkpoints.
  const checkpointsHandled = useRef(false);
  useEffect(() => {
    if (tab !== 'checkpoints' || checkpointsHandled.current || !data.sessions.isFetched) return;
    checkpointsHandled.current = true;
    const firstSession = data.sessionRecords[0];
    setSessionTab('checkpoints');
    setSelectedKey(firstSession ? `session:${firstSession.id}` : WORKSPACE_CHECKPOINTS_KEY);
  }, [tab, data.sessionRecords, data.sessions.isFetched]);

  const restart = useMutation({
    mutationFn: (id: string) => platformClient.operator.fleet.resume(id),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: queryKeys.fleet }); },
    onError: (error) => toast({ title: 'Could not restart it', description: formatError(error), tone: 'danger' }),
  });

  const archiveFinished = async () => {
    setArchiving(true);
    try {
      const result = await platformClient.operator.fleet.archiveFinished();
      toast({
        title: result.archivedCount > 0
          ? `Archived ${result.archivedCount} finished process${result.archivedCount === 1 ? '' : 'es'}`
          : 'No fully finished processes to archive',
        tone: 'info',
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.fleet });
    } catch (error) {
      toast({ title: 'Archive failed', description: formatError(error), tone: 'danger' });
    } finally {
      setArchiving(false);
    }
  };

  const refreshAll = () => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.contracts }),
      queryClient.invalidateQueries({ queryKey: queryKeys.workPlan }),
      queryClient.invalidateQueries({ queryKey: queryKeys.ownerInbox }),
      data.snapshot.refetch(),
      data.approvals.refetch(),
      data.sessions.refetch(),
      data.hosted.refetch(),
      data.tasks.refetch(),
      data.ciWatches.refetch(),
      ...(archived ? [data.archivedList.refetch()] : []),
    ]);
  };

  const detail = (() => {
    if (selectedKey === WORKSPACE_CHECKPOINTS_KEY) {
      return (
        <DetailPane title="Workspace checkpoints" meta="Snapshots of the workspace tree" onClose={closeDetail} closeLabel="Close checkpoints">
          <CheckpointsPanel />
        </DetailPane>
      );
    }
    if (selectedKey === WORK_PLAN_KEY) {
      return (
        <DetailPane title="Work plan" meta="The project’s checklist, shared with the terminal app and the Agent" onClose={closeDetail} closeLabel="Close work plan">
          <WorkPlanPanel lifetime={contractScope} />
        </DetailPane>
      );
    }
    if (!selectedKey) return null;
    const [type, ...rest] = selectedKey.split(':');
    const id = rest.join(':');
    switch (type) {
      case 'contract':
        return <ContractDetail key={id} id={id} lifetime={contractScope} live={subscriptionActive} onClose={closeDetail}
          onOpenProcess={data.liveNodes.some((node) => node.kind === 'contract' && node.id === `contract:${id}`)
            ? () => openItem(`fleet:contract:${id}`) : undefined} />;
      case 'approval': {
        const record = data.approvalRecords.find((a) => a.id === id);
        const ask = asks.find((entry) => entry.key === selectedKey) ?? (record ? approvalAsk(record) : undefined);
        return ask ? <ApprovalDetail key={ask.key} ask={ask} approvalActions={approvalActions} askActions={askActions} now={now} onClose={closeDetail} /> : null;
      }
      case 'inbox': {
        const ask = asks.find((entry) => entry.key === selectedKey);
        return ask ? <ApprovalDetail key={ask.key} ask={ask} approvalActions={approvalActions} askActions={askActions} now={now} onClose={closeDetail} /> : null;
      }
      case 'fleet': {
        const node = data.nodes.find((n) => n.id === id) ?? data.liveNodes.find((n) => n.id === id);
        return node ? (
          <ProcessDetail
            key={node.id}
            node={node}
            archived={archived}
            approvals={data.approvalRecords}
            onOpenItem={openItem}
            onClose={closeDetail}
            onGone={closeDetail}
            onOpenContract={node.kind === 'contract' && node.id.startsWith('contract:') ? () => openItem(node.id) : undefined}
          />
        ) : null;
      }
      case 'attempt-group': {
        const group = data.attemptGroups.find((g) => g.groupId === id);
        return group ? <AttemptGroupDetail key={group.groupId} group={group} onClose={closeDetail} /> : null;
      }
      case 'session': {
        const record = data.sessionRecords.find((s) => s.id === id);
        if (selectedHostedId === id) {
          return (
            <HostedSessionWorkDetail
              key={id}
              sessionId={id}
              attachment={hostedAttachment}
              record={record}
              listed={data.hostedRecords.find((h) => h.id === id)}
              fallbackTitle={nonEmpty(record?.title) ?? nonEmpty(data.hostedRecords.find((h) => h.id === id)?.title) ?? id}
              tab={sessionTab}
              onTabChange={setSessionTab}
              streamPaused={streamPaused}
              onClose={closeDetail}
            />
          );
        }
        return record ? (
          <SessionDetail
            key={record.id}
            record={chatTitles.has(record.id) ? { ...record, title: chatTitles.get(record.id) ?? record.title } : record}
            agents={data.liveNodes.filter((n) => n.sessionRef?.sessionId === record.id)}
            tab={sessionTab}
            onTabChange={setSessionTab}
            streamPaused={streamPaused}
            onOpenItem={openItem}
            onOpenInChat={onOpenSession}
            onClose={closeDetail}
          />
        ) : null;
      }
      case 'task': {
        const task = data.taskRecords.find((t) => t.id === id);
        return task ? <TaskDetail key={task.id} task={task} onClose={closeDetail} /> : null;
      }
      case 'ci-watch': {
        const watch = data.watchRecords.find((w) => w.id === id);
        return watch ? <CiWatchDetail key={watch.id} watch={watch} onClose={closeDetail} onOpenSession={onOpenSession} /> : null;
      }
      default:
        return null;
    }
  })();

  const anyRows = archived
    ? groups.archive.length > 0
    : groups.waiting.length + groups.running.length + groups.scheduled.length + groups.finished.length + groups.unhealthy.length > 0;
  const nothingAtAll = !data.firstLoad && data.failures.length === 0 && !anyRows && (archived || openSessions.length === 0);

  const list = (
    <div className="work-board">
      {data.failures.map(({ label, query: failed }) => (
        <p key={label} className="dv-notice dv-notice--bad work-notice" role="alert">
          Could not load {label}: {formatError(failed.error)}
          {' '}
          <Button size="sm" variant="ghost" onClick={() => void failed.refetch()}>Retry</Button>
        </p>
      ))}
      {!archived && inboxError && (
        <p className="dv-notice dv-notice--bad work-notice" role="alert">
          Questions and purchase windows could not be read: {inboxError}.
          {' '}
          <Button size="sm" variant="ghost" onClick={retryInbox}>Retry</Button>
        </p>
      )}
      {data.hostedUnreadable && (
        <p className="dv-notice work-notice" role="note">
          The daemon answered the hosted session list in a shape this client does not understand, so hosted sessions are not shown.
        </p>
      )}
      {data.truncated && (
        <p className="dv-notice work-notice" role="note">
          Showing {data.truncated.shown} of {data.truncated.total} processes: the daemon caps the fleet snapshot at 2000.
        </p>
      )}

      {data.firstLoad && <SkeletonRows count={6} label="Loading work" />}

      {!data.firstLoad && !archived && (
        <>
          <BoardGroup label="Waiting for you" rows={groups.waiting} selectedKey={selectedKey} onOpen={openItem} />
          <BoardGroup label="Running now" rows={groups.running} selectedKey={selectedKey} onOpen={openItem} />
          <BoardGroup label="Scheduled" rows={groups.scheduled} selectedKey={selectedKey} onOpen={openItem} action={seeSchedules ? { label: seeSchedules, run: () => setSchedulesOpen(true) } : undefined} />
          <BoardGroup label="Finished" rows={groups.finished} selectedKey={selectedKey} onOpen={openItem} />

          <div className="work-services">
            <button
              type="button"
              className="work-services__link"
              aria-expanded={servicesOpen}
              onClick={() => setServicesOpen((open) => !open)}
            >
              Background services: {board.services.healthy} healthy ›
            </button>
            {servicesOpen && systemNodes.length > 0 && (
              <ul className="work-services__list" aria-label="Background services">
                {systemNodes.map((node) => (
                  <li key={node.id} className="work-services__item">
                    <span>{node.label || node.id}</span>
                    <span className="work-services__state">{fleetStatePhrase(node.state)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {groups.unhealthy.length > 0 && (
            <section className="work-board__group" aria-label="Needs attention">
              <h3 className="work-board__label">Needs attention</h3>
              <RowList aria-label="Needs attention">
                {groups.unhealthy.map((row) => (
                  <Row
                    key={row.ref.id}
                    className="work-row work-row--board"
                    title={row.title}
                    meta={row.meta.full || undefined}
                    selected={workKeyOf(row) === selectedKey}
                    onSelect={() => openItem(workKeyOf(row))}
                    trailing={row.actions.includes('resume') ? (
                      <Button size="sm" variant="secondary" disabled={restart.isPending} onClick={() => restart.mutate(row.ref.id)}>Restart</Button>
                    ) : undefined}
                  />
                ))}
              </RowList>
            </section>
          )}

          {openSessions.length > 0 && (
            <Disclosure summary={`Open sessions between turns: ${openSessions.length}${data.moreSessions ? '+' : ''}`}>
              <RowList aria-label="Open sessions">
                {openSessions.map((session) => (
                  <Row
                    key={session.id}
                    className="work-row work-row--board"
                    title={session.title}
                    selected={`session:${session.id}` === selectedKey}
                    onSelect={() => openItem(`session:${session.id}`)}
                  />
                ))}
                {data.moreSessions && (
                  <Row
                    className="work-row work-row--board"
                    title={data.moreSessions.loading ? 'Loading…'
                      : data.moreSessions.error ? `Older sessions could not be read: ${data.moreSessions.error}. Select to try again.`
                        : 'Show older sessions'}
                    onSelect={data.moreSessions.loading ? undefined : data.moreSessions.load}
                  />
                )}
              </RowList>
            </Disclosure>
          )}

          <OwnerQuestions enabled />
        </>
      )}

      {!data.firstLoad && archived && (
        <BoardGroup label="Archive" rows={groups.archive} selectedKey={selectedKey} onOpen={openItem} />
      )}

      {nothingAtAll && (
        query.trim() ? (
          <EmptyState icon={<Search />} action={<Button onClick={() => setQuery('')}>Clear search</Button>}>
            Nothing here matches “{query.trim()}”.
          </EmptyState>
        ) : archived ? (
          <EmptyState icon={<Archive />} action={<Button onClick={() => setScope('active')}>Show active work</Button>}>
            Finished processes you archive stay browsable here.
          </EmptyState>
        ) : (
          <EmptyState icon={<Inbox />}>
            Nothing is running and nothing is waiting for you.
          </EmptyState>
        )
      )}

      {!data.firstLoad && (
        <div className="work-list-footer">
          <Button
            size="sm"
            variant="ghost"
            icon={<ListChecks aria-hidden="true" />}
            onClick={() => { dismissedRef.current = true; setSelectedKey(WORK_PLAN_KEY); }}
          >
            Work plan
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<History aria-hidden="true" />}
            onClick={() => { dismissedRef.current = true; setSessionTab('checkpoints'); setSelectedKey(WORKSPACE_CHECKPOINTS_KEY); }}
          >
            Workspace checkpoints
          </Button>
          {!archived && (
            <Button size="sm" variant="ghost" icon={<Archive aria-hidden="true" />} disabled={archiving} onClick={() => void archiveFinished()}>
              {archiving ? 'Archiving…' : 'Archive finished processes'}
            </Button>
          )}
        </div>
      )}
    </div>
  );

  const waitingCount = board.counts.waiting;

  return (
    <DataPage
      title={WORK.label}
      action={(
        <span className="work-header__actions">
          {!archived && waitingCount > 0 && (
            <Chip tone="warn" className="work-header__chip">{waitingCount} waiting for you</Chip>
          )}
          <NewWorkMenu lifetime={contractScope} onCreated={(key) => { dismissedRef.current = true; setSelectedKey(workKey(key)); }} onSchedules={() => setSchedulesOpen(true)} />
          <CommandScreenDrawer screen={schedulesOpen ? 'schedules' : null} onClose={() => setSchedulesOpen(false)} />
        </span>
      )}
      filters={(
        <>
          <div className="dv-filters__search">
            <Input
              type="search"
              className="gv-input--search"
              aria-label="Search work"
              placeholder="Search work"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="dv-filters__end">
            <Select<ShowScope>
              aria-label="Show"
              value={scope}
              onChange={(next) => { setScope(next); if (selectedKey.startsWith('fleet:') || selectedKey.startsWith('contract:')) setSelectedKey(''); }}
              placement="bottom-end"
              options={[
                { value: 'active', label: 'Active' },
                { value: 'archived', label: 'Archive' },
              ]}
            />
            <IconButton label="Refresh" icon={<RefreshCw />} onClick={refreshAll} />
          </div>
        </>
      )}
    >
      <ListDetail
        list={list}
        detail={detail}
        detailOpen={Boolean(detail)}
        onCloseDetail={closeDetail}
        listLabel="Work"
        detailLabel="Detail"
        backLabel="All work"
      />
    </DataPage>
  );
}
