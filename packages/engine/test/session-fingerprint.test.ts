/** The sessions' fingerprint changes whenever a saved session does, without reading any session. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../platform/src/platform/sessions/manager.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const meta = { title: 't', model: 'm', provider: 'p', timestamp: 1 };

test('a save and a new session each change the fingerprint; an idle directory does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-fingerprint-')); dirs.push(dir);
  const sm = new SessionManager(dir);
  expect(sm.fingerprint()).toBe('');
  sm.save('one', [{ role: 'user', content: 'a' }], meta);
  const first = sm.fingerprint();
  expect(sm.fingerprint()).toBe(first);
  sm.save('one', [{ role: 'user', content: 'b' }], meta);
  const rewritten = sm.fingerprint();
  expect(rewritten).not.toBe(first);
  sm.save('two', [], meta);
  expect(sm.fingerprint()).not.toBe(rewritten);
});
