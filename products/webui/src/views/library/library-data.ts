/**
 * Shared data hooks for the Library tabs. The page header needs the Review count
 * while the Review tab needs the rows themselves, so both read the same query
 * keys (react-query dedupes them into one request).
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  invokeMethod,
  client as platformClient,
  type MemoryRecord,
  type MemoryUpdateInput,
  type MemoryUpdateReviewInput,
} from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { firstArray, firstString } from '../../lib/object';

/** A value that follows `value` after it has been stable for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

/** The most rows one request for the review queue or the candidate list returns. */
export const REVIEW_PAGE_LIMIT = 50;

export function useReviewQueue() {
  return useQuery({
    queryKey: queryKeys.memoryReviewQueue,
    queryFn: () => platformClient.operator.memory.reviewQueue({ limit: REVIEW_PAGE_LIMIT }),
  });
}

export function useConsolidationReceipts() {
  return useQuery({
    queryKey: queryKeys.memoryConsolidationReceipts,
    queryFn: () => platformClient.operator.memory.consolidation.receipts(),
  });
}

export function useKnowledgeCandidates() {
  return useQuery({
    queryKey: queryKeys.knowledgeCandidates,
    queryFn: () => invokeMethod('knowledge.candidates.list', { limit: REVIEW_PAGE_LIMIT }),
  });
}

/** Candidates that still wait for a decision (anything not yet decided). */
export function isUndecidedCandidate(status: string): boolean {
  return status === 'pending' || status === 'unknown' || status === '';
}

export function candidateItems(data: unknown): unknown[] {
  return firstArray(data, ['candidates']);
}

/** Delete and review-save mutations shared by the Memory and Review tabs. */
export function useMemoryRecordMutations() {
  const queryClient = useQueryClient();
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['memory'] });
  };
  const remove = useMutation({
    mutationFn: (record: MemoryRecord) => platformClient.operator.memory.delete(record.id),
    onSuccess: invalidate,
  });
  const saveReview = useMutation({
    mutationFn: ({ id, input }: { id: string; input: MemoryUpdateReviewInput }) =>
      platformClient.operator.memory.updateReview(id, input),
    onSuccess: invalidate,
  });
  /** Saves edited words, tags or scope in place; the record keeps its id and history. */
  const saveEdit = useMutation({
    mutationFn: ({ id, input }: { id: string; input: MemoryUpdateInput }) => platformClient.operator.memory.update(id, input),
    onSuccess: invalidate,
  });
  return { remove, saveReview, saveEdit };
}

/** "fact" -> "Fact", "cross-scope-duplicate" -> "Cross scope duplicate". */
export function sentence(value: string): string {
  const spaced = value.replace(/[-_]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : spaced;
}

export function includesText(haystack: readonly (string | undefined)[], needle: string): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  return haystack.some((part) => part?.toLowerCase().includes(n));
}

/**
 * How many rows the Review tab holds: queued records, pending consolidation
 * proposals and undecided knowledge candidates. The tab label shows exactly this.
 * Neither list reports a total, so a source that returned a full page may have more
 * behind it: `capped` is then true and the number is a lower bound ("50+").
 */
export function useReviewTally(): { count: number; capped: boolean } {
  const queue = useReviewQueue();
  const receipts = useConsolidationReceipts();
  const candidates = useKnowledgeCandidates();
  const queued = queue.data?.records.length ?? 0;
  const proposals = receipts.data?.pendingProposals.length ?? 0;
  const candidateRows = candidateItems(candidates.data);
  const undecided = candidateRows
    .filter((c) => isUndecidedCandidate(firstString(c, ['status']) || 'unknown')).length;
  return {
    count: queued + proposals + undecided,
    capped: queued >= REVIEW_PAGE_LIMIT || candidateRows.length >= REVIEW_PAGE_LIMIT,
  };
}
