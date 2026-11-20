/**
 * The asks waiting for the person (lib/asks.ts), from reads the app shares:
 * `approvals.list` (the key and request the shell and Work already use,
 * revalidated by `approval-update` frames) and one `inbox.list` of the open
 * questions, purchase windows, claims, held actions and reports (revalidated by
 * `owner-inbox-update` frames). Each approvals row carries its ask's words
 * (`presentation`), so no other read words an approval. Each is polled only while the
 * event stream is not live. The sidebar badge, Work and the chat's inline card
 * read the same cached answers, so a chat opening adds no request.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { client as platformClient } from '../lib/goodvibes';
import { useEventStreamState } from '../lib/event-stream';
import { queryKeys } from '../lib/queries';
import { INBOX_ASK_KINDS, openAsks, readInboxAskItems, type OpenAsk } from '../lib/asks';

/** The cache key of the open inbox asks; under `ownerInbox`, so an `owner-inbox-update` frame revalidates it. */
export const OPEN_INBOX_ASKS_KEY = [...queryKeys.ownerInbox, 'open-asks'] as const;
/** The daemon's largest inbox.list page. */
const LIST_LIMIT = 500;
const FALLBACK_POLL_MS = 15_000;

export function useOpenAsks(enabled = true): { asks: OpenAsk[]; isPending: boolean } {
  const streamLive = useEventStreamState('app').status === 'live';
  const approvals = useQuery({
    queryKey: queryKeys.approvals,
    queryFn: () => platformClient.operator.approvals.list(),
    enabled,
    refetchInterval: streamLive ? false : FALLBACK_POLL_MS,
  });
  const inbox = useQuery({
    queryKey: OPEN_INBOX_ASKS_KEY,
    queryFn: async () => readInboxAskItems(await platformClient.operator.invoke('inbox.list', { status: 'open', kinds: INBOX_ASK_KINDS, limit: LIST_LIMIT })),
    enabled,
    refetchInterval: streamLive ? false : FALLBACK_POLL_MS,
    retry: false,
  });
  const asks = useMemo(
    () => openAsks(approvals.data?.approvals ?? [], inbox.isError ? [] : inbox.data ?? []),
    [approvals.data, inbox.data, inbox.isError],
  );
  return { asks, isPending: approvals.isPending };
}
