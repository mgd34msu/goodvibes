/** Regression SOURCE ONLY; execution deferred until implementation is complete. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessManager, type SpawnOptions } from '../platform/src/platform/tools/shared/process-manager.js';
import { createBunStreamHost, createProcessManagerTriggerHost, createTriggerActionExecutor } from '../platform/src/platform/triggers/hosts.js';
import { TriggerManager } from '../platform/src/platform/triggers/manager.js';
import { TriggerManagerWork, stopTriggerResources } from '../platform/src/platform/triggers/manager-work.js';
import { createActionGrant } from '../platform/src/platform/triggers/grants.js';
import { waitFor } from './_helpers/test-timeout.js';

class FastProcesses extends ProcessManager {
  override spawnArgv(command: string, args: readonly string[], cwd?: string, env?: Record<string, string>, options?: SpawnOptions) {
    return super.spawnArgv(command, args, cwd, env, { ...options, sigterm_grace_ms: 20 });
  }
}
const processes: ProcessManager[] = [], supervisors: TriggerManager[] = [], roots: string[] = [];
afterEach(async () => {
  for (const manager of supervisors.splice(0)) { manager.shutdown(); await manager.join(); }
  for (const manager of processes.splice(0)) await manager.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function processManager() { const manager = new FastProcesses(); processes.push(manager); return manager; }
const runningCode = "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)";

test('original native lifetime survives public stop; a copied result cannot acquire a child', async () => {
  const manager = processManager();
  const result = await manager.spawnArgv(process.execPath, ['-e', runningCode]);
  const original = manager.captureProcessLifetime(result);
  expect(() => manager.captureProcessLifetime({ ...result })).toThrow('Original managed process');
  await waitFor(() => original.readStatus().stdoutTail.includes('ready'));
  expect(manager.stop(result.process_id!)).toBe(true);
  expect(manager.getStatus(result.process_id!)).toBeUndefined();
  await original.stop(); await original.completion;
  expect(original.readStatus().running).toBe(false);
  if (process.platform !== 'win32') expect(original.readStatus().signal).toBe('SIGKILL');
});

test('stream host scrubs credentials, streams both pipes, escalates resistant child and retains unrelated process', async () => {
  const manager = processManager(), host = createBunStreamHost(manager);
  const old = process.env['GOODVIBES_NATIVE_TEST_API_KEY'];
  process.env['GOODVIBES_NATIVE_TEST_API_KEY'] = 'synthetic-private-value';
  const chunks: string[] = [], exits: Array<number | null> = [];
  try {
    const unrelated = await manager.spawnArgv(process.execPath, ['-e', runningCode]);
    const originalUnrelated = manager.captureProcessLifetime(unrelated);
    const stream = await host.start({ triggerId: 'owned', command: process.execPath,
      args: ['-e', "process.on('SIGTERM',()=>{});console.log(process.env.GOODVIBES_NATIVE_TEST_API_KEY?'LEAK':'scrubbed');console.error('stderr-ready');setInterval(()=>{},1000)"],
      onChunk: (chunk) => { chunks.push(chunk); }, onExit: (code) => { exits.push(code); } });
    await waitFor(() => chunks.join('').includes('scrubbed') && chunks.join('').includes('stderr-ready'));
    expect(chunks.join('')).not.toContain('LEAK');
    host.stop(stream.streamId); await host.join?.();
    expect(manager.getStatus(stream.streamId)?.done).toBe(true);
    if (process.platform !== 'win32') expect(manager.getStatus(stream.streamId)?.signal).toBe('SIGKILL');
    expect(exits).toHaveLength(1);
    expect(originalUnrelated.readStatus().running).toBe(true);
    const delivered = chunks.length;
    await originalUnrelated.stop();
    expect(chunks).toHaveLength(delivered);
  } finally {
    if (old === undefined) delete process.env['GOODVIBES_NATIVE_TEST_API_KEY']; else process.env['GOODVIBES_NATIVE_TEST_API_KEY'] = old;
    await host.join?.();
  }
}, 10_000);

test('on-exit host refuses unrelated IDs and empty stdin is actual EOF', async () => {
  const manager = processManager(), host = createProcessManagerTriggerHost(manager);
  const unrelated = await manager.spawnArgv(process.execPath, ['-e', runningCode]);
  const original = manager.captureProcessLifetime(unrelated);
  expect(host.observe(unrelated.process_id!)).toBeNull(); host.cancel(unrelated.process_id!);
  expect(original.readStatus().running).toBe(true);
  const child = await host.launch({ command: process.execPath,
    args: ['-e', "process.stdin.resume();process.stdin.on('end',()=>console.log('EOF'))"], stdin: 'empty', maxDurationMs: 2000 });
  await waitFor(() => host.observe(child.processId)?.running === false);
  expect(host.observe(child.processId)?.stdoutTail).toContain('EOF');
  expect(host.observe(child.processId)?.timedOut).toBe(false);
  host.release?.(unrelated.process_id!); expect(original.readStatus().running).toBe(true);
  host.release?.(child.processId); expect(host.observe(child.processId)).toBeNull();
  await host.join?.(); expect(original.readStatus().running).toBe(true);
});

test('actual supervisor keeps its store lease through native host drain and final observer completion', async () => {
  const manager = processManager(), native = createBunStreamHost(manager);
  const drained = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const chunks: string[] = [];
  const root = mkdtempSync(join(tmpdir(), 'trigger-native-drain-')); roots.push(root);
  const path = join(root, 'triggers-v2.json');
  const actions = { async runAgentTurn() { return ''; }, async runGrant() { return ''; } };
  const owner = new TriggerManager({ storePath: path, config: { enabled: true }, actions,
    streamHost: { ...native, start: (input) => native.start({ ...input, onChunk(chunk) { chunks.push(chunk); input.onChunk(chunk); } }),
      async join() { await native.join?.(); drained.resolve(); await release.promise; } },
    processHost: createProcessManagerTriggerHost(manager) });
  supervisors.push(owner);
  try {
    await owner.create({ id: 'stream', label: 'Owned native stream', spec: { kind: 'stream', command: process.execPath,
      args: ['-e', runningCode], match: { kind: 'regex', pattern: 'never-match' }, batchLines: 1 }, action: { kind: 'agent-turn' } });
    await waitFor(() => chunks.join('').includes('ready'));
    owner.shutdown(); const joined = owner.join(); await drained.promise;
    const second = new TriggerManager({ storePath: path, config: { enabled: true }, actions }); supervisors.push(second);
    second.start(); expect(second.executionOwnership).toBe('other-process');
    release.resolve(); await joined;
    const third = new TriggerManager({ storePath: path, config: { enabled: true }, actions }); supervisors.push(third);
    third.start(); expect(third.executionOwnership).toBe('local');
  } finally { release.resolve(); }
}, 10_000);

test('one failed native host drain does not skip the other host and never releases executor ownership', async () => {
  let released = 0, secondDrained = false;
  const work = new TriggerManagerWork(() => { released += 1; }); work.stop();
  work.finishStop(stopTriggerResources(new Map(), { async start() { throw Error(); }, stop() {}, async join() { throw Error('unknown'); } },
    { async launch() { throw Error(); }, observe() { return null; }, cancel() {}, isSameProcessAlive() { return false; }, async join() { secondDrained = true; } }));
  await expect(work.join()).rejects.toThrow(); expect(secondDrained).toBe(true); expect(released).toBe(0);
});

test('shutdown during actual native admission drains the late original child before releasing the store', async () => {
  const processes = processManager(), root = mkdtempSync(join(tmpdir(), 'trigger-native-late-')); roots.push(root);
  const path = join(root, 'triggers-v2.json');
  const actions = { async runAgentTurn() { return ''; }, async runGrant() { return ''; } };
  const manager = new TriggerManager({ storePath: path, config: { enabled: true }, actions,
    streamHost: createBunStreamHost(processes) }); supervisors.push(manager);
  const creating = manager.create({ id: 'late', label: 'Late actual native child',
    spec: { kind: 'stream', command: process.execPath, args: ['-e', runningCode],
      match: { kind: 'regex', pattern: 'never-match' }, batchLines: 1 }, action: { kind: 'agent-turn' } });
  manager.shutdown();
  const second = new TriggerManager({ storePath: path, config: { enabled: true }, actions }); supervisors.push(second);
  second.start(); expect(second.executionOwnership).toBe('other-process');
  await expect(creating).rejects.toThrow(); await manager.join();
  expect(processes.list().every((entry) => entry.done)).toBe(true);
  const third = new TriggerManager({ storePath: path, config: { enabled: true }, actions }); supervisors.push(third);
  third.start(); expect(third.executionOwnership).toBe('local');
});

test('a failed synchronous output observer terminates its actual child and drains both native pipes', async () => {
  const manager = processManager(); let calls = 0;
  const result = await manager.spawnArgv(process.execPath,
    ['-e', "process.on('SIGTERM',()=>{});console.log('first');console.error('sibling');setInterval(()=>{console.error('later')},5)"],
    undefined, undefined, { onOutput() { calls += 1; throw Error('fixture observer failure'); } });
  const original = manager.captureProcessLifetime(result); await original.completion;
  expect(original.readStatus().running).toBe(false); expect(calls).toBe(1);
  await original.stop(); expect(calls).toBe(1);
});

test('grant action waits actual child completion and rejects real failed execution', async () => {
  const manager = processManager(), executor = createTriggerActionExecutor({ processManager: manager, agents: { spawn() { return { id: 'unused' }; } } });
  const grant = createActionGrant({ id: 'actual-grant', description: 'Actual grant', confirmedBy: 'fixture-owner', now: 1000, command: process.execPath, args: ['-e', 'setTimeout(()=>process.exit(7),50)'] });
  await expect(executor.runGrant({ triggerId: 'grant-trigger', grant })).rejects.toThrow('did not complete successfully');
  expect(manager.list().every((entry) => entry.done)).toBe(true);
});
