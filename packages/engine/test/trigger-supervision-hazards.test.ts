/**
 * Trigger supervisor hazards: a late condition result must not undo a cancel or
 * an open breaker, a rejected definition or launch must leave nothing behind, a
 * stream saved as running is started again after a restart, and a failed action
 * gives back the edge it consumed.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TriggerManager,
  type ProbeIo,
  type TriggerActionExecutor,
  type TriggerProcessHost,
  type TriggerStreamHost,
  type TriggerValue,
} from '../platform/src/platform/triggers/index.ts';
import { TriggerDefinitionError, validateDefinition } from '../platform/src/platform/triggers/validation.ts';

const roots: string[] = [];
const managers: TriggerManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) { manager.shutdown(); await manager.join(); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function storePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'trigger-hazards-')); roots.push(root);
  return join(root, 'triggers.json');
}

function condition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'depth', label: 'Depth',
    spec: {
      kind: 'condition',
      probe: { kind: 'http', url: 'https://example.test/m' },
      extract: { kind: 'jsonpath', path: '$.depth' },
      rule: { kind: 'value', operator: 'gt', operand: 10 },
      intervalMs: 1_000,
    },
    action: { kind: 'agent-turn' },
    createdAt: 0,
    ...overrides,
  };
}

function io(fetch: ProbeIo['fetch']): ProbeIo {
  return {
    fetch,
    readFile: () => Promise.resolve(''),
    statFile: () => null,
    runCommand: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    callTool: () => Promise.resolve(null as TriggerValue),
  };
}

const body = (text: string) => Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(text) });

function newManager(options: {
  probeIo?: ProbeIo; actions?: TriggerActionExecutor; path?: string; processHost?: TriggerProcessHost; streamHost?: TriggerStreamHost;
  clock?: { t: number }; bootId?: string; config?: Record<string, unknown>;
}) {
  const clock = options.clock ?? { t: 1_000 };
  const manager = new TriggerManager({
    storePath: options.path ?? storePath(),
    config: { enabled: true, defaultCheckIntervalMs: 1_000, breakerStrikes: 3, backoffLadderMs: '100,200', ...options.config },
    actions: options.actions ?? { runAgentTurn: () => Promise.resolve('ok'), runGrant: () => Promise.resolve('ok') },
    ...(options.probeIo ? { probeIo: options.probeIo } : {}),
    ...(options.processHost ? { processHost: options.processHost } : {}),
    ...(options.streamHost ? { streamHost: options.streamHost } : {}),
    now: () => clock.t,
    daemonBootId: options.bootId ?? 'boot-1',
  });
  managers.push(manager);
  return { manager, clock };
}

describe('a condition check that finishes after the trigger changed', () => {
  test('a trigger cancelled while its probe is in flight stays cancelled and does not fire', async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const turns: string[] = [];
    const { manager } = newManager({
      probeIo: io(async () => { entered.resolve(); await gate.promise; return body('{"depth": 99}'); }),
      actions: { runAgentTurn: (input) => { turns.push(input.triggerId); return Promise.resolve('ok'); }, runGrant: () => Promise.resolve('ok') },
    });
    await manager.create(condition());
    const check = manager.runCheck('depth');
    await entered.promise;
    manager.cancel('depth');
    gate.resolve();
    await check; await manager.join();
    expect(manager.get('depth')?.state).toBe('cancelled');
    expect(turns).toEqual([]);
  });

  test('a manual check does not close an open breaker', async () => {
    let calls = 0;
    const { manager, clock } = newManager({ probeIo: io(() => { calls += 1; return Promise.reject(new Error('ECONNREFUSED')); }), config: { breakerStrikes: 1 } });
    await manager.create(condition());
    await manager.runCheck('depth');
    expect(manager.get('depth')?.state).toBe('circuit-open');
    const before = calls;
    clock.t += 10_000;
    await manager.runCheck('depth');
    expect(calls).toBe(before);
    expect(manager.get('depth')?.state).toBe('circuit-open');
  });
});

describe('a failure that cannot be read', () => {
  test('still spends a strike and backs off instead of staying due', async () => {
    // No judgment port is installed here, so a failure with no structured facts cannot be read.
    const { manager } = newManager({ probeIo: io(() => Promise.reject(new Error('something odd happened'))) });
    await manager.create(condition());
    await manager.runCheck('depth');
    const record = manager.get('depth');
    expect(record?.strikes).toBe(1);
    expect(record?.state).toBe('backoff');
    expect(record?.nextCheckAt).toBeGreaterThan(1_000);
  });
});

describe('a definition the persisted form would refuse', () => {
  test('is rejected at create with its field named, and the next valid create still works', async () => {
    const { manager } = newManager({ probeIo: io(() => body('{}')) });
    const bad = condition({ spec: { ...condition().spec, probe: { kind: 'http', url: 'https://example.test/m', headers: { a: 1 } } } });
    await expect(manager.create(bad)).rejects.toThrow(TriggerDefinitionError);
    await expect(manager.create(bad)).rejects.toThrow(/headers/);
    const created = await manager.create(condition({ id: 'ok' }));
    expect(created.definition.id).toBe('ok');
    expect(manager.list().map((record) => record.definition.id)).toEqual(['ok']);
  });

  test('every spec field the saved form checks is checked at create', () => {
    const base = { id: 'x', label: 'X', action: { kind: 'agent-turn' }, createdAt: 0 };
    const stream = { kind: 'stream', command: 'tail', match: { pattern: 'E' } };
    const onExit = { kind: 'on-exit', command: 'make' };
    for (const spec of [
      { ...stream, restart: 'yes' }, { ...stream, dedupTtlMs: -1 }, { ...stream, batchIntervalMs: 1.5 }, { ...stream, cwd: 4 },
      { ...onExit, env: { A: 1 } }, { ...onExit, outputTailBytes: 'big' }, { ...onExit, cwd: 4 },
    ]) expect(() => validateDefinition({ ...base, spec })).toThrow(TriggerDefinitionError);
    const probe = (extra: Record<string, unknown>) => ({ kind: 'condition', extract: { kind: 'raw' }, rule: { kind: 'change' }, probe: { kind: 'http', url: 'https://x.test', ...extra } });
    for (const extra of [{ timeoutMs: 1.5 }, { timeoutMs: '5000' }, { body: 3 }, { capture: 'all' }])
      expect(() => validateDefinition({ ...base, spec: probe(extra) })).toThrow(TriggerDefinitionError);
  });

  test('an agent turn naming a session is refused because nothing would attach it', () => {
    expect(() => validateDefinition({ id: 'x', label: 'X', spec: condition().spec, action: { kind: 'agent-turn', sessionId: 's1' } })).toThrow(/sessionId/);
  });

  test('a regex that repeats a repeating group is refused', () => {
    const stream = (pattern: string) => ({ id: 'x', label: 'X', action: { kind: 'agent-turn' }, spec: { kind: 'stream', command: 'tail', match: { pattern } } });
    expect(() => validateDefinition(stream('(a+)+$'))).toThrow(/stall the daemon/);
    expect(() => validateDefinition(stream('(?:\\w*\\s?)*x'))).toThrow(/stall the daemon/);
    expect(() => validateDefinition(stream('ERROR (\\d{1,3}) in [a-z+]+'))).not.toThrow();
    expect(() => validateDefinition(stream('(ab)+c'))).not.toThrow();
  });
});

describe('a create that fails after the record was reserved', () => {
  test('leaves no record behind, so the id can be retried and no stream starts later', async () => {
    const starts: string[] = [];
    let failing = true;
    const streamHost: TriggerStreamHost = {
      start: (input) => {
        if (failing) return Promise.reject(new Error('spawn failed'));
        starts.push(input.triggerId); return Promise.resolve({ streamId: 's1', pid: 1 });
      },
      stop: () => {},
    };
    const { manager, clock } = newManager({ streamHost });
    const definition = { id: 'logs', label: 'Logs', spec: { kind: 'stream', command: 'tail', match: { pattern: 'ERR' } }, action: { kind: 'agent-turn' } };
    await expect(manager.create(definition)).rejects.toThrow('spawn failed');
    expect(manager.list()).toEqual([]);
    clock.t += 60_000;
    await manager.supervisionTick();
    expect(starts).toEqual([]);
    failing = false;
    await manager.create(definition);
    expect(starts).toEqual(['logs']);
  });
});

describe('a stream saved as running when the daemon stopped', () => {
  test('is started again by the next supervision tick', async () => {
    const path = storePath();
    const definition = { id: 'logs', label: 'Logs', spec: { kind: 'stream', command: 'tail', match: { pattern: 'ERR' } }, action: { kind: 'agent-turn' } };
    const first: TriggerStreamHost = { start: () => Promise.resolve({ streamId: 'a', pid: 1 }), stop: () => {} };
    const one = newManager({ streamHost: first, path, bootId: 'boot-1' });
    await one.manager.create(definition);
    expect(one.manager.get('logs')?.state).toBe('running');
    one.manager.shutdown(); await one.manager.join();

    const starts: string[] = [];
    const second: TriggerStreamHost = { start: (input) => { starts.push(input.triggerId); return Promise.resolve({ streamId: 'b', pid: 2 }); }, stop: () => {} };
    const two = newManager({ streamHost: second, path, bootId: 'boot-2', clock: { t: 5_000 } });
    two.manager.start();
    await two.manager.supervisionTick();
    expect(starts).toEqual(['logs']);
    expect(two.manager.get('logs')?.state).toBe('running');
  });
});

describe('an action that fails after its rule consumed the edge', () => {
  test('the next check that still sees the condition tries the action again', async () => {
    let attempts = 0;
    const { manager, clock } = newManager({
      probeIo: io(() => body('{"depth": 50}')),
      actions: {
        runAgentTurn: () => { attempts += 1; return attempts === 1 ? Promise.reject(new Error('spawn refused')) : Promise.resolve('ok'); },
        runGrant: () => Promise.resolve('ok'),
      },
    });
    await manager.create(condition());
    await manager.runCheck('depth'); await manager.join();
    expect(attempts).toBe(1);
    clock.t += 2_000;
    await manager.runCheck('depth'); await manager.join();
    expect(attempts).toBe(2);
    expect(manager.get('depth')?.firedCount).toBe(1);
  });

  test('a level rule over a window fires once while it keeps holding', async () => {
    const turns: number[] = [];
    const { manager, clock } = newManager({
      probeIo: io(() => body('{"depth": 50}')),
      actions: { runAgentTurn: () => { turns.push(clock.t); return Promise.resolve('ok'); }, runGrant: () => Promise.resolve('ok') },
    });
    const spec = { ...condition().spec, rule: { kind: 'windowed-aggregate', windowMs: 60_000, aggregate: 'max', operator: 'gt', operand: 10 } };
    await manager.create(condition({ spec }));
    for (let check = 0; check < 3; check += 1) { await manager.runCheck('depth'); await manager.join(); clock.t += 2_000; }
    expect(turns).toHaveLength(1);
  });
});

describe('a probe result JSON cannot hold', () => {
  test('is stored as text, and the check, the other triggers and listing all carry on', async () => {
    const { manager } = newManager({ probeIo: io(() => body('{"depth": 1e999}')) });
    await manager.create(condition());
    await manager.create(condition({ id: 'other', label: 'Other' }));
    const checked = await manager.runCheck('depth');
    expect(checked?.lastError).toBeUndefined();
    expect(checked?.observations.at(-1)?.text).toBe('Infinity');
    expect(manager.list().map((record) => record.definition.id).sort()).toEqual(['depth', 'other']);
    expect((await manager.runCheck('other'))?.state).toBe('idle');
  });
});

describe('a store whose owner has exited', () => {
  test('the observing process takes over on its next supervision tick', async () => {
    const path = storePath();
    const owner = newManager({ path, bootId: 'boot-1' });
    await owner.manager.create(condition());
    expect(owner.manager.executionOwnership).toBe('local');
    const observer = newManager({ path, bootId: 'boot-2' });
    observer.manager.start();
    expect(observer.manager.executionOwnership).toBe('other-process');
    await observer.manager.supervisionTick();
    expect(observer.manager.executionOwnership).toBe('other-process');
    owner.manager.shutdown(); await owner.manager.join();
    await observer.manager.supervisionTick();
    expect(observer.manager.executionOwnership).toBe('local');
  });
});

describe('operator inspection failures', () => {
  test('an unexpected error is logged with its cause and still reaches the wire as the generic refusal', async () => {
    const { triggerOperatorStatus, TriggerOperatorError } = await import('../platform/src/platform/triggers/operator.ts');
    const { logger } = await import('../platform/src/platform/utils/logger.ts');
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const supervisor = { inspectRecords: () => { throw new TypeError('corrupt record'); }, executionOwnership: 'local' as const };
      let thrown: unknown;
      try { triggerOperatorStatus(supervisor as never); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(TriggerOperatorError);
      expect((thrown as { kind: string }).kind).toBe('unavailable');
      expect(warn.mock.calls.some(([, context]) => JSON.stringify(context).includes('corrupt record'))).toBe(true);
    } finally { warn.mockRestore(); }
  });
});
