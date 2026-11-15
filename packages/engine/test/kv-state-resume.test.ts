import { afterEach, expect, test } from 'bun:test';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { KVState } from '../platform/src/platform/state/kv-state.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = (): string => { const dir = makeProjectTempDir('kv-resume'); dirs.push(dir); return dir; };

test('state set before a restart is read back when the same conversation session resumes', async () => {
  const stateDir = tempDir();
  const sessionId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  const first = new KVState({ stateDir, sessionId });
  await first.set({ plan: 'step two' });
  // Disposal is what flushes a write still waiting on the 5 s debounce.
  await first.dispose();

  const resumed = new KVState({ stateDir, sessionId });
  expect(await resumed.get(['plan'])).toEqual({ plan: 'step two' });
  await resumed.dispose();
  expect(KVState.listSessions({ stateDir })).toEqual([`${sessionId}`]);
});

test('a session id that is not filename-safe cannot name a file outside the state directory', async () => {
  const stateDir = tempDir();
  const state = new KVState({ stateDir, sessionId: '../../escape/session:1' });
  await state.set({ k: 1 });
  await state.dispose();
  const [file, ...rest] = readdirSync(stateDir);
  expect(rest).toEqual([]);
  expect(file).toMatch(/^session-______escape_session_1-[0-9a-f]{16}\.json$/);
});
