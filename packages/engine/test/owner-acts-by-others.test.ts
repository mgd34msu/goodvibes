// Proves: A caller who is not the owner withdraws access the owner granted: an admin revokes a device the owner paired, or replaces the shared operator token.
// Red when: `pairing.tokens.delete` revokes a device the calling admin neither holds nor minted instead of putting it to the owner, or `pairing.tokens.revokeShared` runs for an admin who is not the owner.
// Proves: A caller who is not the owner loosens the permission mode the sessions from a channel run under, up to yolo.
// Red when: `channels.profiles.set` or `channels.profiles.delete` applies a binding change that loosens a channel's mode for an admin who is not the owner instead of putting it to the owner.
// Proves: The model the Agent runs claims an approval, or cancels one that another caller raised.
// Red when: The approval actions port stops applying the reading's claim and cancel rule before it reaches the broker, so the Agent's credential claims an ask or cancels one it did not raise.
/**
 * Real components only: the daemon's control-plane helper over a real user
 * store, method catalog with the pairing verbs registered, pairing token store
 * and approval broker; the approval actions port over a real broker.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.ts';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.ts';
import { ControlPlaneGateway } from '../platform/src/platform/control-plane/gateway.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { registerPairingGatewayMethods } from '../platform/src/platform/control-plane/routes/pairing.ts';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { DistributedRuntimeManager } from '../platform/src/platform/runtime/remote/distributed-runtime-manager.ts';
import { ApprovalBroker, type SharedApprovalRecord } from '../platform/src/platform/control-plane/approval-broker.ts';
import { localApprovalActions } from '../platform/src/platform/control-plane/approval-actions.ts';
import { actorFromPrincipal, NO_OWNER_USER } from '@goodvibes/engine/daemon-api/http-policy';
import { registerChannelProfilesGatewayMethods } from '../platform/src/platform/control-plane/routes/channel-profiles.ts';
import { ChannelProfileRegistry, ChannelProfileStore } from '../platform/src/platform/channel-profiles/index.ts';

const OPERATOR_TOKEN = 'synthetic-operator-token';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gv-owner-acts-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('an admin who is not the owner revokes no device the owner paired and cannot replace the shared token; the owner can revoke', async () => {
  const userAuth = new UserAuthManager({ bootstrapFilePath: join(dir, 'users.json'), bootstrapCredentialPath: join(dir, 'bootstrap.txt'), scryptParams: { N: 1024, r: 1, p: 1 } });
  // The owner is the first user; `deputy` is an admin who is not the owner.
  userAuth.addUser('deputy', 'deputy-password', ['admin']);
  const pairing = new PairingTokenManager(join(dir, 'pairing-tokens.json'));
  const broker = new ApprovalBroker({ storePath: join(dir, 'approvals.json') });
  await broker.start();
  const catalog = new GatewayMethodCatalog();
  registerPairingGatewayMethods(catalog, pairing, undefined, broker);
  const helper = new DaemonControlPlaneHelper({
    gatewayMethods: catalog, userAuth, pairingTokens: pairing,
    controlPlaneGateway: new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() }),
    distributedRuntime: new DistributedRuntimeManager(join(dir, 'remote', 'distributed-runtime.json')),
    allowedBrowserOrigins: () => [], authToken: () => OPERATOR_TOKEN, trustProxyEnabled: () => false, host: '127.0.0.1', port: 3421,
  } as unknown as DaemonControlPlaneContext);

  // The owner paired his phone from his own machine.
  const phone = pairing.mint({ name: 'owner phone' });
  expect(pairing.authenticate(phone.token)?.id).toBe(phone.id);
  const deputy = userAuth.createSession('deputy').token;

  const revoke = await helper.invokeGatewayMethodCall({ authToken: deputy, methodId: 'pairing.tokens.delete', body: { id: phone.id } });
  expect({ status: revoke.status, code: (revoke.body as { code?: string }).code }).toEqual({ status: 202, code: 'OWNER_APPROVAL_PENDING' });
  expect(pairing.authenticate(phone.token)?.id).toBe(phone.id);
  // It waits for the owner as an ask only he answers.
  expect(broker.listApprovals().map((entry) => entry.request.tool)).toEqual(['pairing.tokens.delete']);

  const replace = await helper.invokeGatewayMethodCall({ authToken: deputy, methodId: 'pairing.tokens.revokeShared', body: {} });
  expect({ status: replace.status, code: (replace.body as { code?: string }).code }).toEqual({ status: 403, code: 'OWNER_ONLY' });
  expect(pairing.isLegacyRevoked()).toBe(false);

  // The control: the owner's own credential revokes it at once.
  const own = await helper.invokeGatewayMethodCall({ authToken: OPERATOR_TOKEN, methodId: 'pairing.tokens.delete', body: { id: phone.id } });
  expect(own.status).toBe(200);
  expect(pairing.authenticate(phone.token)).toBeNull();
});

test('an admin who is not the owner cannot loosen the permission mode a channel\'s sessions run under; he can tighten it and the owner can loosen it', async () => {
  const userAuth = new UserAuthManager({ bootstrapFilePath: join(dir, 'users.json'), bootstrapCredentialPath: join(dir, 'bootstrap.txt'), scryptParams: { N: 1024, r: 1, p: 1 } });
  userAuth.addUser('deputy', 'deputy-password', ['admin']);
  const broker = new ApprovalBroker({ storePath: join(dir, 'approvals.json') });
  await broker.start();
  const registry = new ChannelProfileRegistry(new ChannelProfileStore(join(dir, 'channel-profiles.json')));
  const catalog = new GatewayMethodCatalog();
  // A session no binding covers runs in just-vibes on this host.
  registerChannelProfilesGatewayMethods(catalog, registry, { hostMode: () => 'just-vibes', ownerApprovals: broker });
  const helper = new DaemonControlPlaneHelper({
    gatewayMethods: catalog, userAuth, pairingTokens: new PairingTokenManager(join(dir, 'pairing-tokens.json')),
    controlPlaneGateway: new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() }),
    distributedRuntime: new DistributedRuntimeManager(join(dir, 'remote', 'distributed-runtime.json')),
    allowedBrowserOrigins: () => [], authToken: () => OPERATOR_TOKEN, trustProxyEnabled: () => false, host: '127.0.0.1', port: 3421,
  } as unknown as DaemonControlPlaneContext);
  const deputy = userAuth.createSession('deputy').token;
  const call = async (authToken: string, methodId: string, body: Record<string, unknown>) => {
    const result = await helper.invokeGatewayMethodCall({ authToken, methodId, body });
    return { status: result.status, code: (result.body as { code?: string }).code };
  };
  const ops = { surfaceKind: 'slack', channelId: 'C-ops' };
  const modeOfOps = async () => (await registry.explain('slack', 'C-ops'))?.profile.permissionMode;

  // The owner holds the ops channel to ask-me.
  expect((await call(OPERATOR_TOKEN, 'channels.profiles.set', { ...ops, permissionMode: 'ask-me' })).status).toBe(200);

  // Each of these loosens ask-me (to yolo, to the host's just-vibes): none is applied, each waits for the owner.
  const loosenings: Array<[string, Record<string, unknown>]> = [
    ['channels.profiles.set', { ...ops, permissionMode: 'yolo' }],
    ['channels.profiles.set', { ...ops, model: 'some-model' }],
    ['channels.profiles.delete', ops],
  ];
  for (const [methodId, body] of loosenings) {
    expect({ methodId, ...(await call(deputy, methodId, body)) }).toEqual({ methodId, status: 202, code: 'OWNER_APPROVAL_PENDING' });
    expect({ methodId, mode: await modeOfOps() }).toEqual({ methodId, mode: 'ask-me' });
  }
  expect(broker.listApprovals().map((entry) => entry.request.tool).sort()).toEqual(loosenings.map(([methodId]) => methodId).sort());

  // The controls: the admin's tightening applies at once, and so does the owner's loosening.
  expect((await call(deputy, 'channels.profiles.set', { ...ops, permissionMode: 'plan' })).status).toBe(200);
  expect(await modeOfOps()).toBe('plan');
  expect((await call(OPERATOR_TOKEN, 'channels.profiles.set', { ...ops, permissionMode: 'yolo' })).status).toBe(200);
  expect(await modeOfOps()).toBe('yolo');
});

test('the Agent\'s credential claims no approval and cancels only one it raised', async () => {
  const broker = new ApprovalBroker({ storePath: join(dir, 'approvals.json') });
  await broker.start();
  const actions = localApprovalActions(broker);
  // The Agent's credential: the model acting for the owner.
  const agent = actions.viewerOf(actorFromPrincipal({ principalId: 'pairing:agent-1', credentialKind: 'agent' }, NO_OWNER_USER));
  const raise = async (callId: string, raisedBy: string): Promise<SharedApprovalRecord> => {
    const raised = await broker.raiseApproval({
      request: { callId, tool: 'payments.purchase', args: { merchant: `${callId}.example` }, category: 'execute',
        analysis: { classification: 'payment', riskLevel: 'high', summary: 'Buy a burr coffee grinder for USD 120.00', reasons: [] } },
      metadata: { raisedVia: 'approvals.raise', raisedByPrincipal: raisedBy },
    });
    void raised.decision.catch(() => undefined);
    return raised.approval;
  };
  const owners = await raise('owners', 'owner');
  const its = await raise('its-own', 'pairing:agent-1');
  const act = { actor: 'pairing:agent-1', actorSurface: 'agent' };
  const status = (id: string) => broker.getApproval(id)?.status;

  const claimed = await actions.claim(owners.id, { ...act, expectedRevision: owners.revision }, agent);
  const cancelled = await actions.cancel(owners.id, { ...act, expectedRevision: owners.revision }, agent);
  expect([claimed.applied, cancelled.applied]).toEqual([false, false]);
  const code = (outcome: typeof claimed) => outcome.applied ? 'applied' : outcome.refusal.code;
  expect([code(claimed), code(cancelled)]).toEqual(['OWNER_ONLY', 'OWNER_ONLY']);
  expect(status(owners.id)).toBe('pending');

  // The control: an ask its own credential raised, which it no longer wants, it may cancel.
  expect((await actions.cancel(its.id, { ...act, expectedRevision: its.revision }, agent)).applied).toBe(true);
  expect(status(its.id)).toBe('cancelled');
});
