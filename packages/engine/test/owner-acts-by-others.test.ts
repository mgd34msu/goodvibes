// Proves: The model the Agent runs claims an approval, or cancels one that another caller raised.
// Red when: The approval actions port stops applying the reading's claim and cancel rule before it reaches the broker, so the Agent's credential claims an ask or cancels one it did not raise.
/**
 * Real components only: the approval actions port over a real approval broker; the Agent's credential is the model acting
 * for the user.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker, type SharedApprovalRecord } from '../platform/src/platform/control-plane/approval-broker.ts';
import { localApprovalActions } from '../platform/src/platform/control-plane/approval-actions.ts';
import { actorFromPrincipal, NO_OWNER_USER } from '@goodvibes/engine/daemon-api/http-policy';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gv-owner-acts-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/**
 * The daemon's dispatch over `catalog` as a daemon composes it: its user store (the owner is the account made at first
 * start), its pairing records, its approvals, and `capabilities.run` with the owner gate, where a method call the
 * dispatch puts to the owner waits for them and is sent again as it came on their yes.
 */
async function daemonOver(catalog: GatewayMethodCatalog, broker: ApprovalBroker, pairing: PairingTokenManager) {
  const userAuth = new UserAuthManager({ bootstrapFilePath: join(dir, 'users.json'), bootstrapCredentialPath: join(dir, 'bootstrap.txt'), scryptParams: { N: 1024, r: 1, p: 1 } });
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const config = new ConfigManager({ surfaceRoot: 'daemon', workingDir: dir, homeDir: home, configDir: join(home, '.goodvibes', 'daemon'), ownsDaemonTier: true });
  expect(config.setMany([{ key: 'permissions.mode' as ConfigKey, value: 'ask-me' }], localOwnerActor()).ok).toBe(true);
  const hookDispatcher = createHookDispatcher();
  const secrets = new SecretsManager({ projectRoot: dir, globalHome: home, surfaceRoot: 'daemon', daemonHome: join(home, '.goodvibes', 'daemon') });
  const rules = new UserPermissionRuleStore(join(dir, 'permission-rules.json'));
  cleanups.push(() => rules.close());
  const ownerGate = createCapabilityOwnerGate({ approvalBroker: broker, configManager: config, policyRuntimeState: new PolicyRuntimeState(), hookDispatcher,
    featureFlags: null, userPermissionRuleStore: rules, secretsManager: secrets, pairingTokens: pairing,
  } as unknown as Parameters<typeof createCapabilityOwnerGate>[0]);
  const helper: DaemonControlPlaneHelper = new DaemonControlPlaneHelper({
    gatewayMethods: catalog, userAuth, pairingTokens: pairing,
    controlPlaneGateway: new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() }),
    distributedRuntime: new DistributedRuntimeManager(join(dir, 'remote', 'distributed-runtime.json')),
    allowedBrowserOrigins: () => [], authToken: () => OPERATOR_TOKEN, trustProxyEnabled: () => false, host: '127.0.0.1', port: 3421,
    // Who reaches the owner's shared things (their channels among them), as the daemon composes it.
    sharedKind: createSharedKindGifts({ homeDirectory: home, broker }),
  } as unknown as DaemonControlPlaneContext);
  const nested = daemonNestedMethods({ gatewayMethods: catalog }, daemonMethodCallOf(() => helper, () => OPERATOR_TOKEN));
  registerCapabilityGatewayMethods(catalog, {
    catalog: async () => new CapabilityCatalog(movedCapabilityEntries()),
    services: createDaemonCapabilityServices({ configManager: config, hookDispatcher, secretsManager: secrets }),
    invokeMethod: nested.invokeMethod, invokeMethodCall: nested.invokeMethodCall,
    ...ownerGate,
  });
  const ownerName = userAuth.ownerUsername();
  if (ownerName === null) throw new Error('the user store made no owner account at first start');
  // What the owner gives a caller of their shared things (Devices and network, devices.give-shared).
  const giveShared = (principalId: string, kinds: readonly SharedKind[]) => new CallerSharedStore(resolveGoodVibesDaemonHome(home)).set(principalId, kinds);
  return { helper, userAuth, giveShared, owner: userAuth.createSession(ownerName).token };
}

/**
 * Under Ask me a call the gate decides waits on the owner's one answer: the question it raises is read (which act it
 * asks about) and answered No while the call waits, from the broker's own record of it.
 */
async function refusedWhileWaiting(broker: ApprovalBroker, send: () => Promise<{ readonly status: number; readonly body: unknown }>) {
  const seen = new Set(broker.listApprovals(Number.MAX_SAFE_INTEGER).map((record) => record.id));
  let asked: string | undefined;
  const stop = broker.subscribe((record) => {
    if (seen.has(record.id) || record.status !== 'pending') return;
    seen.add(record.id);
    asked = String(record.metadata['capabilityId']);
    void broker.resolveApproval(record.id, { approved: false, actor: 'owner', expectedRevision: record.revision, reason: 'Not now.' }).catch(() => undefined);
  });
  try {
    const result = await send();
    return { status: result.status, code: (result.body as { code?: string }).code, asked };
  } finally {
    stop();
  }
}

test('an admin who is not the owner revokes no device the owner paired and cannot replace the shared token; the owner can revoke', async () => {
  const pairing = new PairingTokenManager(join(dir, 'pairing-tokens.json'));
  const broker = new ApprovalBroker({ storePath: join(dir, 'approvals.json') });
  await broker.start();
  const catalog = new GatewayMethodCatalog();
  registerPairingGatewayMethods(catalog, pairing, undefined, broker);
  const { helper, userAuth, owner } = await daemonOver(catalog, broker, pairing);
  // The owner is the first user; `deputy` is an admin who is not the owner.
  userAuth.addUser('deputy', 'deputy-password', ['admin']);

  // The owner paired their phone from their own machine.
  const phone = pairing.mint({ name: 'owner phone', origin: 'owner-pairing', madeBy: { owner: true } });
  expect(pairing.authenticate(phone.token)?.id).toBe(phone.id);
  const deputy = userAuth.createSession('deputy').token;

  // Withdrawing access the deputy neither holds nor minted is the owner's own act: refused, never put to the owner (no question).
  const revoke = await refusedWhileWaiting(broker, () => helper.invokeGatewayMethodCall({ authToken: deputy, methodId: 'pairing.tokens.delete', body: { id: phone.id } }));
  expect({ ...revoke, code: OWNERS_OWN_REFUSALS.has(String(revoke.code)) ? 'refused as the owner\'s own act' : revoke.code })
    .toEqual({ status: 403, code: 'refused as the owner\'s own act', asked: undefined });
  expect(pairing.authenticate(phone.token)?.id).toBe(phone.id);

  const replace = await helper.invokeGatewayMethodCall({ authToken: deputy, methodId: 'pairing.tokens.revokeShared', body: {} });
  expect({ status: replace.status, code: (replace.body as { code?: string }).code }).toEqual({ status: 403, code: 'OWNER_ONLY' });
  expect(pairing.isLegacyRevoked()).toBe(false);

  // The control: the owner in person (their signed-in session) revokes it at once.
  const own = await helper.invokeGatewayMethodCall({ authToken: owner, methodId: 'pairing.tokens.delete', body: { id: phone.id } });
  expect(own.status).toBe(200);
  expect(pairing.authenticate(phone.token)).toBeNull();
});

test('an admin who is not the owner cannot loosen the permission mode a channel\'s sessions run under; that admin can tighten it and the owner can loosen it', async () => {
  const broker = new ApprovalBroker({ storePath: join(dir, 'approvals.json') });
  await broker.start();
  const registry = new ChannelProfileRegistry(new ChannelProfileStore(join(dir, 'channel-profiles.json')));
  const catalog = new GatewayMethodCatalog();
  // A session no binding covers runs in just-vibes on this host.
  registerChannelProfilesGatewayMethods(catalog, registry, { hostMode: () => 'just-vibes', ownerApprovals: broker });
  const { helper, userAuth, owner, giveShared } = await daemonOver(catalog, broker, new PairingTokenManager(join(dir, 'pairing-tokens.json')));
  userAuth.addUser('deputy', 'deputy-password', ['admin']);
  // The owner let the deputy use their channels: what it does with them is still decided by what each act is.
  giveShared('deputy', ['channels']);
  const deputy = userAuth.createSession('deputy').token;
  const call = async (authToken: string, methodId: string, body: Record<string, unknown>) => {
    const result = await helper.invokeGatewayMethodCall({ authToken, methodId, body });
    return { status: result.status, code: (result.body as { code?: string }).code };
  };
  const ops = { surfaceKind: 'slack', channelId: 'C-ops' };
  const modeOfOps = async () => (await registry.explain('slack', 'C-ops'))?.profile.permissionMode;

  // The owner holds the ops channel to ask-me.
  expect((await call(owner, 'channels.profiles.set', { ...ops, permissionMode: 'ask-me' })).status).toBe(200);

  // Each of these loosens ask-me (to yolo, to the host's just-vibes): the owner's own act, each refused, never put to the
  // owner (no question), and none applied.
  const loosenings: Array<[string, Record<string, unknown>]> = [
    ['channels.profiles.set', { ...ops, permissionMode: 'yolo' }],
    ['channels.profiles.set', { ...ops, model: 'some-model' }],
    ['channels.profiles.delete', ops],
  ];
  for (const [methodId, body] of loosenings) {
    const answered = await refusedWhileWaiting(broker, () => helper.invokeGatewayMethodCall({ authToken: deputy, methodId, body }));
    expect({ methodId, ...answered, code: OWNERS_OWN_REFUSALS.has(String(answered.code)) ? 'refused as the owner\'s own act' : answered.code })
      .toEqual({ methodId, status: 403, code: 'refused as the owner\'s own act', asked: undefined });
    expect({ methodId, mode: await modeOfOps() }).toEqual({ methodId, mode: 'ask-me' });
  }

  // The controls: the admin's tightening applies at once, and so does the owner's loosening.
  expect((await call(deputy, 'channels.profiles.set', { ...ops, permissionMode: 'plan' })).status).toBe(200);
  expect(await modeOfOps()).toBe('plan');
  expect((await call(owner, 'channels.profiles.set', { ...ops, permissionMode: 'yolo' })).status).toBe(200);
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
