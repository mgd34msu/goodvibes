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
import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { OperatorMethodInput } from '@goodvibes/engine/contracts';
import { client as platformClient } from '../lib/goodvibes';
import { formatError } from '../lib/errors';
import { useEventStreamState } from '../lib/event-stream';
import { queryKeys } from '../lib/queries';
import { INBOX_ASK_KINDS, openAsks, readInboxAskItems, type OpenAsk } from '../lib/asks';

/** The cache key of the open inbox asks; under `ownerInbox`, so an `owner-inbox-update` frame revalidates it. */
export const OPEN_INBOX_ASKS_KEY = [...queryKeys.ownerInbox, 'open-asks'] as const;
/** The daemon's largest inbox.list page. */
const LIST_LIMIT = 500;
const FALLBACK_POLL_MS = 15_000;

function pageOf(value: unknown): { items?: unknown; nextCursor?: unknown } | null {
  return value as { items?: unknown; nextCursor?: unknown } | null;
}

/**
 * Every open ask in the inbox: one page in practice; past the largest page the
 * next is read with its cursor, so no ask waiting on the person is out of reach.
 */
async function readOpenInboxAsks(): Promise<ReturnType<typeof readInboxAskItems>> {
  const items: unknown[] = [];
  let cursor = '';
  do {
    // `cursor` is on inbox.list's schema; the generated input type gains it when the contract is regenerated.
    const input: OperatorMethodInput<'inbox.list'> & { readonly cursor?: string } = {
      status: 'open', kinds: INBOX_ASK_KINDS, limit: LIST_LIMIT, ...(cursor ? { cursor } : {}),
    };
    const page = pageOf(await platformClient.operator.invoke('inbox.list', input));
    if (Array.isArray(page?.items)) items.push(...(page.items as unknown[]));
    cursor = typeof page?.nextCursor === 'string' ? page.nextCursor : '';
  } while (cursor);
  return readInboxAskItems({ items });
}

export interface OpenAsksRead {
  /** The open asks; after a failed inbox read, the inbox part is the last good read. */
  asks: OpenAsk[];
  isPending: boolean;
  /** Why the latest inbox read failed, or null when it did not. */
  inboxError: string | null;
  /** Reads the inbox again. */
  retryInbox: () => void;
}

export function useOpenAsks(enabled = true): OpenAsksRead {
  const streamLive = useEventStreamState('app').status === 'live';
  const approvals = useQuery({
    queryKey: queryKeys.approvals,
    queryFn: () => platformClient.operator.approvals.list(),
    enabled,
    refetchInterval: streamLive ? false : FALLBACK_POLL_MS,
  });
  const inbox = useQuery({
    queryKey: OPEN_INBOX_ASKS_KEY,
    queryFn: readOpenInboxAsks,
    enabled,
    refetchInterval: streamLive ? false : FALLBACK_POLL_MS,
    retry: false,
  });
  const asks = useMemo(
    () => openAsks(approvals.data?.approvals ?? [], inbox.data ?? []),
    [approvals.data, inbox.data],
  );
  const { refetch } = inbox;
  const retryInbox = useCallback(() => { void refetch(); }, [refetch]);
  return {
    asks,
    isPending: approvals.isPending,
    inboxError: inbox.isError ? formatError(inbox.error) : null,
    retryInbox,
  };
}
