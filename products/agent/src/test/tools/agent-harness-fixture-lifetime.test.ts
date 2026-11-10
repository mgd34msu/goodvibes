import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { MemoryStore } from '@goodvibes-jev/engine/platform/platform/state';
import { withRunTmpDir } from '@goodvibes-jev/engine/toolchain/test-runner';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { makeProjectTempDir, registerProjectTempDrain, sweepCreatedProjectTempDirs } from '../helpers/project-temp.ts';
import { createHarnessFixtureReadings, createMemoryRegistry, makeFixture } from './agent-harness-tool-fixture.ts';

let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
beforeEach(() => {
  log = new SqliteDecisionLog(':memory:');
  previous = installJudgmentPort(withDecisionLog(createHarnessFixtureReadings(), log));
});
afterEach(async () => {
  await sweepCreatedProjectTempDirs();
  installJudgmentPort(previous); log[Symbol.dispose]();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('explicit fixture cleanup and the real global sweep join the same accepted call before stores and root retire', async () => {
  const fixture = makeFixture();
  const registry = await createMemoryRegistry(fixture.paths, fixture.configManager);
  const store = registry.getStore();
  const closed = spyOn(store, 'close');
  const originalPrepare = fixture.toolRegistry.prepareCall.bind(fixture.toolRegistry);
  const originalAdmit = fixture.permissionManager.admitAutonomous.bind(fixture.permissionManager);
  const originalExecute = fixture.toolRegistry.executePrepared.bind(fixture.toolRegistry);
  const entered = deferred(), release = deferred();
  let preparedOptions: unknown, admittedOptions: unknown;
  let executingOptions: Parameters<typeof originalExecute>[2];
  const prepare = spyOn(fixture.toolRegistry, 'prepareCall').mockImplementation((id, name, args, options) => {
    preparedOptions = options; return originalPrepare(id, name, args, options);
  });
  const admit = spyOn(fixture.permissionManager, 'admitAutonomous').mockImplementation((id, name, args, options) => {
    admittedOptions = options; return originalAdmit(id, name, args, options);
  });
  const execute = spyOn(fixture.toolRegistry, 'executePrepared').mockImplementation(async (call, admission, options) => {
    executingOptions = options; entered.resolve();
    await release.promise;
    return originalExecute(call, admission, options);
  });
  const caller = new AbortController();
  const assertCurrent = () => {};
  const call = fixture.admittedTool.execute({ mode: 'summary' }, { signal: caller.signal, assertCurrent });
  const observed = call.catch((error: unknown) => error);
  try {
    await entered.promise;
    expect(preparedOptions).toBe(admittedOptions); expect(executingOptions === preparedOptions).toBe(true);
    expect(executingOptions?.assertCurrent).toBe(assertCurrent);
    const closing = fixture.cleanup();
    expect(fixture.cleanup()).toBe(closing);
    expect(executingOptions?.signal?.aborted).toBe(true); expect(caller.signal.aborted).toBe(false);
    await expect(fixture.admittedTool.execute({ mode: 'summary' })).rejects.toMatchObject({ name: 'AbortError' });
    expect(prepare).toHaveBeenCalledTimes(1);
    let swept = false;
    const sweep = sweepCreatedProjectTempDirs().then(() => { swept = true; });
    await Promise.resolve();
    expect(swept).toBe(false); expect(existsSync(fixture.root)).toBe(true);
    expect(closed).not.toHaveBeenCalled(); expect(registry.getAll()).toEqual([]);
    // The original log is still usable until the admitted call has drained.
    expect(Array.isArray(log.query())).toBe(true);
    release.resolve();
    expect(await observed).toMatchObject({ name: 'ToolInputProjectionError', problem: 'cancelled' });
    await Promise.all([closing, sweep]);
    expect(closed).toHaveBeenCalledTimes(1); expect(existsSync(fixture.root)).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve(); await observed;
    await fixture.cleanup(); prepare.mockRestore(); admit.mockRestore(); execute.mockRestore(); closed.mockRestore();
  }
});

test('a pending real MemoryStore initialization remains owned until it finishes and is closed', async () => {
  const fixture = makeFixture();
  const entered = deferred(), release = deferred();
  const originalInit = MemoryStore.prototype.init;
  const closed = spyOn(MemoryStore.prototype, 'close');
  const init = spyOn(MemoryStore.prototype, 'init').mockImplementation(async function(this: MemoryStore) {
    entered.resolve(); await release.promise; return originalInit.call(this);
  });
  const opening = createMemoryRegistry(fixture.paths, fixture.configManager);
  const observed = opening.catch((error: unknown) => error);
  try {
    await entered.promise;
    const closing = fixture.cleanup();
    expect(existsSync(fixture.root)).toBe(true); expect(closed).not.toHaveBeenCalled();
    release.resolve();
    expect(await observed).toMatchObject({ name: 'AbortError' });
    await closing;
    expect(closed).toHaveBeenCalledTimes(1); expect(existsSync(fixture.root)).toBe(false);
  } finally {
    release.resolve(); await observed; await fixture.cleanup(); init.mockRestore(); closed.mockRestore();
  }
});

test('fixture cleanup terminates and joins its genuine background process before root removal', async () => {
  const fixture = makeFixture();
  try {
    const child = await fixture.processManager.spawnArgv(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], fixture.root, undefined);
    if (!child.process_id) throw new Error('Missing genuine background process ID');
    expect(fixture.processManager.getStatus(child.process_id)?.done).toBe(false);
    await fixture.cleanup();
    expect(fixture.processManager.getStatus(child.process_id)?.done).toBe(true);
    expect(existsSync(fixture.root)).toBe(false);
  } finally { await fixture.cleanup(); }
});

test('an exact registered root stays present until its original drain resolves', async () => {
  const root = makeProjectTempDir('held-agent-root');
  const release = deferred(); let drains = 0;
  const close = registerProjectTempDrain(root, () => { drains++; return release.promise; });
  const closing = close();
  try {
    expect(close()).toBe(closing); expect(existsSync(root)).toBe(true); expect(drains).toBe(1);
  } finally { release.resolve(); await closing; }
  expect(existsSync(root)).toBe(false);
});

test('a failed registered drain preserves original files and repeats its original failed promise', async () => {
  const fixture = makeProjectTempDir('failed-agent-drain-parent');
  const parent = join(fixture, '.test-tmp'); mkdirSync(parent);
  const helper = pathToFileURL(join(import.meta.dir, '../helpers/project-temp.ts')).href;
  await withRunTmpDir(parent, root => {
    const source = `
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const { makeProjectTempDir, registerProjectTempDrain, sweepCreatedProjectTempDirs, sweepProjectTestTmpRoot } = await import(${JSON.stringify(helper)});
      const root = makeProjectTempDir('original-failed-drain');
      const leaf = join(root, 'original.txt'); writeFileSync(leaf, 'original data');
      let calls = 0;
      const close = registerProjectTempDrain(root, () => { calls++; throw new Error('Injected drain failure'); });
      const closing = close();
      if (close() !== closing) throw new Error('Lost original closing promise');
      for (const action of [() => closing, () => sweepCreatedProjectTempDirs(), () => sweepProjectTestTmpRoot()]) {
        let failure; try { await action(); } catch (error) { failure = error; }
        if (!failure) throw new Error('Failed cleanup was hidden');
      }
      if (calls !== 1 || !existsSync(root) || readFileSync(leaf, 'utf8') !== 'original data') throw new Error('Failed root was deleted or retried');
      console.log('original failed root preserved');
    `;
    const child = Bun.spawnSync([process.execPath, '--no-env-file', '--eval', source], {
      cwd: fixture, env: { ...process.env, GOODVIBES_TEST_PROJECT_TMP_ROOT: root }, stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
    });
    expect(Buffer.from(child.stderr).toString()).toBe('');
    expect(child.exitCode).toBe(0);
    expect(Buffer.from(child.stdout).toString()).toContain('original failed root preserved');
  });
});

test('a replaced fixture directory is preserved even when its original callback successfully drains', async () => {
  const fixture = makeProjectTempDir('replaced-agent-drain-parent');
  const parent = join(fixture, '.test-tmp'); mkdirSync(parent);
  const helper = pathToFileURL(join(import.meta.dir, '../helpers/project-temp.ts')).href;
  await withRunTmpDir(parent, root => {
    const source = `
      import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const { makeProjectTempDir, registerProjectTempDrain } = await import(${JSON.stringify(helper)});
      const root = makeProjectTempDir('original-retired-drain');
      writeFileSync(join(root, 'original.txt'), 'original data');
      let release; const held = new Promise(resolve => { release = resolve; });
      const close = registerProjectTempDrain(root, () => held);
      const closing = close();
      renameSync(root, root + '-retired'); mkdirSync(root);
      writeFileSync(join(root, 'foreign.txt'), 'foreign data'); release();
      let failure; try { await closing; } catch (error) { failure = error; }
      if (!failure || !failure.message.includes('replaced Agent fixture root')) throw new Error('Replacement was accepted');
      if (close() !== closing || !existsSync(root + '-retired') || readFileSync(join(root, 'foreign.txt'), 'utf8') !== 'foreign data'
        || readFileSync(join(root + '-retired', 'original.txt'), 'utf8') !== 'original data') throw new Error('Replacement cleanup damaged evidence');
      console.log('foreign replacement preserved');
    `;
    const child = Bun.spawnSync([process.execPath, '--no-env-file', '--eval', source], {
      cwd: fixture, env: { ...process.env, GOODVIBES_TEST_PROJECT_TMP_ROOT: root }, stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
    });
    expect(Buffer.from(child.stderr).toString()).toBe('');
    expect(child.exitCode).toBe(0);
    expect(Buffer.from(child.stdout).toString()).toContain('foreign replacement preserved');
  });
});

test('the actual Bun hooks drain a detached admitted call before resetting its model and log', async () => {
  const fixture = makeProjectTempDir('agent-global-hook-drain');
  const parent = join(fixture, '.test-tmp'); mkdirSync(parent);
  const helper = pathToFileURL(join(import.meta.dir, '../helpers/project-temp.ts')).href;
  const harness = pathToFileURL(join(import.meta.dir, './agent-harness-tool-fixture.ts')).href;
  const preload = join(import.meta.dir, '../helpers/preload.ts');
  await withRunTmpDir(parent, root => {
    const source = `
      import { test, afterEach, afterAll, spyOn } from 'bun:test';
      import { existsSync } from 'node:fs';
      import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
      import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
      const { sweepCreatedProjectTempDirs } = await import(${JSON.stringify(helper)});
      const { makeFixture, createMemoryRegistry, createHarnessFixtureReadings } = await import(${JSON.stringify(harness)});
      const events = []; let originalRoot, log, previous, failure;
      afterEach(async () => {
        await sweepCreatedProjectTempDirs();
        if (existsSync(originalRoot)) throw new Error('Global sweep returned before root removal');
        events.push('root-removed');
        installJudgmentPort(previous); log[Symbol.dispose](); events.push('log-retired');
      });
      afterAll(() => {
        if (failure) throw failure;
        const expected = ['abort-live', 'original-finished', 'store-closed', 'root-removed', 'log-retired'];
        if (JSON.stringify(events) !== JSON.stringify(expected)) throw new Error('Original cleanup ordering changed: ' + JSON.stringify(events));
        console.log('GLOBAL_OWNER_SEQUENCE ' + JSON.stringify(events));
      });
      test('leave an actual accepted call to the hook owner', async () => {
        log = new SqliteDecisionLog(':memory:'); previous = installJudgmentPort(withDecisionLog(createHarnessFixtureReadings(), log));
        const fixture = makeFixture(); originalRoot = fixture.root;
        const registry = await createMemoryRegistry(fixture.paths, fixture.configManager);
        const store = registry.getStore(), close = store.close.bind(store);
        spyOn(store, 'close').mockImplementation(() => { events.push('store-closed'); close(); });
        let enter; const entered = new Promise(resolve => { enter = resolve; });
        const execute = fixture.toolRegistry.executePrepared.bind(fixture.toolRegistry);
        spyOn(fixture.toolRegistry, 'executePrepared').mockImplementation(async (call, admission, options) => {
          let release; const held = new Promise(resolve => { release = resolve; });
          options.signal.addEventListener('abort', () => {
            try {
              if (!existsSync(originalRoot) || registry.getAll().length !== 0 || !Array.isArray(log.query())) throw new Error('Original owner retired before abort');
              events.push('abort-live');
            } catch (error) { failure = error; }
            finally { release(); }
          }, { once: true });
          enter(); await held; return execute(call, admission, options);
        });
        // Deliberately return after admission without joining the call, matching
        // a Bun-detached body without a timeout or speculative extra operation.
        const call = fixture.admittedTool.execute({ mode: 'summary' });
        void call.then(() => { failure = new Error('Cancelled admitted call unexpectedly executed'); }, error => {
          if (error.name !== 'ToolInputProjectionError' || error.problem !== 'cancelled') failure = error;
          events.push('original-finished');
        });
        await entered;
      });
    `;
    const file = join(fixture, 'detached-hook-owner.test.ts'); writeFileSync(file, source);
    const child = Bun.spawnSync([process.execPath, '--no-env-file', 'test', '--preload', preload, file], {
      cwd: fixture, env: { ...process.env, GOODVIBES_TEST_PROJECT_TMP_ROOT: root }, stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
    });
    expect(child.exitCode).toBe(0);
    expect(Buffer.from(child.stderr).toString()).toContain('0 fail');
    expect(Buffer.from(child.stdout).toString()).toContain('GLOBAL_OWNER_SEQUENCE ["abort-live","original-finished","store-closed","root-removed","log-retired"]');
  });
});
