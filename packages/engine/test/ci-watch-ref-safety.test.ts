import { describe, expect, test } from 'bun:test';
import { detectCiPushInCommand } from '../platform/src/platform/ci-watch/auto-watch.ts';
import { startAdmittedCiRepair } from '../platform/src/platform/ci-watch/autonomous.ts';
import { createGhCliCiSource } from '../platform/src/platform/ci-watch/gh-source.ts';
import type { CiRepairRequest } from '../platform/src/platform/ci-watch/autonomous.ts';
import { CiWatchService } from '../platform/src/platform/ci-watch/service.ts';
import { CiWatchStore } from '../platform/src/platform/ci-watch/subscriptions.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { registerCiGatewayMethods } from '../platform/src/platform/control-plane/routes/ci.ts';
import type { CiWatchSubscription } from '../platform/src/platform/ci-watch/types.ts';

describe('push detection refspecs', () => {
  test('a push that deletes a ref or only pushes tags has no branch to watch', () => {
    expect(detectCiPushInCommand('git push --delete origin x')).toBeNull();
    expect(detectCiPushInCommand('git push -d origin x')).toBeNull();
    expect(detectCiPushInCommand('git push origin :x')).toBeNull();
    expect(detectCiPushInCommand('git push --tags origin')).toBeNull();
    expect(detectCiPushInCommand('git push origin refs/tags/v1')).toBeNull();
  });

  test('force marks and refs/heads/ are not part of the branch name', () => {
    expect(detectCiPushInCommand('git push origin +main')).toEqual({ kind: 'push', branch: 'main' });
    expect(detectCiPushInCommand('git push origin refs/heads/feature')).toEqual({ kind: 'push', branch: 'feature' });
    expect(detectCiPushInCommand('git push origin HEAD:refs/heads/feature')).toEqual({ kind: 'push', branch: 'feature' });
  });

  test('pushing HEAD resolves the current branch instead of naming one', () => {
    expect(detectCiPushInCommand('git push origin HEAD')).toEqual({ kind: 'push', branch: undefined });
  });
});

describe('CI repair evidence', () => {
  test('a failing check without a GitHub Actions identity is named in the refusal', async () => {
    const operation = { assertCurrent: () => {}, sourceOf: () => { throw new Error('unused'); } };
    const input = {
      subscription: { id: 'w1', repo: 'o/r' } as CiWatchSubscription,
      brief: {
        repo: 'o/r', failingJobs: ['build', 'vendor-scan'], logs: '',
        jobs: [
          { name: 'build', status: 'completed', conclusion: 'failure', headSha: 'abc', runId: '1', jobId: '2' },
          { name: 'vendor-scan', status: 'completed', conclusion: 'failure', headSha: 'abc' },
        ],
      },
      operation, signal: new AbortController().signal, assertCurrent: () => {},
      claimRepair: () => {}, refreshCurrent: async () => {},
    } as unknown as CiRepairRequest;
    const result = await startAdmittedCiRepair({} as never, input, async () => { throw new Error('must not start'); }) as { error?: string };
    expect(result.error).toContain('vendor-scan');
    expect(result.error).not.toContain('build,');
  });
});

describe('gh status source path safety', () => {
  const source = createGhCliCiSource();
  for (const repo of ['a/b/../c', 'a/b?x=1', 'a', 'a/b/c']) {
    test(`repo ${repo} is refused before any request`, async () => {
      await expect(source.fetchJobs({ repo, ref: 'main' })).rejects.toThrow('not a GitHub owner/name');
    });
  }
  for (const ref of ['../../orgs/x', 'a?b', 'a#b', 'a b']) {
    test(`ref ${ref} is refused before any request`, async () => {
      await expect(source.fetchJobs({ repo: 'o/r', ref })).rejects.toThrow('not a valid git ref');
    });
  }
});

describe('repo and ref are validated before a watch or a status call', () => {
  function serviceWith(fetched: unknown[]) {
    return new CiWatchService({
      source: { fetchJobs: async (target) => { fetched.push(target); return []; } },
      store: new CiWatchStore(':memory:'),
    });
  }

  test('a watch for a bad repo or ref is refused and nothing is stored', async () => {
    const service = serviceWith([]);
    await expect(service.createWatch({ repo: 'a/b/../c', ref: 'main', deliveryChannel: 'slack:C1' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(service.createWatch({ repo: 'o/r', ref: 'a..b', deliveryChannel: 'slack:C1' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await service.listWatches()).toEqual([]);
    expect((await service.createWatch({ repo: 'o/r', ref: 'feature/x', deliveryChannel: 'slack:C1' })).ref).toBe('feature/x');
  });

  test('ci.status with a path-steering repo answers 400 and never reaches the source', async () => {
    const fetched: unknown[] = [];
    const catalog = new GatewayMethodCatalog();
    registerCiGatewayMethods(catalog, serviceWith(fetched));
    await expect(catalog.invoke('ci.status', { context: { admin: true }, body: { repo: 'a/b/../c' } })).rejects.toMatchObject({ status: 400, code: 'INVALID_ARGUMENT' });
    expect(fetched).toEqual([]);
  });
});
