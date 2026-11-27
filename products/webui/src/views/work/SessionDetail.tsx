/**
 * A session from the cross-surface session union in the Work view's detail
 * pane (design doc "Data views": "Detail pane shows the session transcript,
 * its agents, its checkpoints and its actions (steer, stop, open in chat)").
 *
 * Tabs: Transcript (retained messages, live compaction receipts, the steer
 * composer), Changes (the session's diff with per-hunk comments and reverts),
 * Rewind, and Checkpoints (the workspace checkpoints this session works in).
 *
 * Moved from the old Sessions view with its honesty kept: permission mode and
 * context usage read only for the daemon's own live session (an honest
 * "unavailable" otherwise), cost only when the daemon priced something in the
 * last 24 hours (no "price unknown" chip), close keeps history and reopens,
 * delete is a real hard delete offered only when the daemon has the verb and
 * reconciled against a fresh list before it reports success.
 */
import { OwnerApprovalPendingError } from '../../lib/owner-approval';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, MoreHorizontal } from 'lucide-react';
import { client as platformClient } from '../../lib/goodvibes';
import type { FleetProcessNode } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { formatSessionContextUsage } from '../../lib/session-context-usage';
import {
  type UnionSessionRecord,
  kindLabel,
  projectLabel,
  isClosedStatus,
  isReapedStatus,
  canSteer,
  retentionLabel,
  attributionLabel,
  statusLabel,
} from '../../lib/sessions-union';
import { companionMessagesFromListResponse } from '../../lib/companion-chat';
import { asRecord, firstString } from '../../lib/object';
import { errorCode, formatError, isMethodUnavailableError, isSessionNotLocalError } from '../../lib/errors';
import { gatePresetLabel, type SettableGatePresetName } from '@goodvibes/engine/platform/platform/gate/presets';
import { outcomeLabel, type CompactionCheck, type CompactionReceipt } from '../../lib/compaction';
import { useCompactionReceipts } from '../../hooks/useCompactionReceipts';
import { PermissionModeSheet } from '../../components/confirm/PermissionModeSheet';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useSessionLifecycle } from '../../hooks/useSessionLifecycle';
import { PriceSourceNote } from '../../components/pricing/PriceSourceNote';
import { costAmountLabel } from '../../lib/cost-source';
import { DetailPane, DetailSection, Facts } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import { Menu, MenuItem } from '../../components/ui/Menu';
import { Row, RowList } from '../../components/ui/Row';
import { Segmented } from '../../components/ui/Segmented';
import { StatusDot } from '../../components/ui/StatusDot';
import { SteerComposer } from '../sessions/SteerComposer';
import { SessionChanges } from '../sessions/SessionChanges';
import { SessionRewind } from '../sessions/SessionRewind';
import { CheckpointsPanel } from './CheckpointsPanel';
import { fleetKindPhrase, fleetStatePhrase, fleetTone, sentenceCase, whenLabel } from './work-items';

export type SessionTab = 'transcript' | 'changes' | 'rewind' | 'checkpoints';

const SESSION_TABS: readonly { value: SessionTab; label: string }[] = [
  { value: 'transcript', label: 'Transcript' },
  { value: 'changes', label: 'Changes' },
  { value: 'rewind', label: 'Rewind' },
  { value: 'checkpoints', label: 'Checkpoints' },
];

type DeleteCapability = 'available' | 'unavailable' | 'uncertain' | 'checking';

/** Messages per transcript page: the daemon's default page, read newest first. */
const TRANSCRIPT_PAGE = 100;

/** Kinds whose sessions the Chat view can open. */
const CHAT_KINDS = new Set(['companion-chat']);

/** `daemonWide`: the session has no mode of its own (a chat), so its mode is the daemon's and changing it changes that. */
function PermissionModeFact({ sessionId, daemonWide = false }: { sessionId: string; daemonWide?: boolean }) {
  const queryClient = useQueryClient();
  const [sheetOpen, setSheetOpen] = useState(false);
  const modeQuery = useQuery({
    queryKey: queryKeys.sessionPermissionMode(sessionId),
    queryFn: () => platformClient.operator.sessions.permissionMode.get(sessionId),
    enabled: Boolean(sessionId),
    staleTime: 15_000,
    retry: false,
  });
  const notLocal = modeQuery.isError && isSessionNotLocalError(modeQuery.error);
  const mode = modeQuery.data?.mode ?? '';
  // When the mode in force is not the one chosen (or saved), the daemon says which was chosen and why.
  const chosenMode = modeQuery.data?.chosenMode;
  const reason = modeQuery.data?.reason;
  const setMode = useMutation({
    mutationFn: (nextMode: SettableGatePresetName) => platformClient.operator.sessions.permissionMode.set(sessionId, nextMode),
    onSuccess: async () => {
      setSheetOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessionPermissionMode(sessionId) });
    },
    // A looser mode put to the owner waits for their approval (OwnerApprovalNotices says so); the mode shown stays the one in force.
    onError: (error: unknown) => {
      if (error instanceof OwnerApprovalPendingError) setSheetOpen(false);
    },
  });

  if (notLocal) {
    return (
      <span title="When GoodVibes asks is only readable and settable for the daemon's own live local session; this session runs elsewhere">
        Unavailable here
      </span>
    );
  }
  return (
    <span className="work-inline-action">
      {mode ? gatePresetLabel(mode) : modeQuery.isLoading ? 'Loading…' : 'Unknown'}
      {mode && daemonWide ? <span className="text-muted-foreground"> (the daemon's mode, shared by every chat)</span> : null}
      {mode && chosenMode && chosenMode !== mode && reason
        ? <span className="text-muted-foreground" role="note">{` (in force; ${gatePresetLabel(chosenMode)} chosen, but ${reason})`}</span>
        : null}
      <Button size="sm" variant="ghost" onClick={() => setSheetOpen(true)} disabled={!mode} aria-label="Change when GoodVibes asks">
        Change
      </Button>
      <PermissionModeSheet
        open={sheetOpen}
        currentMode={mode}
        pendingMode={setMode.isPending ? setMode.variables : undefined}
        onSelect={(nextMode) => setMode.mutate(nextMode)}
        onCancel={() => setSheetOpen(false)}
      />
      {setMode.isError && <span className="work-error" role="alert">{formatError(setMode.error)}</span>}
    </span>
  );
}

/** Estimated context usage; the "~" says it is the token estimator's figure. */
function useContextUsage(sessionId: string, check: CompactionCheck | null): string {
  const usage = useQuery({
    queryKey: queryKeys.sessionContextUsage(sessionId),
    queryFn: () => platformClient.operator.sessions.contextUsage.get(sessionId),
    enabled: Boolean(sessionId),
    staleTime: 10_000,
    retry: false,
  });
  const { refetch } = usage;
  const lastCheckAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!check || check.receivedAt === lastCheckAtRef.current) return;
    lastCheckAtRef.current = check.receivedAt;
    void refetch();
  }, [check, refetch]);
  if (usage.isError && isSessionNotLocalError(usage.error)) return 'Unavailable here';
  if (usage.isError && errorCode(usage.error) === 'CONTEXT_USAGE_UNAVAILABLE') return 'Not reported';
  if (!usage.data) return '';
  return formatSessionContextUsage(usage.data);
}

/** The session's cost over the last 24 hours, only when something was priced. */
function useKnownCost(sessionId: string) {
  const attribution = useQuery({
    queryKey: queryKeys.costAttribution('24h', 'session'),
    queryFn: () => platformClient.operator.cost.attribution.get({ window: '24h', dimension: 'session' }),
    enabled: Boolean(sessionId),
    staleTime: 30_000,
    retry: false,
  });
  const row = attribution.data?.rows.find((r) => r.key === sessionId);
  if (row?.costUsd == null) return null;
  return (
    <span className="work-cost" title={`${row.pricedRecordCount} priced and ${row.unpricedRecordCount} unpriced record(s) in the last 24 hours`}>
      {costAmountLabel(row.costUsd, row.costState)}
      <PriceSourceNote costSource={row.costSource} pricingAsOf={row.pricingAsOf} />
    </span>
  );
}

function CompactionReceiptNote({ receipt }: { receipt: CompactionReceipt }) {
  return (
    <li className="work-transcript__receipt" role="note">
      <span className="work-transcript__role">Compaction</span>
      <span>
        {outcomeLabel(receipt.outcome)} · {receipt.trigger} · {receipt.strategy || 'unknown strategy'}
        {receipt.qualityGrade ? ` · grade ${receipt.qualityGrade} (${Math.round(receipt.qualityScore * 100)}%)` : ''}
        {' · '}{receipt.tokensBefore.toLocaleString()} to {receipt.tokensAfter.toLocaleString()} tokens
        {' · '}{receipt.messagesBefore} to {receipt.messagesAfter} messages
        {receipt.requestedStrategy ? ` · requested ${receipt.requestedStrategy}${receipt.strategyFallbackReason ? `: ${receipt.strategyFallbackReason}` : ''}` : ''}
        {receipt.instructionsReinjected ? ' · instructions reinjected' : ' · instructions not reinjected'}
        {receipt.validationPassed ? ' · validation passed' : ' · validation failed'}
        {receipt.detail ? ` · ${receipt.detail}` : ''}
      </span>
    </li>
  );
}

export interface SessionDetailProps {
  record: UnionSessionRecord;
  /** Fleet nodes whose session is this one (its agents). */
  agents: readonly FleetProcessNode[];
  tab: SessionTab;
  onTabChange: (tab: SessionTab) => void;
  streamPaused: boolean;
  onOpenItem: (key: string) => void;
  onOpenInChat?: (sessionId: string) => void;
  onClose: () => void;
}

export function SessionDetail({ record, agents, tab, onTabChange, streamPaused, onOpenItem, onOpenInChat, onClose }: SessionDetailProps) {
  const lifecycle = useSessionLifecycle(record.id, onClose);
  const closed = isClosedStatus(record.status);
  const reaped = isReapedStatus(record);
  const retention = retentionLabel(record);
  const compaction = useCompactionReceipts(record.id, Boolean(record.id));
  const contextUsage = useContextUsage(record.id, compaction.latestCheck);
  const cost = useKnownCost(record.id);

  // A chat's messages are the chat's own (the companion chat store); its shared
  // session record only mirrors that the chat exists, so its count reads 0. The
  // read is the one the chat view makes, under the same key.
  const companionChat = record.kind === 'companion-chat';
  const chatMessages = useQuery({
    queryKey: ['companion-chat', record.id, 'messages'],
    queryFn: (): Promise<unknown> => platformClient.chat.messages.list(record.id),
    enabled: companionChat && Boolean(record.id) && tab === 'transcript',
  });
  // A shared session's messages come a page at a time, newest first: "Show older
  // messages" reads the page before with the daemon's offset, so the whole retained
  // history is reachable here; nothing past the newest page is read unless asked.
  const sharedMessages = useInfiniteQuery({
    queryKey: [...queryKeys.sessionMessages(record.id), 'pages'],
    initialPageParam: 0,
    queryFn: ({ pageParam }): Promise<unknown> => platformClient.operator.sessions.messages.list(record.id, { limit: TRANSCRIPT_PAGE, offset: pageParam }),
    getNextPageParam: (last) => {
      const page = asRecord(last);
      return page.hasMore === true && typeof page.nextOffset === 'number' ? page.nextOffset : undefined;
    },
    enabled: !companionChat && Boolean(record.id) && tab === 'transcript',
  });
  const messages = companionChat ? chatMessages : sharedMessages;
  const items = useMemo(
    () => companionChat
      ? companionMessagesFromListResponse(chatMessages.data)
      // Pages are newest first; each page is oldest first within itself.
      : [...(sharedMessages.data?.pages ?? [])].reverse().flatMap((page) => companionMessagesFromListResponse(page)),
    [companionChat, chatMessages.data, sharedMessages.data],
  );
  const messageTotal = companionChat
    ? (typeof asRecord(chatMessages.data).total === 'number' ? asRecord(chatMessages.data).total as number : items.length)
    : record.messageCount;

  // Whether this daemon has a real hard delete (sessions.delete). A 404
  // "Unknown gateway method" means it genuinely lacks it; any other failure is
  // "could not check", never a false "unavailable". Re-probed when the live
  // stream comes back (the daemon may have been upgraded meanwhile).
  const deleteCapability = useQuery({
    queryKey: ['capability', 'sessions.delete'],
    queryFn: () => platformClient.operator.control.methodInfo('sessions.delete'),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const deleteState: DeleteCapability = deleteCapability.isSuccess
    ? 'available'
    : deleteCapability.isError
      ? (isMethodUnavailableError(deleteCapability.error) ? 'unavailable' : 'uncertain')
      : 'checking';
  const { refetch: refetchDeleteCapability } = deleteCapability;
  const prevStreamPausedRef = useRef(streamPaused);
  useEffect(() => {
    if (prevStreamPausedRef.current && !streamPaused) void refetchDeleteCapability();
    prevStreamPausedRef.current = streamPaused;
  }, [streamPaused, refetchDeleteCapability]);

  const statusWord = reaped ? 'Reaped: reopens on the next activity' : closed ? 'Closed' : sentenceCase(statusLabel(record.status));
  const openInChat = onOpenInChat && CHAT_KINDS.has(record.kind) ? () => onOpenInChat(record.id) : undefined;

  const actions = (
    <>
      {openInChat && (
        <Button size="sm" icon={<ExternalLink aria-hidden="true" />} onClick={openInChat}>Open in chat</Button>
      )}
      {closed ? (
        <Button size="sm" disabled={lifecycle.disabled} onClick={() => lifecycle.ask('reopen')}>
          {lifecycle.phase === 'pending' && lifecycle.action === 'reopen' ? 'Reopening…' : 'Reopen'}
        </Button>
      ) : (
        <Button size="sm" disabled={lifecycle.disabled} onClick={() => lifecycle.ask('close')} title="Stops the session and keeps its history; it can be reopened">
          {lifecycle.phase === 'pending' && lifecycle.action === 'close' ? 'Closing…' : 'Close session'}
        </Button>
      )}
      <Menu
        label="More session actions"
        placement="bottom-end"
        trigger={(props) => <IconButton {...props} label="More session actions" icon={<MoreHorizontal />} />}
      >
        {deleteState === 'available' && (
          <MenuItem danger onSelect={() => lifecycle.ask('delete')} disabled={lifecycle.disabled}>
            {lifecycle.phase === 'pending' && lifecycle.action === 'delete' ? 'Deleting…' : 'Delete permanently'}
          </MenuItem>
        )}
        {deleteState === 'unavailable' && (
          <MenuItem disabled wrap>Permanent delete is not available on this daemon; close is the only removal.</MenuItem>
        )}
        {deleteState === 'uncertain' && (
          <MenuItem onSelect={() => void refetchDeleteCapability()} wrap>Could not check whether delete is available. Check again</MenuItem>
        )}
        {deleteState === 'checking' && <MenuItem disabled>Checking delete availability…</MenuItem>}
      </Menu>
    </>
  );

  return (
    <DetailPane
      title={record.title || record.id}
      status={(
        <span className="work-status">
          <StatusDot tone={record.lastError ? 'bad' : closed ? 'idle' : 'ok'} />
          {statusWord}
        </span>
      )}
      meta={[kindLabel(record.kind), projectLabel(record.project), whenLabel(record.updatedAt) ? `updated ${whenLabel(record.updatedAt)}` : ''].filter(Boolean).join(' · ')}
      actions={actions}
      onClose={onClose}
      closeLabel="Close session detail"
      tabs={(
        <Segmented<SessionTab>
          label="Session sections"
          value={tab}
          onChange={onTabChange}
          options={SESSION_TABS}
        />
      )}
    >
      <ConfirmDialog
        open={lifecycle.phase === 'confirming'}
        title={lifecycle.action === 'delete' ? 'Delete this session?' : 'Close this session?'}
        target={record.title}
        description={lifecycle.action === 'delete' ? 'The session record is removed for good and cannot be reopened.' : 'It stays in history and can be reopened.'}
        confirmLabel={lifecycle.action === 'delete' ? 'Delete' : 'Close session'}
        tone={lifecycle.action === 'delete' ? 'danger' : 'default'}
        onConfirm={lifecycle.confirm}
        onCancel={lifecycle.dismiss}
      />
      {lifecycle.notice && <p className="dv-notice dv-notice--bad" role="alert">
        {lifecycle.notice}
        {lifecycle.phase === 'no-answer' && <>{' '}<Button size="sm" variant="ghost" onClick={lifecycle.retry}>Retry</Button></>}
      </p>}
      {record.lastError && <p className="dv-notice dv-notice--bad" role="alert">Last error: {record.lastError}</p>}

      {tab === 'transcript' && (
        <>
          <Facts
            items={[
              { label: 'Messages', value: companionChat && !messages.isSuccess ? '' : `${messageTotal}${retention ? ` (${retention})` : ''}` },
              { label: 'Waiting inputs', value: record.pendingInputCount > 0 ? String(record.pendingInputCount) : '' },
              { label: 'Surfaces', value: record.surfaceKinds.join(', ') },
              { label: 'Attributed to', value: attributionLabel(record) ?? '' },
              { label: 'When GoodVibes asks', value: <PermissionModeFact sessionId={record.id} daemonWide={companionChat} /> },
              { label: 'Context', value: contextUsage },
              { label: 'Cost, last 24 hours', value: cost },
            ]}
          />

          {agents.length > 0 && (
            <DetailSection title="Agents">
              <RowList aria-label="Agents in this session">
                {agents.map((node) => (
                  <Row
                    key={node.id}
                    leading={<StatusDot tone={fleetTone(node)} />}
                    title={node.label || node.id}
                    meta={`${fleetKindPhrase(node.kind)} · ${fleetStatePhrase(node.state)}`}
                    onSelect={() => onOpenItem(`fleet:${node.id}`)}
                  />
                ))}
              </RowList>
            </DetailSection>
          )}
          {agents.length === 0 && record.activeAgentId && (
            <Facts items={[{ label: 'Active agent', value: record.activeAgentId }]} />
          )}

          <DetailSection title="Transcript">
            {messages.isError && <p className="dv-notice dv-notice--bad" role="alert">{formatError(messages.error)}</p>}
            {messages.isSuccess && !items.length && compaction.receipts.length === 0 && (
              <p className="work-prose work-prose--quiet">No retained messages.</p>
            )}
            {(items.length > 0 || compaction.receipts.length > 0) && (
              <ol className="work-transcript" aria-label="Transcript">
                {!companionChat && sharedMessages.hasNextPage && (
                  <li className="work-transcript__message">
                    <Button size="sm" variant="ghost" disabled={sharedMessages.isFetchingNextPage} onClick={() => void sharedMessages.fetchNextPage()}>
                      {sharedMessages.isFetchingNextPage ? 'Loading…' : 'Show older messages'}
                    </Button>
                  </li>
                )}
                {items.map((message, index) => (
                  <li key={firstString(message, ['id', 'messageId']) || String(index)} className="work-transcript__message">
                    <span className="work-transcript__role">{firstString(message, ['role', 'author', 'kind']) || 'message'}</span>
                    <span className="work-transcript__body">{firstString(message, ['body', 'content', 'text', 'message'])}</span>
                  </li>
                ))}
                {compaction.receipts.map((receipt, index) => (
                  <CompactionReceiptNote key={`${receipt.receivedAt}-${index}`} receipt={receipt} />
                ))}
              </ol>
            )}
          </DetailSection>

          <DetailSection title="Continue session">
            <SteerComposer sessionId={record.id} canSteer={canSteer(record)} closed={closed} streamPaused={streamPaused} />
          </DetailSection>
        </>
      )}

      {tab === 'changes' && (
        <SessionChanges sessionId={record.id} canSteer={canSteer(record)} closed={closed} streamPaused={streamPaused} />
      )}

      {tab === 'rewind' && <SessionRewind sessionId={record.id} closed={closed} />}

      {tab === 'checkpoints' && <CheckpointsPanel sessionId={record.id} />}
    </DetailPane>
  );
}
