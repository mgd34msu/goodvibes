// Proves: A scheduled run fails and nobody is told, or its result is lost because the first target refused it and the fallback was not tried.
// Red when: The failure notice has no target for a job without a failure route, or deliverJobRun does not fall back.
/**
 * Unattended work reaches its owner: a run that fails is announced on the
 * job's own delivery target when the job names no separate failure route, and
 * a result the first target refuses goes to the job's fallback target.
 *
 * Real automation manager, settings, job and run stores, route bindings,
 * session broker, delivery manager and delivery router with its ntfy sender.
 * The agent runtime is the stand-in that reports each run's outcome, and the
 * ntfy server is a loopback server that records what each topic was sent and
 * refuses the topics it is told to (404, which is not retried).
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../platform/src/platform/artifacts/index.ts';
import { AutomationDeliveryManager } from '../platform/src/platform/automation/delivery-manager.ts';
import { AutomationManager } from '../platform/src/platform/automation/manager-runtime.ts';
import { AutomationRouteStore } from '../platform/src/platform/automation/store/routes.ts';
import { RouteBindingManager } from '../platform/src/platform/channels/route-manager.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { SecretsManager } from '../platform/src/platform/config/secrets.ts';
import { ServiceRegistry } from '../platform/src/platform/config/service-registry.ts';
import { SubscriptionManager } from '../platform/src/platform/config/subscriptions.ts';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.ts';
import { ntfyOutboundDedup } from '../platform/src/platform/integrations/ntfy.ts';
import { configureDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.ts';
import { PersistentStore } from '../platform/src/platform/state/persistent-store.ts';
import type { AgentRecord } from '../platform/src/platform/tools/agent/record.ts';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  ntfyOutboundDedup.reset();
});

async function ntfyServer(refused: ReadonlySet<string>) {
  const received: Array<{ topic: string; body: string; accepted: boolean }> = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      const topic = decodeURIComponent((req.url ?? '/').slice(1));
      const accepted = !refused.has(topic);
      received.push({ topic, body, accepted });
      res.writeHead(accepted ? 200 : 404).end(accepted ? '{}' : '{"error":"topic not found"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const accepted = (topic: string) => received.filter((entry) => entry.topic === topic && entry.accepted).map((entry) => entry.body);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received, accepted };
}

/** The automation pieces over a fresh home, delivering to the ntfy server; `outcome` is what the agent of each run reports. */
async function automation(ntfyUrl: string, outcome: AgentRecord['status']) {
  const root = mkdtempSync(join(tmpdir(), 'gv-run-delivery-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(configureDecisionModelPolicy(() => 'Hybrid', () => false));
  const configManager = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir: join(root, 'config') });
  configManager.setMany([{ key: 'surfaces.ntfy.baseUrl' as ConfigKey, value: ntfyUrl }], localOwnerActor());
  const secretsManager = new SecretsManager({ surfaceRoot: 'goodvibes', globalHome: join(root, 'home'), projectRoot: root });
  const subscriptionManager = new SubscriptionManager(join(root, 'home', 'subscriptions.json'), { secrets: secretsManager });
  const serviceRegistry = new ServiceRegistry({ user: join(root, 'home', 'services.json'), project: join(root, 'services.json') }, { secretsManager, subscriptionManager });
  const routeBindings = new RouteBindingManager({ store: new AutomationRouteStore(join(root, 'bindings.json')) });
  const sessionBroker = new SharedSessionBroker({
    store: new PersistentStore(join(root, 'sessions.json')) as never,
    routeBindings, agentStatusProvider: { getStatus: () => null }, messageSender: { send: () => false },
  });
  cleanups.push(() => sessionBroker.stop());
  const deliveryManager = new AutomationDeliveryManager({
    serviceRegistry, secretsManager, configManager, routeBindings, artifactStore: new ArtifactStore({ rootDir: join(root, 'artifacts') }),
  });
  const agents = new Map<string, AgentRecord['status']>();
  let spawned = 0;
  const manager = new AutomationManager({
    configManager, routeBindings, sessionBroker, deliveryManager,
    spawnTask: () => { const id = `agent-${++spawned}`; agents.set(id, 'running'); return id; },
    cancelTask: () => {},
    agentStatusProvider: {
      getStatus: (id: string) => {
        const status = agents.get(id);
        return status ? ({ id, status, task: 'nightly report', startedAt: Date.now(), completedAt: Date.now(), error: 'the provider was unavailable', fullOutput: 'the nightly report is ready' } as unknown as AgentRecord) : null;
      },
    },
  });
  cleanups.push(() => manager.stop());
  const job = await manager.createJob({
    name: 'nightly report', prompt: 'Write the nightly report.',
    schedule: { kind: 'at', at: Date.now() + 86_400_000 }, enabled: false,
    delivery: {
      mode: 'surface', includeSummary: true, includeLinks: false,
      targets: [{ kind: 'surface', surfaceKind: 'ntfy', address: 'job-primary' }],
      fallbackTargets: [{ kind: 'surface', surfaceKind: 'ntfy', address: 'job-fallback' }],
    },
  });
  const run = await manager.runNow(job.id);
  agents.set(run.agentId!, outcome);
  // Reading the jobs settles the run from its agent's report.
  manager.listJobs();
  return { manager, run };
}

test('a run that fails is announced once on the job\'s own target when the job names no failure route', async () => {
  const ntfy = await ntfyServer(new Set());
  const { manager, run } = await automation(ntfy.url, 'failed');
  await manager.deliveriesSettled();
  // Further reads settle nothing again and send nothing more.
  manager.listJobs();
  await manager.deliveriesSettled();

  expect(manager.getRun(run.id)?.status).toBe('failed');
  const notices = ntfy.accepted('job-primary');
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain('nightly report');
  expect(notices[0]).toContain('failed');
  expect(ntfy.accepted('job-fallback')).toEqual([]);
});

test('a result the first target refuses is delivered to the fallback target, once', async () => {
  const ntfy = await ntfyServer(new Set(['job-primary']));
  const { manager, run } = await automation(ntfy.url, 'completed');
  await manager.deliveriesSettled();

  expect(manager.getRun(run.id)?.status).toBe('completed');
  expect(ntfy.received.filter((entry) => entry.topic === 'job-primary').map((entry) => entry.accepted)).toEqual([false]);
  expect(ntfy.accepted('job-fallback')).toHaveLength(1);
});
