/**
 * Consolidation over the local memory image is held back while a daemon owns the
 * store, and works on the real registry otherwise.
 */
import { expect, test } from 'bun:test';
import type { MemoryRegistry } from '@goodvibes-jev/engine/platform/platform/state';
import { gateConsolidationToLocalWriter } from '../../runtime/memory-consolidation-gate.ts';

class FakeRegistry {
  readonly writes: string[] = [];
  getAll(): readonly string[] { return ['record-a', 'record-b']; }
  review(id: string): null { this.writes.push(`review:${id}`); return null; }
}

test('the scheduler sees an empty store while the memory spine routes through a daemon, and the real one otherwise', () => {
  const spine = { active: false };
  const gated = gateConsolidationToLocalWriter(new FakeRegistry() as unknown as MemoryRegistry, spine) as unknown as FakeRegistry;
  expect(gated.getAll()).toEqual(['record-a', 'record-b']);
  spine.active = true;
  expect(gated.getAll()).toEqual([]);
  spine.active = false;
  expect(gated.getAll()).toEqual(['record-a', 'record-b']);
});

test('methods other than getAll still reach the underlying registry', () => {
  const registry = new FakeRegistry();
  const gated = gateConsolidationToLocalWriter(registry as unknown as MemoryRegistry, { active: true }) as unknown as FakeRegistry;
  gated.review('m1');
  expect(registry.writes).toEqual(['review:m1']);
});
