import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { createAgentReminderScheduleTool } from '../../tools/agent-reminder-schedule-tool.ts';
import { createAgentScheduleEditTool } from '../../tools/agent-schedule-edit-tool.ts';
import { createScheduleInputProjector } from '../../tools/agent-schedule-effect.ts';
import { registerAgentOperatorMethodTool } from '../../tools/agent-operator-method-tool.ts';
import { scheduleEffectAdmission } from '../helpers/schedule-effect-admission.ts';
import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { resetSessionUntrustedContentLedgerForTests } from '../../trust/untrusted-content.ts';

beforeEach(resetSessionUntrustedContentLedgerForTests);
afterEach(resetSessionUntrustedContentLedgerForTests);

function setup() {
  const root = makeProjectTempDir('goodvibes-agent-schedule-argument-text');
  mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(join(root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'schedule-text-token' }));
  const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const config = new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT), workingDir: root, homeDir: root });
  const fixture = scheduleEffectAdmission(root);
  registerAgentOperatorMethodTool(fixture.registry, paths, config);
  return { paths, config, fixture };
}
function scheduleBody(): Response {
  return Response.json({ id: 'sched-1', name: 'n', labels: [], createdAt: 1, updatedAt: 1, status: 'enabled', enabled: true,
    schedule: { kind: 'every', intervalMs: 1 }, execution: { prompt: 'p', target: { kind: 'main' } },
    delivery: { mode: 'none', targets: [], fallbackTargets: [], includeSummary: true, includeTranscript: false, includeLinks: true },
    failure: { action: 'retry', maxConsecutiveFailures: 3, cooldownMs: 1, retryPolicy: { maxAttempts: 2, delayMs: 1, strategy: 'exponential' } },
    source: { id: 's', kind: 'schedule', label: 'schedule', enabled: true, createdAt: 1, updatedAt: 1, metadata: {} }, runCount: 0, successCount: 0, failureCount: 0, deleteAfterRun: false });
}
async function withCapturedBodies<T>(run: (bodies: Array<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const original = globalThis.fetch; const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = mockFetch(async (_input, init) => { bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}); return scheduleBody(); });
  try { return await run(bodies); } finally { globalThis.fetch = original; }
}

describe('reminder text and provenance reach the created schedule intact', () => {
  test.each(['--- stand up', '--message'])('a message of %p is a reminder, not a missing option value', async message => {
    const { paths, config, fixture } = setup();
    const raw = createAgentReminderScheduleTool(paths, config, fixture.registry);
    fixture.registry.register(raw, { inputProjection: createScheduleInputProjector(paths, config) });
    await withCapturedBodies(async bodies => {
      const result = await fixture.run(raw, { message, scheduleKind: 'every', scheduleValue: '1d' });
      expect(result.success, result.error).toBe(true);
      expect(String(bodies[0]?.prompt)).toContain(message);
    });
  });
  test('explicitUserRequest is recorded in the schedule prompt', async () => {
    const { paths, config, fixture } = setup();
    const raw = createAgentReminderScheduleTool(paths, config, fixture.registry);
    fixture.registry.register(raw, { inputProjection: createScheduleInputProjector(paths, config) });
    await withCapturedBodies(async bodies => {
      const result = await fixture.run(raw, { message: 'Stand up', scheduleKind: 'every', scheduleValue: '1d', explicitUserRequest: 'remind me at 5' });
      expect(result.success, result.error).toBe(true);
      expect(String(bodies[0]?.prompt)).toContain('Request provenance:\nremind me at 5');
    });
  });
});

describe('schedule edit text that begins with dashes', () => {
  test('an edited name that looks like an option is applied as written', async () => {
    const { paths, config, fixture } = setup();
    const raw = createAgentScheduleEditTool(paths, config, fixture.registry);
    fixture.registry.register(raw, { inputProjection: createScheduleInputProjector(paths, config) });
    const original = globalThis.fetch; const patches: Array<Record<string, unknown>> = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === 'PATCH') patches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return url.endsWith('/api/automation/schedules') ? Response.json({ jobs: [{ id: 'sched-1', mutationRevision: 'r1' }] }) : scheduleBody();
    });
    try {
      const result = await fixture.run(raw, { scheduleId: 'sched-1', name: '--timezone' });
      expect(result.success, result.error).toBe(true);
      expect(patches[0]?.name).toBe('--timezone');
    } finally { globalThis.fetch = original; }
  });
});
