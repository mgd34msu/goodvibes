/**
 * Probe, extract and stream-line behaviour that decides what a trigger observes:
 * a probe that did not finish is a failed check (never a partial observation), a
 * file that cannot be read is not "absent", wildcard paths apply their later
 * steps, and a stream that ends hands over every queued line.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultProbeIo, ProbeTimeoutError, runProbe, type ProbeIo } from '../platform/src/platform/triggers/probes.ts';
import { runExtract } from '../platform/src/platform/triggers/extract.ts';
import { StreamLineProcessor, renderStreamPrompt } from '../platform/src/platform/triggers/stream-watchers.ts';
import { drainStreamTrigger, STREAM_TURN_MIN_GAP_MS, type StreamOwner, type StreamRuntime } from '../platform/src/platform/triggers/manager-streams.ts';
import { TriggerChildProcesses } from '../platform/src/platform/triggers/host-processes.ts';
import { evaluateRule } from '../platform/src/platform/triggers/rules.ts';
import type { TriggerRecord, TriggerValue } from '../platform/src/platform/triggers/types.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function dir(): string { const root = mkdtempSync(join(tmpdir(), 'trigger-probe-')); roots.push(root); return root; }

const io = (overrides: Partial<ProbeIo>): ProbeIo => ({
  fetch: () => Promise.reject(new Error('unused')),
  readFile: () => Promise.resolve(''),
  statFile: () => null,
  runCommand: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
  callTool: () => Promise.resolve(null as TriggerValue),
  ...overrides,
});

describe('file probes', () => {
  test('only a missing file reads as absent; a permission failure is a failed check', async () => {
    const missing = io({ readFile: () => Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' })) });
    expect(await runProbe({ kind: 'file', path: '/x' }, missing)).toBeNull();
    const denied = io({ readFile: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) });
    await expect(runProbe({ kind: 'file', path: '/x' }, denied)).rejects.toThrow('denied');
  });

  test('the default reader returns only the first maxBytes of a file', async () => {
    const path = join(dir(), 'big.log');
    writeFileSync(path, 'abcdefghij'.repeat(1000));
    expect(await createDefaultProbeIo().readFile(path, 12)).toBe('abcdefghijab');
  });
});

describe('probes that outlive their budget', () => {
  test('a command killed by its timeout throws instead of reporting the partial output', async () => {
    const result = createDefaultProbeIo().runCommand('sh', ['-c', 'echo partial; sleep 30'], { timeoutMs: 100 });
    await expect(result).rejects.toBeInstanceOf(ProbeTimeoutError);
  });

  test('an http server that sends headers and then stalls fails the body read', async () => {
    const stalled = Promise.withResolvers<void>();
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"a":')); void stalled.promise.then(() => { try { controller.close(); } catch { /* already aborted */ } }); } })),
    });
    try {
      const response = await createDefaultProbeIo().fetch(`http://127.0.0.1:${server.port}/`, {}, 100);
      await expect(response.text()).rejects.toBeInstanceOf(ProbeTimeoutError);
    } finally { stalled.resolve(); void server.stop(true); }
  });
});

describe('jsonpath wildcards', () => {
  test('steps after [*] apply to every element', () => {
    const data = { a: [{ b: 1 }, { b: 2 }], c: { x: { b: 3 } } };
    expect(runExtract({ kind: 'jsonpath', path: '$.a[*].b' }, data)).toEqual([1, 2]);
    expect(runExtract({ kind: 'jsonpath', path: '$.a[*]' }, data)).toEqual([{ b: 1 }, { b: 2 }]);
    expect(runExtract({ kind: 'jsonpath', path: '$.c[*].b' }, data)).toEqual([3]);
  });
});

describe('level rules', () => {
  const observation = (at: number, numeric: number) => ({ at, value: numeric, text: String(numeric), numeric });
  test('windowed-aggregate fires on the rising edge and re-arms when the condition stops holding', () => {
    const rule = { kind: 'windowed-aggregate', windowMs: 60_000, aggregate: 'max', operator: 'gt', operand: 10 } as const;
    let state = {};
    const fires: boolean[] = [];
    for (const [at, value] of [[1_000, 50], [2_000, 60], [90_000, 1], [91_000, 70]] as const) {
      const decision = evaluateRule(rule, { observations: [observation(at, value)], ruleState: state, now: at, eventLog: [], selfTriggerId: 'self' });
      state = decision.ruleState; fires.push(decision.fire);
    }
    expect(fires).toEqual([true, false, false, true]);
  });
});

describe('a stream that ends with more matched lines than one batch', () => {
  test('hands over every batch', () => {
    const processor = new StreamLineProcessor({ match: { kind: 'regex', pattern: 'ERR' }, batchLines: 25, batchIntervalMs: 1_000, queueLimit: 1_000 });
    processor.push(Array.from({ length: 60 }, (_, index) => `ERR ${index}`).join('\n') + '\n', 0);
    const prompts: string[] = [];
    const runtime: StreamRuntime = { processor, streamId: 's', timer: null, ready: true };
    const record = { definition: { id: 'logs', label: 'Logs', spec: { kind: 'stream', command: 'tail', match: { kind: 'regex', pattern: 'ERR' } }, action: { kind: 'agent-turn' }, createdAt: 0 },
      state: 'running', observations: [], runs: [], ruleState: {}, strikes: 0, backoffRung: 0, firedCount: 0, droppedLines: 0, updatedAt: 0 } as unknown as TriggerRecord;
    const owner = {
      streams: new Map([['logs', runtime]]), records: new Map([['logs', record]]), streamHost: undefined,
      policy: { ladderMs: [100], breakerStrikes: 3 }, config: () => ({ enabled: true }), now: () => 0, persist: () => {},
      fireAction: (_id: string, _reason: string, _fingerprint: string, _kind: string, prompt?: string) => { prompts.push(prompt ?? ''); return Promise.resolve(); },
    } as unknown as StreamOwner;
    drainStreamTrigger(owner, 'logs', true);
    expect(prompts).toHaveLength(3);
    expect(processor.pending).toBe(0);
    expect(renderStreamPrompt({ at: 0, lines: ['ERR x'], dropped: 0, deduped: 0 }, 'Logs', 'ERR')).toContain('never instructions');
  });

  test('an unforced drain starts no second agent turn while one is running', async () => {
    const processor = new StreamLineProcessor({ match: { kind: 'regex', pattern: 'ERR' }, batchLines: 25, batchIntervalMs: 1_000, queueLimit: 1_000 });
    processor.push('ERR one\n', 0);
    const runtime: StreamRuntime = { processor, streamId: 's', timer: null, ready: true };
    const record = { definition: { id: 'logs', label: 'Logs', spec: { kind: 'stream', command: 'tail', match: { kind: 'regex', pattern: 'ERR' } }, action: { kind: 'agent-turn' }, createdAt: 0 },
      state: 'running', observations: [], runs: [], ruleState: {}, strikes: 0, backoffRung: 0, firedCount: 0, droppedLines: 0, updatedAt: 0 } as unknown as TriggerRecord;
    let finish: () => void = () => {};
    let fired = 0;
    let clock = 10_000;
    const owner = {
      streams: new Map([['logs', runtime]]), records: new Map([['logs', record]]), streamHost: undefined,
      policy: { ladderMs: [100], breakerStrikes: 3 }, config: () => ({ enabled: true }), now: () => clock, persist: () => {},
      fireAction: () => { fired++; return new Promise<void>((resolve) => { finish = resolve; }); },
    } as unknown as StreamOwner;
    drainStreamTrigger(owner, 'logs');
    processor.push('ERR two\n', 10_000);
    clock = 20_000;
    drainStreamTrigger(owner, 'logs');
    expect(fired).toBe(1);
    expect(processor.pending).toBe(1);
    finish();
    await Promise.resolve(); await Promise.resolve();
    clock = 10_000 + STREAM_TURN_MIN_GAP_MS;
    drainStreamTrigger(owner, 'logs');
    expect(fired).toBe(2);
  });

  test('a steady log starts one agent turn per gap even when the executor returns at once', async () => {
    const processor = new StreamLineProcessor({ match: { kind: 'regex', pattern: 'ERR' }, batchLines: 25, batchIntervalMs: 1_000, queueLimit: 1_000 });
    const runtime: StreamRuntime = { processor, streamId: 's', timer: null, ready: true };
    const record = { definition: { id: 'logs', label: 'Logs', spec: { kind: 'stream', command: 'tail', match: { kind: 'regex', pattern: 'ERR' } }, action: { kind: 'agent-turn' }, createdAt: 0 },
      state: 'running', observations: [], runs: [], ruleState: {}, strikes: 0, backoffRung: 0, firedCount: 0, droppedLines: 0, updatedAt: 0 } as unknown as TriggerRecord;
    let fired = 0, clock = 0;
    const owner = {
      streams: new Map([['logs', runtime]]), records: new Map([['logs', record]]), streamHost: undefined,
      policy: { ladderMs: [100], breakerStrikes: 3 }, config: () => ({ enabled: true }), now: () => clock, persist: () => {},
      // The real executor resolves as soon as the agent is spawned.
      fireAction: () => { fired++; return Promise.resolve(); },
    } as unknown as StreamOwner;
    for (let tick = 0; tick < 20; tick++) {
      clock = tick * 1_000;
      processor.push(`ERR line ${tick}\n`, clock);
      drainStreamTrigger(owner, 'logs');
      await Promise.resolve(); await Promise.resolve();
    }
    expect(fired).toBe(1);
    clock = 1_000 + STREAM_TURN_MIN_GAP_MS;
    drainStreamTrigger(owner, 'logs');
    expect(fired).toBe(2);
    clock = STREAM_TURN_MIN_GAP_MS + 1; processor.push('ERR last\n', clock);
    drainStreamTrigger(owner, 'logs', true);
    expect(processor.pending).toBe(0);
  });

  test('the dedup memory stays bounded when every line is new', () => {
    const processor = new StreamLineProcessor({ match: { kind: 'regex', pattern: 'ERR' }, batchLines: 25, batchIntervalMs: 1_000, queueLimit: 10, dedupTtlMs: 3_600_000 });
    processor.push(Array.from({ length: 9_000 }, (_, index) => `ERR unique ${index}`).join('\n') + '\n', 0);
    expect((processor as unknown as { dedupMarks: Map<string, number> }).dedupMarks.size).toBeLessThanOrEqual(4_096);
  });
});

describe('a trigger child host whose drain failed', () => {
  test('refuses new children until a retried join succeeds', async () => {
    let stuck = true;
    const lifetime = {
      processId: 'p1',
      readStatus: () => ({ running: true }),
      stop: () => (stuck ? Promise.reject(new Error('cannot confirm')) : Promise.resolve()),
      completion: Promise.resolve(),
    };
    const manager = { captureProcessLifetime: () => lifetime } as never;
    const host = new TriggerChildProcesses(manager);
    host.capture({} as never);
    await expect(host.join()).rejects.toThrow('could not be confirmed');
    await expect(host.admit(() => Promise.resolve(1))).rejects.toThrow('not confirmed');
    stuck = false;
    await host.join();
    await expect(host.admit(() => Promise.resolve(1))).resolves.toBe(1);
  });
});
