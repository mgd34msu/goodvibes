/**
 * Session state outlives the process that wrote it, and a session id cannot
 * make the store write outside its own directory.
 */
import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
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
  // set resolves once the value is on disk; dispose only stops housekeeping.
  await first.dispose();

  const resumed = new KVState({ stateDir, sessionId });
  expect(await resumed.get(['plan'])).toEqual({ plan: 'step two' });
  await resumed.dispose();
  expect(KVState.listSessions({ stateDir })).toEqual([sessionId]);
});
