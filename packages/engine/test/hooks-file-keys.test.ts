/**
 * A hooks-file entry fires on the key it is listed under. A key that can never
 * fire, or a `match` that names a different event than the key, is not loaded,
 * and the refusal is listed in the hook activity instead of the hook silently
 * never running (or running on events its definition does not name).
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookActivityTracker } from '../platform/src/platform/hooks/activity.ts';
import { HookDispatcher } from '../platform/src/platform/hooks/dispatcher.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function load(hooks: Record<string, unknown[]>): { dispatcher: HookDispatcher; activity: HookActivityTracker } {
  const dir = mkdtempSync(join(tmpdir(), 'gv-hook-keys-'));
  dirs.push(dir);
  const file = join(dir, 'hooks.json');
  writeFileSync(file, JSON.stringify({ hooks }), { mode: 0o600 });
  const activity = new HookActivityTracker();
  const dispatcher = new HookDispatcher({}, activity);
  dispatcher.loadFromFile(file);
  return { dispatcher, activity };
}

test('the key decides; match is optional and must agree with the key when present', () => {
  const { dispatcher, activity } = load({
    'Pre:tool:*': [
      { name: 'keyed', type: 'command', command: 'true' },
      { name: 'agreeing', match: 'Pre:tool:*', type: 'command', command: 'true' },
      { name: 'moved', match: 'Post:git:commit', type: 'command', command: 'true' },
    ],
    'Pre:git:commit': [{ name: 'git-guard', type: 'command', command: 'true' }],
  });
  expect(dispatcher.listHooks().map(({ hook }) => hook.name)).toEqual(['keyed', 'agreeing', 'git-guard']);
  expect(activity.listRecent()).toHaveLength(1);
  expect(activity.listRecent()[0]).toMatchObject({ pattern: 'Pre:tool:*', hookName: 'moved', ok: false });
});

test('a key that can never fire is refused and listed', () => {
  const { dispatcher, activity } = load({
    'pre:tool:exec': [{ name: 'lowercase', type: 'command', command: 'true' }],
    'Pre:tools:*': [{ name: 'typo', type: 'command', command: 'true' }],
    'Pre:tool': [{ name: 'short', type: 'command', command: 'true' }],
  });
  expect(dispatcher.listHooks()).toEqual([]);
  expect(activity.listRecent().map((record) => record.hookName).sort()).toEqual(['lowercase', 'short', 'typo']);
  expect(activity.listRecent().every((record) => record.error?.includes('is not a recognized hook event point'))).toBe(true);
});
