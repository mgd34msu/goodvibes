/** Native labels are complete opaque IDs; execution ownership is stream-local. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrationEngine } from '../platform/src/platform/orchestration/engine.js';
import { serializeWorkstreamSnapshot } from '../platform/src/platform/orchestration/persistence.js';
import type { PhaseSpec } from '../platform/src/platform/orchestration/types.js';
import { createOrchestrationHarness, engineerReportOutput, makeFakeConfigManager } from './_helpers/orchestration-harness.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); });
const phase: PhaseSpec = { id: 'phase', kind: 'engineer', role: 'engineer', capacity: 1, gate: { scope: 'off', gates: [] } };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-identities-'));
  const h = createOrchestrationHarness();
  const engine = createOrchestrationEngine({ projectRoot: root, agentManager: h.agentManager, configManager: makeFakeConfigManager(),
    runtimeBus: h.bus, createWorktree: () => h.worktree, persist: false, skipClaimVerification: true });
  close.push(async () => {
    // A failed assertion must not leave a fake executor waiting forever and
    // obscure the actual identity regression with a teardown timeout.
    for (const record of h.spawnedRecords) if (record.status === 'running') h.completeAgent(record.id, engineerReportOutput({}));
    engine.dispose(); await engine.join(); rmSync(root, { recursive: true, force: true });
  });
  return { engine, h };
}

test('generated stream, phase, item and best-of-N identities preserve every UUID nibble', () => {
  const { engine } = fixture();
  const stream = engine.createWorkstream({ title: 'opaque', phases: [{ ...phase, id: undefined }],
    isolation: 'worktree', items: [{ title: 'attempt', task: 'task', attempts: 2 }] });
  const uuid = '[a-p]{8}-[a-p]{4}-[a-p]{4}-[a-p]{4}-[a-p]{12}';
  expect(stream.id).toMatch(new RegExp(`^ws-${uuid}$`));
  expect(stream.phases[0]!.id).toMatch(new RegExp(`^phase-${uuid}$`));
  for (const item of stream.items) {
    expect(item.id).toMatch(new RegExp(`^item-${uuid}$`));
    expect(item.attemptGroupId).toMatch(new RegExp(`^boN-${uuid}$`));
  }
});

test('a generated collision cannot replace an existing stream or its original results', () => {
  const { engine } = fixture();
  const random = spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-123456789abc');
  try {
    const original = engine.createWorkstream({ title: 'first', phases: [], items: [] });
    const results = engine.getPhaseResults(original.id);
    expect(() => engine.createWorkstream({ title: 'second', phases: [], items: [] })).toThrow('identity already exists');
    expect(engine.getWorkstream(original.id)).toBe(original);
    expect(engine.getPhaseResults(original.id)).toBe(results);
  } finally { random.mockRestore(); }
});

test('duplicate nested identities fail before any group, event or stream is published', async () => {
  const { engine } = fixture();
  const events: string[] = [];
  engine.on(event => events.push(event.type));
  expect(() => engine.createWorkstream({ id: 'bad-phase', title: 'duplicate phases', phases: [phase, phase], items: [] })).toThrow('phase identity');
  expect(() => engine.createWorkstream({ id: 'bad-item', title: 'expanded collision', phases: [phase], isolation: 'worktree',
    items: [{ id: 'unit', title: 'attempts', task: 'task', attempts: 2 }, { id: 'unit#a0', title: 'collision', task: 'task' }] })).toThrow('work item identity');
  expect(engine.listWorkstreams()).toEqual([]);
  expect(await engine.listHeldMergeGroups()).toEqual([]);
  expect(events).toEqual([]);
  // A failed creation releases only its own reservation.
  expect(engine.createWorkstream({ id: 'bad-item', title: 'valid retry', phases: [phase], items: [] }).id).toBe('bad-item');
});

test('a reentrant listener cannot create the stream whose attempt groups are being announced', () => {
  const { engine } = fixture();
  let refused = false;
  engine.on(event => {
    if (event.type !== 'item-attempts-spawned') return;
    try { engine.createWorkstream({ id: 'original', title: 'replacement', phases: [], items: [] }); }
    catch (error) { refused = error instanceof RangeError; }
  });
  const original = engine.createWorkstream({ id: 'original', title: 'original', phases: [phase], isolation: 'worktree',
    items: [{ id: 'unit', title: 'attempts', task: 'task', attempts: 2 }] });
  expect(refused).toBe(true);
  expect(engine.getWorkstream('original')).toBe(original);
});

test('equal labels in independent streams run independently and ambiguous item-only actions refuse', async () => {
  const { engine, h } = fixture();
  const make = (id: string) => engine.createWorkstream({ id, title: id, phases: [phase], items: [{ id: 'same-unit', title: id, task: 'task' }] });
  const first = make('first'), second = make('second');
  engine.start(first.id); engine.start(second.id);
  expect(h.spawnedRecords).toHaveLength(2);
  const firstAgent = first.items[0]!.agentId!, secondAgent = second.items[0]!.agentId!;
  const firstSignal = h.registeredSignals.get(firstAgent)!, secondSignal = h.registeredSignals.get(secondAgent)!;
  expect(firstSignal).not.toBe(secondSignal);
  expect(firstSignal.aborted).toBe(false); expect(secondSignal.aborted).toBe(false);
  expect(engine.kill('same-unit')).toBe(false);
  expect(engine.requeueItem('same-unit', 'ambiguous')).toBe(false);
  expect(engine.addDependency('same-unit', 'other', 'ambiguous')).toBeNull();
  expect(firstSignal.aborted).toBe(false); expect(secondSignal.aborted).toBe(false);
  h.completeAgent(firstAgent, engineerReportOutput({})); h.completeAgent(secondAgent, engineerReportOutput({}));
  await engine.join();
  expect(first.items[0]!.state).toBe('passed'); expect(second.items[0]!.state).toBe('passed');
  expect(engine.getPhaseResults(first.id)).toHaveLength(1); expect(engine.getPhaseResults(second.id)).toHaveLength(1);
});

test('duplicate imported identities and active same-ID replacement cannot mutate an original stream', async () => {
  const { engine, h } = fixture();
  const original = engine.createWorkstream({ id: 'ws-1234abcd', title: 'historical label', phases: [phase], items: [{ id: 'item-abcd1234', title: 'unit', task: 'task' }] });
  engine.start(original.id);
  const activeSnapshot = engine.serializeWorkstream(original.id)!;
  expect(engine.importWorkstream(activeSnapshot, true)).toBe(false);
  expect(engine.getWorkstream(original.id)).toBe(original);
  h.completeAgent(original.items[0]!.agentId!, engineerReportOutput({})); await engine.join();
  const invalid = { ...original, items: [original.items[0]!, { ...original.items[0]! }] };
  expect(engine.importWorkstream(serializeWorkstreamSnapshot(invalid, [])!, true)).toBe(false);
  expect(engine.getWorkstream(original.id)).toBe(original);
  const phaseCount = original.phases.length;
  expect(() => engine.insertPhase(original.id, 1, phase)).toThrow('phase identity');
  expect(original.phases).toHaveLength(phaseCount);
  // Historical opaque strings remain readable once their actual executor drains.
  expect(engine.importWorkstream(engine.serializeWorkstream(original.id)!, true)).toBe(true);
  expect(engine.getWorkstream(original.id)!.items[0]!.id).toBe('item-abcd1234');
});
