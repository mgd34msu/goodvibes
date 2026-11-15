import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { GitService } from '@goodvibes-jev/engine/platform/platform/git';
import { GitStatusProvider } from '../../renderer/git-status.ts';

const status = { modified: ['a.ts'], created: [], deleted: [], renamed: [], conflicted: [], not_added: [], staged: [], ahead: 1, behind: 0 };

describe('GitStatusProvider after a failed refresh', () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

  test('the header falls back instead of showing the old branch as current', async () => {
    let calls = 0;
    spies.push(spyOn(GitService.prototype, 'status').mockImplementation((async () => {
      calls += 1;
      if (calls > 1) throw new Error('not a git repository');
      return status;
    }) as never));
    spies.push(spyOn(GitService.prototype, 'branch').mockImplementation((async () => ({ current: 'main' })) as never));
    const provider = new GitStatusProvider('/nowhere');
    expect(await provider.refresh()).toEqual({ branch: 'main', dirty: true, ahead: 1, behind: 0 });
    expect(await provider.refresh()).toEqual({ branch: '?', dirty: false, ahead: 0, behind: 0 });
  });
});
