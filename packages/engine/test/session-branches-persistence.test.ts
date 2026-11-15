/** A session saved with /branch work gives the branches back when it is loaded. */
import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../platform/src/platform/sessions/manager.js';
import { ConversationManager } from '../platform/src/platform/core/conversation.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function manager() {
  const dir = mkdtempSync(join(tmpdir(), 'session-branches-')); dirs.push(dir);
  return { dir, sm: new SessionManager(dir) };
}
const meta = { title: 't', model: 'm', provider: 'p', timestamp: 1 };

test('branches and the open branch survive a save and load of the session', () => {
  const { sm } = manager();
  const original = new ConversationManager();
  original.addUserMessage('first');
  original.forkBranch('idea');
  original.addUserMessage('only on main');
  sm.save('s', original.getMessageSnapshot(), meta, undefined, undefined, original.branchState());

  const loaded = sm.load('s');
  expect(loaded.branches?.currentBranch).toBe('main');
  expect(Object.keys(loaded.branches?.branches ?? {})).toEqual(['idea']);

  const restored = new ConversationManager();
  restored.fromJSON({
    messages: loaded.messages as never[],
    branches: loaded.branches?.branches as never,
    currentBranch: loaded.branches?.currentBranch,
  });
  expect(restored.listBranches().map(branch => [branch.name, branch.messageCount]).sort()).toEqual([['idea', 1], ['main', 2]]);
});

test('a session saved without branches loads none, and a damaged branches line is skipped', () => {
  const { sm, dir } = manager();
  sm.save('plain', [{ role: 'user', content: 'hi' }], meta, undefined, undefined, { branches: {}, currentBranch: 'main' });
  expect(sm.load('plain').branches).toBeUndefined();
  sm.save('damaged', [{ role: 'user', content: 'hi' }], meta);
  appendFileSync(join(dir, 'damaged.jsonl'), JSON.stringify({ type: 'branches', branches: { a: 'not messages' }, currentBranch: 'main' }) + '\n');
  const loaded = sm.load('damaged');
  expect(loaded.branches).toBeUndefined();
  expect(loaded.messages).toHaveLength(1);
});
