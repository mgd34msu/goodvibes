/** Two different names that reduce to one file name never overwrite each other's session. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../platform/src/platform/sessions/manager.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function manager() {
  const dir = mkdtempSync(join(tmpdir(), 'session-names-')); dirs.push(dir);
  return { dir, sm: new SessionManager(dir) };
}
const meta = (title: string) => ({ title, model: 'm', provider: 'p', timestamp: 1 });
const say = (text: string) => [{ role: 'user', content: text }];

test('a different name that maps to an existing session file is refused and the session is intact', () => {
  const { sm } = manager();
  sm.save('会议', say('meeting'), meta('meeting'));
  expect(() => sm.save('笔记', say('notes'), meta('notes'))).toThrow(/same file as the existing session "会议"/);
  expect(sm.load('会议').messages).toEqual([{ role: 'user', content: 'meeting' }]);
});

test('saving again under the same name still replaces the session', () => {
  const { sm } = manager();
  sm.save('My Chat', say('one'), meta('one'));
  sm.save('My Chat', say('two'), meta('two'));
  expect(sm.load('My Chat').messages).toEqual([{ role: 'user', content: 'two' }]);
  expect(sm.list()).toHaveLength(1);
});
