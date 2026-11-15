/**
 * Boundaries of the work-ledger hosts and clients: a throwing authorization check is a refusal, a
 * tampered image is never served from the validation cache, host methods reject through their
 * promise, a restored host ledger is observed again, and the intake client's memory is bounded.
 */
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createWorkLedger, createEmptyWorkLedgerState } from '../platform/src/platform/workflow/work-ledger/index.ts';
import type { WorkLedgerStorage, WorkLedgerState } from '../platform/src/platform/workflow/work-ledger/index.ts';
import { createNativeWorkSubmissionHost } from '../platform/src/platform/workflow/work-ledger/native-submission.ts';
import { createNativeLegacyImportHost, type NativeLegacyImportDependencies } from '../platform/src/platform/workflow/work-ledger/native-import.ts';
import { createOperatorWorkLedgerReadClient } from '../platform/src/platform/workflow/work-ledger/operator-read-client.ts';
import { createOperatorNativeConversationIntakeClient } from '../platform/src/platform/workflow/work-ledger/native-intake-client.ts';
import type { NativePairedExecutionAuthority } from '../platform/src/platform/workflow/work-ledger/native-execution.ts';
import type { OperatorRemoteClient } from '../operator-client/src/client-core.js';

const PROJECT = 'boundary-project';
const clock = () => { let id = 0; return { now: () => 1_700_000_000_000 + id, newId: (kind: string) => `${kind}-${++id}` }; };

/** Smallest storage the service accepts: one image, replaced by each committed transaction. */
function memoryStorage(): WorkLedgerStorage & { image: unknown } {
  const storage = {
    image: createEmptyWorkLedgerState(PROJECT) as unknown,
    async read() { return structuredClone(storage.image); },
    async transaction<T>(decide: Parameters<WorkLedgerStorage['transaction']>[0]) {
      const decision = decide(structuredClone(storage.image), undefined) as { next: unknown; value: T };
      if (decision.next !== null) storage.image = structuredClone(decision.next);
      return decision.value;
    },
    subscribe(_listener: (state: WorkLedgerState) => void) { return () => {}; },
  };
  return storage as WorkLedgerStorage & { image: unknown };
}

describe('work ledger service', () => {
  test('an authorization check that throws is a refusal, not an unknown storage outcome', async () => {
    const storage = memoryStorage();
    const { service, authority } = createWorkLedger({ projectId: PROJECT, storage, clock: clock() });
    const actor = authority.issueActor({ actorId: 'coordinator', projectId: PROJECT, role: 'coordinator' });
    const result = await service.execute({ type: 'create', requestId: 'r1', expectedRevision: 0, title: 'T', goal: 'G', criteria: ['C'] }, actor,
      { isAuthorized: () => { throw new Error('owner changed'); } });
    expect(result).toMatchObject({ kind: 'rejected', code: 'forbidden' });
    expect((await service.readSnapshot(actor)).revision).toBe(0);
  });

  test('an edited ledger image is rejected even when the previous image was valid and unchanged in revision', async () => {
    const storage = memoryStorage();
    const { service, authority } = createWorkLedger({ projectId: PROJECT, storage, clock: clock() });
    const actor = authority.issueActor({ actorId: 'coordinator', projectId: PROJECT, role: 'coordinator' });
    const created = await service.execute({ type: 'create', requestId: 'r1', expectedRevision: 0, title: 'T', goal: 'G', criteria: ['C'] }, actor);
    expect(created.kind).toBe('accepted');
    expect((await service.readSnapshot(actor)).revision).toBe(1);
    expect((await service.readSnapshot(actor)).revision).toBe(1);
    const tampered = structuredClone(storage.image) as { works: { goal: string }[] };
    tampered.works[0]!.goal = 'changed outside the ledger';
    storage.image = tampered;
    await expect(service.readSnapshot(actor)).rejects.toMatchObject({ code: 'invalid_state' });
  });
});

describe('native hosts reject through the promise', () => {
  const revoked = { current: () => null, withCurrent: async () => { throw new Error('unreachable'); } } as unknown as NativePairedExecutionAuthority;
  const dir = mkdtempSync(`${tmpdir()}/host-boundaries-`);
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  test('submit and get on the submission host never throw synchronously', async () => {
    const host = createNativeWorkSubmissionHost({ projectId: PROJECT, projectRoot: dir, sessionId: 's', service: {}, authority: {}, scopes: {} } as never);
    let pending: Promise<unknown> | undefined;
    expect(() => { pending = host.submit({} as never, revoked); }).not.toThrow();
    await expect(pending).rejects.toMatchObject({ code: 'invalid' });
    expect(() => { pending = host.get({ requestId: 'x' }, revoked); }).not.toThrow();
    await expect(pending).rejects.toMatchObject({ code: 'unsupported-authority' });
    await host.close();
  });

  test('an import run with lost authority returns the forbidden result instead of throwing', async () => {
    const host = createNativeLegacyImportHost({ hostId: 'h', projectId: PROJECT, projectRoot: dir, storeId: 'store' } as unknown as NativeLegacyImportDependencies);
    let pending: Promise<unknown> | undefined;
    expect(() => { pending = host.run({}, revoked, { isAuthorized: () => true }); }).not.toThrow();
    await expect(pending).resolves.toMatchObject({ kind: 'rejected', code: 'forbidden' });
    await host.close();
  });
});

/** Distinct from the poll interval, so the per-request deadline timers can be told apart from poll timers. */
const REQUEST_TIMEOUT_MS = 5_000;
/** Run poll timers by hand: the client schedules with setTimeout, and each poll reschedules when it settles. */
function manualTimers() {
  const pending: Array<() => void> = [];
  let onScheduled: (() => void) | undefined;
  const set = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === REQUEST_TIMEOUT_MS) return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    pending.push(() => callback(...args));
    const notify = onScheduled; onScheduled = undefined; notify?.();
    return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation((() => {}) as typeof clearTimeout);
  return {
    pending,
    /** Fire the oldest timer and wait until the poll it started has finished and scheduled the next one. */
    async fire(settles: Promise<unknown> | 'reschedule') {
      const run = pending.shift(); if (!run) throw new Error('no timer is pending');
      const next = settles === 'reschedule' ? new Promise<void>((resolve) => { onScheduled = resolve; }) : settles;
      run(); await next;
    },
    restore() { set.mockRestore(); clear.mockRestore(); },
  };
}
const snapshotAt = (cursor: number) => ({ projectId: 'p', cursor, revision: cursor, provenance: 'available', works: [] });

describe('operator read client observation', () => {
  test('a host cursor that goes backwards is adopted and reported to listeners', async () => {
    let cursor = 5;
    const invoke = (async () => snapshotAt(cursor)) as unknown as OperatorRemoteClient['invoke'];
    const timers = manualTimers();
    try {
      const client = createOperatorWorkLedgerReadClient({ invoke }, 'p', { pollIntervalMs: 100, requestTimeoutMs: REQUEST_TIMEOUT_MS });
      const seen: number[] = [];
      client.subscribe((snapshot) => seen.push(snapshot.cursor));
      await timers.fire('reschedule');
      cursor = 2;
      await timers.fire('reschedule');
      expect(seen).toEqual([5, 2]);
      client.dispose();
    } finally { timers.restore(); }
  });

  test('a permanent denial tells the listeners, and a later subscribe starts observing again', async () => {
    const invoke = (async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); }) as unknown as OperatorRemoteClient['invoke'];
    const timers = manualTimers();
    try {
      const stopped: string[] = [];
      const client = createOperatorWorkLedgerReadClient({ invoke }, 'p', { pollIntervalMs: 100, requestTimeoutMs: REQUEST_TIMEOUT_MS, onObservationStopped: (error) => stopped.push(error.message) });
      client.subscribe(() => {});
      const stoppedFirst = new Promise<void>((resolve) => { const original = stopped.push.bind(stopped); stopped.push = (...items: string[]) => { const length = original(...items); resolve(); return length; }; });
      await timers.fire(stoppedFirst);
      expect(stopped).toEqual(['forbidden']);
      expect(timers.pending).toHaveLength(0);
      client.subscribe(() => {});
      expect(timers.pending).toHaveLength(1);
      client.dispose();
    } finally { timers.restore(); }
  });
});

describe('intake client memory', () => {
  test('only a bounded number of captured inputs are remembered', async () => {
    const result = (inputId: string, requestId: string) => ({ kind: 'captured', projectId: 'p', requestId,
      sourceRef: { version: 1, inputId, sourceId: `source-${inputId}`, sourceRevision: 'rev', sessionId: 's' } });
    let respondWith: unknown;
    const invoke = (async () => respondWith) as unknown as OperatorRemoteClient['invoke'];
    const client = createOperatorNativeConversationIntakeClient({ invoke }, 'p');
    const capture = (inputId: string, requestId: string) => ({ requestId, inputId, text: 'x', unsupportedSources: [] });
    respondWith = result('first', 'request-a');
    await client.capture(capture('first', 'request-a'));
    // Remembered: a later response claiming another request for the same input is refused.
    respondWith = result('first', 'request-b');
    await expect(client.get({ inputId: 'first' })).rejects.toMatchObject({ code: 'invalid_response' });
    for (let index = 0; index < 300; index++) { respondWith = result(`other-${index}`, `request-${index}`); await client.capture(capture(`other-${index}`, `request-${index}`)); }
    // Forgotten once the bound is passed, so the same response is no longer compared with it.
    respondWith = result('first', 'request-b');
    await expect(client.get({ inputId: 'first' })).resolves.toMatchObject({ kind: 'captured' });
    client.dispose();
  });
});
