import { describe, test, expect } from 'bun:test';
import { ConfigModal } from '../../../input/config-modal.ts';
import type { ConfigModalActionContext } from '../../../input/config-modal-types.ts';
import { createMemoryModalSurface } from '../../../views/modals/memory-modal.ts';
import { createWorkPlanModalSurface } from '../../../views/modals/work-plan-modal.ts';
import { createKnowledgeModalSurface, type KnowledgeModalDeps } from '../../../views/modals/knowledge-modal.ts';
import { createPolicyModalSurface } from '../../../views/modals/policy-modal.ts';
import { createDevicesModalSurface } from '../../../views/modals/devices-modal.ts';
import { createPairingModalSurface, type PairingConnectionRequest, type PairingModalConnectionInfo } from '../../../views/modals/pairing-modal.ts';
import { createServicesModalSurface } from '../../../views/modals/services-modal.ts';
import { createPluginsModalSurface, type PluginsModalManager } from '../../../views/modals/plugins-modal.ts';
import { createLocalAuthModalSurface } from '../../../views/modals/local-auth-modal.ts';
import { createSandboxModalSurface } from '../../../views/modals/sandbox-modal.ts';
import type { ServiceInspectionQuery, SubscriptionAccessQuery, SandboxSessionRegistry } from '@/runtime/index.ts';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { MemoryRecord, HonestMemorySearchResult } from '@goodvibes-jev/engine/platform/platform/state';
import type { PluginStatus } from '@goodvibes-jev/engine/platform/platform/plugins';
import { actionCtx, open, tabText, viewText } from './modal-surface-test-helpers.ts';
import { hooksModalGoldenSurface } from '../../helpers/modal-golden-surfaces.ts';

/** Let every already-resolved promise chain run to its end (no timers). */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

function statusRecorder(): { statuses: string[]; extra: Partial<ConfigModalActionContext> } {
  const statuses: string[] = [];
  return { statuses, extra: { setStatus: (message: string) => statuses.push(message) } };
}

describe('a modal action reports what its command did, then re-reads what it changed', () => {
  test('memory delete: the record leaves the list once the command settles, and the status says Done', async () => {
    const records: MemoryRecord[] = [
      { id: 'mem-aaa1', scope: 'project', cls: 'decision', summary: 'Keep me.', tags: [], reviewState: 'reviewed', confidence: 90, createdAt: 1, updatedAt: 1, provenance: [] },
      { id: 'mem-bbb2', scope: 'project', cls: 'risk', summary: 'Delete me.', tags: [], reviewState: 'stale', confidence: 30, createdAt: 2, updatedAt: 2, provenance: [] },
    ];
    const search = (): HonestMemorySearchResult => ({
      records: [...records], mode: 'literal', requestedSemantic: false, indexUnavailableReason: null,
      caveat: null, recallFiltered: false, excludedFlaggedCount: 0, excludedBelowFloorCount: 0,
      excludedOutOfWindowCount: 0, totalBeforeRecallFilter: records.length, recallFloor: 60,
    });
    const surface = createMemoryModalSurface({ memoryRegistry: { honestSearch: async () => search(), reviewQueue: async () => [...records] } });
    surface.onOpen?.(() => {});
    await settle();
    expect(tabText(surface.buildView(), 'all')).toContain('Delete me.');

    const { statuses, extra } = statusRecorder();
    surface.onAction?.('remove', actionCtx({ id: 'mem-bbb2', label: '' }, {
      ...extra,
      executeCommand: async (_name, args) => { records.splice(records.findIndex((r) => r.id === args[1]), 1); },
    }));
    expect(statuses.at(-1)).toContain('Dispatched /recall remove mem-bbb2');
    await settle();

    const view = surface.buildView();
    expect(tabText(view, 'all')).not.toContain('Delete me.');
    expect(tabText(view, 'review')).not.toContain('Delete me.');
    expect(statuses.at(-1)).toBe('Done: /recall remove mem-bbb2.');
  });

  test('a rejecting command ends as "Failed: <reason>" with no unhandled rejection', async () => {
    const surface = createWorkPlanModalSurface({ workPlanStore: { getActivePlan: () => ({ projectRoot: '/p', items: [{ id: 'wpi-1', title: 'a', status: 'pending', updatedAt: 0 }] }) } });
    open(surface);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { statuses, extra } = statusRecorder();
      surface.onAction?.('remove', actionCtx({ id: 'wpi-1', label: '' }, { ...extra, executeCommand: async () => { throw new Error('plan is locked'); } }));
      await settle();
      expect(statuses.at(-1)).toContain('Failed: /work-plan remove wpi-1');
      expect(statuses.at(-1)).toContain('plan is locked');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('a synchronously throwing runner is reported the same way', async () => {
    const surface = hooksModalGoldenSurface();
    open(surface);
    const { statuses, extra } = statusRecorder();
    surface.onAction?.('remove', actionCtx({ id: 'Pre:tool:*#pre-tool-guard', label: '' }, {
      ...extra,
      executeCommand: () => { throw new Error('registry closed'); },
    }));
    await settle();
    expect(statuses.at(-1)).toContain('Failed: /hooks remove pre-tool-guard: registry closed');
  });

  test('with no command runner the status says it was not run instead of claiming a dispatch', () => {
    const surface = hooksModalGoldenSurface();
    open(surface);
    const { statuses, extra } = statusRecorder();
    surface.onAction?.('remove', actionCtx({ id: 'Pre:tool:*#pre-tool-guard', label: '' }, extra));
    expect(statuses.at(-1)).toContain('Not run: /hooks remove pre-tool-guard');
  });

  test('work-plan status key: the row shows the new status after the command settles', async () => {
    const items: Array<{ id: string; title: string; status: 'pending' | 'done'; updatedAt: number }> = [{ id: 'wpi-1', title: 'Ship it', status: 'pending', updatedAt: 0 }];
    const surface = createWorkPlanModalSurface({ workPlanStore: { getActivePlan: () => ({ projectRoot: '/p', items: items.map((i) => ({ ...i })) }) } });
    open(surface);
    expect(tabText(surface.buildView(), 'items')).toContain('[ ] Ship it');
    surface.onAction?.('setDone', actionCtx({ id: 'wpi-1', label: '' }, { executeCommand: async () => { items[0]!.status = 'done'; } }));
    await settle();
    expect(tabText(surface.buildView(), 'items')).toContain('[x] Ship it');
  });

  test('knowledge accept: the issue leaves the Review tab once the command settles', async () => {
    const issues = [{ id: 'issue-1', severity: 'warning' as const, code: 'stale-source', message: 'Recrawl.', status: 'open' as 'open' | 'resolved' }];
    const deps: KnowledgeModalDeps = {
      knowledgeApi: {
        graph: { nodes: { list: async () => [] }, issues: { list: async () => issues.map((i) => ({ ...i })) } },
        sources: { list: async () => [] },
        jobs: { schedules: { list: () => [] } },
      },
    };
    const surface = createKnowledgeModalSurface(deps);
    surface.onOpen?.(() => {});
    await surface.whenLoaded();
    expect(surface.buildView().tabs.find((t) => t.id === 'review')!.rows.map((r) => r.id)).toEqual(['issue:issue-1']);
    surface.onAction?.('accept', actionCtx({ id: 'issue:issue-1', label: '' }, { executeCommand: async () => { issues[0]!.status = 'resolved'; } }));
    await settle();
    await surface.whenLoaded();
    expect(surface.buildView().tabs.find((t) => t.id === 'review')!.rows).toEqual([]);
  });
});

describe('knowledge modal counts and review queue cover the whole store, not the first 60 rows', () => {
  test('open issues older than the newest 60 resolved ones still appear, and the header shows store totals', async () => {
    const resolvedNewest = Array.from({ length: 60 }, (_, i) => ({ id: `r${i}`, severity: 'info' as const, code: 'done', message: 'fixed', status: 'resolved' as const }));
    const openOlder = Array.from({ length: 40 }, (_, i) => ({ id: `o${i}`, severity: 'warning' as const, code: 'todo', message: 'look', status: 'open' as const }));
    const surface = createKnowledgeModalSurface({
      knowledgeApi: {
        graph: {
          nodes: { list: async () => [{ id: 'n', kind: 'topic', title: 'N' }] },
          // The store lists the 60 most recently updated issues only.
          issues: {
            list: async () => resolvedNewest,
            query: async (input) => ({ total: openOlder.length, items: input.status === 'open' ? openOlder : [] }),
          },
        },
        sources: { list: async () => [{ id: 's', sourceType: 'repo', status: 'indexed' }] },
        jobs: { schedules: { list: () => [] } },
        status: { get: async () => ({ sourceCount: 1, nodeCount: 500, issueCount: 100 }) },
      },
    });
    surface.onOpen?.(() => {});
    await surface.whenLoaded();
    const view = surface.buildView();
    const review = view.tabs.find((t) => t.id === 'review')!;
    expect(review.rows).toHaveLength(40);
    expect(tabText(view, 'browse')).toContain('nodes 500 (listing 1)');
    expect(tabText(view, 'browse')).toContain('issues 100 (listing 60)');
  });
});

describe('policy promote and rollback need a second press', () => {
  test('one press arms the confirm and runs nothing; the second press dispatches', () => {
    const surface = createPolicyModalSurface({
      policyRuntimeState: { getSnapshot: () => ({ current: null, candidate: null, history: [], diff: null, divergence: null, recentPermissionAudit: [], lintFindings: [], lastSimulationSummary: null, lastPreflightReview: null, capturedAt: '2023-11-01T00:00:00.000Z' }) },
    });
    const modal = new ConfigModal();
    modal.open(surface);
    const calls: string[][] = [];
    const ctx = { print: () => {}, executeCommand: async (_name: string, args: string[]) => { calls.push(args); } };
    for (const key of ['b', 'p']) {
      calls.length = 0;
      modal.fireAction(key, ctx);
      expect(calls).toEqual([]);
      modal.fireAction(key, ctx);
      expect(calls).toEqual([[key === 'b' ? 'rollback' : 'promote']]);
    }
    // Read-only commands are not gated.
    calls.length = 0;
    modal.fireAction('l', ctx);
    expect(calls).toEqual([['lint']]);
  });
});

describe('devices modal one-time token', () => {
  function deviceSurface(withClipboard: boolean) {
    let legacyRevoked = false;
    const copied: string[] = [];
    const surface = createDevicesModalSurface({
      now: () => 0,
      ...(withClipboard ? { copyToClipboard: (text: string) => { copied.push(text); } } : {}),
      pairingTokens: {
        list: () => [], rename: () => true, revoke: () => true,
        mintForMigration: (input) => ({ id: 'm', name: input.name, token: 'tok-SECRET-123', createdAt: 0 }),
        isLegacyRevoked: () => legacyRevoked,
        revokeLegacyShared: () => { legacyRevoked = true; },
      },
    });
    return { surface, copied };
  }

  test('without a clipboard the token is never printed; it is masked in the modal until revealed', () => {
    const { surface } = deviceSurface(false);
    open(surface);
    const printed: string[] = [];
    const { statuses, extra } = statusRecorder();
    surface.onAction?.('migrateShared', actionCtx(null, { ...extra, print: (m: string) => printed.push(m) }));
    expect(printed.join('\n')).not.toContain('tok-SECRET-123');
    expect(statuses.join('\n')).not.toContain('tok-SECRET-123');
    expect(viewText(surface.buildView())).not.toContain('tok-SECRET-123');
    expect(viewText(surface.buildView())).toContain('One-time token for "migrated device"');

    surface.onAction?.('toggleReveal', actionCtx(null));
    expect(viewText(surface.buildView())).toContain('tok-SECRET-123');

    // Closing the modal forgets the secret.
    surface.onClose?.();
    expect(viewText(surface.buildView())).not.toContain('tok-SECRET-123');
  });

  test('migrate needs a confirm and is unavailable once the shared token is revoked', () => {
    const { surface } = deviceSurface(true);
    open(surface);
    const migrate = (surface.actions ?? []).find((a) => a.id === 'migrateShared')!;
    expect(migrate.confirm).toBe(true);
    expect(migrate.enabledFor?.(null, 'devices')).toBe(true);
    surface.onAction?.('revokeShared', actionCtx(null));
    expect(migrate.enabledFor?.(null, 'devices')).toBe(false);
  });
});

describe('pairing modal mints one token per open', () => {
  const info = (token: string): PairingModalConnectionInfo => ({
    url: 'http://workshop.local:3141', token, tokenName: 'laptop',
    deepLink: `http://workshop.local:3141/#pair=${token}`, offers: [],
  });

  test('reopening hands the held offer back to be reused or replaced, and a new token asks for a fresh one', () => {
    let mints = 0;
    const requests: (PairingConnectionRequest | undefined)[] = [];
    const surface = createPairingModalSurface({ getConnectionInfo: (request) => {
      requests.push(request);
      return request?.held && !request.fresh ? request.held : info(`token-${++mints}`);
    } });
    surface.onOpen?.(() => {});
    surface.onAction?.('toggleReveal', actionCtx(null));
    expect(tabText(surface.buildView(), 'pairing')).toContain('token-1');
    expect(tabText(surface.buildView(), 'pairing')).toContain('token-1');
    expect(requests).toEqual([undefined]);

    surface.onClose?.();
    surface.onOpen?.(() => {});
    surface.onAction?.('toggleReveal', actionCtx(null));
    expect(tabText(surface.buildView(), 'pairing')).toContain('token-1');
    expect(requests[1]?.held?.token).toBe('token-1');
    expect(mints).toBe(1);

    surface.onAction?.('newToken', actionCtx(null));
    expect(requests[2]).toMatchObject({ fresh: true });
    expect(requests[2]?.held?.token).toBe('token-1');
    expect(mints).toBe(2);
  });

  test('a mint that throws names its reason, and a refused new token keeps the working QR', () => {
    let refuse = true;
    const surface = createPairingModalSurface({
      getConnectionInfo: () => {
        if (refuse) throw new Error('5 devices paired; revoke one in Settings to pair another.');
        return info('token-ok');
      },
    });
    const view = open(surface);
    expect(view.degraded).toContain('5 devices paired; revoke one in Settings');

    refuse = false;
    surface.onClose?.();
    surface.onOpen?.(() => {});
    expect(surface.buildView().degraded).toBeUndefined();

    refuse = true;
    const { statuses, extra } = statusRecorder();
    surface.onAction?.('newToken', actionCtx(null, extra));
    expect(statuses.at(-1)).toContain('5 devices paired');
    expect(surface.buildView().degraded).toBeUndefined();
  });
});

describe('earlier test and verify results do not outlive what they described', () => {
  test('services: a re-inspection drops the earlier HEALTHY', async () => {
    const registry = {
      getAll: () => ({ alpha: { name: 'alpha', authType: 'api-key', baseUrl: 'http://alpha' } }),
      inspect: async (name: string) => ({ config: { name, authType: 'api-key', baseUrl: `http://${name}` }, hasPrimaryCredential: true }),
      testConnection: async () => ({ ok: true, status: 200, testedUrl: null }),
    } as unknown as ServiceInspectionQuery;
    const subs = { getAccessToken: () => null, get: () => null } as unknown as SubscriptionAccessQuery;
    const surface = createServicesModalSurface(registry, subs);
    surface.onOpen?.(() => {});
    await settle();
    surface.onAction?.('test', actionCtx({ id: 'svc:alpha', label: '' }));
    await settle();
    expect(tabText(surface.buildView(), 'services')).toContain('HEALTHY');
    surface.onAction?.('refresh', actionCtx(null));
    await settle();
    const text = tabText(surface.buildView(), 'services');
    expect(text).toContain('CONFIGURED');
    expect(text).not.toContain('HEALTHY');
  });

  test('services: reopening drops the earlier HEALTHY and re-inspects', async () => {
    let inspections = 0;
    const registry = {
      getAll: () => ({ alpha: { name: 'alpha', authType: 'api-key', baseUrl: 'http://alpha' } }),
      inspect: async (name: string) => { inspections++; return { config: { name, authType: 'api-key', baseUrl: `http://${name}` }, hasPrimaryCredential: true }; },
      testConnection: async () => ({ ok: true, status: 200, testedUrl: null }),
    } as unknown as ServiceInspectionQuery;
    const subs = { getAccessToken: () => null, get: () => null } as unknown as SubscriptionAccessQuery;
    const surface = createServicesModalSurface(registry, subs);
    surface.onOpen?.(() => {});
    await settle();
    surface.onAction?.('test', actionCtx({ id: 'svc:alpha', label: '' }));
    await settle();
    expect(tabText(surface.buildView(), 'services')).toContain('HEALTHY');
    const before = inspections;
    surface.onOpen?.(() => {});
    // Before the re-inspection even finishes, the old result is gone.
    expect(tabText(surface.buildView(), 'services')).not.toContain('HEALTHY');
    await settle();
    expect(inspections).toBeGreaterThan(before);
    expect(tabText(surface.buildView(), 'services')).toContain('CONFIGURED');
  });

  test('services: an unusable services file is shown as the degraded reason, not as an empty list', async () => {
    const registry = {
      getAll: () => ({}),
      inspect: async () => null,
      unreadableReason: () => '/w/services.json is not valid JSON',
      testConnection: async () => ({ ok: false, status: null, testedUrl: null }),
    } as unknown as ServiceInspectionQuery;
    const subs = { getAccessToken: () => null, get: () => null } as unknown as SubscriptionAccessQuery;
    const surface = createServicesModalSurface(registry, subs);
    surface.onOpen?.(() => {});
    await settle();
    expect(surface.buildView().degraded).toContain('Service list unusable: /w/services.json is not valid JSON');
  });

  test('plugins: a verify result stops showing once the plugin changes state, and refresh clears it', () => {
    let plugin: PluginStatus = { name: 'formatter', version: '1.0.0', description: 'd', enabled: true, active: true, trustTier: 'trusted', quarantined: false };
    const manager: PluginsModalManager = {
      list: () => [plugin],
      capabilities: () => null,
      getTrustRecord: () => undefined,
      getQuarantineRecord: () => undefined,
      verify: () => ({ ok: true, valid: true, fingerprint: 'fp-1' }),
    };
    const surface = createPluginsModalSurface({ pluginManager: manager });
    open(surface);
    const row = { id: 'formatter', label: '' };
    surface.onAction?.('verify', actionCtx(row));
    expect(tabText(surface.buildView(), 'plugins')).toContain('verify VALID');

    plugin = { ...plugin, active: false, enabled: false };
    expect(tabText(surface.buildView(), 'plugins')).not.toContain('verify VALID');

    plugin = { ...plugin, active: true, enabled: true };
    expect(tabText(surface.buildView(), 'plugins')).toContain('verify VALID');
    surface.onAction?.('refresh', actionCtx(null));
    expect(tabText(surface.buildView(), 'plugins')).not.toContain('verify VALID');
  });
});

describe('local-auth actions do not claim an outcome the handler did not report', () => {
  test('a delete the handler refused (it prints and resolves) ends as Done, never "Deleted <user>"', async () => {
    const auth = { inspect: () => ({ userCount: 1, sessionCount: 0, bootstrapCredentialPresent: true, users: [{ username: 'alice', roles: ['admin'] }] }), addUser: () => null, deleteUser: () => false, rotatePassword: () => null, clearBootstrapCredentialFile: () => false };
    const surface = createLocalAuthModalSurface(auth as never);
    const { statuses, extra } = statusRecorder();
    const ctx = actionCtx({ id: 'user:alice', label: '' }, { ...extra, executeCommand: async () => true });
    surface.onAction?.('delete', ctx);
    await settle();
    expect(statuses.at(-1)).toBe('Done: /local-auth delete-user alice.');
    surface.onAction?.('clear-bootstrap', ctx);
    await settle();
    expect(statuses.at(-1)).toBe('Done: /local-auth clear-bootstrap-file.');
    expect(statuses.join('\n')).not.toContain('Deleted alice');
  });
});

describe('sandbox modal shows the probe result', () => {
  test('execute reports the exit status and first output line; stop names an absent session', async () => {
    const sessions = {
      list: () => [],
      execute: async () => ({ status: 0, stdout: 'sandbox modal probe ok\nsecond line', stderr: '' }),
      stop: () => null,
    } as unknown as SandboxSessionRegistry;
    const surface = createSandboxModalSurface({} as ConfigManager, sessions);
    const { statuses, extra } = statusRecorder();
    surface.onAction?.('execute', actionCtx({ id: 'session:s1', label: '' }, extra));
    expect(statuses.at(-1)).toContain('Running probe');
    await Promise.resolve(); await Promise.resolve();
    expect(statuses.at(-1)).toBe('Probe succeeded: sandbox modal probe ok');
    surface.onAction?.('stop', actionCtx({ id: 'session:s1', label: '' }, extra));
    expect(statuses.at(-1)).toContain('no longer exists');
  });

  test('a failing probe shows its exit status and stderr', async () => {
    const sessions = {
      list: () => [],
      execute: async () => ({ status: 3, stdout: '', stderr: 'boom' }),
    } as unknown as SandboxSessionRegistry;
    const surface = createSandboxModalSurface({} as ConfigManager, sessions);
    const { statuses, extra } = statusRecorder();
    surface.onAction?.('execute', actionCtx({ id: 'session:s1', label: '' }, extra));
    await Promise.resolve(); await Promise.resolve();
    expect(statuses.at(-1)).toBe('Probe failed (exit 3): boom');
  });
});
