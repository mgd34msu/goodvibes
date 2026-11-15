import { describe, test, expect, afterEach, beforeEach, jest } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { GitStatusProvider } from '../../renderer/git-status.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StatusResult = {
  modified: string[];
  created: string[];
  deleted: string[];
  renamed: string[];
  conflicted: string[];
  not_added: string[];
  staged: string[];
  ahead: number;
  behind: number;
};

function makeStatus(overrides: Partial<StatusResult> = {}): StatusResult {
  return {
    modified: [],
    created: [],
    deleted: [],
    renamed: [],
    conflicted: [],
    not_added: [],
    staged: [],
    ahead: 0,
    behind: 0,
    ...overrides,
  };
}

/**
 * Create a GitStatusProvider with a fake fetch function.
 * This avoids process-global module mocks, which pollute the global module registry and
 * breaks other test files (e.g. src/test/git/service.test.ts) that import
 * the real GitService constructor.
 */
function providerWithFakeFetch(
  statusResult: StatusResult,
  branchName: string,
): GitStatusProvider {
  const provider = new GitStatusProvider(process.cwd());
  type PrivateProvider = {
    _fetch: () => Promise<void>;
    cache: { branch: string; dirty: boolean; ahead: number; behind: number };
    lastFetch: number;
    fetching: boolean;
  };
  const p = provider as unknown as PrivateProvider;
  p._fetch = async () => {
    const dirty =
      statusResult.modified.length > 0 ||
      statusResult.created.length > 0 ||
      statusResult.deleted.length > 0 ||
      statusResult.renamed.length > 0 ||
      statusResult.conflicted.length > 0 ||
      statusResult.not_added.length > 0;
    p.cache = {
      branch: branchName,
      dirty,
      ahead: statusResult.ahead ?? 0,
      behind: statusResult.behind ?? 0,
    };
    p.lastFetch = Date.now();
    p.fetching = false;
  };
  return provider;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitStatusProvider', () => {
  describe('getStatus: clean repo', () => {

    test('returns boolean for dirty', async () => {
      const provider = new GitStatusProvider(process.cwd());
      const info = await provider.getStatus();
      expect(typeof info.dirty).toBe('boolean');
    });

  });

  describe('unborn HEAD (repo with no commits); 5a', () => {
    test('shows "new" instead of "?" for a freshly-initialised repo', async () => {
      const dir = makeProjectTempDir('gv-git-new');
      try {
        Bun.spawnSync(['git', 'init'], { cwd: dir });
        const provider = new GitStatusProvider(dir);
        const info = await provider.getStatus();
        expect(info.branch).toBe('new');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('caching behaviour', () => {
    test('second call within TTL returns cached result without refetching', async () => {
      const provider = new GitStatusProvider(process.cwd());
      // Prime the cache
      const first = await provider.getStatus();
      // Immediately call again, should be same object (cached)
      const second = await provider.getStatus();
      expect(second).toBe(first);
    });

  });

  describe('error handling: never throws', () => {
    test('getStatus returns the fallback when the git state cannot be read', async () => {
      // The directory does not exist, so the real fetch fails inside GitService.
      const missing = join(makeProjectTempDir('gv-git-missing-parent'), 'absent');
      const provider = new GitStatusProvider(missing);
      const info = await provider.getStatus();
      expect(info).toEqual({ branch: '?', dirty: false, ahead: 0, behind: 0 });
    });

    test('refresh replaces a good reading with the fallback once git fails', async () => {
      const dir = makeProjectTempDir('gv-git-refresh-fails');
      try {
        Bun.spawnSync(['git', 'init'], { cwd: dir });
        await Bun.write(join(dir, 'untracked.txt'), 'x');
        const provider = new GitStatusProvider(dir);
        const good = await provider.refresh();
        expect(good.branch).not.toBe('?');
        expect(good.dirty).toBe(true);
        // The repository disappears; the old branch and dirty marker must not stand as current.
        rmSync(dir, { recursive: true, force: true });
        const after = await provider.refresh();
        expect(after).toEqual({ branch: '?', dirty: false, ahead: 0, behind: 0 });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('dirty detection', () => {
    test('dirty is false when all arrays are empty', async () => {
      const provider = providerWithFakeFetch(makeStatus(), 'main');
      const info = await provider.getStatus();
      expect(info.dirty).toBe(false);
    });

    test('dirty is true when modified files present', async () => {
      const provider = providerWithFakeFetch(makeStatus({ modified: ['src/foo.ts'] }), 'main');
      const info = await provider.getStatus();
      expect(info.dirty).toBe(true);
    });

    test('dirty is true when untracked files present', async () => {
      const provider = providerWithFakeFetch(makeStatus({ not_added: ['new-file.ts'] }), 'feature');
      const info = await provider.getStatus();
      expect(info.dirty).toBe(true);
    });

    test('dirty is true when conflicted files present', async () => {
      const provider = providerWithFakeFetch(makeStatus({ conflicted: ['conflict.ts'] }), 'main');
      const info = await provider.getStatus();
      expect(info.dirty).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // startPolling / stopPolling
  // -------------------------------------------------------------------------
  describe('startPolling / stopPolling', () => {
    const POLL_MS = 20;
    const providers: GitStatusProvider[] = [];

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      for (const p of providers.splice(0)) p.stopPolling();
      jest.useRealTimers();
    });

    /** A provider whose fetch reads a branch the test can change, counting fetches. */
    function providerWithBranch(initial: string): { provider: GitStatusProvider; setBranch: (b: string) => void; fetches: () => number } {
      let branch = initial;
      let fetches = 0;
      const provider = new GitStatusProvider(process.cwd());
      providers.push(provider);
      const p = provider as unknown as { _fetch: () => Promise<void>; cache: { branch: string; dirty: boolean; ahead: number; behind: number }; lastFetch: number };
      p._fetch = async () => {
        fetches++;
        p.cache = { branch, dirty: false, ahead: 0, behind: 0 };
        p.lastFetch = Date.now();
      };
      return { provider, setBranch: (b) => { branch = b; }, fetches: () => fetches };
    }

    async function settle(): Promise<void> {
      for (let i = 0; i < 3; i++) await Promise.resolve();
    }

    test('a branch switched outside the app reaches onChange once, and an unchanged reading never does', async () => {
      const { provider, setBranch, fetches } = providerWithBranch('main');
      await provider.refresh();
      const seen: string[] = [];
      provider.startPolling(POLL_MS, (info) => { seen.push(info.branch); });

      for (let i = 0; i < 3; i++) { jest.advanceTimersByTime(POLL_MS); await settle(); }
      expect(seen).toEqual([]);

      setBranch('feature');
      for (let i = 0; i < 3; i++) { jest.advanceTimersByTime(POLL_MS); await settle(); }
      expect(seen).toEqual(['feature']);
      expect(fetches()).toBe(7);
    });

    test('stopPolling() stops fetching', async () => {
      const { provider, fetches } = providerWithBranch('main');
      provider.startPolling(POLL_MS, () => {});
      jest.advanceTimersByTime(POLL_MS);
      await settle();
      expect(fetches()).toBe(1);
      provider.stopPolling();
      jest.advanceTimersByTime(POLL_MS * 10);
      await settle();
      expect(fetches()).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// GitHeaderInfo integration with UIFactory.createHeader
// ---------------------------------------------------------------------------

import { UIFactory } from '../../renderer/ui-factory.ts';
import { lineToString } from '../setup.ts';
import { activeTokens } from '../../renderer/theme.ts';

describe('UIFactory.createHeader with gitInfo', () => {
  const WIDTH = 120;

  test('shows branch name when gitInfo provided', () => {
    const lines = UIFactory.createHeader(WIDTH, 'model', undefined, {
      branch: 'main',
      dirty: false,
      ahead: 0,
      behind: 0,
    });
    const text = lineToString(lines[0]);
    expect(text).toContain('main');
  });

  test('shows the dirty dot, in the warning color, when dirty', () => {
    const lines = UIFactory.createHeader(WIDTH, 'model', undefined, {
      branch: 'feature',
      dirty: true,
      ahead: 0,
      behind: 0,
    });
    const text = lineToString(lines[0]);
    expect(text).toContain('feature ●');
    expect(lines[0]![text.indexOf('●')]!.fg).toBe(activeTokens().warning);
  });

  test('shows ahead/behind indicators when out of sync', () => {
    const lines = UIFactory.createHeader(WIDTH, 'model', undefined, {
      branch: 'main',
      dirty: false,
      ahead: 2,
      behind: 1,
    });
    const text = lineToString(lines[0]);
    expect(text).toContain('+2');
    expect(text).toContain('-1');
  });

  test('omits git section when gitInfo is undefined', () => {
    const withGit = UIFactory.createHeader(WIDTH, 'model', undefined, {
      branch: 'main',
      dirty: false,
      ahead: 0,
      behind: 0,
    });
    const withoutGit = UIFactory.createHeader(WIDTH, 'model', undefined, undefined);
    const textWith = lineToString(withGit[0]);
    const textWithout = lineToString(withoutGit[0]);
    expect(textWith).toContain('main');
    expect(textWithout).not.toContain('main');
  });

  test('does not throw when gitInfo has empty branch', () => {
    expect(() => {
      UIFactory.createHeader(WIDTH, 'model', undefined, {
        branch: '',
        dirty: false,
        ahead: 0,
        behind: 0,
      });
    }).not.toThrow();
  });

  test('the header is a single row: no rule row under it', () => {
    expect(UIFactory.createHeader(WIDTH, 'model', undefined, undefined)).toHaveLength(1);
  });

  test('line 0 always has correct width', () => {
    const lines = UIFactory.createHeader(WIDTH, 'model', undefined, {
      branch: 'main',
      dirty: true,
      ahead: 3,
      behind: 2,
    });
    expect(lines[0].length).toBe(WIDTH);
  });
});
