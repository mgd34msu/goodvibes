/** Regression source intentionally UNRUN during the coding-first pass. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { contractPath, contractCheckpointsDir, contractsDir } from '../../platform/src/platform/contract/store.js';
import { DurableContractAdmissions, durableKeyHash, type DurableContractRequest } from '../../platform/src/platform/contract/durable-admission.js';
import { makeHarness, makeRepo, oneUnitPlan, type Harness } from './runner-support.js';

const roots = new Set<string>(), running = new Set<Harness>();
async function close(h: Harness): Promise<void> {
  if (!running.delete(h)) return;
  const ids = h.runner.list({ includeTerminal: true }).map(contract => contract.id);
  h.dispose(); await Promise.all(ids.map(id => h.runner.join(id)));
}
afterEach(async () => { for (const h of [...running].reverse()) await close(h); for (const root of roots) rmSync(root, { recursive: true, force: true }); roots.clear(); });
function setup(root: string): Harness {
  const h = makeHarness({ root, plan: oneUnitPlan(), contract: { maxActiveContracts: 8 },
    durableAdmission: { withCurrent: (_admission, launch) => launch(() => undefined) },
    scripts: { u1: () => [{ text: '', stop: { kind: 'hang' } }] } });
  running.add(h); return h;
}
function request(root: string): DurableContractRequest {
  return { key: { workId: 'namespace-work', criteriaId: 'criteria', criteriaRevision: 'revision', attemptId: 'attempt' },
    binding: { sourceId: 'source', inputRevision: 'input', actionId: 'start', actionRevision: 'action-revision', authorityId: 'owner', authorityRevision: 'owner-revision', scopeId: 'workspace', scopeRevision: 'scope-revision' },
    input: { ask: 'Add a CSV parser module', sessionId: 'namespace-session', origin: 'turn', projectRoot: root, isolation: 'shared' } };
}

test('schema6 namespace keeps the original durable operation and cross-process execution lease across restart', async () => {
  const root = makeRepo(); roots.add(root); const input = request(root), first = setup(root);
  const started = await first.runner.startDurable(input), id = started.admission.contractId;
  const admissions = new DurableContractAdmissions(root), directory = join(contractsDir(root), 'admissions');
  const digest = durableKeyHash(input.key), path = join(directory, digest + '.json'), lease = path + '.execution';
  expect(dirname(contractPath(root, id))).toBe(contractCheckpointsDir(root));
  expect(JSON.parse(readFileSync(contractPath(root, id), 'utf8')).schemaVersion).toBe(6);
  expect(existsSync(join(contractsDir(root), id + '.json'))).toBe(false); expect(existsSync(lease)).toBe(true);
  const original = admissions.read(input.key);
  // The old program's flat checkpoint scanner never visits the new image.
  expect(readdirSync(contractsDir(root)).filter(name => /^ctr-[a-f0-9]{8}\.json$/.test(name))).toEqual([]);
  // Moving the ID copy did not create a second execution namespace.
  await expect(new DurableContractAdmissions(root).lease(input.key)).rejects.toThrow('cross-process-lock');
  const heldCheckpoint = admissions.checkpoint(input.key);
  expect(JSON.parse(heldCheckpoint).schemaVersion).toBe(6); expect(existsSync(path + '.unrecognized')).toBe(false);
  await close(first); expect(existsSync(lease)).toBe(false);
  const next = setup(root), resumed = await next.runner.resumeDurable(input.key);
  expect(resumed.admission).toEqual(started.admission); expect(resumed.admission.contractId).toBe(id);
  expect(admissions.read(input.key)).toEqual(original); expect(existsSync(lease)).toBe(true);
  expect(readdirSync(directory).filter(name => name.endsWith('.json'))).toEqual([digest + '.json']);
  expect(existsSync(join(contractsDir(root), id + '.json'))).toBe(false);
});


test('a restore failure after lease acquisition releases the original execution namespace', async () => {
  const root = makeRepo(); roots.add(root); const input = request(root), first = setup(root);
  const started = await first.runner.startDurable(input); await close(first);
  const next = setup(root), held = spyOn(next.store, 'hold').mockImplementation(() => { throw new Error('Owned checkpoint restore retired'); });
  try {
    await expect(next.runner.resumeDurable(input.key)).rejects.toThrow('restore retired');
    expect(next.runner.list({ includeTerminal: true })).toEqual([]);
    const release = await new DurableContractAdmissions(root).lease(input.key);
    release();
    expect(new DurableContractAdmissions(root).read(input.key)?.contractId).toBe(started.admission.contractId);
  } finally { held.mockRestore(); }
});
