import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { routineScheduleReceiptStorePath } from '../../agent/routine-schedule-receipts.ts';
import { handleRoutinesCommand } from '../../cli/routines-command.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { mockFetch } from '../helpers/typed-fetch-mock.ts';

const SCHEDULE_NAME = 'Agent routine: Daily Operations Sweep';
const roots: string[] = [];

function liveSchedule() {
  return {
    id: 'sched-created-earlier',
    mutationRevision: '33333333-3333-4333-8333-333333333333',
    name: SCHEDULE_NAME,
    labels: [],
    createdAt: 1,
    updatedAt: 1,
    status: 'enabled',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 8 * * *' },
    execution: { prompt: 'routine prompt', target: { kind: 'main' } },
    delivery: { mode: 'none', targets: [], fallbackTargets: [], includeSummary: true, includeTranscript: false, includeLinks: true },
    failure: { action: 'retry', maxConsecutiveFailures: 3, cooldownMs: 3600000, retryPolicy: { maxAttempts: 2, delayMs: 60000, strategy: 'exponential' } },
    source: { id: 'source-sched-created-earlier', kind: 'schedule', label: 'schedule', enabled: true, createdAt: 1, updatedAt: 1, metadata: {} },
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    deleteAfterRun: false,
  };
}


function setup(failureKind: string) {
  const root = makeProjectTempDir('gv-agent-routines-retry');
  roots.push(root);
  const workingDirectory = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(join(homeDirectory, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(join(homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'routine-cli-token' }));
  const configManager = new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, workingDir: workingDirectory, homeDir: homeDirectory });
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  AgentRoutineRegistry.fromShellPaths(shellPaths).create({
    name: 'Daily Operations Sweep',
    description: 'Review operations posture.',
    steps: 'Inspect connected-host status.',
    enabled: true,
    tags: ['ops'],
    triggers: ['daily'],
    source: 'user',
    provenance: 'test',
  });
  // Promotion to a recurring schedule requires a reviewed routine.
  AgentRoutineRegistry.fromShellPaths(shellPaths).markReviewed('daily-operations-sweep');
  // An earlier promotion whose outcome the host never confirmed.
  const receiptPath = routineScheduleReceiptStorePath(shellPaths);
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify({
    version: 1,
    receipts: [{
      id: 'earlier-attempt',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      routineId: 'daily-operations-sweep',
      routineName: 'Daily Operations Sweep',
      route: '/api/automation/schedules',
      method: 'automation.schedules.create',
      status: 'failed',
      connectedHostBaseUrl: 'http://127.0.0.1:3421',
      scheduleName: SCHEDULE_NAME,
      scheduleKind: 'cron',
      scheduleValue: '0 8 * * *',
      enabled: true,
      target: { kind: 'main', surfaceKind: 'service' },
      failureKind,
      failureError: 'request timed out',
    }],
  })}\n`);
  return {
    cli: parseGoodVibesCli(['routines', 'promote', 'daily-operations-sweep', '--cron', '0 8 * * *', '--yes', '--json']),
    configManager,
    workingDirectory,
    homeDirectory,
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('routines promote after an attempt with an unknown outcome', () => {
  test('does not create a second schedule when the host already holds the first', async () => {
    const methods: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (_input, init) => {
      methods.push(init?.method ?? 'GET');
      return Response.json({ jobs: [liveSchedule()], runs: [] });
    });
    try {
      const result = await handleRoutinesCommand(setup('connected_host_unavailable'));
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.output)).toMatchObject({ ok: false, kind: 'schedule_already_exists' });
      expect(result.output).toContain('sched-created-earlier');
      expect(methods).not.toContain('POST');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('refuses to retry while the host cannot say whether the first attempt landed', async () => {
    const methods: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (_input, init) => {
      methods.push(init?.method ?? 'GET');
      throw new Error('connect ECONNREFUSED');
    });
    try {
      const result = await handleRoutinesCommand(setup('connected_host_error'));
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.output)).toMatchObject({ ok: false, kind: 'earlier_attempt_unverified' });
      expect(methods).not.toContain('POST');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('creates the schedule when the host does not hold one from the first attempt', async () => {
    const methods: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (_input, init) => {
      methods.push(init?.method ?? 'GET');
      if ((init?.method ?? 'GET') === 'GET') return Response.json({ jobs: [], runs: [] });
      return new Response('boom', { status: 500 });
    });
    try {
      await handleRoutinesCommand(setup('connected_host_unavailable'));
      expect(methods).toContain('POST');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
