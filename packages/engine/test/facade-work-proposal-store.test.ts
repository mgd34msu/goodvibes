/**
 * The facade's proposal store closes the held input row of a proposal nobody
 * answered. Built through the same factory the daemon composes.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFacadeWorkProposalStore } from '../platform/src/platform/daemon/facade-work-proposal-store.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gv-facade-proposals-'));
  const failed: Array<[string, string, string]> = [];
  const sessionBroker = {
    failInput: async (sessionId: string, inputId: string, error: string) => { failed.push([sessionId, inputId, error]); return null; },
  };
  let now = 1_000_000;
  const store = createFacadeWorkProposalStore(
    { get: () => undefined, getCategory: () => undefined, getControlPlaneConfigDir: () => dir } as never,
    sessionBroker as never,
    () => now,
  );
  return { store, failed, advance: (ms: number) => { now += ms; }, dispose: () => { store.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

describe('facade work proposal store', () => {
  test('an expired pending proposal fails the input row it was holding', () => {
    const h = setup();
    try {
      const held = h.store.create({ surfaceKind: 'ntfy', task: 'fix it', summary: 'fix it', ttlMs: 60_000, sessionId: 's1', inputId: 'i1' });
      h.store.markDelivered(held.id);
      h.advance(60_001);
      h.store.reap();
      expect(h.failed.map(([sessionId, inputId]) => [sessionId, inputId])).toEqual([['s1', 'i1']]);
      expect(h.failed[0]![2]).toContain('not answered in time');
    } finally { h.dispose(); }
  });

  test('an answered proposal leaves its input row alone', () => {
    const h = setup();
    try {
      const held = h.store.create({ surfaceKind: 'ntfy', task: 'fix it', summary: 'fix it', ttlMs: 60_000, sessionId: 's1', inputId: 'i1' });
      h.store.markDelivered(held.id);
      h.store.resolve(held.id, 'declined');
      h.advance(60_001);
      h.store.reap();
      expect(h.failed).toEqual([]);
    } finally { h.dispose(); }
  });
});
