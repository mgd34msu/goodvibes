import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { upsertEcosystemCatalogEntry } from '../platform/src/platform/runtime/ecosystem/catalog.ts';
import { TurnActivityTally } from '../platform/src/platform/runtime/turn-notification.ts';
import { countUndecidedApprovals } from '../platform/src/platform/runtime/ui-read-models-core.ts';
import { createMaintenanceObservabilityReadModels } from '../platform/src/platform/runtime/ui-read-models-observability-maintenance.ts';
import { createSystemObservabilityReadModels } from '../platform/src/platform/runtime/ui-read-models-observability-system.ts';
import { createProviderRuntimeInspectionQuery } from '../platform/src/platform/runtime/ui-service-queries.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

type SystemServices = Parameters<typeof createSystemObservabilityReadModels>[0];

describe('marketplace recommendations after a failed ranking', () => {
  test('the failure is shown, the same candidates wait out the retry delay, then are ranked again and recover', async () => {
    const root = makeProjectTempDir('market-rank-');
    upsertEcosystemCatalogEntry({ id: 'github', kind: 'plugin', name: 'github', summary: 'github summary', source: 'catalog', tags: [] }, { cwd: root, homeDir: root });

    const working = fakePort(() => noulAnswer(0.9)).port;
    let asks = 0;
    const port: JudgmentPort = {
      model: working.model,
      async ask(request) {
        asks++;
        if (asks === 1) throw new JudgmentError('rejected', 'ranking refused');
        return working.ask(request);
      },
    };
    installJudgmentPort(port);

    const services = {
      runtimeStore: { getState: () => ({ permissions: { denialCount: 0 }, mcp: { servers: new Map() } }), subscribe: () => () => {} },
      shellPaths: { workingDirectory: root, homeDirectory: root },
    } as unknown as SystemServices;
    let clock = 1_000_000;
    const { marketplace } = createSystemObservabilityReadModels(services, { now: () => clock });

    let wake: (() => void) | undefined;
    marketplace.subscribe(() => wake?.());
    const nextNotification = () => new Promise<void>((resolve) => { wake = resolve; });

    let settled = nextNotification();
    marketplace.getSnapshot();
    await settled;
    expect(asks).toBe(1);
    const failed = marketplace.getSnapshot();
    expect(failed.recommendations).toEqual([]);
    expect(failed.startupIssues.join(' ')).toContain('could not be ranked (');
    expect(failed.startupIssues.join(' ')).toContain('ranking refused');

    // Inside the retry delay the candidates are not sent to Jev again.
    clock += 1_000;
    marketplace.getSnapshot();
    expect(asks).toBe(1);

    clock += 60_000;
    settled = nextNotification();
    marketplace.getSnapshot();
    await settled;
    expect(asks).toBeGreaterThan(1);
    const recovered = marketplace.getSnapshot();
    expect(recovered.recommendations.map((r) => r.id)).toEqual(['plugin:github']);
    expect(recovered.startupIssues.join(' ')).not.toContain('could not be ranked');
  });
});

describe('cockpit change sources', () => {
  test('a raised approval wakes a cockpit subscriber, and the shared count sees pending and claimed asks only', () => {
    const brokerListeners = new Set<() => void>();
    let approvals: { status: string }[] = [];
    const approvalBroker = {
      listApprovals: () => approvals,
      subscribe: (listener: () => void) => { brokerListeners.add(listener); return () => { brokerListeners.delete(listener); }; },
    };
    const none = { subscribe: () => () => {} };
    const services = {
      runtimeStore: { getState: () => ({}), subscribe: () => () => {} },
      pluginManager: none,
      policyRuntimeState: none,
      approvalBroker,
      shellPaths: { workingDirectory: '/unused', homeDirectory: '/unused' },
    } as unknown as SystemServices;
    const { cockpit } = createSystemObservabilityReadModels(services);

    let woken = 0;
    const stop = cockpit.subscribe(() => { woken++; });
    approvals = [{ status: 'pending' }, { status: 'claimed' }, { status: 'approved' }, { status: 'cancelled' }];
    for (const listener of brokerListeners) listener();
    expect(woken).toBe(1);
    expect(countUndecidedApprovals(approvalBroker as never)).toBe(2);

    stop();
    expect(brokerListeners.size).toBe(0);
  });
});

describe('models whose state nothing announces', () => {
  test('settings and worktrees say they are poll-only, never call a subscriber, and show new state on the next read', () => {
    let conflicts = 0;
    const services = {
      integrationHelpers: {
        getSettingsSnapshot: () => ({ available: true, conflicts: new Array(conflicts).fill({}), recentFailures: [], managedLockCount: 0, stagedManagedBundle: undefined }),
        getWorktreeSnapshot: () => ({ summary: { total: 0, active: 0, paused: 0, pendingCleanup: 0, discard: 0 }, records: [] }),
        getContinuitySnapshot: () => ({}),
      },
      runtimeStore: { getState: () => ({}), subscribe: () => () => {} },
    } as unknown as Parameters<typeof createMaintenanceObservabilityReadModels>[0];
    const { settings, worktrees } = createMaintenanceObservabilityReadModels(services);

    let woken = 0;
    settings.subscribe(() => { woken++; });
    expect(settings.pollOnly).toBe(true);
    expect(worktrees.pollOnly).toBe(true);
    expect(settings.getSnapshot().conflictCount).toBe(0);
    conflicts = 2;
    expect(woken).toBe(0);
    expect(settings.getSnapshot().conflictCount).toBe(2);
  });
});

describe('provider runtime inspection', () => {
  test('an answer for another scope than the one asked is an error, not an empty provider list', async () => {
    const wrong = { listProviderIds: () => [], queryRuntimeMetadata: async () => ({ scope: 'provider', snapshot: null }) } as never;
    const query = createProviderRuntimeInspectionQuery(wrong);
    await expect(query.inspectAll()).rejects.toThrow("scope 'all' answered with scope 'provider'");
    const other = { listProviderIds: () => [], queryRuntimeMetadata: async () => ({ scope: 'all', snapshots: [] }) } as never;
    await expect(createProviderRuntimeInspectionQuery(other).inspect('x')).rejects.toThrow("scope 'provider' answered with scope 'all'");
    const known = { listProviderIds: () => [], queryRuntimeMetadata: async () => ({ scope: 'provider', snapshot: null }) } as never;
    expect(await createProviderRuntimeInspectionQuery(known).inspect('missing')).toBeNull();
  });
});

describe('TurnActivityTally', () => {
  test('only a succeeded write or edit counts its files; failures, dry runs and other tools count calls only', () => {
    const tally = new TurnActivityTally();
    tally.noteToolReceived('w1', 'write', { files: [{ path: 'a.ts' }] });
    tally.noteToolReceived('w2', 'edit', { path: 'b.ts' });
    tally.noteToolReceived('w3', 'write', { path: 'c.ts', dry_run: true });
    tally.noteToolReceived('r1', 'read', { path: 'd.ts' });
    tally.noteToolSucceeded('w1');
    tally.noteToolFailed('w2');
    tally.noteToolSucceeded('w3');
    tally.noteToolSucceeded('r1');
    tally.noteAgentStarted();
    tally.noteReviewScore(Number.NaN);
    tally.noteReviewScore(8);
    expect(tally.snapshot()).toEqual({ toolCalls: 4, filesChanged: 1, agentsStarted: 1, reviewScore: 8 });
    tally.reset();
    expect(tally.snapshot()).toEqual({ toolCalls: 0, filesChanged: 0, agentsStarted: 0, reviewScore: null });
  });
});
