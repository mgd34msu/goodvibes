import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KVState } from '../platform/src/platform/state/kv-state.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('KVState load failure', () => {
  test('a failed load is retried on the next call once the file is fixed', async () => {
    const dir = join(tmpdir(), `gv-kv-retry-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const file = join(dir, 'session_0000abcd.json');
    writeFileSync(file, '[1, 2, 3]');
    const state = new KVState({ stateDir: dir, sessionId: '0000abcd' });
    await expect(state.get(['k'])).rejects.toThrow(/Move or delete that file/);
    writeFileSync(file, JSON.stringify({ id: '0000abcd', k: 'v' }));
    expect(await state.get(['k'])).toEqual({ k: 'v' });
    await state.dispose();
  });
});
