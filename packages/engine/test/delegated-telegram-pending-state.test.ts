import { createDaemonControlRouteHandlers } from '../daemon-api/src/control-routes.js';
import { dispatchGatewayRestRoutes } from '../daemon-api/src/gateway-rest-routes.js';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.js';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { DelegatedInboundReviewReceiver } from '../platform/src/platform/control-plane/delegated-inbound-receiver.js';
import { join } from 'node:path';
import { ApprovalBroker } from '../platform/src/platform/control-plane/approval-broker.js';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.js';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';
import { AutomationRouteStore } from '../platform/src/platform/automation/store/routes.js';
import { RouteBindingManager } from '../platform/src/platform/channels/route-manager.js';
import { handleTelegramSurfaceWebhook, processTelegramUpdate } from '../platform/src/platform/adapters/telegram/index.js';
import { TelegramBotApi } from '../platform/src/platform/channels/telegram/api.js';
import { createTelegramSourceAccountOwner } from '../platform/src/platform/channels/telegram/source-account.js';
import type { SurfaceAdapterContext } from '../platform/src/platform/adapters/types.js';
import { DelegatedTelegramIntake, type DelegatedTelegramIngress } from '../platform/src/platform/daemon/delegated-telegram-intake.js';
import { registerDelegatedTelegramCommands } from '../platform/src/platform/daemon/facade-delegated-telegram.js';
import type { NativeExecutionAuthority, NativePairedSnapshot } from '../platform/src/platform/security/http-auth.js';
import type { NativeInboundSourceRef } from '../platform/src/platform/control-plane/native-inbound-source.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const original = '  /goodvibes 🚲 e\u0301 repeat repeat\r\nEXTERNAL ORIGINAL\t ';
const choices = { processingPurpose: 'accept-external-message-for-owner-review', sourceRetention: 'memory-only-until-review-close-or-deadline', sourceRetentionMs: 10_000,
  derivedRecord: 'external-source-reference-only-v1', derivedRecordRetentionMs: 20_000, execution: 'none', ownerMayReadOriginal: true };
async function fixture(persistedPairing = false) {
  const directory = mkdtempSync(join(tmpdir(), 'delegated-telegram-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const routes = new RouteBindingManager({ store: new AutomationRouteStore(join(directory, 'routes.json')) });
  const sent: string[] = []; let spawned = 0; const configuredUsername = 'synthetic_bot'; let sourceReads = 0;
  const accounts = createTelegramSourceAccountOwner(); const providerCalls: string[] = [];
  let liveToken = ''; let transport = new AbortController();
  const attachAccount = (id: number, username: string, token: string) => {
    transport.abort(); transport = new AbortController(); liveToken = token;
    const api = new TelegramBotApi(token, async (url) => {
      providerCalls.push(url.split('/').pop()!);
      return Response.json({ ok: true, result: { id, username, is_bot: true, first_name: 'Synthetic fixture bot' } });
    });
    return accounts.attach({ lifetime: transport.signal, isCurrent: async () => liveToken === token, isCurrentSync: () => liveToken === token,
      readIdentity: signal => api.getVerifiedIdentity(signal) });
  };
  let lease = attachAccount(123, configuredUsername, '123:synthetic-original');
  cleanups.push(() => { transport.abort(); accounts.invalidate(); });
  const broker = new SharedSessionBroker({ storePath: join(directory, 'broker.json'), routeBindings: routes,
    agentStatusProvider: { getStatus: () => null }, messageSender: { send: (_from, _to, text) => { sent.push(text); return true; } } });
  cleanups.push(() => broker.stop());
  const approvals = new ApprovalBroker({ storePath: join(directory, 'approvals.json') });
  let current: NativePairedSnapshot | null = { kind: 'pairing-token', tokenId: 'synthetic-pairing', principalId: 'pairing:synthetic-pairing', authorityId: 'pairing:synthetic-pairing', authorityRevision: 'synthetic-pairing', scopes: ['read:work-ledger', 'write:work-ledger'] };
  let authority: NativeExecutionAuthority = { current: () => current, withCurrent: async (expected, callback) => {
    const assert = () => { if (!current || current.tokenId !== expected.tokenId) throw new Error('Owner revoked'); return current; }; assert(); const result = await callback(assert); assert(); return result;
  } };
  if (persistedPairing) {
    const manager = new PairingTokenManager(join(directory, 'synthetic-pairing.json'));
    const paired = manager.mint({ name: 'Offline test fixture only' });
    const helper = new DaemonControlPlaneHelper({ gatewayMethods: new GatewayMethodCatalog(), pairingTokens: manager, authToken: () => null, userAuth: { validateSession: () => null } } as unknown as DaemonControlPlaneContext);
    authority = helper.createNativeExecutionAuthority(paired.token, ['read:work-ledger', 'write:work-ledger'])!;
    current = authority.current();
  }
  const hostDeps = { broker, approvals, routes, accounts: accounts.reader, workspaceRoot: directory, selectionPath: join(directory, 'selection.json'), receiptPath: join(directory, 'review.json') };
  const host = new DelegatedTelegramIntake(hostDeps); cleanups.push(() => host.close());
  const catalog = new GatewayMethodCatalog(); registerDelegatedTelegramCommands(catalog, host);
  const invoke = (operation: string, body: Record<string, unknown> = {}) => catalog.invoke(`inbound.telegram.${operation}`, { body,
    context: { admin: true, principalKind: 'token', principalId: authority.current()?.principalId ?? 'revoked-owner', scopes: ['*'] }, isAuthorized: () => current !== null, nativeExecutionAuthority: authority });
  const policyInputs: unknown[] = [];
  const context = { serviceRegistry: { resolveSecret: async () => null }, configManager: { get: (key: string) => {
    if (key === 'surfaces.telegram.botUsername') return configuredUsername;
    if (key === 'surfaces.telegram.botToken') return liveToken;
    if (key === 'surfaces.telegram.webhookSecret') return 'synthetic-webhook-secret';
    return undefined;
  } }, routeBindings: routes, sessionBroker: broker, delegatedTelegram: {
    selects: (chatId: string, threadId?: string) => host.selects(chatId, threadId),
    accept: (input: DelegatedTelegramIngress) => host.accept({ ...input, readOriginal: () => { sourceReads++; return input.readOriginal(); } }),
  },
    authorizeSurfaceIngress: async (input: unknown) => { policyInputs.push(input); return { allowed: true, reason: 'synthetic' }; },
    parseSurfaceControlCommand: () => null, performSurfaceControlCommand: async () => 'unused', performInteractiveSurfaceAction: async () => 'unused',
    trySpawnAgent: () => { spawned++; return { id: 'legacy-fixture-agent' }; }, queueSurfaceReplyFromBinding: () => {},
  } as unknown as SurfaceAdapterContext;
  const configure = (overrides: Record<string, unknown> = {}) => invoke('configure', { chatId: '42', accountId: configuredUsername, pendingRetention: 'memory-only-until-deadline', pendingRetentionMs: 10_000,
    configurationLifetimeMs: 60_000, onExpiry: 'release-original-and-hold', ...overrides });
  const updateDeps = () => ({ acquireSourceAccount: lease.acquire });
  const ingress = async (text = original, id = 1) => (await processTelegramUpdate({ update_id: id, message: { message_id: id, chat: { id: 42, type: 'private' }, from: { id: 99 }, text } }, context, updateDeps())).json() as Promise<{ ref: NativeInboundSourceRef; approvalId: string; outcome: string; reason?: string }>;
  const decide = (pending: { ref: NativeInboundSourceRef; approvalId: string }, overrides: Record<string, unknown> = {}) => invoke('decide', { ref: pending.ref, approvalId: pending.approvalId, approved: true, choices, ...overrides });
  return { directory, broker, approvals, host, hostDeps, catalog, invoke, authority, context, policyInputs, configure, ingress, decide, sent, accounts, providerCalls,
    get updateDeps() { return updateDeps(); }, sourceReads: () => sourceReads,
    spawned: () => spawned, changeAccount: () => { lease = attachAccount(456, 'replacement_bot', '456:synthetic-replacement'); },
    rotateSameAccount: () => { lease = attachAccount(123, configuredUsername, '123:synthetic-rotated'); },
    replaceOwner: (change: Partial<NativePairedSnapshot>) => { if (!current) throw new Error('Fixture owner missing'); current = { ...current, ...change }; },
    mutateOwnerScopes: () => { if (!current) throw new Error('Fixture owner missing'); (current.scopes as string[]).push('read:other-fixture'); },
    revokeOwner: () => { current = null; } };
}

// ---- pending-review state machine ------------------------------------------------
type PendingView = { state: string };
const pendingOf = (f: Awaited<ReturnType<typeof fixture>>, requestId: string): PendingView =>
  (f.host as unknown as { pending: Map<string, PendingView> }).pending.get(requestId)!;

test('a decision attempt that fails returns the review to awaiting-owner so the owner can retry', async () => {
  const f = await fixture(); await f.configure(); const pending = await f.ingress();
  const record = pendingOf(f, pending.ref.requestId);
  const holder = record as unknown as { approval: { resolveOwnerDecision: (...a: unknown[]) => Promise<unknown> } };
  const approval = holder.approval;
  const real = approval.resolveOwnerDecision.bind(approval);
  let fail = true;
  holder.approval = { ...approval, resolveOwnerDecision: async (...args: unknown[]) => { if (fail) { fail = false; throw new Error('broker unavailable'); } return real(...args); } };
  await expect(f.decide({ ref: pending.ref, approvalId: pending.approvalId })).rejects.toThrow();
  expect(record.state).toBe('awaiting-owner');
  expect(await f.decide({ ref: pending.ref, approvalId: pending.approvalId })).toMatchObject({ outcome: 'transferred' });
});

test('cancel after the handoff does not overwrite the approved outcome with cancelled', async () => {
  const f = await fixture(); await f.configure(); const pending = await f.ingress();
  await f.decide({ ref: pending.ref, approvalId: pending.approvalId });
  const record = pendingOf(f, pending.ref.requestId);
  expect(record.state).toBe('transferred');
  expect(await f.invoke('cancel', { ref: pending.ref })).toMatchObject({ outcome: 'cancelled', execution: 'not-started' });
  expect(record.state).toBe('transferred');
});

test('a late denial callback does not overwrite a cancelled review with held', async () => {
  const f = await fixture(); await f.configure(); const pending = await f.ingress();
  const record = pendingOf(f, pending.ref.requestId);
  expect(await f.invoke('cancel', { ref: pending.ref })).toMatchObject({ outcome: 'cancelled' });
  await Bun.sleep(30);
  expect(record.state).toBe('cancelled');
});
