import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime, type ClientLifetime } from '../lib/client-lifetime';
import { firstJsonSchemaFailure } from '@goodvibes-jev/engine/transport-http';
import contractSchema from '../lib/generated/contract-inspection-schema.json';
import summarySchema from '../lib/generated/contract-summary-schema.json';
import type { ContractRecord, ContractsSummariesResult } from '../lib/contract-bridge-types';
import { hasStoredTokenSync, client as platformClient } from '../lib/goodvibes';
import { queryKeys } from '../lib/queries';

/** A local revision, never a token or user-provided identifier, owns these caches. */
export function useContractScope(): ClientLifetime {
  const client = useQueryClient();
  const lifetime = useSyncExternalStore(subscribeClientLifetime, getClientLifetime, getClientLifetime);
  useEffect(() => {
    const purge = () => {
      const revision = getClientLifetime().revision;
      client.removeQueries({ predicate: (query) => query.queryKey[0] === 'contracts' && query.queryKey[1] !== revision });
    };
    purge();
    return subscribeClientLifetime(purge);
  }, [client]);
  return lifetime;
}

/** Abort on identity replacement even when the transport has already answered.
 * A late response cannot be adopted after sign-out or an A → B → A switch. */
export async function readInContractScope<T>(
  lifetime: ClientLifetime,
  signal: AbortSignal,
  read: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const unsubscribe = subscribeClientLifetime(cancel);
  signal.addEventListener('abort', cancel, { once: true });
  const check = () => {
    if (signal.aborted || !isClientLifetimeCurrent(lifetime) || !hasStoredTokenSync()) cancel();
    abort.signal.throwIfAborted();
  };
  try {
    check();
    const result = await read(abort.signal);
    check();
    return result;
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', cancel);
  }
}

/** The public engine schemas are snapshotted and checked before every build.
 * Invalid nested evidence must fail the query, never crash during rendering.
 * Contract reads go through the web UI's own fetch, not the operator client, so
 * this is the one check a record gets; the schemas are the contract's
 * `contracts.get`, `contracts.summaries` and `contracts.status` output schemas. */
function assertShape(schema: Record<string, unknown>, value: unknown, what: string): void {
  const failure = firstJsonSchemaFailure(schema, value);
  if (failure) throw new Error(`The daemon returned an unreadable ${what} (${failure.path}).`);
}

/** The Work list: one summary per contract (counts, status, open question), never the trees. */
export function useContractList(lifetime: ClientLifetime, includeTerminal: boolean, enabled: boolean, live: boolean) {
  return useQuery({
    queryKey: queryKeys.contractList(lifetime.revision, includeTerminal),
    queryFn: ({ signal }) => readInContractScope(lifetime, signal, async (current): Promise<ContractsSummariesResult> => {
      const result = await platformClient.operator.contracts.summaries({ includeTerminal }, current);
      assertShape(summarySchema.summaries, result, 'contract list');
      return result;
    }),
    enabled: enabled && hasStoredTokenSync() && isClientLifetimeCurrent(lifetime),
    retry: false,
    gcTime: 0,
    refetchInterval: live ? 60_000 : 15_000,
  });
}

/** One contract's tree and the summary revision it was read at. */
export interface ContractDetailRead {
  readonly contract: ContractRecord;
  readonly revision: string;
}

/**
 * One contract's tree. A poll asks `contracts.status` with the revision last
 * read and keeps the tree it has when the daemon answers not-modified; the tree
 * is fetched only when the revision moved, or when `reload` asks. The status
 * is read before the tree, so a change between the two reads is fetched on the
 * next poll, never missed.
 */
export function useContractDetail(lifetime: ClientLifetime, id: string, live: boolean, options: { includeInputFiles?: boolean } = {}) {
  const client = useQueryClient();
  const reloadRef = useRef(false);
  const includeInputFiles = options.includeInputFiles === true;
  const includeRef = useRef(includeInputFiles);
  const queryKey = queryKeys.contractDetail(lifetime.revision, id);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => readInContractScope(lifetime, signal, async (current): Promise<ContractDetailRead> => {
      const previous = reloadRef.current ? undefined : client.getQueryData<ContractDetailRead>(queryKey);
      reloadRef.current = false;
      const status = await platformClient.operator.contracts.status(id, previous?.revision, current);
      assertShape(summarySchema.status, status, 'contract status');
      if (status.id !== id) throw new Error('The daemon returned a different contract. Refresh to try again.');
      if ('notModified' in status && previous) return previous;
      const contract = await platformClient.operator.contracts.get(id, current, { includeInputFiles: includeRef.current });
      assertShape(contractSchema, contract, 'contract record');
      if (contract.id !== id) throw new Error('The daemon returned a different contract. Refresh to try again.');
      return { contract, revision: status.revision };
    }),
    enabled: Boolean(id) && hasStoredTokenSync() && isClientLifetimeCurrent(lifetime),
    retry: false,
    gcTime: 0,
    // Retain the safety poll even for terminal snapshots: a lost event must not
    // leave a permanently stale detail. An unchanged contract costs one status read.
    refetchInterval: live ? 60_000 : 15_000,
  });
  /** Reads the whole tree again, whatever the revision says. */
  const { refetch } = query;
  const reload = useCallback(() => {
    reloadRef.current = true;
    return refetch();
  }, [refetch]);
  // Asking for the captured file list reads the tree again with it; later
  // reads keep it until the detail closes.
  useEffect(() => {
    includeRef.current = includeInputFiles;
    if (includeInputFiles) void reload();
  }, [includeInputFiles, reload]);
  return { query, reload };
}
