/**
 * store-write-ordering.test.ts
 *
 * One defect, four stores. The rest of the stores that share it are pinned in
 * store-write-ordering-registries.test.ts and store-write-ordering-extras.test.ts.
 *
 * `PersistentStore.persist` replaces a file atomically, so no reader ever sees
 * a torn write, but it says nothing about ORDER. A caller that serialises its
 * whole store from a snapshot and starts two of those writes at once finishes
 * them in whatever order their renames land, so the write that STARTED first
 * can FINISH last and put its older view back on disk. CI demonstrated it on
 * `ApprovalBroker` (approval-broker-persist-ordering.test.ts): an approved
 * payment approval read back as pending after a restart.
 *
 * Every test here forces the same interleaving with the same harness, a real
 * store whose next write is parked on a gate the test releases, so the overlap
 * is the same on an idle machine and a loaded one, and asserts the REAL consequence of the defect rather than a
 * general statement about ordering: a revoked permission rule that comes back,
 * a cancelled batch job that reads back queued, a deleted CI watch that keeps
 * notifying. Each one fails if its store's write queue is removed.
 *
 * The assertions read the FILE, not the object under test. Every one of these
 * defects leaves the in-memory state perfectly correct; what it loses is the
 * bytes a restart reads.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from './_helpers/test-timeout.js';
import {
  makeControllableStore,
  readOnDisk,
  replaceInternalStore,
  settleCompetingWrite,
  type ControllableStore,
} from './_helpers/controllable-store.js';

import { UserPermissionRuleStore, type StoredUserPermissionRule } from '../platform/src/platform/permissions/user-rule-store.js';
import { DaemonBatchManager } from '../platform/src/platform/batch/manager.js';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import type { LLMProvider, ProviderBatchResult } from '../platform/src/platform/providers/interface.js';
import type { ProviderRegistry } from '../platform/src/platform/providers/registry.js';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.js';
import type { RouteBindingManager } from '../platform/src/platform/channels/index.js';
import { ChannelPolicyManager } from '../platform/src/platform/channels/policy-manager.js';

/** A temp directory that the caller is responsible for removing. */
function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `gv-${prefix}-`));
}

// ---------------------------------------------------------------------------
// 1. UserPermissionRuleStore, a revoked always-allow rule must stay revoked.
// ---------------------------------------------------------------------------

interface UserRuleFileShape extends Record<string, unknown> {
  readonly version: 1;
  readonly rules: readonly StoredUserPermissionRule[];
}

function alwaysAllowRule(id: string): StoredUserPermissionRule {
  return {
    rule: {
      id,
      type: 'prefix',
      origin: 'user',
      effect: 'allow',
      toolPattern: 'exec',
      commandPrefixes: ['git push'],
    },
    createdAt: Date.now(),
    tier: 'command-class',
    tool: 'exec',
  };
}

describe('UserPermissionRuleStore: a revoked rule does not come back', () => {
  test('the rule an operator revoked is absent from the file a fresh store reads', async () => {
    const { store, path, cleanup } = makeControllableStore<UserRuleFileShape>('user-rules', 'user-rules.json');
    try {
      const rules = new UserPermissionRuleStore(path);
      replaceInternalStore(rules, 'store', store);
      await rules.init();

      // The remembered decision's write is the slow one, it is the one the
      // revocation must follow. Even if the caller knows the rule id before
      // the add commits, its queued delete must see the completed addition.
      const release = store.holdNext();
      const adding = rules.add(alwaysAllowRule('rule-always-allow-git-push'));
      await waitFor(() => store.started >= 1);
      const removing = rules.delete('rule-always-allow-git-push');
      await settleCompetingWrite(store, 1);
      release();
      expect(await removing).toBe(true);
      await adding;
      await waitFor(() => store.finished >= 2);

      // What a restart reads. A durable user rule is consulted BEFORE anything
      // prompts, so this rule surviving means the next `git push` is
      // auto-approved by a rule its owner took away.
      const fresh = new UserPermissionRuleStore(path);
      await fresh.init();
      expect(fresh.rules().map((rule) => rule.id)).not.toContain('rule-always-allow-git-push');
      expect(readOnDisk<UserRuleFileShape>(path)?.rules ?? []).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. DaemonBatchManager, a cancelled job is never submitted to the provider.
// ---------------------------------------------------------------------------

function makeBatchProvider(): LLMProvider & { readonly submitted: string[] } {
  const submitted: string[] = [];
  return {
    name: 'openai',
    models: ['gpt-test'],
    submitted,
    isConfigured: () => true,
    async chat() { throw new Error('not used'); },
    batch: {
      kind: 'provider-batch',
      endpoints: ['/v1/chat/completions'],
      async createChatBatch(input) {
        submitted.push(...input.requests.map((request) => request.customId));
        return { providerBatchId: 'provider-batch-1', status: 'submitted' };
      },
      async retrieveBatch(providerBatchId) {
        return { providerBatchId, status: 'submitted', resultAvailable: false };
      },
      async getResults(): Promise<ProviderBatchResult[]> { return []; },
    },
  };
}

function makeBatchRegistry(provider: LLMProvider): Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'getRegistered' | 'listProviders'> {
  return {
    getCurrentModel: () => ({
      id: 'gpt-test',
      provider: 'openai',
      registryKey: 'openai:gpt-test',
      displayName: 'GPT Test',
      description: 'test model',
      capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
      contextWindow: 128_000,
      selectable: true,
      tier: 'standard',
    }),
    getForModel: () => provider,
    getRegistered: () => provider,
    listProviders: () => [provider],
  };
}

interface BatchStoreShape extends Record<string, unknown> {
  readonly version: 1;
  readonly jobs: Record<string, { readonly status: string }>;
}

describe('DaemonBatchManager: a cancelled job does not read back queued', () => {
  test("the operator's cancel survives a tick whose write was already in flight", async () => {
    const { store, path, cleanup } = makeControllableStore<BatchStoreShape>('batch-order', 'batch-jobs.json');
    const configDir = tempDir('batch-config');
    try {
      const configManager = new ConfigManager({ configDir });
      configManager.set('batch.mode', 'explicit');
      const provider = makeBatchProvider();
      const manager = new DaemonBatchManager({
        configManager,
        providerRegistry: makeBatchRegistry(provider),
        storePath: path,
      });
      replaceInternalStore(manager, 'store', store);

      // A batch already at the provider: the pass polls it, which changes a
      // row, so the pass writes at its end. A pass with nothing to change
      // writes nothing and has no write to race.
      await manager.createJob({
        provider: 'openai',
        model: 'gpt-test',
        request: { messages: [{ role: 'user', content: 'already submitted' }] },
        flush: true,
      });
      const job = await manager.createJob({
        provider: 'openai',
        model: 'gpt-test',
        request: { messages: [{ role: 'user', content: 'summarise the day' }] },
      });
      expect(job.status).toBe('queued');
      const writesBefore = store.started;

      // A tick's write is the slow one. The tick begins with provider I/O and
      // writes at the end of the pass, so its write is routinely in flight when
      // an operator acts.
      const release = store.holdNext();
      const ticking = manager.tick();
      await waitFor(() => store.started >= writesBefore + 1);

      const cancelling = manager.cancelJob(job.id);
      await settleCompetingWrite(store, writesBefore + 1);
      release();
      const cancelled = await cancelling;
      expect(cancelled.status).toBe('cancelled');
      await ticking;
      await waitFor(() => store.finished >= writesBefore + 2);

      // What the next daemon start reads. 'queued' here is a job the next tick
      // submits to the provider, a paid request the operator called off.
      expect(readOnDisk<BatchStoreShape>(path)?.jobs[job.id]?.status).toBe('cancelled');
    } finally {
      cleanup();
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. SharedSessionBroker, a cancelled input does not read back queued.
// ---------------------------------------------------------------------------

interface SessionStoreShape extends Record<string, unknown> {
  readonly inputs: readonly { readonly id: string; readonly state: string }[];
}

function makeSessionBroker(store: ControllableStore<SessionStoreShape>): SharedSessionBroker {
  const routeBindings = {
    start: async () => {},
    stop: async () => {},
    list: () => [],
    find: () => null,
    resolve: () => null,
    bind: async () => ({}),
    unbind: async () => {},
    patch: async () => null,
    patchBinding: async () => null,
    getBinding: () => null,
  } as unknown as RouteBindingManager;
  return new SharedSessionBroker({
    store: store as never,
    routeBindings,
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: async () => {} },
    // Both idle thresholds at zero so one `trimRetained('floor')` makes the GC
    // sweep find something to do, which is what makes it write. In the daemon
    // that write happens on a 60-second timer, unawaited, against whatever the
    // other sixteen persisting verbs are doing.
    idleEmptyMs: 0,
    idleLongMs: 0,
  } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]);
}

describe('SharedSessionBroker: a cancelled input does not read back queued', () => {
  test("the GC sweep's unawaited write cannot undo a cancel requested after it", async () => {
    const { store, path, cleanup } = makeControllableStore<SessionStoreShape>('session-order', 'sessions.json');
    try {
      const broker = makeSessionBroker(store);
      await broker.start();
      await broker.createSession({ id: 'sess-order' });
      await broker.submitMessage({
        sessionId: 'sess-order',
        surfaceKind: 'tui',
        surfaceId: 'tui-1',
        body: 'deploy the release',
      } as never);
      const queued = broker.getInputs('sess-order').find((entry) => entry.state === 'queued');
      expect(queued).toBeDefined();

      // A second, idle session, because the sweep only writes when it finds
      // something to close and it never closes a session with a pending input.
      // That is the shape in the daemon too: the sweep is reaping one session
      // while another is busy, and it writes the WHOLE store either way.
      await broker.createSession({ id: 'sess-idle' });

      // The sweep's write is the slow one, and it is fired without being
      // awaited, exactly as the 60-second timer fires it.
      const before = store.started;
      const release = store.holdNext();
      broker.trimRetained('floor');
      await waitFor(() => store.started > before);

      const cancelling = broker.cancelInput('sess-order', queued?.id as string);
      await settleCompetingWrite(store, before + 1);
      release();
      const cancelled = await cancelling;
      expect(cancelled?.state).toBe('cancelled');
      await waitFor(() => store.finished >= store.started);

      // What boot reconciliation reads. A 'queued' input is work waiting to be
      // picked up, so this is an agent spawned for work somebody cancelled.
      const onDisk = readOnDisk<SessionStoreShape>(path)?.inputs ?? [];
      expect(onDisk.find((entry) => entry.id === queued?.id)?.state).toBe('cancelled');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. ChannelPolicyManager, a "disable this surface" ruling does not revert.
// ---------------------------------------------------------------------------

interface ChannelPolicyShape extends Record<string, unknown> {
  readonly policies: readonly { readonly surface: string; readonly enabled: boolean }[];
}

describe('ChannelPolicyManager: a disabled surface stays disabled', () => {
  test('the debounced audit flush cannot put an enabled surface back', async () => {
    const { store, path, cleanup } = makeControllableStore<ChannelPolicyShape>('channel-policy-order', 'channel-policies.json');
    try {
      const manager = new ChannelPolicyManager({ store: store as never });
      await manager.start();
      // Seed the owner allowlist first, so evaluateIngress below does not also
      // take the self-seeding path and write on its own account.
      await manager.upsertPolicy('telegram' as never, { allowlistUserIds: ['owner'] });

      // One inbound message. Its audit entry is written by the debounced flush
      // a second later, the write that races every policy change.
      await manager.evaluateIngress({
        surface: 'telegram',
        userId: 'owner',
        conversationKind: 'direct',
        text: 'status?',
      } as never);

      const release = store.holdNext();
      const before = store.started;
      await waitFor(() => store.started > before, { timeoutMs: 10_000 });

      const disabling = manager.upsertPolicy('telegram' as never, { enabled: false });
      await settleCompetingWrite(store, before + 1);
      release();
      await disabling;
      await waitFor(() => store.finished >= store.started);

      // What a restart reads. `enabled: true` here is a surface its owner
      // switched off answering messages again.
      const policy = readOnDisk<ChannelPolicyShape>(path)?.policies.find((entry) => entry.surface === 'telegram');
      expect(policy?.enabled).toBe(false);
    } finally {
      cleanup();
    }
  });
});
