/**
 * Promoting a routine to a recurring connected schedule: the review gate the workspace shows is
 * enforced, `/routines update` keeps the requirements it was not asked to change, and a receipt
 * that cannot be written does not hide that the schedule was created.
 */
import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerRoutinesRuntimeCommands } from '../../input/commands/routines-runtime.ts';
import { registerScheduleRuntimeCommands } from '../../input/commands/schedule-runtime.ts';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { RoutineScheduleReceiptStore } from '../../agent/routine-schedule-receipts.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/platform/contracts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function harness() {
  const root = makeProjectTempDir('goodvibes-agent-routine-gate');
  const registry = new CommandRegistry();
  registerRoutinesRuntimeCommands(registry);
  registerScheduleRuntimeCommands(registry);
  const out: string[] = [];
  mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(join(root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'routine-token' }));
  const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const ctx = {
    print: (text: string) => out.push(text),
    workspace: { shellPaths },
    platform: { configManager: new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, workingDir: root, homeDir: root }) },
    ops: { automationManager: { listJobs: () => [] } },
  } as unknown as CommandContext;
  return { registry, out, ctx, shellPaths };
}

function scheduleResponse(): Response {
  return new Response(JSON.stringify({
    id: 'sched-1',
    mutationRevision: 'schedule-revision-1',
    name: 'Agent routine: Inbox Sweep',
    labels: [],
    createdAt: 1,
    updatedAt: 1,
    status: 'enabled',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'America/Chicago' },
    execution: { prompt: 'routine prompt', target: { kind: 'main' } },
    delivery: {
      mode: 'none',
      targets: [],
      fallbackTargets: [],
      includeSummary: true,
      includeTranscript: false,
      includeLinks: true,
    },
    failure: {
      action: 'retry',
      maxConsecutiveFailures: 3,
      cooldownMs: 3600000,
      retryPolicy: { maxAttempts: 2, delayMs: 60000, strategy: 'exponential' },
    },
    source: {
      id: 'source-sched-1',
      kind: 'schedule',
      label: 'schedule',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      metadata: {},
    },
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    deleteAfterRun: false,
  } satisfies OperatorMethodOutput<'automation.schedules.create'>), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function schedulesListResponse(): Response {
  return new Response(JSON.stringify({
    jobs: [
      {
        id: 'sched-1',
        mutationRevision: 'schedule-revision-1',
        name: 'Agent routine: Inbox Sweep',
        labels: [],
        createdAt: 1,
        updatedAt: 1,
        status: 'enabled',
        enabled: true,
        schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'America/Chicago' },
        execution: { prompt: 'routine prompt', target: { kind: 'main' } },
        delivery: {
          mode: 'none',
          targets: [],
          fallbackTargets: [],
          includeSummary: true,
          includeTranscript: false,
          includeLinks: true,
        },
        failure: {
          action: 'retry',
          maxConsecutiveFailures: 3,
          cooldownMs: 3600000,
          retryPolicy: { maxAttempts: 2, delayMs: 60000, strategy: 'exponential' },
        },
        source: {
          id: 'source-sched-1',
          kind: 'schedule',
          label: 'schedule',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
          metadata: {},
        },
        nextRunAt: 1_700_000_000_000,
        runCount: 3,
        successCount: 2,
        failureCount: 1,
        deleteAfterRun: false,
      },
    ],
    runs: [],
  } satisfies OperatorMethodOutput<'automation.schedules.list'>), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const CREATE = ['create', '--name', 'Inbox Sweep', '--description', 'Review messages.', '--steps', 'Summarize inbound messages.'];
const PROMOTE = ['promote-routine', 'inbox-sweep', '--cron', '0 9 * * *', '--yes'];

describe('routine promotion gate', () => {
  test('an unreviewed, disabled routine is refused with --yes and the host is never called', async () => {
    const { registry, out, ctx } = harness();
    let calls = 0;
    globalThis.fetch = mockFetch(async () => { calls += 1; return scheduleResponse(); });
    await registry.execute('routines', CREATE, ctx);
    await registry.execute('schedule', PROMOTE, ctx);
    const text = out.join('\n');
    expect(text).toContain('Refusing to promote inbox-sweep: no schedule was created.');
    expect(text).toContain('/routines enable inbox-sweep');
    expect(text).toContain('/routines review inbox-sweep');
    expect(calls).toBe(0);
  });

  test('the same refusal applies to /routines promote', async () => {
    const { registry, out, ctx } = harness();
    let calls = 0;
    globalThis.fetch = mockFetch(async () => { calls += 1; return scheduleResponse(); });
    await registry.execute('routines', CREATE, ctx);
    await registry.execute('routines', ['promote', 'inbox-sweep', '--cron', '0 9 * * *', '--yes'], ctx);
    expect(out.join('\n')).toContain('Refusing to promote inbox-sweep');
    expect(calls).toBe(0);
  });

  test('a routine with a missing requirement is refused even when enabled and reviewed', async () => {
    const { registry, out, ctx } = harness();
    let calls = 0;
    globalThis.fetch = mockFetch(async () => { calls += 1; return scheduleResponse(); });
    await registry.execute('routines', [...CREATE, '--requires-command', 'no-such-command-for-gate-test'], ctx);
    await registry.execute('routines', ['enable', 'inbox-sweep'], ctx);
    await registry.execute('routines', ['review', 'inbox-sweep'], ctx);
    await registry.execute('schedule', PROMOTE, ctx);
    expect(out.join('\n')).toContain('setup is missing: command:no-such-command-for-gate-test');
    expect(calls).toBe(0);
  });

  test('the preview shows what blocks the promotion', async () => {
    const { registry, out, ctx } = harness();
    await registry.execute('routines', CREATE, ctx);
    await registry.execute('schedule', ['promote-routine', 'inbox-sweep', '--cron', '0 9 * * *'], ctx);
    expect(out.join('\n')).toContain('Not ready to promote inbox-sweep:');
  });

  test('an enabled, reviewed routine is promoted; a receipt that cannot be written does not hide the host result', async () => {
    const { registry, out, ctx, shellPaths } = harness();
    const requests: string[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push(`${init?.method ?? 'GET'} ${typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url}`);
      return scheduleResponse();
    });
    await registry.execute('routines', CREATE, ctx);
    await registry.execute('routines', ['enable', 'inbox-sweep'], ctx);
    await registry.execute('routines', ['review', 'inbox-sweep'], ctx);
    const original = RoutineScheduleReceiptStore.fromShellPaths;
    RoutineScheduleReceiptStore.fromShellPaths = ((paths: typeof shellPaths) => {
      const store = original.call(RoutineScheduleReceiptStore, paths);
      store.append = () => { throw new Error('disk full'); };
      return store;
    }) as typeof original;
    try {
      await registry.execute('schedule', PROMOTE, ctx);
    } finally {
      RoutineScheduleReceiptStore.fromShellPaths = original;
    }
    const text = out.join('\n');
    expect(requests.filter((request) => request.startsWith('POST'))).toHaveLength(1);
    expect(text).toContain('Created GoodVibes schedule for Agent routine');
    expect(text).toContain('receipt not recorded: disk full');
  });
});

describe('retrying a promotion whose outcome is unknown', () => {
  test('is refused when the host already has the schedule from the first attempt', async () => {
    const { registry, out, ctx } = harness();
    let posts = 0;
    globalThis.fetch = mockFetch(async (_input, init) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posts += 1;
        throw new Error('connection dropped');
      }
      return schedulesListResponse();
    });
    await registry.execute('routines', CREATE, ctx);
    await registry.execute('routines', ['enable', 'inbox-sweep'], ctx);
    await registry.execute('routines', ['review', 'inbox-sweep'], ctx);
    await registry.execute('schedule', PROMOTE, ctx);
    expect(posts).toBe(1);
    out.length = 0;
    await registry.execute('schedule', PROMOTE, ctx);
    expect(posts).toBe(1);
    expect(out.join('\n')).toContain('already exists on the connected host');
    expect(out.join('\n')).toContain('Nothing was created');
  });
});

describe('/routines update', () => {
  test('changing one requirement kind keeps the other', async () => {
    const { registry, ctx, shellPaths } = harness();
    await registry.execute('routines', [...CREATE, '--requires-env', 'OLD_TOKEN', '--requires-command', 'gh'], ctx);
    await registry.execute('routines', ['update', 'inbox-sweep', '--requires-env', 'NEW_TOKEN'], ctx);
    const requirements = AgentRoutineRegistry.fromShellPaths(shellPaths).get('inbox-sweep')!.requirements.map((r) => `${r.kind}:${r.name}`);
    expect(requirements.sort()).toEqual(['command:gh', 'env:NEW_TOKEN']);
    await registry.execute('routines', ['update', 'inbox-sweep', '--requires-command', 'jq'], ctx);
    const after = AgentRoutineRegistry.fromShellPaths(shellPaths).get('inbox-sweep')!.requirements.map((r) => `${r.kind}:${r.name}`);
    expect(after.sort()).toEqual(['command:jq', 'env:NEW_TOKEN']);
  });
});

describe('/schedule list', () => {
  test('prints the whole schedule id so it can be used with the schedule verbs', async () => {
    const { registry, out, ctx } = harness();
    // A 13-character id: cutting it to 12 characters would drop the last one.
    globalThis.fetch = mockFetch(async () => new Response((await schedulesListResponse().text()).replaceAll('sched-1', 'auto-12345678'), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await registry.execute('schedule', ['list'], ctx);
    expect(out.join('\n')).toContain('auto-12345678 ');
  });
});
