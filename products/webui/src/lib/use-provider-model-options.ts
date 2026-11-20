import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { failedRead, present, toRefusal, type Observed } from '@goodvibes/engine/errors';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime } from './client-lifetime';
import { modelOptionsForProvider, type ModelOption } from './provider-models';

/** Where the provider and model lists stand: still being read the first time, read (and maybe being read again), or not readable. */
export type ModelOptionsSource =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly refreshing: boolean }
  | { readonly kind: 'failed'; readonly error: unknown };

/** The models a provider offers, or that they are still loading: empty is a present list with no models, never a load or a failure. */
export type ProviderModelOptionsRead = Observed<readonly ModelOption[]> | { readonly kind: 'loading' };

/** The source of two lists read together: failed when either failed, loading until both were read once. */
export function modelOptionsSourceOf(
  ...queries: readonly { readonly isError: boolean; readonly error: unknown; readonly isSuccess: boolean; readonly isFetching: boolean }[]
): ModelOptionsSource {
  const failed = queries.find((query) => query.isError);
  if (failed) return { kind: 'failed', error: failed.error };
  if (!queries.every((query) => query.isSuccess)) return { kind: 'loading' };
  return { kind: 'ready', refreshing: queries.some((query) => query.isFetching) };
}

/**
 * The models a provider offers, from what its registration declares: its own models, or
 * the catalog models of the base it declares (a declared alias, `catalogProviderId`). No
 * model is asked; a custom provider with no declared base shows its own models.
 *
 * While the lists are read again in the background, the last list read for the same
 * provider stays shown; a model can be chosen only from a list that is current.
 */
export function useProviderModelOptions(provider: unknown, catalog: unknown[], source: ModelOptionsSource) {
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [clientRevision, setClientRevision] = useState(0);
  useEffect(() => subscribeClientLifetime(() => setClientRevision(value => value + 1)), []);
  const settled = source.kind === 'ready' && !source.refreshing;
  const owner = useMemo(() => ({ provider, catalog, settled, clientRevision, client: getClientLifetime() }),
    [provider, catalog, settled, clientRevision]);
  const latest = useRef<typeof owner | undefined>(undefined);
  useLayoutEffect(() => {
    latest.current = owner;
    return () => {
      if (latest.current === owner) latest.current = undefined;
    };
  }, [owner]);
  // The last list read for this provider, shown while the lists are read again.
  const lastShown = useRef<{ readonly provider: unknown; readonly models: readonly ModelOption[] } | undefined>(undefined);
  const currentClient = isClientLifetimeCurrent(owner.client);
  const currentModels = (): ModelOption[] => currentClient && settled && provider
    ? modelOptionsForProvider(provider, catalog)
    : [];
  let read: ProviderModelOptionsRead;
  if (!currentClient) read = { kind: 'loading' };
  else if (!provider) read = present([]);
  else if (source.kind === 'failed') {
    read = failedRead(toRefusal(source.error, {
      state: 'the model list could not be read',
      next: ['Retry, or check that the daemon is running.'],
    }));
  } else if (settled) read = present(currentModels());
  else if (lastShown.current?.provider === provider) read = present(lastShown.current.models);
  else read = { kind: 'loading' };
  if (read.kind === 'present' && settled && provider) lastShown.current = { provider, models: read.value };
  return {
    read,
    models: read.kind === 'present' ? [...read.value] : [],
    /** Recheck immediately before dispatch so a detached handler cannot use retired options. */
    hasCurrentModel: (registryKey: string) => mounted.current && latest.current === owner
      && currentModels().some(model => model.registryKey === registryKey),
  };
}
