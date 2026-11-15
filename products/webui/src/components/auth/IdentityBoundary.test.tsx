import { expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { IdentityBoundary } from './IdentityBoundary';
import { invalidateClientLifetime } from '../../lib/client-lifetime';
import { readStoredCompanionSessions, writeStoredCompanionSessions } from '../../lib/companion-chat';

test('identity replacement discards query, mutation, local transcript, and component state', async () => {
  let client!: QueryClient;
  let seed!: () => void;
  function PrivateView() {
    client = useQueryClient();
    const [secret, setSecret] = useState('empty');
    seed = () => setSecret('owner A');
    return <span>{secret}</span>;
  }
  const el = document.createElement('div'); document.body.append(el);
  const root = createRoot(el);
  flushSync(() => root.render(<IdentityBoundary><PrivateView/></IdentityBoundary>));
  const old = client;
  old.setQueryData(['mail'], 'owner A mail');
  writeStoredCompanionSessions([{ id: 'a', title: 'private title' }]);
  let resolve!: (value: string) => void;
  // A mutation in the old owner's cache, held pending: it must not survive the replacement.
  const mutation = old.getMutationCache().build(old, { mutationFn: () => new Promise<string>(() => {}) });
  void mutation.execute(undefined).catch(() => undefined);
  expect(old.getMutationCache().getAll()).toHaveLength(1);
  const obsolete = old.fetchQuery({ queryKey: ['late'], queryFn: () => new Promise<string>(yes => { resolve = yes; }) }).catch(() => undefined);
  flushSync(seed);
  expect(el.textContent).toBe('owner A');
  flushSync(invalidateClientLifetime);
  expect(client).not.toBe(old);
  expect(el.textContent).toBe('empty');
  expect(client.getQueryData(['mail'])).toBeUndefined();
  expect(readStoredCompanionSessions()).toEqual([]);
  resolve('old owner response'); await obsolete;
  expect(client.getQueryData(['late'])).toBeUndefined();
  expect(old.getQueryCache().getAll()).toEqual([]);
  expect(old.getMutationCache().getAll()).toEqual([]);
  expect(client.getMutationCache().getAll()).toEqual([]);
  flushSync(() => root.unmount()); el.remove();
});
