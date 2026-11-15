import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationRouteStore } from '../platform/src/platform/automation/store/routes.js';
import { RouteBindingManager } from '../platform/src/platform/channels/route-manager.js';
import { createTelegramSourceAccountOwner } from '../platform/src/platform/channels/telegram/source-account.js';
import { ApprovalBroker } from '../platform/src/platform/control-plane/approval-broker.js';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.js';
import type { DelegatedTelegramConfiguration, DelegatedInboundChoices } from '../platform/src/platform/control-plane/delegated-inbound-wire.js';
import type { NativeInboundSourceRef } from '../platform/src/platform/control-plane/native-inbound-source.js';
import type { DelegatedTelegramIntake } from '../platform/src/platform/daemon/delegated-telegram-intake.js';
import { composeDelegatedTelegramIntake } from '../platform/src/platform/daemon/facade-delegated-telegram.js';
import type { ResolvedDaemonFacadeRuntime } from '../platform/src/platform/daemon/facade-types.js';
import type { WorkspaceSwapManagerLike } from '../daemon-api/src/system-route-types.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { createShellPathService } from '../platform/src/platform/runtime/shell-paths.js';
import type { NativeExecutionAuthority, NativePairedSnapshot } from '../platform/src/platform/security/http-auth.js';
import { createNativeDataWriteOwner, assertNativeReaderCompatible, NativeDataCompatibilityError, NATIVE_READER_REQUIREMENT_FILE } from '../platform/src/platform/runtime/native-reader-compatibility.js';
import { realUpdateFileIo } from '../platform/src/platform/runtime/self-update.js';
import { WorkspaceSwapManager } from '../platform/src/platform/workspace/workspace-swap-manager.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const original = 'Synthetic external original retained for workspace-fence review';
const configuration: DelegatedTelegramConfiguration = {
  chatId: '42', accountId: '123', pendingRetention: 'memory-only-until-deadline', pendingRetentionMs: 10_000,
  configurationLifetimeMs: 60_000, onExpiry: 'release-original-and-hold',
};
const choices: DelegatedInboundChoices = {
  processingPurpose: 'accept-external-message-for-owner-review', sourceRetention: 'memory-only-until-review-close-or-deadline',
  sourceRetentionMs: 10_000, derivedRecord: 'external-source-reference-only-v1', derivedRecordRetentionMs: 20_000,
  execution: 'none', ownerMayReadOriginal: true,
};
type PendingSource = { ref: NativeInboundSourceRef; approvalId: string };

async function fixture(beforeWrite?: () => void) {
  const directory = mkdtempSync(join(tmpdir(), 'delegated-workspace-fence-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const initialRoot = join(directory, 'first');
  const replacementRoot = join(directory, 'second');
  const runtimeBus = new RuntimeEventBus();
  const accounts = createTelegramSourceAccountOwner();
  cleanups.push(() => accounts.invalidate());
  const lease = accounts.attach({ lifetime: new AbortController().signal, isCurrent: async () => true, isCurrentSync: () => true,
    readIdentity: async () => ({ id: '123', username: 'synthetic_bot' }) });
  const routes = new RouteBindingManager({ store: new AutomationRouteStore(join(directory, 'routes.json')) });
  const binding = await routes.upsertBinding({ kind: 'channel', surfaceKind: 'telegram', surfaceId: 'synthetic_bot', externalId: '42', channelId: '42' });
  const broker = new SharedSessionBroker({ storePath: join(directory, 'broker.json'), routeBindings: routes,
    agentStatusProvider: { getStatus: () => null }, messageSender: { send: () => false } });
  cleanups.push(() => broker.stop());
  const approvals = new ApprovalBroker({ storePath: join(directory, 'approvals.json') });
  const owner: NativePairedSnapshot = { kind: 'pairing-token', tokenId: 'synthetic-workspace-owner',
    principalId: 'pairing:synthetic-workspace-owner', authorityId: 'pairing:synthetic-workspace-owner',
    authorityRevision: 'synthetic-workspace-owner', scopes: ['read:work-ledger', 'write:work-ledger'] };
  const authority: NativeExecutionAuthority = { current: () => owner,
    withCurrent: async (_expected, use) => use(() => owner) };
  const manager = new WorkspaceSwapManager(initialRoot, { runtimeBus, daemonHomeDir: join(directory, 'daemon') });
  const execPath = join(directory, 'goodvibes-daemon');
  const nativeDataWriter = createNativeDataWriteOwner({ execPath, version: '3.1.2', assertCurrent: () => { beforeWrite?.(); } });
  const construct = (workspaceRoot = manager.getCurrentWorkingDir(), swapManager: WorkspaceSwapManagerLike | null = manager) => {
    const runtime = { sessionBroker: broker, approvalBroker: approvals, routeBindings: routes, runtimeBus,
      gatewayMethods: new GatewayMethodCatalog(), runtimeServices: { workingDirectory: workspaceRoot, nativeDataWriter,
        shellPaths: createShellPathService({ workingDirectory: workspaceRoot, homeDirectory: directory }) },
    } as unknown as ResolvedDaemonFacadeRuntime;
    const host = composeDelegatedTelegramIntake(runtime, accounts.reader, swapManager);
    cleanups.push(() => host.close());
    return host;
  };
  let message = 0;
  const accept = async (host: DelegatedTelegramIntake, readOriginal = () => original) => {
    const account = await lease.acquire();
    expect(account).not.toBeNull();
    return host.accept({ binding: routes.getBinding(binding.id)!, chatId: '42', providerMessageId: String(++message),
      account: account!, readOriginal });
  };
  const approve = async (host: DelegatedTelegramIntake) => {
    const pending = await accept(host) as PendingSource;
    expect(pending.ref).toBeDefined();
    expect(await host.decide({ ref: pending.ref, approvalId: pending.approvalId, approved: true, choices }, authority)).toMatchObject({ outcome: 'transferred' });
    expect(await host.status(pending.ref, authority, true)).toMatchObject({ source: 'available-in-memory', original: { text: original } });
    return pending;
  };
  return { directory, execPath, initialRoot, replacementRoot, authority, broker, construct, accept, approve, runtimeBus, manager };
}

test('a working-directory change, saved or refused, leaves delegated intake open in this process', async () => {
  const f = await fixture(); const host = f.construct();
  await host.configure(configuration, f.authority); const pending = await f.approve(host);
  const saved = await f.manager.requestSwap(f.replacementRoot);
  expect(saved.ok && saved.restartRequired).toBe(true);
  expect((await f.manager.requestSwap('')).ok).toBe(false);
  expect(await f.manager.requestSwap(f.initialRoot)).toMatchObject({ ok: true, restartRequired: false });
  expect(await host.status(pending.ref, f.authority, true)).toMatchObject({ source: 'available-in-memory', original: { text: original } });
  await f.approve(host);
});

test('a fixed-root host without a swap manager can still explicitly configure and approve', async () => {
  const f = await fixture(); const host = f.construct(f.initialRoot, null);
  expect(await host.configure(configuration, f.authority)).toHaveProperty('configurationId');
  await f.approve(host);
});

test('real delegated composition publishes a reader requirement before its first explicit-owner receipt', async () => {
  const f = await fixture(); const host = f.construct();
  await host.configure(configuration, f.authority);
  const compatibility = join(f.directory, NATIVE_READER_REQUIREMENT_FILE);
  expect(existsSync(compatibility)).toBe(false);
  await f.approve(host);
  expect(existsSync(compatibility)).toBe(true);
  expect(() => assertNativeReaderCompatible(f.execPath, '3.1.2', realUpdateFileIo,
    { schema: 1, version: '3.1.2', formats: [] })).toThrow(NativeDataCompatibilityError);
});

test('a retired native writer cannot publish a delegated review receipt', async () => {
  let retired = false;
  const f = await fixture(() => { if (retired) throw new Error('Fixture native writer retired'); });
  const host = f.construct(); await host.configure(configuration, f.authority);
  const pending = await f.accept(host) as PendingSource; retired = true;
  expect(await host.decide({ ref: pending.ref, approvalId: pending.approvalId, approved: true, choices }, f.authority)).toMatchObject({ outcome: 'unknown' });
  expect((await host.list(f.authority)).records).toEqual([]);
  expect(await host.status(pending.ref, f.authority, true)).not.toHaveProperty('original');
  expect(existsSync(join(f.directory, NATIVE_READER_REQUIREMENT_FILE))).toBe(false);
});
