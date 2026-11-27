import { useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getClientLifetime, subscribeClientLifetime } from '../../lib/client-lifetime';
import { setChatCallProject } from '../../lib/goodvibes';

/** Each credential generation (token or relay pairing) owns its cache and mounted application; a route flip is not one. */
export function IdentityBoundary({ children }: { children: ReactNode }) {
  const lifetime = useSyncExternalStore(subscribeClientLifetime, getClientLifetime, getClientLifetime);
  // networkMode 'always': the browser's online flag says whether it has a network
  // beyond this machine, not whether the daemon answers. A daemon on loopback is
  // reachable with no network at all, so requests are always sent and an unreachable
  // daemon shows as the failure it is.
  const client = useMemo(() => new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000, networkMode: 'always' },
      mutations: { networkMode: 'always' },
    },
  }), [lifetime]);
  useLayoutEffect(() => {
    const unsubscribe = subscribeClientLifetime(() => {
      // Cancel before any late anonymous or previous-owner response is adopted.
      void client.cancelQueries();
      client.clear();
      // The chats this browser keeps are the signed-in person's own (account-storage.ts); the open chat's project is
      // forgotten, so no call of the next person names it (the chat view sets it again for a chat it opens).
      setChatCallProject(undefined);
    });
    return () => { unsubscribe(); void client.cancelQueries(); client.clear(); };
  }, [client]);
  return <QueryClientProvider key={lifetime.revision} client={client}>{children}</QueryClientProvider>;
}
