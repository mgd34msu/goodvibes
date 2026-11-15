import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUnitWatchdog, type WatchedAgent } from '../platform/src/platform/contract/watchdog.js';
import { ContractStore, contractPath } from '../platform/src/platform/contract/store.js';
import { makeContract } from './contract/fixtures.js';

type Handler = (event: { payload: { agentId: string } }) => void;
function fakeBus() {
  const handlers = new Map<string, Handler[]>();
  return {
    on: ((type: string, handler: Handler) => {
      handlers.set(type, [...(handlers.get(type) ?? []), handler]);
      return () => { handlers.set(type, (handlers.get(type) ?? []).filter((candidate) => candidate !== handler)); };
    }) as never,
    emit(type: string, agentId: string) { for (const handler of handlers.get(type) ?? []) handler({ payload: { agentId } }); },
  };
}

const TIMEOUT = 4_000;
const INTERVAL = 1_000;

function watchdogFixture(agents: readonly WatchedAgent[] = [{ contractId: 'c', unitId: 'u', agentId: 'a1', startedAt: 0 }]) {
  const bus = fakeBus();
  const clock = { now: 0 };
  const silent: number[] = [];
  const watchdog = createUnitWatchdog({
    runtimeBus: bus,
    timeoutMs: () => TIMEOUT,
    watched: () => agents,
    onSilent: (_agent, silentMs) => { silent.push(silentMs); },
    now: () => clock.now,
  });
  return { bus, clock, silent, watchdog };
}

describe('the unit silence watchdog', () => {
  test('an agent that stays quiet for the whole timeout is reported once the timeout has passed', () => {
    const { clock, silent, watchdog } = watchdogFixture();
    watchdog.touch('a1');
    for (clock.now = INTERVAL; clock.now < TIMEOUT; clock.now += INTERVAL) watchdog.tick();
    expect(silent).toEqual([]);
    clock.now = TIMEOUT;
    watchdog.tick();
    expect(silent).toEqual([TIMEOUT]);
    watchdog.dispose();
  });

  test('progress from a watched agent restarts its clock', () => {
    const { bus, clock, silent, watchdog } = watchdogFixture();
    watchdog.touch('a1');
    for (clock.now = INTERVAL; clock.now <= 3 * INTERVAL; clock.now += INTERVAL) watchdog.tick();
    clock.now = 3 * INTERVAL;
    bus.emit('AGENT_PROGRESS', 'a1');
    for (clock.now = 4 * INTERVAL; clock.now < 7 * INTERVAL; clock.now += INTERVAL) watchdog.tick();
    expect(silent).toEqual([]);
    clock.now = 7 * INTERVAL;
    watchdog.tick();
    expect(silent).toEqual([TIMEOUT]);
    watchdog.dispose();
  });

  test('a long gap between ticks is a stopped process, not silence, and the clock restarts after it', () => {
    const { clock, silent, watchdog } = watchdogFixture();
    watchdog.touch('a1');
    clock.now = INTERVAL;
    watchdog.tick();
    // The machine slept for ten timeouts: the next tick must not blame the agent.
    clock.now = INTERVAL + 10 * TIMEOUT;
    watchdog.tick();
    expect(silent).toEqual([]);
    const wokeAt = clock.now;
    for (clock.now = wokeAt + INTERVAL; clock.now < wokeAt + TIMEOUT; clock.now += INTERVAL) watchdog.tick();
    expect(silent).toEqual([]);
    clock.now = wokeAt + TIMEOUT;
    watchdog.tick();
    expect(silent).toEqual([TIMEOUT]);
    watchdog.dispose();
  });

  test('agents the runner never touched do not accumulate, and a finished agent is dropped', () => {
    const { bus, watchdog } = watchdogFixture();
    for (let index = 0; index < 1_000; index += 1) bus.emit('AGENT_PROGRESS', `unrelated-${index}`);
    expect(watchdog.trackedAgents()).toBe(0);
    watchdog.touch('a1');
    bus.emit('AGENT_PROGRESS', 'a1');
    expect(watchdog.trackedAgents()).toBe(1);
    bus.emit('AGENT_COMPLETED', 'a1');
    bus.emit('AGENT_PROGRESS', 'a1');
    expect(watchdog.trackedAgents()).toBe(0);
    watchdog.dispose();
  });
});

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function projectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-contract-store-'));
  dirs.push(dir);
  return dir;
}

describe('the contract checkpoint store', () => {
  test('a debounced or flushed write that fails is reported, and cleared by the next one that succeeds', () => {
    const root = projectRoot();
    let refuse = true;
    const reported: string[] = [];
    const store = new ContractStore({
      projectRoot: root,
      sweepIntervalMs: 0,
      beforeWrite() { if (refuse) throw new Error('disk is full'); },
      onWriteFailure: (contractId, failure) => { reported.push(`${contractId}: ${failure.message}`); },
    });
    const contract = makeContract({ projectRoot: root });
    try {
      store.put(contract);
      store.scheduleWrite(contract.id);
      store.flush();
      expect(store.writeFailure(contract.id)?.message).toContain('disk is full');
      expect(store.writeFailure(contract.id)?.newerFormat).toBe(false);
      expect(reported).toHaveLength(1);
      refuse = false;
      expect(store.write(contract.id)).toBe(true);
      expect(store.writeFailure(contract.id)).toBeNull();
    } finally { store.dispose(); }
  });

  test('a checkpoint written by a newer build is reported, never overwritten, and not retried on every event', () => {
    const root = projectRoot();
    const store = new ContractStore({ projectRoot: root, sweepIntervalMs: 0 });
    const contract = makeContract({ projectRoot: root });
    try {
      store.put(contract);
      expect(store.write(contract.id)).toBe(true);
      const path = contractPath(root, contract.id);
      const envelope = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion: number };
      envelope.schemaVersion += 1;
      const newer = JSON.stringify(envelope);
      writeFileSync(path, newer);
      expect(store.write(contract.id)).toBe(false);
      expect(store.writeFailure(contract.id)).toMatchObject({ newerFormat: true });
      store.scheduleWrite(contract.id);
      store.flush();
      expect(readFileSync(path, 'utf8')).toBe(newer);
    } finally { store.dispose(); }
  });

  test('listing stored ids does not read and parse every completed checkpoint', () => {
    const root = projectRoot();
    const store = new ContractStore({ projectRoot: root, sweepIntervalMs: 0 });
    const contract = makeContract({ projectRoot: root, status: 'passed' });
    try {
      store.put(contract);
      expect(store.write(contract.id)).toBe(true);
      const reads: string[] = [];
      const original = fs.readFileSync;
      const spy = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
        reads.push(String(args[0]));
        return original(...args);
      }) as typeof fs.readFileSync);
      try {
        expect(store.listStoredIds()).toContain(contract.id);
      } finally { spy.mockRestore(); }
      expect(reads.filter((path) => path.endsWith(`${contract.id}.json`))).toEqual([]);
    } finally { store.dispose(); }
  });
});

