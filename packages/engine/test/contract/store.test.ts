/**
 * ContractStore: round trip, atomic write, quarantine of files it
 * cannot trust, reaping bounds, and importContract refusing to replace a live
 * contract without force.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, linkSync, symlinkSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContractEvent } from '../../sdk/src/events/contract.js';
import {
  CONTRACT_QUARANTINE_MAX_AGE_MS,
  CURRENT_CONTRACT_SCHEMA_VERSION,
  ContractStore,
  ContractStoreVersionError,
  MAX_CONTRACT_QUARANTINE_FILES,
  contractPath,
  contractCheckpointsDir,
  contractsDir,
  deserializeContract,
  readContractSnapshot,
  serializeContract,
  type Contract,
  type ContractSnapshotRejection,
} from '../../sdk/src/platform/contract/index.js';
import { makeContract } from './fixtures.js';

const DAY = 24 * 60 * 60 * 1000;
const roots: string[] = [];

function tempRoot(): string {
  const root = join(tmpdir(), `gv-contract-store-${Date.now()}-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    const dir = contractCheckpointsDir(root);
    if (existsSync(dir)) chmodSync(dir, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

function withDeadWriter<T>(operation: () => T): T {
  const original = process.kill;
  const probe = spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === 999) throw Object.assign(new Error('fixture dead writer'), { code: 'ESRCH' });
    if (pid === 998) throw Object.assign(new Error('fixture inaccessible writer'), { code: 'EPERM' });
    return original(pid, signal);
  });
  try { return operation(); } finally { probe.mockRestore(); }
}

function envelope(contract: unknown, schemaVersion = 1, writtenAt = 5): string {
  return JSON.stringify({ schemaVersion, writtenAt, contract });
}

function writeRaw(root: string, id: string, text: string): string {
  mkdirSync(contractCheckpointsDir(root), { recursive: true });
  const path = contractPath(root, id);
  writeFileSync(path, text, 'utf-8');
  return path;
}

function storeAt(root: string, now: number = Date.now()): ContractStore {
  return new ContractStore({ projectRoot: root, now: () => now, sweepIntervalMs: 0 });
}

function terminalContract(completedAt: number, status: Contract['status'] = 'passed'): Contract {
  return makeContract({ status, completedAt });
}

describe('round trip', () => {
  test('a written contract loads back equal, inside a versioned envelope', () => {
    const root = tempRoot();
    const store = storeAt(root, 42_000);
    const contract = makeContract();
    contract.units[0]!.criteria[0]!.readings.push({
      checkId: 'u1.k1', at: 10, probabilityUnmet: 0.12, verdict: 'met', outcome: 'act', decisionId: 'd-1',
    });
    store.put(contract);
    expect(store.write(contract.id)).toBe(true);

    const onDisk = JSON.parse(readFileSync(contractPath(root, contract.id), 'utf-8')) as Record<string, unknown>;
    expect(onDisk['schemaVersion']).toBe(CURRENT_CONTRACT_SCHEMA_VERSION);
    expect(onDisk['writtenAt']).toBe(42_000);
    expect(storeAt(root).load(contract.id)).toEqual(contract);
  });

  test('serialize, then import into another store, gives the same contract', () => {
    const source = storeAt(tempRoot());
    const contract = makeContract({ status: 'passed', completedAt: 9 });
    source.put(contract);
    const json = source.serialize(contract.id);
    expect(json).not.toBeNull();
    const target = storeAt(tempRoot());
    expect(target.importContract(json!)).toBe(true);
    expect(target.get(contract.id)).toEqual(contract);
    expect(deserializeContract(json!)).toEqual(contract);
    expect(source.serialize('ctr-00000000')).toBeNull();
  });
});

describe('checkpoint namespaces', () => {
  test('flat schema1–5 checkpoints are read without rewriting and a new write preserves the old reader file', () => {
    for (const schemaVersion of [1, 2, 3, 4, 5]) {
      const root = tempRoot(), contract = makeContract(), store = storeAt(root);
      mkdirSync(contractsDir(root), { recursive: true });
      const oldPath = join(contractsDir(root), `${contract.id}.json`), original = envelope(contract, schemaVersion);
      writeFileSync(oldPath, original);
      expect(store.listStoredIds()).toEqual([contract.id]);
      const restored = store.load(contract.id)!; expect(restored.id).toBe(contract.id);
      expect(existsSync(contractPath(root, contract.id))).toBe(false);
      restored.goal = 'Updated by the schema-six reader'; store.hold(restored);
      expect(store.write(contract.id)).toBe(true);
      expect(readFileSync(oldPath, 'utf8')).toBe(original);
      // This is the actual old reader's flat-directory discovery rule.
      expect(readdirSync(contractsDir(root)).filter(name => name.endsWith('.json'))).toEqual([`${contract.id}.json`]);
      expect(JSON.parse(readFileSync(contractPath(root, contract.id), 'utf8')).schemaVersion).toBe(6);
      expect(store.listStoredIds()).toEqual([contract.id]);
      expect(storeAt(root).load(contract.id)?.goal).toBe(restored.goal);
      store.dispose();
    }
  });

  test('new checkpoints stay outside an already-running old reader scan and export/import uses the new namespace', () => {
    const root = tempRoot(), store = storeAt(root), contract = makeContract();
    store.hold(contract); expect(store.write(contract.id)).toBe(true);
    expect(readdirSync(contractsDir(root)).filter(name => name.endsWith('.json'))).toEqual([]);
    const targetRoot = tempRoot(), target = storeAt(targetRoot);
    expect(target.importContract(store.serialize(contract.id)!)).toBe(true);
    expect(existsSync(contractPath(targetRoot, contract.id))).toBe(true);
    expect(existsSync(join(contractsDir(targetRoot), `${contract.id}.json`))).toBe(false);
  });

  test('a future current checkpoint never falls back to an older flat checkpoint', () => {
    const root = tempRoot(), store = storeAt(root), contract = makeContract();
    mkdirSync(contractsDir(root), { recursive: true });
    const oldPath = join(contractsDir(root), `${contract.id}.json`), old = envelope(contract, 5);
    writeFileSync(oldPath, old);
    const future = envelope(contract, CURRENT_CONTRACT_SCHEMA_VERSION + 1), path = writeRaw(root, contract.id, future);
    expect(() => store.load(contract.id)).toThrow(ContractStoreVersionError);
    expect(() => store.hold(contract)).toThrow(ContractStoreVersionError);
    expect(store.importContract(envelope(contract), true)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(future); expect(readFileSync(oldPath, 'utf8')).toBe(old);
    expect(store.reap().total).toBe(0); expect(store.listStoredIds()).toEqual([contract.id]);
  });

  test('housekeeping covers abandoned files in both namespaces without moving an old active checkpoint', () => {
    const root = tempRoot(), store = storeAt(root), contract = makeContract({ status: 'running' });
    mkdirSync(contractsDir(root), { recursive: true });
    const oldPath = join(contractsDir(root), `${contract.id}.json`), old = envelope(contract, 5);
    writeFileSync(oldPath, old); writeRaw(root, contract.id, envelope({ ...contract, goal: 'new' }));
    const stale = [oldPath, contractPath(root, contract.id)].map(path => `${path}.tmp-999-1-deadbeef`);
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const path of stale) { writeFileSync(path, '{}'); utimesSync(path, past, past); }
    expect(withDeadWriter(() => store.reap()).staleTempRemoved).toBe(2);
    expect(readFileSync(oldPath, 'utf8')).toBe(old);
    expect(storeAt(root).load(contract.id)?.goal).toBe('new');
  });
});

describe('atomic write', () => {
  test('a write leaves only the contract file behind, and a rewrite replaces it whole', () => {
    const root = tempRoot();
    const store = storeAt(root);
    const contract = makeContract();
    store.put(contract);
    store.write(contract.id);
    contract.goal = 'A second goal';
    contract.status = 'judging';
    store.write(contract.id);
    expect(readdirSync(contractCheckpointsDir(root))).toEqual([`${contract.id}.json`]);
    expect(storeAt(root).load(contract.id)?.goal).toBe('A second goal');
  });

  test('a write that fails keeps the previous file whole', () => {
    const root = tempRoot();
    const store = storeAt(root);
    const contract = makeContract();
    store.put(contract);
    store.write(contract.id);
    chmodSync(contractCheckpointsDir(root), 0o500);
    contract.goal = 'Never written';
    expect(store.write(contract.id)).toBe(false);
    chmodSync(contractCheckpointsDir(root), 0o700);
    expect(storeAt(root).load(contract.id)?.goal).toBe('A parser for every documented input form');
    expect(readdirSync(contractCheckpointsDir(root))).toEqual([`${contract.id}.json`]);
  });

  test('a temp file left by a dead writer is reaped after an hour; a fresh one is left alone', () => {
    const root = tempRoot();
    const contract = makeContract();
    const path = writeRaw(root, contract.id, envelope(contract));
    const stale = `${path}.tmp-999-1-deadbeef`;
    const fresh = `${path}.tmp-999-2-feedface`;
    writeFileSync(stale, '{"partial', 'utf-8');
    writeFileSync(fresh, '{"partial', 'utf-8');
    const now = Date.now();
    utimesSync(stale, new Date(now - 2 * 60 * 60 * 1000), new Date(now - 2 * 60 * 60 * 1000));
    const summary = withDeadWriter(() => storeAt(root, now).reap());
    expect(summary.staleTempRemoved).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  test('age alone never reaps a live, inaccessible, foreign-named or aliased temporary file', () => {
    const root = tempRoot(), contract = makeContract(), path = writeRaw(root, contract.id, envelope(contract));
    const dead = `${path}.tmp-999-1-deadbeef`, live = `${path}.tmp-${process.pid}-1-feedface`, inaccessible = `${path}.tmp-998-1-feedface`;
    const foreign = `${path}.tmp-999-manual-backup`, unrelated = join(contractCheckpointsDir(root), 'notes.json.tmp-999-1-deadbeef');
    const hardlink = `${path}.tmp-999-2-deadbeef`, alias = `${path}.tmp-999-3-deadbeef`, original = join(root, 'original-temp-body');
    for (const file of [dead, live, inaccessible, foreign, unrelated, original]) writeFileSync(file, 'kept');
    linkSync(original, hardlink); symlinkSync(original, alias);
    const now = Date.now(), old = new Date(now - 2 * 60 * 60 * 1000);
    for (const file of [dead, live, inaccessible, foreign, unrelated, hardlink]) utimesSync(file, old, old);
    const summary = withDeadWriter(() => storeAt(root, now).reap());
    expect(summary.staleTempRemoved).toBe(1); expect(existsSync(dead)).toBe(false);
    for (const file of [live, inaccessible, foreign, unrelated, hardlink, alias, original]) expect(readFileSync(file, 'utf8')).toBe('kept');
  });

  test('no contract id can name a path outside the contract directory', () => {
    expect(() => contractPath('/p', '../ctr-00000000')).toThrow('Not a contract id');
    expect(() => contractPath('/p', 'ctr-0000000g')).toThrow('Not a contract id');
    expect(contractPath('/p', 'ctr-0000abcd')).toBe(join('/p', '.goodvibes', 'contracts', 'checkpoints-v6', 'ctr-0000abcd.json'));
  });
});

describe('quarantine', () => {
  test('unchanged version checks reuse their exact physical image and a foreign future replacement invalidates it', () => {
    const root = tempRoot(), contract = makeContract(), store = storeAt(root);
    const path = writeRaw(root, contract.id, envelope(contract)); store.hold(contract);
    const parse = spyOn(JSON, 'parse');
    try {
      store.hold(contract); store.hold(contract);
      expect(parse).not.toHaveBeenCalled();
      const future = envelope(contract, CURRENT_CONTRACT_SCHEMA_VERSION + 1), stage = `${path}.replacement`;
      writeFileSync(stage, future); renameSync(stage, path);
      expect(() => store.hold(contract)).toThrow(ContractStoreVersionError);
      expect(readFileSync(path, 'utf8')).toBe(future);
    } finally { parse.mockRestore(); }
  });

  test('future checkpoints remain at their original path and refuse load, put, hold, write and forced import', () => {
    const root = tempRoot(), contract = makeContract(), store = storeAt(root);
    store.hold(contract);
    const text = envelope(contract, CURRENT_CONTRACT_SCHEMA_VERSION + 1), path = writeRaw(root, contract.id, text);
    expect(() => store.load(contract.id)).toThrow(ContractStoreVersionError);
    expect(() => store.put(contract)).toThrow(ContractStoreVersionError);
    expect(() => store.hold(contract)).toThrow(ContractStoreVersionError);
    expect(store.write(contract.id)).toBe(false);
    expect(store.importContract(envelope(contract), true)).toBe(false);
    expect(store.listStoredIds()).toContain(contract.id);
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(existsSync(`${path}.unrecognized`)).toBe(false);
  });

  const cases: ReadonlyArray<readonly [string, (contract: Contract) => string, ContractSnapshotRejection]> = [
    ['corrupt JSON', () => '{"schemaVersion": 1, "contract": {', 'unparseable'],
    ['a bare contract with no envelope', (contract) => JSON.stringify(contract), 'invalid-contract'],
    ['an envelope with no schema version', (contract) => JSON.stringify({ writtenAt: 1, contract }), 'not-an-envelope'],
    ['a malformed contract', (contract) => envelope({ ...contract, units: 'none' }), 'invalid-contract'],
    ['an unknown status', (contract) => envelope({ ...contract, status: 'reviewing' }), 'invalid-contract'],
  ];

  for (const [name, text, reason] of cases) {
    test(`${name} is moved to .unrecognized and not loaded`, () => {
      const root = tempRoot();
      const contract = makeContract();
      const path = writeRaw(root, contract.id, text(contract));
      expect(readContractSnapshot(text(contract))).toEqual({ rejected: reason });
      expect(storeAt(root).load(contract.id)).toBeNull();
      expect(existsSync(path)).toBe(false);
      expect(readFileSync(`${path}.unrecognized`, 'utf-8')).toBe(text(contract));
    });
  }

  test('a file holding a different contract than its name is quarantined', () => {
    const root = tempRoot();
    const contract = makeContract();
    const path = writeRaw(root, 'ctr-0000ffff', envelope(contract));
    expect(storeAt(root).load('ctr-0000ffff')).toBeNull();
    expect(existsSync(`${path}.unrecognized`)).toBe(true);
  });

  test('deserializeContract refuses a newer schema rather than trusting part of it', () => {
    expect(deserializeContract(envelope(makeContract(), CURRENT_CONTRACT_SCHEMA_VERSION + 1))).toBeNull();
    expect(deserializeContract(envelope(makeContract(), 1))).not.toBeNull();
  });
});

describe('reaping', () => {
  test('terminal contracts remain available beyond 14 days alongside live contracts', () => {
    const root = tempRoot();
    const now = 100 * DAY;
    const old = terminalContract(now - (14 * DAY) - 1, 'failed');
    const recent = terminalContract(now - (14 * DAY) + 1, 'cancelled');
    const live = makeContract({ status: 'awaiting-owner', createdAt: 0 });
    for (const contract of [old, recent, live]) writeRaw(root, contract.id, envelope(contract, 1, 0));

    const summary = storeAt(root, now).reap();
    expect(summary.terminalExpired).toBe(0);
    expect(summary.reapedIds).toEqual([]);
    expect(existsSync(contractPath(root, old.id))).toBe(true);
    expect(existsSync(contractPath(root, recent.id))).toBe(true);
    expect(existsSync(contractPath(root, live.id))).toBe(true);
  });

  test('all terminal and live contracts are retained beyond 50 files', () => {
    const root = tempRoot();
    const now = 100 * DAY;
    const terminal = Array.from({ length: 50 + 3 }, (_, index) => terminalContract(now - DAY + index));
    const live = Array.from({ length: 5 }, () => makeContract({ status: 'running' }));
    for (const contract of [...terminal, ...live]) writeRaw(root, contract.id, envelope(contract));

    const summary = storeAt(root, now).reap();
    expect(summary.terminalOverCap).toBe(0);
    expect(summary.reapedIds).toEqual([]);
    expect(readdirSync(contractCheckpointsDir(root))).toHaveLength(53 + 5);
  });

  test('a contract held live in memory is not reaped even when its file on disk says terminal', () => {
    const root = tempRoot();
    const now = 100 * DAY;
    const onDisk = terminalContract(0);
    writeRaw(root, onDisk.id, envelope(onDisk));
    const store = storeAt(root, now);
    store.put({ ...onDisk, status: 'running', completedAt: undefined });
    expect(store.reap().total).toBe(0);
    expect(existsSync(contractPath(root, onDisk.id))).toBe(true);
  });

  test('an old terminal contract remains available in memory', () => {
    const root = tempRoot();
    const store = storeAt(root, 100 * DAY);
    const contract = terminalContract(0);
    store.put(contract);
    store.write(contract.id);
    store.reap();
    expect(store.get(contract.id)).toEqual(contract);
  });

  test('quarantine files go after 30 days, and beyond 20 the oldest go', () => {
    const root = tempRoot();
    const now = Date.now();
    mkdirSync(contractCheckpointsDir(root), { recursive: true });
    const files = Array.from({ length: MAX_CONTRACT_QUARANTINE_FILES + 4 }, (_, index) => {
      const path = join(contractCheckpointsDir(root), `ctr-${index.toString(16).padStart(8, '0')}.json.unrecognized`);
      writeFileSync(path, 'x', 'utf-8');
      const at = new Date(now - (index + 1) * 60_000);
      utimesSync(path, at, at);
      return path;
    });
    const expired = join(contractCheckpointsDir(root), 'ctr-ffffffff.json.unrecognized');
    writeFileSync(expired, 'x', 'utf-8');
    const long = new Date(now - CONTRACT_QUARANTINE_MAX_AGE_MS - 60_000);
    utimesSync(expired, long, long);

    const summary = storeAt(root, now).reap();
    expect(summary.quarantineExpired).toBe(1);
    expect(summary.quarantineOverCap).toBe(4);
    expect(existsSync(expired)).toBe(false);
    // The newest 20 remain: files are numbered newest first.
    expect(files.filter((path) => existsSync(path))).toEqual(files.slice(0, MAX_CONTRACT_QUARANTINE_FILES));
  });

  test('a refused file is left for load() to quarantine, not deleted by the reap', () => {
    const root = tempRoot();
    const contract = terminalContract(0);
    const path = writeRaw(root, contract.id, envelope(contract, CURRENT_CONTRACT_SCHEMA_VERSION + 1));
    expect(storeAt(root, 100 * DAY).reap().total).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  test('listStoredIds retains old and live contracts while excluding unrelated files', () => {
    const root = tempRoot();
    const old = terminalContract(0);
    const live = makeContract();
    writeRaw(root, old.id, envelope(old));
    writeRaw(root, live.id, envelope(live));
    writeFileSync(join(contractCheckpointsDir(root), 'notes.json'), '{}', 'utf-8');
    expect(storeAt(root, 100 * DAY).listStoredIds().sort()).toEqual([live.id, old.id].sort());
  });
});

describe('importContract', () => {
  test('refuses to replace a live contract held in memory unless forced', () => {
    const store = storeAt(tempRoot());
    const live = makeContract({ status: 'running' });
    store.put(live);
    const replacement = { ...live, status: 'passed' as const, goal: 'Replaced' };
    const json = serializeContract(replacement, 1)!;
    expect(store.importContract(json)).toBe(false);
    expect(store.get(live.id)?.goal).toBe(live.goal);
    expect(store.importContract(json, true)).toBe(true);
    expect(store.get(live.id)?.goal).toBe('Replaced');
  });

  test('refuses to replace a live contract that is only on disk unless forced', () => {
    const root = tempRoot();
    const live = makeContract({ status: 'awaiting-owner' });
    writeRaw(root, live.id, envelope(live));
    const json = serializeContract({ ...live, goal: 'Replaced' }, 1)!;
    expect(storeAt(root).importContract(json)).toBe(false);
    expect(storeAt(root).load(live.id)?.goal).toBe(live.goal);
    expect(storeAt(root).importContract(json, true)).toBe(true);
    expect(storeAt(root).load(live.id)?.goal).toBe('Replaced');
  });

  test('replaces a terminal contract without force, holding and writing it at once', () => {
    const root = tempRoot();
    const store = storeAt(root);
    const done = makeContract({ status: 'failed', completedAt: 3 });
    store.put(done);
    const again = { ...done, status: 'queued' as const, completedAt: undefined };
    expect(store.importContract(serializeContract(again, 1)!)).toBe(true);
    expect(store.get(done.id)?.status).toBe('queued');
    expect(storeAt(root).load(done.id)?.status).toBe('queued');
  });

  test('failed persistence refuses import and preserves the previous memory and disk state', () => {
    const root = tempRoot();
    const store = storeAt(root);
    const original = makeContract({ status: 'passed', completedAt: 1 });
    store.hold(original); expect(store.write(original.id)).toBe(true);
    const path = contractPath(root, original.id);
    const before = readFileSync(path, 'utf8');
    chmodSync(contractCheckpointsDir(root), 0o500);
    try {
      expect(store.importContract(serializeContract({ ...original, goal: 'uncommitted import' }, 2)!, true)).toBe(false);
      expect(store.get(original.id)?.goal).toBe(original.goal);
      expect(readFileSync(path, 'utf8')).toBe(before);
      const other = makeContract({ id: 'failed-new-import' });
      expect(store.importContract(serializeContract(other, 2)!)).toBe(false);
      expect(store.get(other.id)).toBeNull();
    } finally { chmodSync(contractCheckpointsDir(root), 0o700); store.dispose(); }
  });

  test('refuses a snapshot it cannot trust', () => {
    const store = storeAt(tempRoot());
    expect(store.importContract(envelope(makeContract(), CURRENT_CONTRACT_SCHEMA_VERSION + 1))).toBe(false);
    expect(store.importContract('not json')).toBe(false);
    expect(store.list()).toEqual([]);
  });
});

describe('the debounced writer', () => {
  function bus(): { subscribe: (listener: (event: ContractEvent) => void) => () => void; emit: (event: ContractEvent) => void; listeners: number } {
    const listeners = new Set<(event: ContractEvent) => void>();
    return {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit: (event) => listeners.forEach((listener) => listener(event)),
      get listeners() {
        return listeners.size;
      },
    };
  }

  test('a contract event schedules a write of that contract after the debounce', async () => {
    const root = tempRoot();
    const events = bus();
    const store = new ContractStore({ projectRoot: root, debounceMs: 20, sweepIntervalMs: 0 });
    const contract = makeContract();
    store.put(contract);
    store.flush();
    const detach = store.attach(events.subscribe);
    contract.status = 'judging';
    events.emit({ type: 'CONTRACT_STATUS_CHANGED', contractId: contract.id, from: 'running', to: 'judging' });
    expect(storeAt(root).load(contract.id)?.status).toBe('running');
    await Bun.sleep(60);
    expect(storeAt(root).load(contract.id)?.status).toBe('judging');
    detach();
    expect(events.listeners).toBe(0);
  });

  test('detaching writes whatever is still pending, and events for contracts not held are ignored', () => {
    const root = tempRoot();
    const events = bus();
    const store = new ContractStore({ projectRoot: root, debounceMs: 60_000, sweepIntervalMs: 0 });
    const contract = makeContract();
    store.put(contract);
    const detach = store.attach(events.subscribe);
    events.emit({ type: 'CONTRACT_PASSED', contractId: 'ctr-00000abc', criteriaMet: 1, criteriaJudged: 1, excluded: 0, nudges: 0 });
    events.emit({ type: 'CONTRACT_SPAWN_GUARD_TRIGGERED', agentId: 'a', depth: 2, activeAgents: 3, reason: 'units are leaves' });
    expect(existsSync(contractPath(root, contract.id))).toBe(false);
    detach();
    expect(existsSync(contractPath(root, contract.id))).toBe(true);
    expect(existsSync(contractPath(root, 'ctr-00000abc'))).toBe(false);
  });
});
