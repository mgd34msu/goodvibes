import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime } from './client-lifetime';
import { modelOptionsForProvider } from './provider-models';

/**
 * The models a provider offers, from what its registration declares: its own models, or
 * the catalog models of the base it declares (a declared alias, `catalogProviderId`). No
 * model is asked; a custom provider with no declared base shows its own models.
 */
export function useProviderModelOptions(provider: unknown, catalog: unknown[], enabled = true) {
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [clientRevision, setClientRevision] = useState(0);
  useEffect(() => subscribeClientLifetime(() => setClientRevision(value => value + 1)), []);
  const owner = useMemo(() => ({ provider, catalog, enabled, clientRevision, client: getClientLifetime() }),
    [provider, catalog, enabled, clientRevision]);
  const latest = useRef<typeof owner | undefined>(undefined);
  useLayoutEffect(() => {
    latest.current = owner;
    return () => {
      if (latest.current === owner) latest.current = undefined;
    };
  }, [owner]);
  const currentModels = () => isClientLifetimeCurrent(owner.client) && enabled && provider
    ? modelOptionsForProvider(provider, catalog)
    : [];
  return {
    models: currentModels(),
    /** Recheck immediately before dispatch so a detached handler cannot use retired options. */
    hasCurrentModel: (registryKey: string) => mounted.current && latest.current === owner
      && currentModels().some(model => model.registryKey === registryKey),
  };
}
