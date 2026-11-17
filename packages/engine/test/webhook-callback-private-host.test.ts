// Proves: A callback address supplied by a webhook sender cannot send job output to a host on the owner's own network, even one the owner approved for his own targets.
// Red when: A delivery to a sender-bound callback on a private host reaches dispatch, or nothing reaches dispatch at all so the refusal proves nothing.
/**
 * A webhook callback URL is supplied by whoever bound the route, so a delivery
 * to it is held to public hosts even when the owner approved a host on his own
 * network: a sender cannot point job output at an internal machine. The owner's
 * own target to that approved host still goes out.
 *
 * Real delivery router, webhook strategy, settings manager and artifact store.
 * The dispatch itself is the stand-in: the publication hook records that the
 * request reached the point of sending and stops it there, so nothing touches
 * the network.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../platform/src/platform/artifacts/index.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { ChannelDeliveryRouter } from '../platform/src/platform/channels/delivery-router.ts';
import { createWebhookDeliveryStrategy } from '../platform/src/platform/channels/delivery/strategies-core.ts';
import type { ChannelDeliveryRouteBinding } from '../platform/src/platform/channels/delivery/types.ts';

const APPROVED_PRIVATE_HOST = '10.1.2.3';
const PRIVATE_URL = `https://${APPROVED_PRIVATE_HOST}/hook`;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function router(binding: ChannelDeliveryRouteBinding): ChannelDeliveryRouter {
  const root = mkdtempSync(join(tmpdir(), 'gv-webhook-callback-'));
  dirs.push(root);
  const configManager = new ConfigManager({ configDir: join(root, 'config'), daemonTierPath: join(root, 'daemon', 'settings.json'), ownsDaemonTier: true });
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const secrets = { get: async () => null, getGlobalHome: () => root };
  const webhook = createWebhookDeliveryStrategy(configManager, artifactStore, secrets, { privateDeliveryHosts: () => [APPROVED_PRIVATE_HOST] });
  return new ChannelDeliveryRouter({ strategies: [webhook], routeBindings: { getBinding: (id) => (id === binding.id ? binding : undefined) } });
}

/** Deliver and report whether the request reached dispatch; dispatch is stopped before any connection. */
async function reachesDispatch(deliver: (withPublication: <T>(operation: (assertCurrent: () => void) => T | Promise<T>) => Promise<T>) => Promise<unknown>): Promise<boolean> {
  let dispatched = false;
  await deliver(async () => { dispatched = true; throw new Error('dispatch stopped by the proof'); }).catch(() => undefined);
  return dispatched;
}

const callbackBinding: ChannelDeliveryRouteBinding = {
  id: 'route-webhook', surfaceKind: 'webhook', surfaceId: 'webhook', externalId: 'sender',
  metadata: { callbackUrl: PRIVATE_URL },
};

test('a callback URL bound by a sender never reaches an owner-approved private host', async () => {
  const delivery = router(callbackBinding);
  expect(await reachesDispatch((withPublication) => delivery.deliver({
    target: { kind: 'webhook', routeId: callbackBinding.id }, body: 'job output', title: 'job', jobId: 'job-1', runId: 'run-1', includeLinks: false, withPublication,
  }))).toBe(false);
});

test("the owner's own target to the approved host is sent", async () => {
  const delivery = router(callbackBinding);
  expect(await reachesDispatch((withPublication) => delivery.deliver({
    target: { kind: 'webhook', address: PRIVATE_URL }, body: 'job output', title: 'job', jobId: 'job-1', runId: 'run-1', includeLinks: false, withPublication,
  }))).toBe(true);
});
