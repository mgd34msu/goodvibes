import { expect, test } from 'bun:test';
import { createSessionContractViews } from '../../core/work-tree-wiring.ts';
import type { ContractRunner, ContractView } from '@goodvibes-jev/engine/platform/platform/contract';

test('agent lookups reuse a detached snapshot and refresh after events and session changes', () => {
  let changed: (() => void) | undefined;
  let reads = 0;
  let selectedSession = 'first';
  let status = 'awaiting-owner';
  const runner = {
    list(filter: { sessionId?: string; includeInputSnapshot?: boolean }) {
      reads++;
      expect(filter.includeInputSnapshot).toBe(false);
      return [{ id: 'ctr-12345678', ownerAgentId: 'owner', sessionId: filter.sessionId, status }] as ContractView[];
    },
    on(listener: () => void) { changed = listener; return () => { changed = undefined; }; },
  } as Pick<ContractRunner, 'list' | 'on'>;
  const views = createSessionContractViews(runner, () => selectedSession);
  const first = views.read();
  for (let agent = 0; agent < 100; agent++) {
    expect(views.read()).toBe(first);
    expect(views.byOwner('owner')).toBe(first[0]);
    expect(views.byId('ctr-12345678')).toBe(first[0]);
  }
  expect(reads).toBe(1);
  status = 'passed'; changed!();
  expect(views.read()[0]!.status).toBe('passed');
  expect(first[0]!.status).toBe('awaiting-owner');
  expect(reads).toBe(2);
  selectedSession = 'second';
  expect(views.read()[0]!.sessionId).toBe('second');
  expect(reads).toBe(3);
  views.dispose(); expect(changed).toBeUndefined();
});
