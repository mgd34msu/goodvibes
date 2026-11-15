/**
 * A lifecycle run that fails after `execute` applied the compaction must leave
 * the machine idle and say so, and a compaction that took effect is never
 * announced as failed just because its boundary commit did not validate.
 */
import { expect, test } from 'bun:test';
import { CompactionManager } from '../platform/src/platform/runtime/compaction/manager.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';

function build() {
  const bus = new RuntimeEventBus();
  const manager = new CompactionManager({ sessionId: 's1', bus, contextWindow: () => 1000 });
  const types: string[] = [];
  bus.onDomain('compaction', (env) => { types.push(env.payload.type); });
  return { manager, types };
}

const run = (manager: CompactionManager, outcome: () => { messages: never[]; tokensAfter: number; summary: string } | null) => manager.runLifecycle({
  trigger: 'auto', strategy: 'autocompact', messages: [], tokenCount: 900,
  execute: async () => 'applied', outcome,
});

test('an outcome callback that throws leaves the machine idle and reports the failure', async () => {
  const { manager, types } = build();
  await expect(run(manager, () => { throw new Error('unexpected result shape'); })).rejects.toThrow('unexpected result shape');
  expect(manager.state).toBe('idle');
  expect(types).toContain('COMPACTION_FAILED');
  manager.dispose();
});

test('an applied compaction whose boundary commit is invalid is done, not failed', async () => {
  const { manager, types } = build();
  expect(await run(manager, () => ({ messages: [], tokensAfter: 0, summary: 's' }))).toBe('applied');
  expect(types).not.toContain('COMPACTION_FAILED');
  expect(types).toContain('COMPACTION_DONE');
  expect(manager.state).toBe('idle');
  expect(manager.lastCommit).toBeNull();
  manager.dispose();
});
