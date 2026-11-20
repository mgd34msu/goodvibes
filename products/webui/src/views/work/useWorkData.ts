/**
 * Every read the Work view makes, in one place.
 *
 * Freshness follows the old views' rules: the fleet (and its archive and
 * best-of-N groups) polls at a slow safety cadence while the fleet
 * subscription is live and every 15 s when it is down; approvals refresh from
 * `approval-update` frames on the shared event stream and poll only while it
 * is down; hosted sessions poll slowly while their stream is up. Tasks, the
 * session union and CI watches refresh from realtime invalidation and after
 * mutations. A daemon without a verb (METHOD_NOT_FOUND) degrades to "none",
 * never an error banner.
 */
import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { client as platformClient } from '../../lib/goodvibes';
import type { FleetAttemptGroup } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { isMethodUnavailableError } from '../../lib/errors';
import { sortApprovalsNewestFirst } from '../../lib/approvals';
import { hostedSessionsFromListResult, sortHostedSessionsNewestFirst } from '../../lib/hosted-sessions';
import { sortUnionSessions, unionSessionFromRecord, unionSessionsFromListResponse } from '../../lib/sessions-union';
import { companionSessionsFromListResponse } from '../../lib/companion-chat';

/** The daemon's session snapshot (sessions.list) holds this many, newest first. */
const SESSION_SNAPSHOT_SIZE = 50;
/** One sessions.search page read by "Show older sessions". */
const OLDER_SESSIONS_PAGE = 100;
import { useEventStreamState } from '../../lib/event-stream';
import { useContractList } from '../../hooks/useContracts';
import { readSessionList } from '../../hooks/useSessionLifecycle';
import type { ClientLifetime } from '../../lib/client-lifetime';
import type { CiWatch } from './work-items';

const FLEET_FALLBACK_POLL_MS = 15_000;
const FLEET_SAFETY_POLL_MS = 60_000;

export interface WorkDataOptions {
  contractScope: ClientLifetime;
  subscriptionActive: boolean;
  /** Read the fleet archive instead of hiding finished work. */
  archived: boolean;
  /** Include finished hosted sessions. */
  includeFinished: boolean;
  /** The hosted-session stream is live. */
  hostedStreamConnected: boolean;
}

export function useWorkData({ contractScope, subscriptionActive, archived, includeFinished, hostedStreamConnected }: WorkDataOptions) {
  const pollInterval = subscriptionActive ? FLEET_SAFETY_POLL_MS : FLEET_FALLBACK_POLL_MS;

  const contracts = useContractList(contractScope, includeFinished, !archived, subscriptionActive);

  const snapshot = useQuery({
    queryKey: queryKeys.fleet,
    queryFn: () => platformClient.operator.fleet.snapshot(),
    refetchInterval: pollInterval,
  });
  const archivedList = useQuery({
    queryKey: queryKeys.fleetArchived,
    queryFn: () => platformClient.operator.fleet.archivedList(),
    refetchInterval: pollInterval,
    enabled: archived,
  });
  const attempts = useQuery({
    queryKey: queryKeys.fleetAttempts,
    queryFn: () => platformClient.operator.fleet.attempts.list(),
    refetchInterval: pollInterval,
    retry: false,
  });

  const streamLive = useEventStreamState('app').status === 'live';
  const approvals = useQuery({
    queryKey: queryKeys.approvals,
    queryFn: () => platformClient.operator.approvals.list(),
    refetchInterval: streamLive ? false : 15_000,
  });

  const sessions = useQuery({
    queryKey: queryKeys.sessionList(contractScope.revision),
    queryFn: ({ signal }) => readSessionList(contractScope, signal),
    gcTime: 0,
    refetchInterval: pollInterval,
  });

  const hosted = useQuery({
    queryKey: queryKeys.hostedSessions(includeFinished),
    queryFn: () => platformClient.operator.sessions.hosted.list({ includeTerminated: includeFinished }),
    refetchInterval: hostedStreamConnected ? 60_000 : 15_000,
    retry: false,
  });

  const tasks = useQuery({
    queryKey: queryKeys.tasks,
    refetchInterval: pollInterval,
    queryFn: () => platformClient.operator.tasks.list(),
    retry: false,
  });

  const ciWatches = useQuery({
    queryKey: queryKeys.ciWatches,
    refetchInterval: pollInterval,
    queryFn: () => platformClient.operator.ci.watches.list(),
    retry: false,
  });

  const contractRecords = useMemo(() => archived || contracts.isError ? [] : contracts.data?.contracts ?? [], [archived, contracts.isError, contracts.data]);
  const attemptGroups: readonly FleetAttemptGroup[] = useMemo(
    () => (attempts.isError ? [] : attempts.data?.groups ?? []),
    [attempts.data, attempts.isError],
  );
  const nodes = useMemo(
    () => (archived ? archivedList.data?.nodes : snapshot.data?.nodes) ?? [],
    [archived, archivedList.data, snapshot.data],
  );
  const liveNodes = useMemo(() => snapshot.data?.nodes ?? [], [snapshot.data]);
  const approvalRecords = useMemo(() => sortApprovalsNewestFirst(approvals.data?.approvals ?? []), [approvals.data]);
  // The session snapshot holds the newest 50; "Show older sessions" reads sessions.search a page at a
  // time with its cursor, so every open session is reachable (and opens) here. No read until pressed.
  const [olderSessions, setOlderSessions] = useState<{ readonly records: readonly unknown[]; readonly cursor: string; readonly started: boolean; readonly loading: boolean; readonly done: boolean }>(
    { records: [], cursor: '', started: false, loading: false, done: false });
  const snapshotFull = companionSessionsFromListResponse(sessions.data).length >= SESSION_SNAPSHOT_SIZE;
  const loadOlderSessions = useCallback(() => {
    if (olderSessions.loading || olderSessions.done) return;
    setOlderSessions((current) => ({ ...current, loading: true }));
    platformClient.operator.sessions.search({ limit: OLDER_SESSIONS_PAGE, ...(olderSessions.cursor ? { cursor: olderSessions.cursor } : {}) }).then((page) => {
      const record = page as { sessions?: unknown[]; nextCursor?: unknown; hasMore?: unknown };
      const next = typeof record.nextCursor === 'string' ? record.nextCursor : '';
      setOlderSessions((current) => ({
        records: [...current.records, ...(Array.isArray(record.sessions) ? record.sessions : [])],
        cursor: next, started: true, loading: false, done: record.hasMore !== true || !next,
      }));
    }, () => setOlderSessions((current) => ({ ...current, loading: false })));
  }, [olderSessions.loading, olderSessions.done, olderSessions.cursor]);
  const sessionRecords = useMemo(() => {
    const newest = unionSessionsFromListResponse(sessions.data);
    if (olderSessions.records.length === 0) return sortUnionSessions(newest);
    const listed = new Set(newest.map((record) => record.id));
    const older = olderSessions.records.map(unionSessionFromRecord).filter((record) => record.id && !listed.has(record.id) && (listed.add(record.id), true));
    return sortUnionSessions([...newest, ...older]);
  }, [sessions.data, olderSessions.records]);
  const moreSessions = snapshotFull && !olderSessions.done
    ? { loading: olderSessions.loading, load: loadOlderSessions }
    : null;
  const hostedRecords = useMemo(
    () => sortHostedSessionsNewestFirst(hostedSessionsFromListResult(hosted.data)),
    [hosted.data],
  );
  const taskRecords = useMemo(() => tasks.data?.tasks ?? [], [tasks.data]);
  const watchRecords: readonly CiWatch[] = useMemo(() => ciWatches.data?.watches ?? [], [ciWatches.data]);

  /** Sources that failed for a reason other than a missing verb, for one quiet notice each. */
  const failures = [
    { label: archived ? 'the archive' : 'the fleet', query: archived ? archivedList : snapshot },
    { label: 'approvals', query: approvals },
    { label: 'sessions', query: sessions },
    { label: 'hosted sessions', query: hosted },
    { label: 'tasks', query: tasks },
    { label: 'CI watches', query: ciWatches },
    { label: 'best-of-N groups', query: attempts },
    ...(!archived ? [{ label: 'contracts', query: contracts }] : []),
  ].filter(({ label, query }) => query.isError && (label === 'contracts' || !isMethodUnavailableError(query.error)));

  // A hosted list answer without a `sessions` array (an unmodeled verb, an older
  // daemon) is "could not be read", never an empty list.
  const hostedUnreadable = hosted.isSuccess
    && !(Boolean(hosted.data) && typeof hosted.data === 'object' && Array.isArray((hosted.data as { sessions?: unknown }).sessions));

  const firstLoad = (archived ? archivedList.isPending : snapshot.isPending) && approvals.isPending;

  return {
    contracts,
    contractRecords,
    snapshot,
    archivedList,
    approvals,
    sessions,
    hosted,
    tasks,
    ciWatches,
    attemptGroups,
    nodes,
    liveNodes,
    approvalRecords,
    sessionRecords,
    moreSessions,
    hostedRecords,
    taskRecords,
    watchRecords,
    failures,
    hostedUnreadable,
    firstLoad,
    truncated: !archived && snapshot.isSuccess && snapshot.data.truncated
      ? { shown: snapshot.data.nodes.length, total: snapshot.data.totalCount }
      : null,
  };
}
