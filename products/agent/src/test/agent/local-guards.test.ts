import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { MemoryRecord, MemoryRegistry } from '@goodvibes-jev/engine/platform/platform/state';
import { buildOperatorActionRequest } from '../../agent/operator-actions.ts';
import { createOccasionsGatewayInvoke } from '../../agent/occasions-gateway.ts';
import { rankMemoryForTurn } from '../../agent/memory-prompt.ts';
import { UNKNOWN_PRINCIPAL_LABEL, resolveChannelPrincipalAttribution } from '../../agent/principal-attribution.ts';
import { formatAgentRecordReviewState, formatAgentRecordSource } from '../../agent/record-labels.ts';
import {
  buildReminderSchedulePreview,
  createReminderSchedule,
  parseReminderScheduleArgs,
} from '../../agent/reminder-schedule.ts';
import { parseAutonomyScheduleArgs } from '../../agent/autonomy-schedule.ts';
import { parseRoutineSchedulePromotionArgs } from '../../agent/routine-schedule-args.ts';
import { OCCASIONS_METHOD_IDS } from '../../tools/agent-occasions-types.ts';
import { mockFetch } from '../helpers/typed-fetch-mock.ts';

describe('names that exist on every object are not options', () => {
  test('an operator action called "constructor" gets the list of real actions', () => {
    const result = buildOperatorActionRequest({ action: 'constructor', targetId: 'x' });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('action must be one of');
  });

  test('a record whose source or review state is "constructor" is shown as written', () => {
    expect(formatAgentRecordSource('constructor')).toBe('Constructor');
    expect(formatAgentRecordReviewState('constructor')).toBe('Constructor');
  });
});

describe('occasions gateway cancellation', () => {
  test('an abort during an in-process call is thrown, not reported as a handler failure', async () => {
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
    const controller = new AbortController();
    catalog.register(
      { id: OCCASIONS_METHOD_IDS.pending, title: 'pending', description: 'stub', category: 'test', source: 'plugin', access: 'authenticated', transport: ['internal'], scopes: [] },
      () => { controller.abort(new Error('turn cancelled')); throw new Error('handler stopped'); },
    );
    const invoke = createOccasionsGatewayInvoke({ gatewayMethods: catalog, configManager: { get: () => undefined }, homeDirectory: '/nowhere' });
    await expect(invoke(OCCASIONS_METHOD_IDS.pending, {}, { signal: controller.signal })).rejects.toThrow('turn cancelled');
  });
});

describe('per-turn memory ranking', () => {
  const record = (id: string): MemoryRecord => ({ id, confidence: 80, updatedAt: 1 }) as unknown as MemoryRecord;
  const registryWithHits = (ids: readonly string[]): MemoryRegistry => ({
    vectorStats: () => ({ enabled: true, available: true, indexedRecords: 10 }),
    searchSemantic: async () => ids.map((id) => ({ record: record(id), similarity: 0.9 })),
  }) as unknown as MemoryRegistry;

  test('hits that are all ineligible records do not make the ranking count as relevance-scored', async () => {
    const ranking = await rankMemoryForTurn(registryWithHits(['flagged']), [record('a'), record('b')], 'what did I say');
    expect(ranking.scored).toBe(false);
    expect(ranking.degradedReason).toContain('no semantic match');
    expect(ranking.relevanceById.size).toBe(0);
  });

  test('a hit on an eligible record still scores the ranking', async () => {
    const ranking = await rankMemoryForTurn(registryWithHits(['flagged', 'b']), [record('a'), record('b')], 'what did I say');
    expect(ranking.scored).toBe(true);
    expect(ranking.records[0]!.id).toBe('b');
  });
});

describe('principal lookup for display', () => {
  test('a host that never answers yields "unknown principal" once the lookup is cancelled', async () => {
    const controller = new AbortController();
    const hung = (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('lookup cancelled')));
      controller.abort();
    });
    const result = await resolveChannelPrincipalAttribution(
      { baseUrl: 'http://127.0.0.1:3421', token: 'fixture-token' } as never,
      'slack',
      'U123',
      { signal: controller.signal, fetch: hung as never },
    );
    expect(result.known).toBe(false);
    expect(result.label).toBe(UNKNOWN_PRINCIPAL_LABEL);
    expect(result.error).toBeTruthy();
  });
});

describe('principal lookup default timeout', () => {
  test('the lookup carries its own live abort signal when the caller supplies none', async () => {
    let seen: AbortSignal | null | undefined;
    const stub = (_input: unknown, init?: RequestInit) => {
      seen = init?.signal;
      return Promise.reject(new Error('stub host unreachable'));
    };
    const result = await resolveChannelPrincipalAttribution(
      { baseUrl: 'http://127.0.0.1:3421', token: 'fixture-token' } as never,
      'slack',
      'U123',
      { fetch: stub as never },
    );
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
    expect(result.known).toBe(false);
    expect(result.label).toBe(UNKNOWN_PRINCIPAL_LABEL);
  });
});

describe('--timezone with a schedule kind that has no zone', () => {
  for (const [name, parse] of [
    ['reminder', (args: readonly string[]) => parseReminderScheduleArgs(['Water the plants', ...args])],
    ['routine promotion', (args: readonly string[]) => parseRoutineSchedulePromotionArgs(['daily-review', ...args])],
    ['autonomy', (args: readonly string[]) => parseAutonomyScheduleArgs(['--task', 'Check', '--success-criteria', 'Reported', '--explicit-user-request', 'ok', ...args])],
  ] as const) {
    test(`${name}: --at and --every with --timezone are errors, --cron is accepted`, () => {
      expect(parse(['--at', '2026-12-01T09:00', '--timezone', 'America/New_York']).errors.join(' ')).toContain('--timezone only applies to --cron');
      expect(parse(['--every', '1h', '--timezone', 'America/New_York']).errors.join(' ')).toContain('--timezone only applies to --cron');
      expect(parse(['--cron', '0 9 * * *', '--timezone', 'America/New_York']).errors).toEqual([]);
    });
  }
});

describe('creating a reminder schedule on the connected host', () => {
  let originalFetch: typeof fetch;
  let creates: number;
  let existing: unknown[];
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    creates = 0;
    existing = [];
    globalThis.fetch = mockFetch(async (_input, init) => {
      if ((init?.method ?? 'GET') === 'GET') return Response.json({ jobs: existing, runs: [] });
      creates += 1;
      return Response.json(hostJob('created', { kind: 'cron', expression: '0 21 * * *' }));
    });
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  /** A schedule record complete enough for the host's own list contract. */
  const hostJob = (name: string | undefined, schedule: Record<string, unknown>) => ({
    id: 'sched-1', mutationRevision: 'r1', name, labels: [], createdAt: 1, updatedAt: 1, status: 'enabled', enabled: true, schedule,
    execution: { target: { kind: 'main' } },
    delivery: { mode: 'none', targets: [], fallbackTargets: [], includeSummary: true, includeTranscript: false, includeLinks: true },
    failure: { action: 'retry', maxConsecutiveFailures: 3, cooldownMs: 1, retryPolicy: { maxAttempts: 1, delayMs: 1, strategy: 'fixed' } },
    source: { id: 's', kind: 'manual', label: 'manual', enabled: true, createdAt: 1, updatedAt: 1, metadata: {} },
    runCount: 0, successCount: 0, failureCount: 0, deleteAfterRun: false,
  });
  const connection = { baseUrl: 'http://127.0.0.1:3421', token: 'fixture-token', tokenPath: '/fixture/tokens.json' };
  const preview = () => buildReminderSchedulePreview(parseReminderScheduleArgs([
    'Take the pills', '--cron', '0 9 * * *', '--timezone', 'America/New_York', '--yes',
  ]));

  test('a schedule the host already holds is returned, not created a second time', async () => {
    const request = preview();
    existing = [hostJob(request.payload.name, { kind: 'cron', expression: '0 9 * * *', timezone: 'America/New_York' })];
    const result = await createReminderSchedule(connection, request);
    expect(result.ok).toBe(true);
    expect(result.ok && result.alreadyExisted).toBe(true);
    expect(creates).toBe(0);
  });

  test('an interval reminder the host already holds is returned, not created again', async () => {
    const request = buildReminderSchedulePreview(parseReminderScheduleArgs(['Stretch', '--every', '30m', '--yes']));
    existing = [hostJob(request.payload.name, { kind: 'every', intervalMs: 30 * 60_000 })];
    const result = await createReminderSchedule(connection, request);
    expect(result.ok && result.alreadyExisted).toBe(true);
    expect(creates).toBe(0);
  });

  test('the same name at another interval is a different reminder and is created', async () => {
    const request = buildReminderSchedulePreview(parseReminderScheduleArgs(['Stretch', '--every', '30m', '--yes']));
    existing = [hostJob(request.payload.name, { kind: 'every', intervalMs: 60 * 60_000 })];
    const result = await createReminderSchedule(connection, request);
    expect(result.ok && result.alreadyExisted).toBeFalsy();
    expect(creates).toBe(1);
  });

  test('a cron reminder with no --timezone matches the host copy stored under the host zone', async () => {
    const request = buildReminderSchedulePreview(parseReminderScheduleArgs(['Take the pills', '--cron', '0 9 * * *', '--yes']));
    existing = [hostJob(request.payload.name, { kind: 'cron', expression: '0 9 * * *', timezone: 'Europe/Berlin' })];
    const result = await createReminderSchedule(connection, request);
    expect(result.ok && result.alreadyExisted).toBe(true);
    expect(creates).toBe(0);
  });

  test('the same name at another time is a different reminder and is created', async () => {
    const request = preview();
    existing = [hostJob(request.payload.name, { kind: 'cron', expression: '0 21 * * *', timezone: 'America/New_York' })];
    const result = await createReminderSchedule(connection, request);
    expect(result.ok && result.alreadyExisted).toBeFalsy();
    expect(creates).toBe(1);
  });
});
