import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TailscaleServeReceiptStore,
  defaultTailscaleRunner,
  detectTailscaleAsync,
  enableTailscaleServeAsync,
  type TailscaleCommandResult,
  type TailscaleCommandRunner,
} from '../platform/src/platform/remote-access/tailscale.ts';

const READY_STATUS = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'node.tail.ts.net.' } });

describe('tailscale without blocking the daemon', () => {
  test('the asynchronous path never calls the blocking runner', async () => {
    const blocking: string[] = [];
    const runner: TailscaleCommandRunner = {
      run: (command, args) => { blocking.push(`${command} ${args.join(' ')}`); throw new Error('the blocking runner must not be used'); },
      runAsync: async () => ({ status: 0, stdout: READY_STATUS, stderr: '' }),
    };
    const detection = await detectTailscaleAsync(runner);
    expect(detection.httpsUrl).toBe('https://node.tail.ts.net');
    expect(blocking).toEqual([]);
  });

  test('a runner that only blocks is still usable', async () => {
    const runner: TailscaleCommandRunner = { run: () => ({ status: 0, stdout: READY_STATUS, stderr: '' }) };
    expect((await detectTailscaleAsync(runner)).loggedIn).toBe(true);
  });

  test('two serve requests for one port run tailscale serve once and share the receipt', async () => {
    const serves: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner: TailscaleCommandRunner = {
      run: () => { throw new Error('not used'); },
      runAsync: async (_command, args): Promise<TailscaleCommandResult> => {
        if (args[0] === 'status') return { status: 0, stdout: READY_STATUS, stderr: '' };
        serves.push(args.join(' '));
        await gate;
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    const first = enableTailscaleServeAsync(4000, runner);
    const second = enableTailscaleServeAsync(4000, runner);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(serves).toEqual(['serve --bg 4000']);
    expect(a).toBe(b);
    expect(a.ok).toBe(true);
    // A later request, once the first is done, runs again.
    await enableTailscaleServeAsync(4000, runner);
    expect(serves).toHaveLength(2);
  });

  test('the real asynchronous runner reports a missing binary by its errno code', async () => {
    const result = await defaultTailscaleRunner().runAsync!('goodvibes-no-such-binary-for-this-test', []);
    expect(result.status).toBeNull();
    expect(result.errorCode).toBe('ENOENT');
  });
});

describe('the serve receipt log', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const receipt = (n: number) => ({ at: n, command: 'tailscale serve --bg 1', ok: true, detail: `receipt ${n}` });

  test('a log that cannot be read is set aside, not overwritten by the next receipt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-tailscale-'));
    dirs.push(dir);
    const path = join(dir, 'receipts.json');
    writeFileSync(path, '{"receipts":[{"at":1,"command":"x"');
    const store = new TailscaleServeReceiptStore(path);
    store.append(receipt(2));
    expect(store.list().map((r) => r.detail)).toEqual(['receipt 2']);
    const setAside = readdirSync(dir).find((name) => name.startsWith('receipts.json.corrupt-') && !name.endsWith('.why'));
    expect(setAside).toBeDefined();
    expect(readFileSync(join(dir, setAside!), 'utf-8')).toContain('"at":1');
  });

  test('appending leaves no staging file behind and keeps the history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-tailscale-'));
    dirs.push(dir);
    const path = join(dir, 'receipts.json');
    const store = new TailscaleServeReceiptStore(path);
    store.append(receipt(1));
    store.append(receipt(2));
    expect(store.list().map((r) => r.at)).toEqual([1, 2]);
    expect(readdirSync(dir)).toEqual(["receipts.json"]);
  });
});
