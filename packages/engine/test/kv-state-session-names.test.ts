import { mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test } from 'bun:test';
import { KVState } from '../platform/src/platform/state/kv-state.ts';

/**
 * Session state files: distinct ids keep distinct state, a caller key that
 * would be dropped is refused, and a saved conversation's state is not reaped.
 */
const roots: string[] = [];
const states: KVState[] = [];
afterEach(async () => {
  for (const state of states.splice(0)) await state.dispose().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function stateDir(): string {
  const dir = join(tmpdir(), `gv-kv-names-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}
function open(options: ConstructorParameters<typeof KVState>[0]): KVState {
  const state = new KVState(options);
  states.push(state);
  return state;
}

describe('session ids that sanitize alike', () => {
  test('a/b and a_b do not see each other\'s values', async () => {
    const dir = stateDir();
    const slash = open({ stateDir: dir, sessionId: 'a/b' });
    const underscore = open({ stateDir: dir, sessionId: 'a_b' });
    await slash.set({ owner: 'slash' });
    await underscore.set({ owner: 'underscore' });
    await slash.dispose();
    await underscore.dispose();
    expect(await open({ stateDir: dir, sessionId: 'a/b' }).get(['owner'])).toEqual({ owner: 'slash' });
    expect(await open({ stateDir: dir, sessionId: 'a_b' }).get(['owner'])).toEqual({ owner: 'underscore' });
  });

  test('two ids with one 64-character prefix keep separate files', async () => {
    const dir = stateDir();
    const prefix = 'p'.repeat(70);
    const first = open({ stateDir: dir, sessionId: `${prefix}/one` });
    const second = open({ stateDir: dir, sessionId: `${prefix}/two` });
    await first.set({ k: 1 }); await second.set({ k: 2 });
    await first.dispose(); await second.dispose();
    expect(readdirSync(dir).filter((name) => name.startsWith('session-'))).toHaveLength(2);
  });
});

describe('reserved keys', () => {
  test('set refuses a reserved key by name and stores nothing from that call', async () => {
    const state = open({ stateDir: stateDir(), sessionId: 'reserved-keys' });
    await expect(state.set({ fine: 1, id: 'mine' })).rejects.toThrow(/reserved key\(s\): id/);
    expect(await state.get(['fine', 'id'])).toEqual({ id: 'reserved-keys' });
  });
});

describe('housekeeping and a saved conversation', () => {
  function writeOld(dir: string, name: string, ageDays: number): void {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ id: name, started_at: 'then', kept: true }));
    const seconds = (Date.now() - ageDays * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(path, seconds, seconds);
  }

  test('an old keyed file survives another session\'s sweep; an old generated file does not', async () => {
    const dir = stateDir();
    writeOld(dir, 'session-saved-conversation.json', 20);
    writeOld(dir, 'session_aaaaaaaa.json', 20);
    await open({ stateDir: dir, sessionId: 'bbbbbbbb' }).get([]);
    const left = readdirSync(dir);
    expect(left).toContain('session-saved-conversation.json');
    expect(left).not.toContain('session_aaaaaaaa.json');
  });

  test('when the owner of conversations says one is gone, its old state is reclaimed', async () => {
    const dir = stateDir();
    writeOld(dir, 'session-gone.json', 20);
    writeOld(dir, 'session-kept.json', 20);
    await open({ stateDir: dir, sessionId: 'bbbbbbbb', canReclaimKeyedState: (token) => token === 'gone' }).get([]);
    const left = readdirSync(dir);
    expect(left).not.toContain('session-gone.json');
    expect(left).toContain('session-kept.json');
  });
});
