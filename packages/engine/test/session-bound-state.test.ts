/** State written after the host's session id changes (resume, fork) lands in the new session's file and is read back by it. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KVState } from '../platform/src/platform/state/kv-state.ts';
import { createSessionBoundKvState } from '../platform/src/platform/tools/session-kv-state.ts';

const dirs: string[] = [];
const stateDir = () => { const dir = mkdtempSync(join(tmpdir(), 'gv-bound-kv-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('session-bound state', () => {
  test('a write after the session id changes lands under the new id, and the earlier write stays under the old one', async () => {
    const dir = stateDir();
    let sessionId = 'user-launch1';
    const bound = createSessionBoundKvState({ stateDir: dir }, () => sessionId);
    await bound.state.set({ before: 1 });
    sessionId = 'resumed-session';
    await bound.state.set({ after: 2 });
    await bound.dispose();

    // The resumed session, in a later process, finds only what it wrote.
    const later = new KVState({ stateDir: dir, sessionId: 'resumed-session' });
    expect(await later.get(['before', 'after'])).toEqual({ after: 2 });
    await later.dispose();
    // The launch id's file kept its own key (flushed before the switch), not the new one.
    const launch = new KVState({ stateDir: dir, sessionId: 'user-launch1' });
    expect(await launch.get(['before', 'after'])).toEqual({ before: 1 });
    await launch.dispose();
  });

  test('reads follow the id too', async () => {
    const dir = stateDir();
    const seed = new KVState({ stateDir: dir, sessionId: 'S' });
    await seed.set({ saved: 'yes' });
    await seed.dispose();
    let sessionId = 'user-launch2';
    const bound = createSessionBoundKvState({ stateDir: dir }, () => sessionId);
    expect(await bound.state.get(['saved'])).toEqual({});
    sessionId = 'S';
    expect(await bound.state.get(['saved'])).toEqual({ saved: 'yes' });
    await bound.dispose();
  });

  test('instances are registered while bound and released when replaced', async () => {
    const dir = stateDir();
    let sessionId = 'a';
    const live = new Set<KVState>();
    const bound = createSessionBoundKvState({ stateDir: dir }, () => sessionId, { onBind: (s) => live.add(s), onRelease: (s) => live.delete(s) });
    expect(live.size).toBe(1);
    sessionId = 'b';
    await bound.state.set({ x: 1 });
    expect(live.size).toBe(1);
    expect([...live][0]).toBe(bound.current());
    await bound.dispose();
    expect(live.size).toBe(0);
  });

  test('without a resolver it is one plain state with a generated id', async () => {
    const dir = stateDir();
    const bound = createSessionBoundKvState({ stateDir: dir }, undefined);
    await bound.state.set({ k: 1 });
    await bound.dispose();
    expect(readdirSync(dir).filter((name) => name.startsWith('session_'))).toHaveLength(1);
  });
});
