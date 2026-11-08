import { expect, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserHostClient, BrowserHostError } from '../sdk/src/platform/browser/browser-host-client.js';
import { withTestTimeout } from './_helpers/test-timeout.js';

/** Real owned subprocesses; no system browser or user profile is opened. */
function fixture(options: { readonly ready?: boolean; readonly ignoreTerm?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'browser-host-lifetime-'));
  const paths = {
    started: join(root, 'started'), admitted: join(root, 'admitted'),
    stopping: join(root, 'stopping'), release: join(root, 'release'), stopped: join(root, 'stopped'),
  };
  const scriptPath = join(root, 'host.mjs');
  writeFileSync(scriptPath, `
    import { existsSync, writeFileSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    const paths = ${JSON.stringify(paths)};
    process.on('exit', () => writeFileSync(paths.stopped, 'stopped'));
    process.on('SIGTERM', () => {
      writeFileSync(paths.stopping, 'stopping');
      ${options.ignoreTerm ? '' : 'const timer = setInterval(() => { if (existsSync(paths.release)) { clearInterval(timer); process.exit(0); } }, 5);'}
    });
    setInterval(() => {}, 1000);
    createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      if (message.command === 'hold') writeFileSync(paths.admitted, 'admitted');
    });
    writeFileSync(paths.started, String(process.pid));
    ${options.ready === false ? '' : 'process.stdout.write(JSON.stringify({ id: 0, ok: true, result: { ready: true } }) + "\\n");'}
  `);
  const client = new BrowserHostClient({ scriptPath });
  const wait = async (path: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!existsSync(path)) {
      if (Date.now() >= deadline) throw new Error('The owned helper did not reach the fixture barrier');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  const pid = (): number => {
    const value = Number(readFileSync(paths.started, 'utf8'));
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid owned helper fixture PID');
    return value;
  };
  const cleanup = async (): Promise<void> => {
    writeFileSync(paths.release, 'release');
    try { await withTestTimeout(client.close(), 10_000, 'The owned helper did not close'); }
    catch (error) {
      if (existsSync(paths.started)) {
        try { process.kill(pid(), 'SIGKILL'); } catch { /* This fixture child already exited. */ }
      }
      throw error;
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
  return { client, paths, wait, pid, cleanup };
}

test('close before startup dispatch prevents spawning and rejects subsequent admissions', async () => {
  const owned = fixture();
  const started = owned.client.start().catch((error: unknown) => error);
  try {
    const closing = owned.client.close();
    expect(owned.client.close()).toBe(closing);
    expect(await started).toBeInstanceOf(BrowserHostError);
    await closing;
    expect(existsSync(owned.paths.started)).toBe(false);
    await expect(owned.client.start()).rejects.toThrow('closing');
    await expect(owned.client.call('hold')).rejects.toThrow('closing');
  } finally { await owned.cleanup(); }
});

test('close joins actual delayed exit, settles the pending call and removes its abort listener', async () => {
  const owned = fixture(), controller = new AbortController();
  let closed = false;
  try {
    const firstStart = owned.client.start();
    expect(owned.client.start()).toBe(firstStart);
    await firstStart;
    const listenerCount = getEventListeners(controller.signal, 'abort').length;
    const call = owned.client.call('hold', {}, { signal: controller.signal }).catch((error: unknown) => error);
    await owned.wait(owned.paths.admitted);
    const closing = owned.client.close();
    void closing.then(() => { closed = true; }, () => {});
    expect(owned.client.close()).toBe(closing);
    await owned.wait(owned.paths.stopping);
    expect(closed).toBe(false);
    expect(existsSync(owned.paths.stopped)).toBe(false);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(listenerCount + 1);
    await expect(owned.client.call('hold')).rejects.toThrow('closing');
    writeFileSync(owned.paths.release, 'release');
    await closing;
    expect(await call).toBeInstanceOf(BrowserHostError);
    expect(existsSync(owned.paths.stopped)).toBe(true);
    expect(() => process.kill(owned.pid(), 0)).toThrow();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(listenerCount);
    controller.abort(new Error('retired caller'));
  } finally { await owned.cleanup(); }
}, 15_000);

test('close owns a child that has not sent ready and drains the failed startup', async () => {
  const owned = fixture({ ready: false });
  let startedSettled = false, closed = false;
  const started = owned.client.start().catch((error: unknown) => { startedSettled = true; return error; });
  try {
    await owned.wait(owned.paths.started);
    const closing = owned.client.close();
    void closing.then(() => { closed = true; }, () => {});
    await owned.wait(owned.paths.stopping);
    expect(startedSettled).toBe(false); expect(closed).toBe(false);
    writeFileSync(owned.paths.release, 'release');
    await closing;
    expect(await started).toBeInstanceOf(BrowserHostError);
    expect(existsSync(owned.paths.stopped)).toBe(true);
    expect(() => process.kill(owned.pid(), 0)).toThrow();
  } finally { await owned.cleanup(); await started; }
}, 15_000);

test('a helper ignoring SIGTERM is killed before close reports successful drainage', async () => {
  const owned = fixture({ ignoreTerm: true });
  try {
    await owned.client.start();
    const call = owned.client.call('hold').catch((error: unknown) => error);
    await owned.wait(owned.paths.admitted);
    const closing = owned.client.close();
    await owned.wait(owned.paths.stopping);
    expect(() => process.kill(owned.pid(), 0)).not.toThrow();
    await closing;
    expect(await call).toBeInstanceOf(BrowserHostError);
    expect(() => process.kill(owned.pid(), 0)).toThrow();
    // SIGKILL does not run the child's exit handlers.
    expect(existsSync(owned.paths.stopped)).toBe(false);
  } finally { await owned.cleanup(); }
}, 15_000);
