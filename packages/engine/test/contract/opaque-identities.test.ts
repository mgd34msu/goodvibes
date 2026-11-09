import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as atomic from '../../platform/src/platform/utils/atomic-json-store.js';
/** Regression source authored during coding; execution is deferred. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import * as types from '../../platform/src/platform/contract/types.js';
import * as placement from '../../platform/src/platform/contract/git-placement.js';
import { ContractStore, contractPath, contractCheckpointsDir, serializeContract } from '../../platform/src/platform/contract/store.js';
import { DurableContractAdmissions, type DurableContractRequest } from '../../platform/src/platform/contract/durable-admission.js';
import { captureNativeSettlementPublication } from '../../platform/src/platform/workflow/work-ledger/native-settlement-types.js';
import { makeHarness, makeRepo, oneUnitPlan, waitFor, type Harness } from './runner-support.js';
import { makeContract as fixtureContract } from './fixtures.js';
const roots: string[] = [], harnesses: Harness[] = [], stores: ContractStore[] = [];
afterEach(async () => { for (const h of harnesses.splice(0)) { const ids = h.runner.list({ includeTerminal: true }).map(row => row.id); h.dispose(); await Promise.all(ids.map(id => h.runner.join(id))); } for (const store of stores.splice(0)) store.dispose(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const id = `ctr-${opaqueUuid('00000000-0000-4000-8000-000000000001')}`;
function root() { const value = makeRepo(); roots.push(value); return value; }
function harness(path = root()) { const value = makeHarness({ root: path, contract: { maxActiveContracts: 0 }, plan: oneUnitPlan(), scripts: {}, durableAdmission: { withCurrent: (_admission, launch) => launch(() => undefined) } }); harnesses.push(value); return value; }
const input = (projectRoot: string) => ({ ask: 'Keep the original requested work', sessionId: 'identity-session', origin: 'cli' as const, projectRoot, isolation: 'shared' as const });
const request = (projectRoot: string, attemptId = 'attempt'): DurableContractRequest => ({ key: { workId: 'work', criteriaId: 'criteria', criteriaRevision: '1', attemptId },
  binding: { sourceId: 'source', inputRevision: 'input', actionId: 'action', actionRevision: '1', authorityId: 'owner', authorityRevision: '1', scopeId: 'workspace', scopeRevision: '1' }, input: input(projectRoot) });

test('new IDs use all opaque128bits while old IDs and only safe filenames remain readable', () => {
  const ids = new Set(Array.from({ length: 30 }, () => types.newContractId())); expect(ids.size).toBe(30);
  for (const value of ids) { expect(value).toMatch(/^ctr-[a-p]{8}(?:-[a-p]{4}){3}-[a-p]{12}$/); expect(types.isContractId(value)).toBe(true); }
  expect(types.isContractId('ctr-1234abcd')).toBe(true);
  for (const value of [`${id}/..`, `${id}.json`, '../' + id, 'ctr-' + 'a'.repeat(32), 'ctr-0000000g']) expect(types.isContractId(value)).toBe(false);
});

for (const mode of ['ordinary', 'draft', 'durable'] as const) {
  test(`${mode} keeps pending and live identities through placement awaits and refuses a second start`, async () => {
    const h = harness(), started = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    const chosen = spyOn(types, 'newContractId').mockReturnValue(id);
    const locate = spyOn(placement, 'resolveContractGitPlacement').mockImplementation(async () => { started.resolve(); await resume.promise; return { isolation: 'shared' }; });
    const begin = async (attempt = 'attempt') => mode === 'durable' ? h.runner.startDurable(request(h.root, attempt)) : mode === 'draft'
      ? h.runner.startFromPlan({ ...input(h.root), draft: { goal: 'Keep the original requested work', units: [{ id: 'u1', title: 'Original work', brief: 'Keep the original requested work', dependsOn: [] }] } }) : h.runner.start(input(h.root));
    try {
      const first = begin(); void first.catch(() => {}); await started.promise;
      expect(h.manager.list()).toHaveLength(0); expect(h.runner.list()).toHaveLength(0);
      await expect(Promise.resolve().then(() => begin('second-attempt'))).rejects.toThrow();
      expect(h.manager.list()).toHaveLength(0);
      resume.resolve(); const initial = await first; const contractId = 'admission' in initial ? initial.admission.contractId : initial.contract.id;
      const original = h.store.get(contractId)!; h.store.flush(); const bytes = readFileSync(contractPath(h.root, contractId));
      await expect(Promise.resolve().then(() => begin('third-attempt'))).rejects.toThrow();
      expect(h.store.get(contractId)).toBe(original); expect(readFileSync(contractPath(h.root, contractId))).toEqual(bytes);
      expect(h.runner.list()).toHaveLength(1); expect(h.manager.list().filter(record => record.contractRole === 'owner')).toHaveLength(1);
      expect(readdirSync(join(h.root, '.goodvibes', 'contracts', '.creation-claims'))).toEqual([]);
    } finally { resume.resolve(); locate.mockRestore(); chosen.mockRestore(); }
  });
}

test('AgentManager-owned startup cannot replace the original contract after its owner was published', async () => {
  const h = harness(); h.manager.setContractRunner(h.runner);
  const chosen = spyOn(types, 'newContractId').mockReturnValue(id);
  try {
    const first = h.manager.spawnOwned({ mode: 'spawn', task: 'First original owner', workingDirectory: h.root });
    await waitFor(() => first.record.contractId === id, 'original owner contract');
    const original = h.store.get(id)!;
    const second = h.manager.spawnOwned({ mode: 'spawn', task: 'Second conflicting owner', workingDirectory: h.root });
    await waitFor(() => second.record.status === 'failed', 'conflicting owner refusal');
    expect(h.store.get(id)).toBe(original); expect(first.record.status).not.toBe('cancelled'); expect(h.runner.list()).toHaveLength(1);
  } finally { chosen.mockRestore(); }
});

test('a spawn hook that occupies the selected checkpoint preserves its bytes and never registers the new run', async () => {
  const h = harness(), chosen = spyOn(types, 'newContractId').mockReturnValue(id);
  const spawn = h.manager.spawn.bind(h.manager);
  const intercept = spyOn(h.manager, 'spawn').mockImplementation((...args) => {
    const record = spawn(...args); mkdirSync(contractCheckpointsDir(h.root), { recursive: true });
    writeFileSync(contractPath(h.root, id), 'Foreign checkpoint from the intervening source'); return record;
  });
  try {
    await expect(h.runner.start(input(h.root))).rejects.toThrow('occupied');
    expect(readFileSync(contractPath(h.root, id), 'utf8')).toBe('Foreign checkpoint from the intervening source');
    expect(h.runner.list()).toHaveLength(0); expect(h.manager.list().every(record => record.status === 'cancelled')).toBe(true);
    expect(readdirSync(join(h.root, '.goodvibes', 'contracts', '.creation-claims'))).toEqual([]);
  } finally { intercept.mockRestore(); chosen.mockRestore(); }
});

test('failed placement releases original creation custody and a later original start can use the still-absent ID', async () => {
  const h = harness(), chosen = spyOn(types, 'newContractId').mockReturnValue(id);
  const locate = spyOn(placement, 'resolveContractGitPlacement').mockRejectedValue(new Error('Original placement failed'));
  try { await expect(h.runner.start(input(h.root))).rejects.toThrow('Original placement failed'); expect(h.manager.list()).toHaveLength(0); expect(existsSync(contractPath(h.root, id))).toBe(false); }
  finally { locate.mockRestore(); }
  try { expect((await h.runner.start(input(h.root))).contract.id).toBe(id); }
  finally { chosen.mockRestore(); }
});

test('existing saved history and old8hex IDs survive restart and refuse fresh collision', async () => {
  const path = root(), store = new ContractStore({ projectRoot: path, sweepIntervalMs: 0 }); stores.push(store);
  const historical = fixtureContract({ id: 'ctr-1234abcd', projectRoot: path, status: 'cancelled' });
  store.put(historical); expect(store.write(historical.id)).toBe(true); const bytes = readFileSync(contractPath(path, historical.id));
  expect(new ContractStore({ projectRoot: path }).load(historical.id)?.id).toBe(historical.id);
  const h = harness(path), chosen = spyOn(types, 'newContractId').mockReturnValue(historical.id);
  try { await expect(Promise.resolve().then(() => h.runner.start(input(path)))).rejects.toThrow(); expect(readFileSync(contractPath(path, historical.id))).toEqual(bytes); expect(h.manager.list()).toHaveLength(0); }
  finally { chosen.mockRestore(); }
});

test('native full-ID receipt survives durable restart and settlement publication shape with its exact worktree branch', async () => {
  const h = harness(), started = await h.runner.startDurable({ ...request(h.root), input: { ...input(h.root), isolation: 'worktree' } });
  expect(types.isOpaqueContractId(started.admission.contractId)).toBe(true);
  expect(started.admission.execution).toMatchObject({ branch: `contract/${started.admission.contractId.slice(4)}` });
  const publication = captureNativeSettlementPublication({ version: 2, receipt: started.admission, actorId: 'verifier', report: 'Complete original requested work',
    attestation: { outcome: 'verified', reason: 'Original criteria checked', references: [], source: 'host_check', criteriaResults: [] } });
  expect(publication.version).toBe(2);
  const saved = new DurableContractAdmissions(h.root).read(started.admission.key)!; expect(saved.contractId).toBe(started.admission.contractId);
  expect(new ContractStore({ projectRoot: h.root }).load(saved.contractId)?.id).toBe(saved.contractId);
});

test('native creation floor refuses before owner hooks, claim directories or checkpoint publication', () => {
  const path = root(); let declared = 0;
  const store = new ContractStore({ projectRoot: path, beforeCreate(value) { expect(types.isOpaqueContractId(value)).toBe(true); declared++; throw new Error('Older reader is still installed'); } }); stores.push(store);
  expect(() => store.reserveCreation(id)).toThrow('Older reader is still installed'); expect(declared).toBe(1);
  expect(existsSync(join(path, '.goodvibes', 'contracts'))).toBe(false);
});

test('the exclusive checkpoint commit preserves an intervening target even after a real reservation', () => {
  const path = root(), store = new ContractStore({ projectRoot: path }); stores.push(store); const reservation = store.reserveCreation(id);
  const value = fixtureContract({ id, projectRoot: path });
  try { mkdirSync(contractCheckpointsDir(path), { recursive: true }); writeFileSync(contractPath(path, id), 'Do not replace this new owner'); expect(() => store.publishCreation(reservation, value)).toThrow(); expect(readFileSync(contractPath(path, id), 'utf8')).toBe('Do not replace this new owner'); expect(store.get(id)).toBeNull(); }
  finally { reservation.release(); }
});

test('actual new full128 admission does not invoke historical receipt scanning, while an old ID lookup still holds corrupt unknown authority', async () => {
  const h = harness(); const directory = join(h.root, '.goodvibes', 'contracts', 'admissions'); mkdirSync(directory, { recursive: true });
  const unknown = join(directory, '0'.repeat(64) + '.json'); writeFileSync(unknown, '{older unrecognized receipt');
  const started = await h.runner.startDurable(request(h.root));
  expect(types.isOpaqueContractId(started.admission.contractId)).toBe(true);
  expect(new DurableContractAdmissions(h.root).findByContractId(started.admission.contractId)?.contractId).toBe(started.admission.contractId);
  expect(readFileSync(unknown, 'utf8')).toBe('{older unrecognized receipt');
  expect(() => new DurableContractAdmissions(h.root).findByContractId('ctr-ffffffff')).toThrow('invalid');
});

test('independent stores share a real creation claim and release only that original claim', () => {
  const path = root(), first = new ContractStore({ projectRoot: path }), second = new ContractStore({ projectRoot: path }); stores.push(first, second);
  const held = first.reserveCreation(id);
  try { expect(() => second.reserveCreation(id)).toThrow('being created'); }
  finally { held.release(); }
  const next = second.reserveCreation(id); next.assertCurrent(); next.release();
  expect(readdirSync(join(path, '.goodvibes', 'contracts', '.creation-claims'))).toEqual([]);
});

test('a borrowed initial persistence hook cannot redirect the contract ID into another stored owner', () => {
  const path = root(), victim = 'ctr-1234abcd'; mkdirSync(contractCheckpointsDir(path), { recursive: true });
  writeFileSync(contractPath(path, victim), 'Original other contract checkpoint');
  const store = new ContractStore({ projectRoot: path, beforeWrite(contract) { if (contract) (contract as { id: string }).id = victim; } }); stores.push(store);
  const reservation = store.reserveCreation(id), value = fixtureContract({ id, projectRoot: path });
  try {
    expect(() => store.publishCreation(reservation, value)).toThrow();
    expect(readFileSync(contractPath(path, victim), 'utf8')).toBe('Original other contract checkpoint'); expect(existsSync(contractPath(path, id))).toBe(false); expect(store.get(victim)).toBeNull();
  } finally { reservation.release(); }
});

test('retired physical claim parents preserve a foreign replacement during failed cleanup', () => {
  const path = root(), store = new ContractStore({ projectRoot: path }); stores.push(store);
  const reservation = store.reserveCreation(id), directory = join(path, '.goodvibes', 'contracts', '.creation-claims');
  renameSync(directory, directory + '.original'); mkdirSync(directory);
  const replacement = join(directory, `${id}.lock`); writeFileSync(replacement, 'Foreign creation claim');
  expect(() => reservation.assertCurrent()).toThrow(); expect(() => reservation.release()).toThrow();
  expect(readFileSync(replacement, 'utf8')).toBe('Foreign creation claim');
});

test('an existing staging leaf is preserved when exclusive initial creation fails', () => {
  const path = root(), store = new ContractStore({ projectRoot: path }); stores.push(store); const reservation = store.reserveCreation(id);
  mkdirSync(contractCheckpointsDir(path), { recursive: true });
  const foreign = join(contractCheckpointsDir(path), `${id}.json.tmp-foreign`); writeFileSync(foreign, 'Foreign original staging');
  const staged = spyOn(atomic, 'createAtomicTempPath').mockReturnValue(foreign);
  try { expect(() => store.publishCreation(reservation, fixtureContract({ id, projectRoot: path }))).toThrow(); expect(readFileSync(foreign, 'utf8')).toBe('Foreign original staging'); expect(existsSync(contractPath(path, id))).toBe(false); }
  finally { staged.mockRestore(); reservation.release(); }
});

test('a target forensic quarantine is preserved and holds that exact identity', () => {
  const path = root(), store = new ContractStore({ projectRoot: path }); stores.push(store);
  mkdirSync(contractCheckpointsDir(path), { recursive: true }); const forensic = contractPath(path, id) + '.unrecognized'; writeFileSync(forensic, 'Original forensic record');
  expect(() => store.reserveCreation(id)).toThrow('occupied'); expect(readFileSync(forensic, 'utf8')).toBe('Original forensic record'); expect(existsSync(contractPath(path, id))).toBe(false);
});

test('an actively publishing checkpoint is not adopted by a second reader', () => {
  const path = root(), writer = new ContractStore({ projectRoot: path }), reader = new ContractStore({ projectRoot: path }); stores.push(writer, reader);
  const reservation = writer.reserveCreation(id);
  try {
    writer.publishCreation(reservation, fixtureContract({ id, projectRoot: path }));
    expect(() => reader.load(id)).toThrow('still being created');
  } finally { reservation.release(); }
  expect(reader.load(id)?.id).toBe(id);
});

test('a real dead creator claim is reclaimed when its complete checkpoint is read after restart', () => {
  const path = root(), module = new URL('../../platform/src/platform/contract/store.ts', import.meta.url).href;
  const text = serializeContract(fixtureContract({ id, projectRoot: path, status: 'queued' }), Date.now())!;
  const script = `const {ContractStore}=await import(${JSON.stringify(module)});const data=JSON.parse(process.argv[1]);const store=new ContractStore({projectRoot:data.projectRoot});const claim=store.reserveCreation(data.id);store.publishCreation(claim,data);process.exit(0);`;
  const child = spawnSync(process.execPath, ['--eval', script, JSON.stringify(JSON.parse(text).contract)], { encoding: 'utf8' });
  expect(child.status).toBe(0);
  const claim = join(path, '.goodvibes', 'contracts', '.creation-claims', `${id}.lock`); expect(existsSync(claim)).toBe(true);
  const reader = new ContractStore({ projectRoot: path }); stores.push(reader);
  expect(reader.load(id)?.id).toBe(id); expect(existsSync(claim)).toBe(false);
});

test('a real claim appearing after the initial absent probe still fences the actual checkpoint read', () => {
  const path = root(), writer = new ContractStore({ projectRoot: path }), reader = new ContractStore({ projectRoot: path }); stores.push(writer, reader);
  const claimPath = join(path, '.goodvibes', 'contracts', '.creation-claims', `${id}.lock`);
  const original = fs.lstatSync, apply = Reflect.apply;
  let injected = false, reservation: ReturnType<ContractStore['reserveCreation']> | undefined;
  const probe = spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
    if (!injected && String(args[0]) === claimPath) {
      injected = true;
      try { return apply(original, fs, args); }
      catch (error) {
        reservation = writer.reserveCreation(id);
        writer.publishCreation(reservation, fixtureContract({ id, projectRoot: path, status: 'queued' }));
        throw error; // Preserve the real original absent observation.
      }
    }
    return apply(original, fs, args);
  }) as typeof fs.lstatSync);
  try { expect(() => reader.load(id)).toThrow('still being created'); expect(injected).toBe(true); }
  finally { probe.mockRestore(); reservation?.release(); }
  expect(reader.load(id)?.id).toBe(id);
});
