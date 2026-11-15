/**
 * daemon-build-compatibility.test.ts, this process judging the daemon it
 * attached to.
 *
 * The forward guard (client-build-compatibility) covers this build being too
 * old for the daemon. This covers the reverse, and the reason it matters is
 * that its failure mode is invisible: a daemon too old to serve a verb answers
 * one call with a 400, which reads as a broken feature. Nobody goes looking at
 * the daemon's version.
 *
 * The two properties under test are the ones a guard gets wrong:
 *
 *  - An UNREADABLE version is 'unknown', never 'ok'. A peer that cannot prove
 *    it carries a behavior is treated as one that does not.
 *  - The finding LATCHES, so a later read that cannot determine a version does
 *    not silently clear it, but `reset()` drops it, because a verdict about
 *    one daemon says nothing about a different one.
 */

import { describe, expect, test } from 'bun:test';
import {
  AGENT_DAEMON_BUILD_FLOOR,
  DaemonBuildGuard,
  createDaemonAdoptionGate,
  readDaemonStatusPayload,
} from '../../runtime/daemon-build-compatibility.ts';

describe('the floor this product declares', () => {

  test('a 3.x daemon older than the verbs this build uses is refused adoption, through the declared constant', () => {
    const notices: string[] = [];
    const guard = new DaemonBuildGuard({
      floor: AGENT_DAEMON_BUILD_FLOOR,
      onDaemonUpdateRequired: (verdict) => { notices.push(verdict.message); },
    });

    // The question the adoption path actually asks.
    const verdict = guard.judgeForAdoption({ status: 'running', version: '3.1.1' });

    expect(verdict.status).toBe('daemon-update-required');
    expect(verdict.message).toContain('3.1.1');
    expect(verdict.message).toContain('3.1.2');
    // Refused, not merely noted: this is what leaves the spine local.
    expect(guard.refusal()).toBeDefined();
    expect(notices).toHaveLength(1);
  });

  test('a daemon at the floor is adopted, through the declared constant', () => {
    const guard = new DaemonBuildGuard({ floor: AGENT_DAEMON_BUILD_FLOOR });

    const verdict = guard.judgeForAdoption({ status: 'running', version: '3.1.2' });

    expect(verdict.status).toBe('ok');
    expect(guard.refusal()).toBeUndefined();
  });
});

describe('judging for adoption, as the adoption path does', () => {
  test('an updated daemon is adoptable again: the refusal does not latch against a real newer build', () => {
    const guard = new DaemonBuildGuard({ floor: '1.28.0' });

    expect(guard.judgeForAdoption({ version: '1.27.1' }).status).toBe('daemon-update-required');
    expect(guard.refusal()).toBeDefined();

    // The operator updates the daemon. The next adoption attempt must be able
    // to say yes, a latch here would strand the process on a fixed daemon.
    expect(guard.judgeForAdoption({ version: '1.28.0' }).status).toBe('ok');
    expect(guard.refusal()).toBeUndefined();
  });

  test('a daemon that goes back below the floor is announced again', () => {
    const notices: string[] = [];
    const guard = new DaemonBuildGuard({
      floor: '1.28.0',
      onDaemonUpdateRequired: (verdict) => { notices.push(verdict.message); },
    });

    guard.judgeForAdoption({ version: '1.27.1' });
    guard.judgeForAdoption({ version: '1.28.0' });
    // A different, older daemon now answers on the same address.
    guard.judgeForAdoption({ version: '1.26.0' });

    expect(notices).toHaveLength(2);
    expect(notices[1]).toContain('1.26.0');
  });

  test('repeated attempts against the same old daemon say it once', () => {
    const notices: string[] = [];
    const guard = new DaemonBuildGuard({
      floor: '1.28.0',
      onDaemonUpdateRequired: (verdict) => { notices.push(verdict.message); },
    });

    // The reconciler retries every heartbeat while the daemon stays refused.
    guard.judgeForAdoption({ version: '1.27.1' });
    guard.judgeForAdoption({ version: '1.27.1' });
    guard.judgeForAdoption({ version: '1.27.1' });

    expect(notices).toHaveLength(1);
  });

  test('a status body with no version is unknown and not adopted, the same verdict the terminal app reads', () => {
    const notices: string[] = [];
    const guard = new DaemonBuildGuard({ floor: '1.28.0', onDaemonUpdateRequired: (verdict) => { notices.push(verdict.notice ?? ''); } });

    const verdict = guard.judgeForAdoption({ status: 'running' });

    // A body that parsed but names no build is not a peer this client can
    // identify. A read that failed outright yields no body at all and is left to
    // the reachability handling (see createDaemonAdoptionGate).
    expect(verdict.status).toBe('unknown');
    expect(verdict.adopt).toBe(false);
    expect(guard.refusal()).toBeDefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('did not report a version');
  });
});

describe('reading the daemon build off /status', () => {
  test('the parsed body is returned', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ status: 'running', version: '1.21.0' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

    const payload = await readDaemonStatusPayload({ baseUrl: 'http://d', token: 't' }, { fetchImpl });

    expect(payload).toMatchObject({ version: '1.21.0' });
  });

  test('an unreachable daemon yields null rather than throwing', async () => {
    // Null is "nothing observed", which the guard treats as no verdict at all,
    // an offline laptop must not be reported as running an old daemon.
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;

    const payload = await readDaemonStatusPayload({ baseUrl: 'http://d', token: 't' }, { fetchImpl });

    expect(payload).toBeNull();
  });

  test('a non-2xx answer yields null', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;

    const payload = await readDaemonStatusPayload({ baseUrl: 'http://d', token: 't' }, { fetchImpl });

    expect(payload).toBeNull();
  });

  test('a body that is not JSON yields null', async () => {
    const fetchImpl = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;

    const payload = await readDaemonStatusPayload({ baseUrl: 'http://d', token: 't' }, { fetchImpl });

    expect(payload).toBeNull();
  });
});

/**
 * The composed gate services.ts uses: /status read + verdict -> adopt or refuse.
 * What it proves is the composition the reconciler depends on: which readings
 * refuse, and which do not.
 */
describe('the adoption gate services composes', () => {
  const connection = { baseUrl: 'http://127.0.0.1:3421', token: null };
  function gate(guard: DaemonBuildGuard, fetchImpl: typeof fetch) {
    return createDaemonAdoptionGate({
      resolveConnection: () => connection,
      readStatus: (c) => readDaemonStatusPayload(c, { fetchImpl }),
      guard,
    });
  }

  const respond = (body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;

  test('a daemon below the floor refuses adoption and names both versions once', async () => {
    const notices: string[] = [];
    const guard = new DaemonBuildGuard({
      floor: AGENT_DAEMON_BUILD_FLOOR,
      onDaemonUpdateRequired: (verdict) => { notices.push(verdict.message); },
    });

    expect(await gate(guard, respond({ status: 'running', version: '3.1.1' }))()).toBe(false);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('3.1.1');
    expect(notices[0]).toContain('3.1.2');
  });

  test('a daemon at the floor adopts', async () => {
    const guard = new DaemonBuildGuard({ floor: AGENT_DAEMON_BUILD_FLOOR });
    expect(await gate(guard, respond({ status: 'running', version: '3.1.2' }))()).toBe(true);
  });

  test('an unreachable daemon adopts: a dropped read is not evidence of an old build', async () => {
    const guard = new DaemonBuildGuard({ floor: AGENT_DAEMON_BUILD_FLOOR });
    const failing = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;

    // Refusing here would turn one failed request into a lost adoption. Whether
    // a daemon is answering at all is the reachability probe's question.
    expect(await gate(guard, failing)()).toBe(true);
  });

  test('a failed read after a refusal keeps the refusal', async () => {
    const guard = new DaemonBuildGuard({ floor: AGENT_DAEMON_BUILD_FLOOR });
    const failing = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await gate(guard, respond({ version: '3.1.1' }))()).toBe(false);
    expect(await gate(guard, failing)()).toBe(false);
    expect(guard.refusal()).toContain('3.1.1');
  });

  test('a non-200 /status adopts, for the same reason', async () => {
    const guard = new DaemonBuildGuard({ floor: AGENT_DAEMON_BUILD_FLOOR });
    const serverError = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    expect(await gate(guard, serverError)()).toBe(true);
  });

  test('an updated daemon flips the gate back to adopt without restarting the process', async () => {
    const guard = new DaemonBuildGuard({ floor: AGENT_DAEMON_BUILD_FLOOR });

    expect(await gate(guard, respond({ version: '3.1.1' }))()).toBe(false);
    expect(await gate(guard, respond({ version: '3.2.1' }))()).toBe(true);
    expect(guard.refusal()).toBeUndefined();
  });
});

describe('the adoption gate reads the connection it was given', () => {
  test('the status read goes to the resolved base URL, and the gate refuses on the version it returned', async () => {
    const urls: string[] = [];
    const guard = new DaemonBuildGuard({ floor: AGENT_DAEMON_BUILD_FLOOR });
    const fetchImpl = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ version: '3.1.1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const gate = createDaemonAdoptionGate({
      resolveConnection: () => ({ baseUrl: 'http://daemon.test:9', token: null }),
      readStatus: (c) => readDaemonStatusPayload(c, { fetchImpl }),
      guard,
    });

    expect(await gate()).toBe(false);
    expect(urls).toEqual(['http://daemon.test:9/status']);
  });
});
