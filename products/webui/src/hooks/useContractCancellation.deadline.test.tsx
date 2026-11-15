import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider, onlineManager, useQuery } from '@tanstack/react-query';
import { getClientLifetime, tokenStore, WEBUI_TOKEN_STORE_KEY } from '../lib/client-lifetime';
import { queryKeys } from '../lib/queries';
let cancel: (id: string, signal: AbortSignal) => Promise<{ cancelled: boolean }> = () => Promise.resolve({ cancelled: true });
mock.module('../lib/goodvibes', () => ({
  hasStoredTokenSync: () => Boolean(localStorage.getItem(WEBUI_TOKEN_STORE_KEY)),
  client: { operator: { contracts: { cancel: (id: string, signal: AbortSignal) => cancel(id, signal) } } },
}));
const { useContractCancellation, CONTRACT_CANCEL_NOTICE } = await import('./useContractCancellation');
const { useContractScope } = await import('./useContracts');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve };
}
async function settle(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Cancellation did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5)); flushSync(() => {});
  }
}
const cleanups: (() => void)[] = [];
beforeEach(async () => { await tokenStore.setToken('cancel-account-a'); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup(); onlineManager.setOnline(true); await tokenStore.clearToken();
  cancel = () => Promise.resolve({ cancelled: true });
});
function render(initialId = 'first') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: 5 } } });
  const el = document.createElement('div'); document.body.append(el); const root = createRoot(el);
  const reads = { list: 0, detail: 0, fleet: 0, attempts: 0 }; let failReads = false, failAttempts = false;
  let fleetResponse: (() => Promise<string>) | undefined;
  let action: ReturnType<typeof useContractCancellation>;
  const read = (kind: keyof typeof reads) => { reads[kind]++; if (kind === 'fleet' && fleetResponse) return fleetResponse(); return (failReads || (kind === 'attempts' && failAttempts)) ? Promise.reject(new Error('read failed')) : Promise.resolve('running'); };
  function Detail({ id }: { id: string }) {
    const scope = useContractScope(); action = useContractCancellation(scope, id);
    const detail = useQuery({ queryKey: queryKeys.contractDetail(scope.revision, id), queryFn: () => read('detail') });
    return <div>{id}:{detail.data}:{action.phase}:{action.notice}</div>;
  }
  function Harness({ id }: { id: string }) {
    const scope = useContractScope();
    useQuery({ queryKey: queryKeys.contractList(scope.revision, true), queryFn: () => read('list') });
    useQuery({ queryKey: queryKeys.fleet, queryFn: () => read('fleet') });
    useQuery({ queryKey: queryKeys.fleetAttempts, queryFn: () => read('attempts') });
    return id ? <Detail key={`${scope.revision}:${id}`} id={id} /> : null;
  }
  const rerender = (id: string) => flushSync(() => root.render(<QueryClientProvider client={client}><Harness id={id} /></QueryClientProvider>));
  rerender(initialId); cleanups.push(() => { flushSync(() => root.unmount()); client.clear(); el.remove(); });
  const ask = () => flushSync(() => action.ask());
  const confirm = () => { let result!: Promise<void>; flushSync(() => { result = action.confirm(); }); return result; };
  return { client, el, reads, rerender, action: () => action!, ask, confirm, failReads: () => { failReads = true; }, failAttempts: () => { failAttempts = true; }, holdFleet: (read: () => Promise<string>) => { fleetResponse = read; } };
}

test('a refresh the daemon never answers ends at the deadline and asks for a manual refresh', async () => {
  const realSetTimeout = globalThis.setTimeout;
  // Shorten only the 30 s response deadline so the test does not wait it out.
  globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => realSetTimeout(handler, ms === 30_000 ? 20 : ms, ...args)) as typeof setTimeout;
  cleanups.push(() => { globalThis.setTimeout = realSetTimeout; });
  const h = render();
  await settle(() => h.reads.fleet > 0);
  h.holdFleet(() => new Promise<string>(() => {}));
  h.ask(); await h.confirm();
  expect(h.action().phase).toBe('acknowledged');
  expect(h.action().refreshing).toBe(false);
  expect(h.action().needsRefresh).toBe(true);
  h.holdFleet(() => Promise.resolve('running'));
  await h.action().refresh();
  await settle(() => !h.action().needsRefresh);
  expect(h.action().disabled).toBe(false);
});
