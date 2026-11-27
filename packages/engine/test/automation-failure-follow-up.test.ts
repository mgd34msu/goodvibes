// Proves: A scheduled job the owner removed comes back, or one they disabled runs again, because the follow-up of a failed run writes the copy of the job it took before the owner's change.
// Red when: The failure follow-up applies its cooldown to the job as the failed run saw it instead of the job as it stands, so the removed job is put back and the disabled one enabled.
/**
 * A run that fails to start is followed up after its failure is read: the
 * job's cooldown moves its next run out. The owner may remove or disable the
 * job while that reading is still out; the follow-up then acts on the job as
 * it stands, never on the copy it held.
 *
 * Real settings, job and run stores, route bindings, session broker and
 * automation manager. Stand-ins: the agent runtime refuses to start the run,
 * and the decision model's reading of the failure is held until the owner's
 * change is done, then answers that it cannot read it.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes/judgment';
import { AutomationManager } from '../platform/src/platform/automation/manager-runtime.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.ts';
import { RouteBindingManager } from '../platform/src/platform/channels/route-manager.ts';
import { AutomationRouteStore } from '../platform/src/platform/automation/store/routes.ts';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test('a job removed or disabled while its failed run is being read stays removed or disabled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-automation-follow-up-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  // The decision model: each failure reading waits until the test lets it go, then cannot be made; any other reading cannot be made at once.
  const held: Array<() => void> = [];
  let reached: () => void = () => {};
  const port: JudgmentPort = {
    model: 'held-decision-model',
    async ask(request: { readonly context?: { readonly battery?: string } }) {
      if (request.context?.battery === 'engine.failure-reading') await new Promise<void>((release) => { held.push(release); reached(); });
      throw new JudgmentError('unavailable', 'judgment unavailable');
    },
  } as unknown as JudgmentPort;
  const previous = installJudgmentPort(port);
  cleanups.push(() => installJudgmentPort(previous));

  const configManager = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir: join(root, 'config') });
  const routeBindings = new RouteBindingManager({ store: new AutomationRouteStore(join(root, 'bindings.json')) });
  const sessionBroker = new SharedSessionBroker({ storePath: join(root, 'sessions.json'), routeBindings,
    agentStatusProvider: { getStatus: () => null }, messageSender: { send: () => false } });
  cleanups.push(() => sessionBroker.stop());
  const manager = new AutomationManager({
    configManager, routeBindings, sessionBroker,
    // The agent runtime refuses every start, each in its own words.
    spawnTask: (input: { readonly task?: string }) => { throw new Error(`the agent runtime refused: ${String(input.task)}`); },
    cancelTask: () => {},
    agentStatusProvider: { getStatus: () => null },
  } as unknown as ConstructorParameters<typeof AutomationManager>[0]);
  cleanups.push(() => manager.stop());

  const hourly = { kind: 'every' as const, intervalMs: 3_600_000 };
  const cooldown = { action: 'cooldown' as const, cooldownMs: 60_000 };
  const removed = await manager.createJob({ name: 'backup', prompt: 'Back up the photos.', schedule: hourly, enabled: true, failure: cooldown });
  const disabled = await manager.createJob({ name: 'digest', prompt: 'Send the news digest.', schedule: hourly, enabled: true, failure: cooldown });

  /** Run the job; while its failure is being read, the owner makes their change; then the reading ends. */
  const failWhile = async (jobId: string, change: () => Promise<unknown>) => {
    const reading = new Promise<void>((resolve) => { reached = resolve; });
    const run = manager.runNow(jobId).then(() => 'started', () => 'failed');
    await reading;
    await change();
    held.splice(0).forEach((release) => release());
    expect(await run).toBe('failed');
  };
  await failWhile(removed.id, () => manager.removeJob(removed.id));
  await failWhile(disabled.id, () => manager.setEnabled(disabled.id, false));

  expect(manager.listJobs().map((job) => ({ name: job.name, enabled: job.enabled }))).toEqual([{ name: 'digest', enabled: false }]);
});
