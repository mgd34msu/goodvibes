// Proves: A one-time job (a reminder, a scheduled task) is deleted after a run that failed, so the owner's scheduled work is silently gone.
// Red when: `manager-runtime-reconcile.ts:178` deletes a `deleteAfterRun` job on any settlement instead of only a completed one.
/**
 * A one-time job is the owner's record of work to do: a run of it that fails
 * must leave the job in place so the run can be retried, and only a run that
 * succeeds removes it. Real settings, job and run stores, route bindings and
 * session broker; only the agent runtime that would carry out the run is a
 * stand-in, reporting the outcome the proof needs.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationManager } from '../platform/src/platform/automation/manager-runtime.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.ts';
import { RouteBindingManager } from '../platform/src/platform/channels/route-manager.ts';
import { AutomationRouteStore } from '../platform/src/platform/automation/store/routes.ts';
import { PersistentStore } from '../platform/src/platform/state/persistent-store.ts';
import type { AgentRecord } from '../platform/src/platform/tools/agent/record.ts';

const roots: string[] = [];
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('one-time automation job', () => {
  test('a failed run leaves the job to retry, and the retry that succeeds removes it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-one-shot-retry-'));
    roots.push(root);
    const configManager = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir: join(root, 'config') });
    const routeBindings = new RouteBindingManager({ store: new AutomationRouteStore(join(root, 'bindings.json')) });
    const agents = new Map<string, AgentRecord['status']>();
    const sessionBroker = new SharedSessionBroker({
      store: new PersistentStore(join(root, 'sessions.json')) as never,
      routeBindings,
      agentStatusProvider: { getStatus: () => null },
      messageSender: { send: () => false },
    });
    cleanups.push(() => sessionBroker.stop());
    let spawned = 0;
    const manager = new AutomationManager({
      configManager,
      routeBindings,
      sessionBroker,
      spawnTask: () => {
        const id = `agent-${++spawned}`;
        agents.set(id, 'running');
        return id;
      },
      cancelTask: () => {},
      agentStatusProvider: {
        getStatus: (id: string) => {
          const status = agents.get(id);
          return status ? ({ id, status, task: 'reminder', startedAt: Date.now(), completedAt: Date.now(), error: 'provider unavailable' } as unknown as AgentRecord) : null;
        },
      },
    });
    cleanups.push(() => manager.stop());

    const job = await manager.createJob({
      name: 'one-time reminder',
      prompt: 'Remind me to renew the domain.',
      schedule: { kind: 'at', at: Date.now() + 86_400_000 },
      enabled: false,
      deleteAfterRun: true,
    });
    const first = await manager.runNow(job.id);
    agents.set(first.agentId!, 'failed');

    // Reading the jobs settles the run from the agent's report.
    expect(manager.listJobs().map(entry => entry.id)).toContain(job.id);
    expect(manager.getRun(first.id)?.status).toBe('failed');

    const retry = await manager.retryRun(first.id);
    agents.set(retry.agentId!, 'completed');
    expect(manager.listJobs().map(entry => entry.id)).not.toContain(job.id);
    expect(manager.getRun(retry.id)?.status).toBe('completed');
  });
});
