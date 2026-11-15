/** A webhook reply posts only to the callback its own request supplied, never to one left on the shared route binding. */
import { describe, expect, test } from 'bun:test';
import { ChannelPluginRegistry } from '../platform/src/platform/channels/plugin-registry.js';
import { ChannelReplyPipeline } from '../platform/src/platform/channels/reply-pipeline.js';
import { DaemonSurfaceDeliveryHelper } from '../platform/src/platform/daemon/surface-delivery.js';
import type { RouteBindingManager } from '../platform/src/platform/channels/index.js';
import type { AutomationRouteBinding } from '../platform/src/platform/automation/routes.js';
import { renderBuiltinChannelEvent } from '../platform/src/platform/channels/builtin/rendering.js';
import type { ChannelDeliveryRequest } from '../platform/src/platform/channels/delivery/types.js';
import type { PendingSurfaceReply } from '../platform/src/platform/daemon/types.js';

function harness() {
  const now = Date.now();
  // Request A's callback is on the shared binding when request B's reply is built from it.
  const binding = {
    id: 'route-webhook', kind: 'message', surfaceKind: 'webhook', surfaceId: 'webhook', externalId: 'conversation-1',
    lastSeenAt: now, createdAt: now, updatedAt: now,
    metadata: { callbackUrl: 'https://a.example/hook', correlationId: 'corr-a', callbackSignature: 'shared-secret' },
  } as unknown as AutomationRouteBinding;
  const routeBindings = { getBinding: (id: string) => id === binding.id ? binding : undefined } as unknown as RouteBindingManager;
  const pendingSurfaceReplies = new Map<string, PendingSurfaceReply>();
  const pipeline = new ChannelReplyPipeline({ channelPlugins: new ChannelPluginRegistry(), routeBindings, waitBeforeRetry: async () => {} });
  const helper = new DaemonSurfaceDeliveryHelper({
    pendingSurfaceReplies, channelReplyPipeline: pipeline, configManager: { get: () => undefined } as never,
    serviceRegistry: { resolveSecret: async () => null } as never, agentManager: { getStatus: () => null } as never,
    sessionBroker: {} as never, routeBindings, channelPlugins: new ChannelPluginRegistry(), authToken: () => null,
    surfaceDeliveryEnabled: () => true, recordDeliveryAttempt: () => {},
  } as never);
  return { binding, helper, pendingSurfaceReplies, pipeline };
}

test('a reply built from the shared binding carries no callback another request left on it', () => {
  const h = harness();
  expect(h.helper.queueSurfaceReplyFromBinding(h.binding, { agentId: 'agent-b', task: 'no callback here' })).toBe(true);
  const pending = h.pendingSurfaceReplies.get('agent-b')!;
  expect(pending.callbackUrl).toBeUndefined();
  expect(pending.callbackCorrelationId).toBeUndefined();
  expect(pending.callbackSignature).toBeUndefined();
});

test('the request callback is written onto the queued reply in place, keeping what the pipeline holds for it', () => {
  const h = harness();
  h.helper.queueSurfaceReplyFromBinding(h.binding, { agentId: 'agent-c', task: 'with callback' });
  const queued = h.pipeline.getPending('agent-c');
  h.helper.queueWebhookReply({ agentId: 'agent-c', task: 'with callback', routeId: h.binding.id, callbackUrl: 'https://c.example/hook', callbackCorrelationId: 'corr-c' });
  expect(h.pendingSurfaceReplies.get('agent-c')).toMatchObject({ callbackUrl: 'https://c.example/hook', callbackCorrelationId: 'corr-c' });
  expect(h.pipeline.getPending('agent-c')).toBe(queued);
  expect(h.pipeline.getPending('agent-c')).toBe(h.pendingSurfaceReplies.get('agent-c')!);
});

describe('rendering a webhook reply through the delivery router', () => {
  const render = async (pending: Record<string, unknown>) => {
    const delivered: ChannelDeliveryRequest[] = [];
    const { binding } = harness();
    const context = {
      deps: {
        deliveryRouter: { deliver: async (request: ChannelDeliveryRequest) => { delivered.push(request); return 'response-1'; } },
        routeBindings: { getBinding: (id: string) => id === binding.id ? binding : undefined },
      },
      listTools: () => [], runTool: async () => null,
    } as unknown as Parameters<typeof renderBuiltinChannelEvent>[0];
    await renderBuiltinChannelEvent(context, 'webhook', {
      surface: 'webhook', phase: 'final', routeId: binding.id, agentId: 'agent-b', title: 'Reply', text: 'done', events: [], pending, metadata: {},
    });
    return delivered[0]!;
  };

  test('a final reply with no callback of its own is not sent to the callback another request left on the binding', async () => {
    const request = await render({});
    expect(request.target.address).toBeUndefined();
    expect(request.binding?.metadata.callbackUrl).toBeUndefined();
  });

  test('a final reply goes to the callback its own request supplied', async () => {
    const request = await render({ callbackUrl: 'https://b.example/hook' });
    expect(request.target.address).toBe('https://b.example/hook');
  });
});
