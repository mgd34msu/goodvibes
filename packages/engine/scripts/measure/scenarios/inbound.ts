/**
 * One inbound channel message through the generic webhook adapter, from the
 * HTTP request to the point a turn is dispatched (trySpawnAgent).
 */
import { createHash, createHmac } from 'node:crypto';
import { handleGenericWebhookSurface } from '../../../platform/src/platform/adapters/webhook/index.ts';
import type { GenericWebhookAdapterContext } from '../../../platform/src/platform/adapters/types.ts';
import { RouteBindingManager } from '../../../platform/src/platform/channels/route-manager.ts';
import { AutomationRouteStore } from '../../../platform/src/platform/automation/store/routes.ts';
import { ChannelPolicyManager } from '../../../platform/src/platform/channels/policy-manager.ts';
import { refuseCardShapedIngress } from '../../../platform/src/platform/daemon/surface-card-gate.ts';
import { ConfigManager } from '../../../platform/src/platform/config/manager.ts';
import { createShellPathService } from '../../../platform/src/platform/runtime/shell-paths.ts';
import { SharedSessionBroker } from '../../../platform/src/platform/control-plane/session-broker.ts';
import { openBroker } from './stores.ts';
import { assertOutcome, type Instance, type Scenario } from '../harness.ts';

const P = 'packages/engine/platform/src/platform';
const SECRET = 'measure-webhook-secret';

const inboundMessage: Scenario = {
  name: 'inbound-message',
  drives: 'handleGenericWebhookSurface with a JSON POST (secret header) -> channel policy (ChannelPolicyManager.evaluateIngress deciding once, the card-shape gate, evaluateIngress admitting with that decision: the core of SurfaceActionHelper.authorizeSurfaceIngress; the pending-proposal consumption step is not driven) -> RouteBindingManager.upsertBinding (real AutomationRouteStore file) -> SharedSessionBroker.submitMessage on a store of 50 sessions x 200 messages -> trySpawnAgent (counting stub: the turn-dispatch boundary) -> bindAgent. Each run posts as a new external conversation.',
  entries: [
    `${P}/adapters/webhook/index.ts:23 handleGenericWebhookSurface`,
    `${P}/daemon/surface-actions.ts:354 SurfaceActionHelper.authorizeSurfaceIngress (core steps reproduced)`,
    `${P}/channels/route-manager.ts:114 RouteBindingManager`,
    `${P}/control-plane/session-broker.ts:666 SharedSessionBroker.submitMessage`,
  ],
  async setup(env): Promise<Instance> {
    const b = await openBroker(env);
    const configManager = new ConfigManager({ surfaceRoot: 'daemon', homeDir: env.home, workingDir: env.workspace });
    const shellPaths = createShellPathService({ workingDirectory: env.workspace, homeDirectory: env.home });
    const channelPolicy = new ChannelPolicyManager({ storePath: shellPaths.resolveProjectPath('daemon', 'channels', 'policies.json') });
    await channelPolicy.start();
    const routeBindings = new RouteBindingManager({ store: new AutomationRouteStore({ configManager }) });
    await routeBindings.start();
    let spawned = 0;
    const context: GenericWebhookAdapterContext = {
      configManager: { get: (key: string) => key === 'surfaces.webhook.enabled' ? true : key === 'surfaces.webhook.secret' ? SECRET : configManager.get(key as never) },
      routeBindings,
      sessionBroker: b.broker,
      async authorizeSurfaceIngress(input) {
        const checked = await channelPolicy.evaluateIngress(input, { admit: false });
        if (!checked.allowed) {
          const denial = await channelPolicy.recordDeniedIngress(input, checked);
          if (!denial.allowed) return denial;
        }
        const card = await refuseCardShapedIngress({ channelPolicy } as unknown as Parameters<typeof refuseCardShapedIngress>[0], input);
        if (card) return card;
        const decision = await channelPolicy.evaluateIngress(input, { recordDenied: false, decided: checked });
        if (!decision.allowed) { await channelPolicy.recordDeniedIngress(input, decision); return decision; }
        return decision;
      },
      trySpawnAgent: () => { spawned++; return { id: `agent-measure-${spawned}` } as never; },
      surfaceDeliveryEnabled: () => false,
      signWebhookPayload: (body, secret) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      queueWebhookReply: () => {},
    };
    let externalId = '';
    return {
      settled: () => b.broker.idle(),
      async op(run) {
        spawned = 0;
        externalId = `conversation-${run}-${createHash('sha1').update(String(Date.now())).digest('hex').slice(0, 8)}`;
        const response = await handleGenericWebhookSurface(new Request('http://127.0.0.1/webhook', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goodvibes-webhook-secret': SECRET },
          body: JSON.stringify({ message: 'Please summarise the open pull requests for me.', externalId, userId: 'owner' }),
        }), context);
        const body = await response.text();
        assertOutcome(response.status === 200, `the webhook answered HTTP ${response.status}: ${body.slice(0, 300)}`);
        assertOutcome(spawned === 1, `the message was accepted but ${spawned} turns were dispatched`);
        return { httpStatus: response.status, turnsDispatched: spawned, sessionStoreBytes: Bun.file(b.path).size };
      },
      async verify() {
        // What a restarted daemon loads: a second broker over the same store holds the message in a session.
        const reopened = new SharedSessionBroker({ storePath: b.path, routeBindings: b.routeBindings, agentStatusProvider: { getStatus: () => null },
          messageSender: { send: () => true } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]['messageSender'] });
        await reopened.start();
        try {
          const holder = reopened.listSessions(10_000).find((session) => JSON.stringify(session).includes(externalId));
          const messages = holder ? reopened.getMessages(holder.id, 10_000) : [];
          assertOutcome(messages.some((message) => message.body === 'Please summarise the open pull requests for me.'),
            `the message of ${externalId} is not in the stored sessions${holder ? ` (session ${holder.id} holds ${messages.length} messages)` : ' (no session names it)'}`);
        } finally { await reopened.stop(); }
      },
      async dispose() { await b.broker.stop(); b.restore(); },
    };
  },
};

export const scenarios: Scenario[] = [inboundMessage];
