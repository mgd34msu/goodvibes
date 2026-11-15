/**
 * Control-plane route handlers refuse what is the caller's mistake with a
 * caller-error status, report partial outcomes as partial, and do not leave
 * state behind for a request that never started.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import type { GatewayMethodInvocation } from '../platform/src/platform/control-plane/method-catalog-shared.ts';
import { GatewayVerbError } from '../platform/src/platform/control-plane/routes/gateway-verb-error.ts';
import { registerTailscaleGatewayMethods } from '../platform/src/platform/control-plane/routes/tailscale.ts';
import { TailscaleServeReceiptStore, type TailscaleCommandRunner } from '../platform/src/platform/remote-access/tailscale.ts';
import {
  createVoiceInstallHandler,
  createWakeModelHandler,
  type VoiceSetupGatewayService,
} from '../platform/src/platform/control-plane/routes/voice-setup.ts';
import { registerWorkspacesGatewayMethods, type WorkspacesGatewayService } from '../platform/src/platform/control-plane/routes/workspaces.ts';
import { WorkspaceRegistrationError } from '../platform/src/platform/workspace/registration/index.ts';
import { createPaymentsCardsCreateHandler, type PaymentsGatewayService } from '../platform/src/platform/control-plane/routes/payments.ts';
import { resolveFailureThreshold } from '../platform/src/platform/control-plane/routes/push-composition.ts';
import { registerRewindConversationHostGatewayMethods, createConversationRewindHostBroker } from '../platform/src/platform/control-plane/routes/rewind-conversation-hosts.ts';
import { createResolutionRunTracker, startCiFixSession, startConflictResolutionSession } from '../platform/src/platform/control-plane/routes/seeded-sessions.ts';
import { registerStepUpGatewayMethods } from '../platform/src/platform/control-plane/routes/stepup.ts';
import { registerUpdateGatewayMethods } from '../platform/src/platform/control-plane/routes/update.ts';
import { registerRelayGatewayMethods } from '../platform/src/platform/control-plane/routes/relay.ts';
import type { AutomationManager } from '../platform/src/platform/automation/index.ts';

async function refusal(run: () => unknown): Promise<GatewayVerbError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayVerbError);
    return error as GatewayVerbError;
  }
  throw new Error('expected a refusal');
}

describe('tailscale.serve.run', () => {
  test('a receipt store that cannot write does not turn an active serve into an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-receipt-'));
    try {
      const runner: TailscaleCommandRunner = {
        run(_command, args) {
          if (args[0] === 'status') return { status: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.tail.ts.net.' } }), stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        },
      };
      const receipts = new TailscaleServeReceiptStore(join(dir, 'receipts.json'));
      receipts.append = () => { throw new Error('read-only file system'); };
      const urls: string[] = [];
      const catalog = new GatewayMethodCatalog();
      registerTailscaleGatewayMethods(catalog, { runner, receipts, resolveWebPort: () => 3423, setPublicBaseUrl: (url) => { urls.push(url); } });
      const result = await catalog.invoke('tailscale.serve.run', { context: { principalId: 'p', admin: true }, body: {} }) as {
        receipt: { ok: boolean }; publicBaseUrlUpdated: boolean; receiptRecorded?: boolean;
      };
      expect(result.receipt.ok).toBe(true);
      expect(result.publicBaseUrlUpdated).toBe(true);
      expect(result.receiptRecorded).toBe(false);
      expect(urls).toEqual(['https://box.tail.ts.net']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('tailscale verbs never block the daemon', () => {
  test('tailscale.get and tailscale.serve.run run their commands through the asynchronous runner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-async-'));
    try {
      const runner: TailscaleCommandRunner = {
        run() { throw new Error('the blocking runner must not be used by a request handler'); },
        async runAsync(_command, args) {
          if (args[0] === 'status') return { status: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.tail.ts.net.' } }), stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        },
      };
      const catalog = new GatewayMethodCatalog();
      registerTailscaleGatewayMethods(catalog, { runner, receipts: new TailscaleServeReceiptStore(join(dir, 'receipts.json')), resolveWebPort: () => 3424, setPublicBaseUrl: () => {} });
      const context = { principalId: 'p', admin: true };
      const detected = await catalog.invoke('tailscale.get', { context, body: {} }) as { running?: boolean; state?: string };
      expect(JSON.stringify(detected)).toContain('box.tail.ts.net');
      const served = await catalog.invoke('tailscale.serve.run', { context, body: {} }) as { receipt: { ok: boolean } };
      expect(served.receipt.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('voice setup refusals carry caller-error statuses', () => {
  const service: VoiceSetupGatewayService = {
    status: () => ({}) as never,
    install: async (options) => { options?.assertCurrent?.(); return {} as never; },
    wakeStatus: () => ({}),
    wakeProvision: async () => ({}),
    wakeModelChunk: () => ({}) as never,
  };
  const query = (values: Record<string, unknown>) => ({ query: values, body: undefined, context: {} }) as unknown as GatewayMethodInvocation;

  test('an unknown wake component is a 400 naming the field', async () => {
    const error = await refusal(() => createWakeModelHandler(service)(query({ component: 'foo' })));
    expect(error.status).toBe(400);
    expect(error.field).toBe('component');
  });

  test('a malformed offset is a 400 naming the field', async () => {
    const error = await refusal(() => createWakeModelHandler(service)(query({ component: 'classifier', offset: 'abc' })));
    expect(error.status).toBe(400);
    expect(error.field).toBe('offset');
  });

  test('an install whose write authority was revoked mid-run is a 403', async () => {
    const invocation = { signal: undefined, isAuthorized: () => false, context: {}, body: {} } as unknown as GatewayMethodInvocation;
    const error = await refusal(() => createVoiceInstallHandler(service)(invocation));
    expect(error.status).toBe(403);
  });
});

describe('workspaces.registrations.remove and workspaces.resolve', () => {
  test('a registration refusal is a 400, not an internal error', async () => {
    const service: WorkspacesGatewayService = {
      snapshot: async () => ({ workspaces: [], declines: [] }) as never,
      add: async () => { throw new Error('unused'); },
      remove: async () => { throw new WorkspaceRegistrationError('root must be absolute'); },
      resolve: async () => { throw new WorkspaceRegistrationError('path must be absolute'); },
    };
    const catalog = new GatewayMethodCatalog();
    registerWorkspacesGatewayMethods(catalog, service);
    const ctx = { context: { admin: true } } as const;
    expect((await refusal(() => catalog.invoke('workspaces.registrations.remove', { ...ctx, body: { root: 'x' } }))).status).toBe(400);
    expect((await refusal(() => catalog.invoke('workspaces.resolve', { ...ctx, body: { path: 'x' } }))).status).toBe(400);
  });
});

describe('payments.cards.create field validation', () => {
  const service: PaymentsGatewayService = {
    budgetStatus: async () => { throw new Error('unused'); },
    listCards: async () => ({ cards: [], defaultCardId: '' }),
    createCard: async () => { throw new Error('must not store'); },
    deleteCard: async () => ({ deleted: false, secretsCleared: 0 }),
    listPurchases: async () => ({ purchases: [], total: 0 }),
    beginCheckout: async () => { throw new Error('unused'); },
    fillCardIntoCheckout: async () => { throw new Error('unused'); },
  };
  const card = { label: 'shopping', kind: 'virtual', number: '4242424242424242', expiryMonth: 12, expiryYear: 2034, cvv: '123', cardholderName: 'A Person' };
  const create = (body: Record<string, unknown>) => createPaymentsCardsCreateHandler(service)({ body, context: {} } as unknown as GatewayMethodInvocation);

  test('a cap that is not a non-negative whole number is a 400, never silently dropped', async () => {
    for (const cap of ['5000', -1, 1.5, Number.NaN]) {
      const error = await refusal(() => create({ ...card, issuerCapMinorUnits: cap }));
      expect(error.status).toBe(400);
      expect(error.field).toBe('issuerCapMinorUnits');
    }
  });

  test('an expiry month outside 1-12 and a two-digit year are 400s', async () => {
    expect((await refusal(() => create({ ...card, expiryMonth: 13 }))).field).toBe('expiryMonth');
    expect((await refusal(() => create({ ...card, expiryYear: 29 }))).field).toBe('expiryYear');
  });
});

describe('push failure threshold', () => {
  const depsWith = (value: unknown) => ({ configManager: { get: () => value } }) as unknown as Parameters<typeof resolveFailureThreshold>[0];

  test('a hand-edited zero or negative bound falls back to the default instead of pruning every subscription', () => {
    expect(resolveFailureThreshold(depsWith(0))).toBeGreaterThanOrEqual(1);
    expect(resolveFailureThreshold(depsWith(-3))).toBeGreaterThanOrEqual(1);
    expect(resolveFailureThreshold(depsWith(0))).toBe(resolveFailureThreshold(depsWith(undefined)));
  });

  test('a sane bound is used as configured, whole', () => {
    expect(resolveFailureThreshold(depsWith(7.9))).toBe(7);
  });
});

describe('rewind conversation hosts belong to the principal that registered them', () => {
  function harness() {
    const broker = createConversationRewindHostBroker();
    const catalog = new GatewayMethodCatalog();
    registerRewindConversationHostGatewayMethods(catalog, broker);
    const as = (principalId: string) => ({ context: { principalId, principalKind: 'user', admin: true } }) as const;
    return { catalog, as };
  }

  test('another principal cannot take over a session by registering without a hostId', async () => {
    const { catalog, as } = harness();
    const first = await catalog.invoke('rewind.conversation.host.register', { ...as('alice'), body: { sessionId: 's1', label: 'terminal' } }) as { host: { hostId: string } };
    const error = await refusal(() => catalog.invoke('rewind.conversation.host.register', { ...as('mallory'), body: { sessionId: 's1' } }));
    expect(error.status).toBe(403);
    const listed = await catalog.invoke('rewind.conversation.hosts.list', { ...as('alice'), body: {} }) as { hosts: Array<{ hostId: string }> };
    expect(listed.hosts.map((host) => host.hostId)).toEqual([first.host.hostId]);
  });

  test('another principal cannot poll, answer for or release a host', async () => {
    const { catalog, as } = harness();
    const first = await catalog.invoke('rewind.conversation.host.register', { ...as('alice'), body: { sessionId: 's1' } }) as { host: { hostId: string } };
    const hostId = first.host.hostId;
    expect((await refusal(() => catalog.invoke('rewind.conversation.requests.take', { ...as('mallory'), body: { hostId } }))).status).toBe(403);
    expect((await refusal(() => catalog.invoke('rewind.conversation.requests.answer', { ...as('mallory'), body: { hostId, requestId: 'r' } }))).status).toBe(403);
    expect((await refusal(() => catalog.invoke('rewind.conversation.host.release', { ...as('mallory'), body: { sessionId: 's1', hostId } }))).status).toBe(403);
    const renewed = await catalog.invoke('rewind.conversation.host.register', { ...as('alice'), body: { sessionId: 's1', hostId } }) as { renewed: boolean };
    expect(renewed.renewed).toBe(true);
  });
});

describe('seeded sessions that fail to start leave nothing behind', () => {
  function automationStub(runNow: () => Promise<{ id: string; status: string; sessionId?: string }>) {
    const jobs = new Map<string, string>();
    const order: string[] = [];
    let counter = 0;
    const automation = {
      createJob: async () => { counter += 1; const id = `job-${counter}`; jobs.set(id, id); order.push(`create:${id}`); return { id }; },
      runNow: async (id: string) => { order.push(`run:${id}`); return runNow(); },
      removeJob: async (id: string) => { order.push(`remove:${id}`); return jobs.delete(id); },
    } as unknown as Pick<AutomationManager, 'createJob' | 'runNow' | 'removeJob'>;
    return { automation, jobs, order };
  }

  test('a CI fix run that is refused removes its job', async () => {
    const { automation, jobs } = automationStub(async () => { throw new Error('automation concurrency ceiling reached'); });
    const outcome = await startCiFixSession(automation, { repo: 'o/r', ref: 'main', failingJobs: ['build'], logs: '' });
    expect(outcome).toEqual({ error: expect.stringContaining('concurrency ceiling') });
    expect(jobs.size).toBe(0);
  });

  test('a conflict resolution run is tracked from job creation and removed when refused', async () => {
    const { automation, jobs, order } = automationStub(async () => { throw new Error('automation is disabled'); });
    const tracked: string[] = [];
    const outcome = await startConflictResolutionSession(automation, {
      workstreamId: 'w', itemId: 'i', title: 'merge', worktreePath: '/wt', branch: 'b', files: ['a.ts'],
    }, (jobId) => { order.push(`track:${jobId}`); tracked.push(jobId); });
    expect('error' in outcome).toBe(true);
    expect(tracked).toEqual(['job-1']);
    expect(order).toEqual(['create:job-1', 'track:job-1', 'run:job-1', 'remove:job-1']);
    expect(jobs.size).toBe(0);
  });
});

describe('resolution runs in flight', () => {
  test('a session is live from its start until its run completes, and completion names the item', () => {
    const runs = createResolutionRunTracker();
    runs.begin('job-1', 'item-1');
    expect(runs.isSessionLive('sess-1')).toBe(false);
    runs.started('job-1', 'sess-1');
    expect(runs.isSessionLive('sess-1')).toBe(true);
    expect(runs.complete('job-1')).toBe('item-1');
    expect(runs.isSessionLive('sess-1')).toBe(false);
    expect(runs.complete('job-1')).toBeUndefined();
  });

  test('a run that completed before its session was known is never recorded as live', () => {
    const runs = createResolutionRunTracker();
    runs.begin('job-1', 'item-1');
    runs.complete('job-1');
    runs.started('job-1', 'sess-1');
    expect(runs.isSessionLive('sess-1')).toBe(false);
  });

  test('a start that failed leaves nothing live', () => {
    const runs = createResolutionRunTracker();
    runs.begin('job-1', 'item-1');
    runs.abandon('job-1');
    runs.started('job-1', 'sess-1');
    expect(runs.isSessionLive('sess-1')).toBe(false);
  });
});

describe('step-up credential registration', () => {
  const service = {
    registerCredential: async () => ({ credentialId: 'c' }) as never,
    mintChallenge: (() => ({})) as never,
    listCredentials: async () => [{ credentialId: 'c', createdAt: 1, signCount: 0 }],
    removeCredential: async (id: string) => id === 'c',
  };
  const body = { rpId: 'example.com', credentialId: 'c', publicKeyCose: 'k' };

  test('a missing origin is a 400 naming the field before the service is reached', async () => {
    const catalog = new GatewayMethodCatalog();
    registerStepUpGatewayMethods(catalog, { ...service, registerCredential: async () => { throw new Error('must not be reached'); } });
    const error = await refusal(() => catalog.invoke('stepup.credentials.register', { context: { admin: true }, body }));
    expect(error.status).toBe(400);
    expect(error.field).toBe('origin');
  });

  test('a complete registration reaches the service and returns its credential', async () => {
    const catalog = new GatewayMethodCatalog();
    registerStepUpGatewayMethods(catalog, service);
    const result = await catalog.invoke('stepup.credentials.register', { context: { admin: true }, body: { ...body, origin: 'https://example.com' } }) as { credential: { credentialId: string } };
    expect(result.credential.credentialId).toBe('c');
  });

  test('the registered credentials are listed and one is removed by id', async () => {
    const catalog = new GatewayMethodCatalog();
    registerStepUpGatewayMethods(catalog, service);
    const listed = await catalog.invoke('stepup.credentials.list', { context: { admin: true } }) as { credentials: { credentialId: string }[] };
    expect(listed.credentials.map((c) => c.credentialId)).toEqual(['c']);
    expect(await catalog.invoke('stepup.credentials.remove', { context: { admin: true }, body: { credentialId: 'c' } })).toEqual({ credentialId: 'c', removed: true });
  });

  test('a minted challenge is bound to the session, rendezvous, method and path the caller names', async () => {
    const catalog = new GatewayMethodCatalog();
    const minted: unknown[] = [];
    registerStepUpGatewayMethods(catalog, { ...service, mintChallenge: ((input: unknown) => { minted.push(input); return { challengeId: 'i', challenge: 'c', expiresAt: 1 }; }) as never });
    await catalog.invoke('stepup.challenge.mint', { context: { admin: true }, body: { sessionId: 's-1', rendezvousId: 'r-1', method: 'delete', path: '/api/sessions/s-1', ttlMs: 30000 } });
    expect(minted).toEqual([{ sessionId: 's-1', rendezvousId: 'r-1', method: 'delete', path: '/api/sessions/s-1', ttlMs: 30000 }]);
  });

  test('removing an unknown credential is a 404 naming the field', async () => {
    const catalog = new GatewayMethodCatalog();
    registerStepUpGatewayMethods(catalog, service);
    const error = await refusal(() => catalog.invoke('stepup.credentials.remove', { context: { admin: true }, body: { credentialId: 'nope' } }));
    expect(error.status).toBe(404);
    expect(error.field).toBe('credentialId');
  });
});

describe('update and relay verbs', () => {
  test('update.check asks the lifecycle to check now and returns its answer', async () => {
    const catalog = new GatewayMethodCatalog();
    let checks = 0;
    registerUpdateGatewayMethods(catalog, {
      updateStatus: () => ({ state: 'idle' }) as never,
      checkForUpdatesNow: async () => { checks += 1; return { checked: true } as never; },
    });
    expect(await catalog.invoke('update.check', { context: { admin: true }, body: {} })).toEqual({ checked: true });
    expect(checks).toBe(1);
  });

  test('relay.pairing.mint with no relay controller reports disabled instead of failing', async () => {
    const catalog = new GatewayMethodCatalog();
    registerRelayGatewayMethods(catalog, () => null);
    expect(await catalog.invoke('relay.pairing.mint', { context: { admin: true }, body: {} })).toEqual({ pairing: null, status: 'disabled' });
  });
});
