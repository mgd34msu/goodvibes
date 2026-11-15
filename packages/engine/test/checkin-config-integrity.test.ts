import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createProviderBackedCheckinJudge } from '../platform/src/platform/checkin/judge.js';
import { CheckinConfigError, CheckinService } from '../platform/src/platform/checkin/service.js';
import { CheckinReceiptStore } from '../platform/src/platform/checkin/receipts.js';
import type { CheckinReceipt } from '../platform/src/platform/checkin/types.js';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';
import { CHECKIN_CONFIG_SET_OUTPUT_SCHEMA } from '../platform/src/platform/control-plane/method-catalog-checkin.js';
import { registerCheckinGatewayMethods } from '../platform/src/platform/control-plane/routes/checkin.js';
import { firstJsonSchemaFailure } from '../transport-http/src/index.js';
import type { ProviderRegistry } from '../platform/src/platform/providers/registry.js';

function receipt(id: string, ranAt: number): CheckinReceipt {
  return { id, ranAt, trigger: 'manual', outcome: 'quiet', briefingSummary: 'x' };
}

function makeService(initial: Record<string, string | boolean>, automation?: ConstructorParameters<typeof CheckinService>[0]['automation'], judge?: ConstructorParameters<typeof CheckinService>[0]['judge']) {
  const values = new Map<string, unknown>(Object.entries(initial));
  const receipts = new CheckinReceiptStore(':memory:');
  const service = new CheckinService({
    config: { get: (k) => values.get(k), set: (k, v) => { values.set(k, v); } },
    stateReader: { snapshot: async () => ({ runningSessions: 0, blockedSessions: 0, unreadChannelItems: 0, recentCompletions: 0, needsAttention: [] }) },
    judge: judge ?? { decide: async () => ({ contact: false, reason: 'quiet' }) },
    deliverer: { deliver: async () => undefined },
    receipts,
    automation,
  });
  return { service, values, receipts };
}

const BASE = { 'checkin.enabled': false, 'checkin.cadence': '0 */4 * * *', 'checkin.deliveryChannel': 'slack:C1', 'checkin.quietHours': '' };

describe('check-in receipt store', () => {
  test('two appends started before the first load finishes both survive', async () => {
    const store = new CheckinReceiptStore(':memory:');
    await Promise.all([store.append(receipt('a', 1)), store.append(receipt('b', 2))]);
    expect((await store.list()).map((r) => r.id).sort()).toEqual(['a', 'b']);
  });
});

describe('check-in config validation', () => {
  test('an unparseable quiet-hours window is refused with its field and nothing is stored', async () => {
    const { service, values } = makeService(BASE);
    const error = await service.setConfig({ quietHours: '10pm-8am' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CheckinConfigError);
    expect((error as CheckinConfigError).field).toBe('quietHours');
    expect((error as CheckinConfigError).status).toBe(400);
    expect(values.get('checkin.quietHours')).toBe('');
  });

  test('an invalid cron cadence is refused', async () => {
    const { service } = makeService(BASE);
    const error = await service.setConfig({ cadence: 'every day' }).catch((e: unknown) => e);
    expect((error as CheckinConfigError).field).toBe('cadence');
  });

  test('enabling without a delivery channel is refused, disabling a half-configured install still works', async () => {
    const { service } = makeService({ ...BASE, 'checkin.deliveryChannel': '' });
    const error = await service.setConfig({ enabled: true }).catch((e: unknown) => e);
    expect((error as CheckinConfigError).field).toBe('deliveryChannel');
    expect((await service.setConfig({ enabled: false })).enabled).toBe(false);
  });

  test('a failing scheduler is reported instead of looking installed', async () => {
    const automation = {
      listJobs: () => [], createJob: async () => { throw new Error('automation is disabled'); },
      updateJob: async () => { throw new Error('unused'); }, setEnabled: async () => { throw new Error('unused'); },
      attachCheckinEvaluator: () => {},
    } as unknown as NonNullable<ConstructorParameters<typeof CheckinService>[0]['automation']>;
    const { service } = makeService(BASE, automation);
    const config = await service.setConfig({ enabled: true });
    expect(config.enabled).toBe(true);
    expect(service.scheduleStatus().state).toBe('failed');
    expect(service.scheduleStatus().reason).toContain('automation is disabled');
  });

  test('concurrent syncs create one job', async () => {
    const jobs: Array<{ id: string; kind: string }> = [];
    const automation = {
      listJobs: () => jobs,
      createJob: async () => { await Promise.resolve(); jobs.push({ id: `j${jobs.length}`, kind: 'checkin' }); },
      updateJob: async () => {}, setEnabled: async () => {}, attachCheckinEvaluator: () => {},
    } as unknown as NonNullable<ConstructorParameters<typeof CheckinService>[0]['automation']>;
    const { service } = makeService({ ...BASE, 'checkin.enabled': true }, automation);
    await Promise.all([service.syncScheduledJob(), service.syncScheduledJob()]);
    expect(jobs).toHaveLength(1);
  });
});

describe('check-in config edits made outside setConfig', () => {
  test('an external change to a check-in key syncs the scheduler once attached and stops after dispose', async () => {
    const jobs: Array<{ id: string; kind: string; enabled?: boolean }> = [];
    const automation = {
      listJobs: () => jobs,
      createJob: async () => { jobs.push({ id: 'j0', kind: 'checkin' }); },
      updateJob: async (_id: string, patch: { enabled: boolean }) => { jobs[0]!.enabled = patch.enabled; },
      setEnabled: async () => {}, attachCheckinEvaluator: () => {},
    } as unknown as NonNullable<ConstructorParameters<typeof CheckinService>[0]['automation']>;
    const values = new Map<string, unknown>(Object.entries(BASE));
    const listeners = new Map<string, Set<() => void>>();
    const service = new CheckinService({
      config: {
        get: (k) => values.get(k), set: (k, v) => { values.set(k, v); },
        subscribe: (key, listener) => { (listeners.get(key) ?? listeners.set(key, new Set()).get(key)!).add(listener); return () => listeners.get(key)!.delete(listener); },
      },
      stateReader: { snapshot: async () => ({ runningSessions: 0, blockedSessions: 0, unreadChannelItems: 0, recentCompletions: 0, needsAttention: [] }) },
      judge: { decide: async () => ({ contact: false, reason: 'quiet' }) },
      deliverer: { deliver: async () => undefined },
      receipts: new CheckinReceiptStore(':memory:'),
      automation,
    });
    await service.attach();
    expect(jobs).toHaveLength(0);
    values.set('checkin.enabled', true);
    expect(listeners.has('checkin.enabled')).toBe(true);
    expect([...listeners.values()].every((set) => set.size === 1)).toBe(true);
    for (const listener of listeners.get('checkin.enabled') ?? []) listener();
    // Only the subscription may install the job: the test never calls syncScheduledJob itself.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(jobs).toHaveLength(1);
    service.dispose();
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
  });
});

describe('check-in single flight', () => {
  test('an overlapping run does not judge or deliver a second time and says why', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let decisions = 0;
    const { service, receipts } = makeService({ ...BASE, 'checkin.enabled': true }, undefined, {
      decide: async () => { decisions++; entered.resolve(); await release.promise; return { contact: false, reason: 'quiet' }; },
    });
    const first = service.evaluate('scheduled');
    await entered.promise;
    const second = await service.evaluate('manual');
    expect(second.outcome).toBe('skipped');
    expect(second.summary).toContain('already in progress');
    release.resolve();
    await first;
    expect(decisions).toBe(1);
    expect((await receipts.list()).map((r) => r.outcome).sort()).toEqual(['cancelled', 'quiet']);
  });
});

describe('check-in content generation bound', () => {
  let previous: JudgmentPort | undefined;
  let log: SqliteDecisionLog;
  beforeEach(() => { previous = installJudgmentPort(undefined); log = new SqliteDecisionLog(':memory:'); });
  afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); });

  test('a provider that never answers makes decide reject after the timeout', async () => {
    const fake = fakePort((name, question) => name === 'contact' ? noulAnswer(0.99) : choiceAnswer(question, 'supports', 0.99));
    installJudgmentPort(withDecisionLog(fake.port, log));
    const registry = {
      getCurrentModel: () => ({ id: 'm', registryKey: 'm', provider: 'p' }),
      getForModel: () => ({ chat: () => new Promise(() => {}) }),
    } as unknown as Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel'>;
    const judge = createProviderBackedCheckinJudge(registry, { timeoutMs: 1 });
    await expect(judge.decide('briefing')).rejects.toThrow('timed out');
  });
});

describe('check-in config.set reports the scheduler', () => {
  test('enabling while the scheduler refuses answers with the config and a failed schedule that names why', async () => {
    const automation = {
      listJobs: () => [], createJob: async () => { throw new Error('automation is disabled'); },
      updateJob: async () => {}, setEnabled: async () => {}, attachCheckinEvaluator: () => {},
    } as unknown as NonNullable<ConstructorParameters<typeof CheckinService>[0]['automation']>;
    const { service } = makeService(BASE, automation);
    const catalog = new GatewayMethodCatalog();
    registerCheckinGatewayMethods(catalog, service);
    const result = await catalog.invoke('checkin.config.set', { context: { admin: true }, body: { enabled: true } }) as { config: { enabled: boolean }; schedule: { state: string; reason?: string } };
    expect(result.config.enabled).toBe(true);
    expect(result.schedule.state).toBe('failed');
    expect(result.schedule.reason).toContain('automation is disabled');
    expect(firstJsonSchemaFailure(CHECKIN_CONFIG_SET_OUTPUT_SCHEMA, result)).toBeUndefined();
  });

  test('turning the automation subsystem on later installs the job that could not be created', async () => {
    const jobs: Array<{ id: string; kind: string }> = [];
    let automationOn = false;
    const automation = {
      listJobs: () => jobs,
      createJob: async () => { if (!automationOn) throw new Error('automation is disabled'); jobs.push({ id: 'j0', kind: 'checkin' }); },
      updateJob: async () => {}, setEnabled: async () => {}, attachCheckinEvaluator: () => {},
    } as unknown as NonNullable<ConstructorParameters<typeof CheckinService>[0]['automation']>;
    const values = new Map<string, unknown>(Object.entries({ ...BASE, 'checkin.enabled': true }));
    const listeners = new Map<string, () => void>();
    const service = new CheckinService({
      config: { get: (k) => values.get(k), set: (k, v) => { values.set(k, v); }, subscribe: (key, listener) => { listeners.set(key, listener); return () => listeners.delete(key); } },
      stateReader: { snapshot: async () => ({ runningSessions: 0, blockedSessions: 0, unreadChannelItems: 0, recentCompletions: 0, needsAttention: [] }) },
      judge: { decide: async () => ({ contact: false, reason: 'quiet' }) },
      deliverer: { deliver: async () => undefined },
      receipts: new CheckinReceiptStore(':memory:'),
      automation,
    });
    await service.attach();
    expect(service.scheduleStatus().state).toBe('failed');
    automationOn = true;
    listeners.get('automation.enabled')!();
    expect((await service.syncScheduledJob()).state).toBe('scheduled');
    expect(jobs).toHaveLength(1);
    service.dispose();
  });
});
