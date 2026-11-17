import { describe, expect, mock, test } from 'bun:test';
import { chmodSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import * as hostClient from '../../agent/connected-host-client.ts';

type Invoke = (method: string, input: unknown) => Promise<unknown>;
let invoke: Invoke = async () => ({ jobs: [] });

// The reconcile path calls the connected-host client; this is the one seam to the host.
mock.module('../../agent/connected-host-client.ts', () => ({
  ...hostClient,
  createConnectedHost: () => ({ invoke: (method: string, input: unknown) => invoke(method, input) }),
}));

const {
  reconcileRoutineScheduleReceipts,
  RoutineScheduleReceiptStore,
} = await import('../../agent/routine-schedule-receipts.ts');
const { formatRoutineScheduleCorrelation } = await import('../../agent/routine-schedule-format.ts');
const {
  ROUTINE_SCHEDULE_METHOD,
  ROUTINE_SCHEDULE_ROUTE,
} = await import('../../agent/routine-schedule-promotion.ts');
const { makeProjectTempDir } = await import('../helpers/project-temp.ts');

const BASE_URL = 'http://127.0.0.1:7317';
const DAY_MS = 24 * 60 * 60 * 1000;

function withStorePath<T>(fn: (storePath: string) => T | Promise<T>): Promise<T> {
  const root = makeProjectTempDir('gv-routine-receipt-safety');
  return Promise.resolve(fn(join(root, 'schedule-receipts.json'))).finally(() => {
    rmSync(root, { recursive: true, force: true });
  });
}

function receipt(id: string, createdAtMs: number) {
  return {
    id,
    createdAt: new Date(createdAtMs).toISOString(),
    routineId: `routine-${id}`,
    routineName: `Routine ${id}`,
    route: ROUTINE_SCHEDULE_ROUTE,
    method: ROUTINE_SCHEDULE_METHOD,
    status: 'created',
    connectedHostBaseUrl: BASE_URL,
    scheduleId: `sched-${id}`,
    scheduleName: `Routine ${id}`,
    scheduleKind: 'cron',
    scheduleValue: '0 9 * * *',
    enabled: true,
    target: {},
  };
}

const connection = { baseUrl: BASE_URL, token: 'token', tokenPath: '/tmp/operator-token' };
const preview = {
  routineId: 'nightly',
  routineName: 'Nightly',
  route: ROUTINE_SCHEDULE_ROUTE,
  method: ROUTINE_SCHEDULE_METHOD,
  payload: { name: 'Nightly', prompt: 'p', kind: 'cron', cron: '0 9 * * *', enabled: true },
} as unknown as Parameters<InstanceType<typeof RoutineScheduleReceiptStore>['append']>[1];
const created = { ok: true, kind: ROUTINE_SCHEDULE_METHOD, route: ROUTINE_SCHEDULE_ROUTE, routineId: 'nightly', routineName: 'Nightly', schedule: { id: 'live-1' }, request: preview.payload } as unknown as Parameters<InstanceType<typeof RoutineScheduleReceiptStore>['append']>[2];

describe('receipt store never writes over what it could not read', () => {
  test('a store that cannot be read is left byte-for-byte alone and append refuses', async () => {
    await withStorePath((storePath) => {
      const original = JSON.stringify({ version: 1, receipts: [receipt('keep', Date.now() - DAY_MS)] });
      writeFileSync(storePath, original, 'utf-8');
      chmodSync(storePath, 0o000);
      try {
        let readable = true;
        try { readFileSync(storePath, 'utf-8'); } catch { readable = false; }
        if (readable) return; // running with privileges that ignore file modes
        const store = new RoutineScheduleReceiptStore(storePath);
        expect(() => store.append(connection, preview, created)).toThrow();
        chmodSync(storePath, 0o600);
        expect(readFileSync(storePath, 'utf-8')).toBe(original);
      } finally {
        chmodSync(storePath, 0o600);
      }
    });
  });

  test('a store that is not JSON is copied aside before an append replaces it', async () => {
    await withStorePath((storePath) => {
      writeFileSync(storePath, '{"version":1,"receipts":[', 'utf-8');
      const store = new RoutineScheduleReceiptStore(storePath);
      expect(store.snapshot().receipts).toHaveLength(0);
      store.append(connection, preview, created);
      const copies = readdirSync(dirname(storePath)).filter((name) => name.startsWith(`${basename(storePath)}.unreadable-`));
      expect(copies).toHaveLength(1);
      expect(readFileSync(join(dirname(storePath), copies[0]!), 'utf-8')).toBe('{"version":1,"receipts":[');
    });
  });

  test('a store written by a newer version refuses writes and keeps every entry', async () => {
    await withStorePath((storePath) => {
      const original = JSON.stringify({ version: 2, receipts: [{ ...receipt('a', Date.now() - DAY_MS), scheduleKind: 'rrule' }] });
      writeFileSync(storePath, original, 'utf-8');
      const store = new RoutineScheduleReceiptStore(storePath);
      expect(() => store.append(connection, preview, created)).toThrow();
      expect(store.remove(['a'])).toBe(0);
      expect(readFileSync(storePath, 'utf-8')).toBe(original);
    });
  });

  test('an entry this version cannot validate survives later appends and removals', async () => {
    await withStorePath((storePath) => {
      const unknown = { id: 'odd', note: 'kept verbatim', scheduleKind: 'rrule' };
      writeFileSync(storePath, JSON.stringify({ version: 1, receipts: [receipt('a', Date.now() - DAY_MS), unknown] }), 'utf-8');
      const store = new RoutineScheduleReceiptStore(storePath);
      store.append(connection, preview, created);
      expect(store.remove(['a'])).toBe(1);
      const persisted = JSON.parse(readFileSync(storePath, 'utf-8')) as { receipts: unknown[] };
      expect(persisted.receipts).toContainEqual(unknown);
      expect(persisted.receipts).toHaveLength(2);
    });
  });
});

describe('reconcile', () => {
  test('names the receipts it retires from the local store', async () => {
    await withStorePath(async (storePath) => {
      writeFileSync(storePath, JSON.stringify({ version: 1, receipts: [receipt('gone', Date.now() - 2 * DAY_MS)] }), 'utf-8');
      invoke = async () => ({ jobs: [] });
      const store = new RoutineScheduleReceiptStore(storePath);
      const result = await reconcileRoutineScheduleReceipts(connection, store.snapshot());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reaping).toEqual({ reaped: 1, withinGrace: 0, reapedIds: ['gone'] });
      expect(formatRoutineScheduleCorrelation(result)).toContain('retired 1 local receipt');
      expect(formatRoutineScheduleCorrelation(result)).toContain('gone');
      expect(store.snapshot().receipts).toHaveLength(0);
    });
  });

  test('a receipt created on another host is listed as not checked and never reaped', async () => {
    await withStorePath(async (storePath) => {
      const elsewhere = { ...receipt('elsewhere', Date.now() - 2 * DAY_MS), connectedHostBaseUrl: 'http://192.0.2.10:3421' };
      writeFileSync(storePath, JSON.stringify({ version: 1, receipts: [elsewhere] }), 'utf-8');
      invoke = async () => ({ jobs: [] });
      const store = new RoutineScheduleReceiptStore(storePath);
      const result = await reconcileRoutineScheduleReceipts(connection, store.snapshot());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.correlations).toHaveLength(0);
      expect(result.notChecked.map((entry) => entry.receipt.id)).toEqual(['elsewhere']);
      expect(store.snapshot().receipts).toHaveLength(1);
    });
  });

  test('a host failure is a result, never a rejection', async () => {
    await withStorePath(async (storePath) => {
      writeFileSync(storePath, JSON.stringify({ version: 1, receipts: [receipt('keep', Date.now() - 2 * DAY_MS)] }), 'utf-8');
      invoke = async () => { throw Object.assign(new Error('boom'), { status: 500 }); };
      const store = new RoutineScheduleReceiptStore(storePath);
      const result = await reconcileRoutineScheduleReceipts(connection, store.snapshot());
      expect(result.ok).toBe(false);
      expect(store.snapshot().receipts).toHaveLength(1);
    });
  });
});
