import { expect, test } from 'bun:test';
import { useFailureReadings } from './_helpers/failure-readings.ts';
useFailureReadings([]);
import { HostedSessionSpineIntake, type HostedSessionSpine } from '../platform/src/platform/hosted-sessions/spine-intake.ts';
import type { HostedSessionRecord } from '../platform/src/platform/hosted-sessions/types.ts';

function record(id: string): HostedSessionRecord {
  return { id, workspaceRoot: '/w', title: 'a session', status: 'idle', detachPolicy: null, effectiveDetachPolicy: 'survive', attachedClients: [],
    createdAt: 1, updatedAt: 1, turnCount: 0, messageCount: 0, restoredFromDisk: false, contractIds: [] };
}

/** A spine that keeps a collected input out of the queued set only once the collected mark lands, like the broker. */
function spine(queued: Map<string, { id: string; body: string }[]>, hooks: {
  collect?: (inputId: string) => Promise<void>;
  consume?: (inputId: string) => Promise<void>;
  register?: (sessionId: string) => Promise<unknown>;
} = {}) {
  const log = { registered: [] as string[], collected: [] as string[], consumed: [] as string[] };
  const value: HostedSessionSpine = {
    register: async input => { log.registered.push(input.sessionId); return hooks.register ? hooks.register(input.sessionId) : {}; },
    closeSession: async () => ({}),
    getInputsSince: sessionId => queued.get(sessionId) ?? [],
    markInputDelivered: async (sessionId, inputId, options) => {
      if (options?.consumed === true) { await hooks.consume?.(inputId); log.consumed.push(inputId); return {}; }
      await hooks.collect?.(inputId);
      log.collected.push(inputId);
      queued.set(sessionId, (queued.get(sessionId) ?? []).filter(entry => entry.id !== inputId));
      return {};
    },
  };
  return { value, log };
}

function intake(value: HostedSessionSpine, sessions: HostedSessionRecord[], deliveries: string[], intervalMs = 750) {
  return new HostedSessionSpineIntake({ spine: value, liveSessions: () => sessions, now: () => 1, intervalMs,
    deliver: async (sessionId, text) => { deliveries.push(`${sessionId}:${text}`); } });
}

test('an input that could not be marked collected is not delivered until the mark lands, then delivered once', async () => {
  const queued = new Map([['s1', [{ id: 'in-1', body: 'hello' }]]]);
  let failing = true;
  const s = spine(queued, { collect: async () => { if (failing) throw new Error('broker write failed'); } });
  const deliveries: string[] = [];
  const subject = intake(s.value, [record('s1')], deliveries);
  await subject.tick(); await subject.drainDeliveries();
  expect(deliveries).toEqual([]);
  failing = false;
  await subject.tick(); await subject.drainDeliveries();
  await subject.tick(); await subject.drainDeliveries();
  expect(deliveries).toEqual(['s1:hello']);
  expect(s.log.collected).toEqual(['in-1']);
});

test('a consumed mark that failed is retried on the next tick and the input is never delivered again', async () => {
  const queued = new Map([['s1', [{ id: 'in-1', body: 'hello' }]]]);
  let failing = true;
  const s = spine(queued, { consume: async () => { if (failing) throw new Error('broker write failed'); } });
  const deliveries: string[] = [];
  const subject = intake(s.value, [record('s1')], deliveries);
  await subject.tick(); await subject.drainDeliveries();
  expect(s.log.consumed).toEqual([]);
  failing = false;
  await subject.tick(); await subject.drainDeliveries();
  expect(s.log.consumed).toEqual(['in-1']);
  await subject.tick(); await subject.drainDeliveries();
  expect(deliveries).toEqual(['s1:hello']);
  expect(s.log.consumed).toEqual(['in-1']);
});

test('a registration that never settles does not stop another session from being collected', async () => {
  const queued = new Map([['stuck', []], ['other', [{ id: 'in-2', body: 'steer' }]]]);
  const s = spine(queued, { register: sessionId => sessionId === 'stuck' ? new Promise(() => {}) : Promise.resolve({}) });
  const deliveries: string[] = [];
  const subject = intake(s.value, [record('stuck'), record('other')], deliveries, 1);
  await subject.tick(); await subject.drainDeliveries();
  expect(deliveries).toEqual(['other:steer']);
  // The next tick leaves the outstanding registration alone rather than stacking another.
  await subject.tick();
  expect(s.log.registered.filter(id => id === 'stuck')).toHaveLength(1);
});

test('a closed session refuses late registration until the manager forgets it', async () => {
  const s = spine(new Map());
  const subject = intake(s.value, [], []);
  await subject.close('gone');
  await subject.register(record('gone'));
  expect(s.log.registered).toEqual([]);
  subject.forget('gone');
  await subject.register(record('gone'));
  expect(s.log.registered).toEqual(['gone']);
});

test('an unchanged session is registered once per heartbeat interval, a changed one at the next tick', async () => {
  const s = spine(new Map());
  let clock = 1_000;
  const sessions = [record('s1')];
  const subject = new HostedSessionSpineIntake({ spine: s.value, liveSessions: () => sessions, now: () => clock, deliver: async () => {} });
  for (let tick = 0; tick < 10; tick++) await subject.tick();
  expect(s.log.registered).toEqual(['s1']);
  clock += 30_000;
  await subject.tick();
  expect(s.log.registered).toEqual(['s1', 's1']);
  sessions[0] = { ...sessions[0]!, title: 'renamed' };
  await subject.tick();
  expect(s.log.registered).toEqual(['s1', 's1', 's1']);
});
