/**
 * The persistent stores behind sessions, knowledge, memory, inbound mail and
 * settings, each opened at the path the product composition gives it under the
 * isolated home, prefilled, then driven through its public method.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigManager } from '../../../platform/src/platform/config/manager.ts';
import { createShellPathService } from '../../../platform/src/platform/runtime/shell-paths.ts';
import { openStateDecisionLogWithNotice } from '../../../platform/src/platform/state/decision-log.ts';
import { SharedSessionBroker } from '../../../platform/src/platform/control-plane/session-broker.ts';
import { createSharedSessionRecord } from '../../../platform/src/platform/control-plane/session-broker-sessions.ts';
import { controlPlaneStorePath } from '../../../platform/src/platform/control-plane/control-plane-store-paths.ts';
import type { SharedSessionMessage } from '../../../platform/src/platform/control-plane/session-types.ts';
import type { RouteBindingManager } from '../../../platform/src/platform/channels/route-manager.ts';
import { KnowledgeStore } from '../../../platform/src/platform/knowledge/store.ts';
import { KnowledgeService } from '../../../platform/src/platform/knowledge/service.ts';
import { ArtifactStore } from '../../../platform/src/platform/artifacts/store.ts';
import { MemoryStore } from '../../../platform/src/platform/state/memory-store.ts';
import { MemoryRegistry } from '../../../platform/src/platform/state/memory-registry.ts';
import { MemoryEmbeddingProviderRegistry } from '../../../platform/src/platform/state/memory-embeddings.ts';
import { InboundMailStore, type InboundMailRecordInput } from '../../../platform/src/platform/email/inbound/record-store.ts';
import { installCountingJudgment } from '../fakes.ts';
import type { Instance, MeasureEnv, Scenario } from '../harness.ts';

const P = 'packages/engine/platform/src/platform';
const SURFACE = 'tui';

/** The decision port the product installs records to the state root's decision log; so does this one. */
export function decisions(env: MeasureEnv, surface = SURFACE): { restore(): void } {
  const shellPaths = createShellPathService({ workingDirectory: env.workspace, homeDirectory: env.home });
  const { log } = openStateDecisionLogWithNotice(shellPaths.resolveProjectPath(surface));
  const install = installCountingJudgment({ log });
  return { restore() { install.restore(); log[Symbol.dispose](); } };
}

function config(env: MeasureEnv): ConfigManager {
  return new ConfigManager({ surfaceRoot: SURFACE, homeDir: env.home, workingDir: env.workspace });
}

// ---------------------------------------------------------------- sessions

const SESSIONS = 50;
const MESSAGES = 200;

export async function openBroker(env: MeasureEnv): Promise<{ broker: SharedSessionBroker; path: string; firstId: string; restore(): void }> {
  const judgment = decisions(env, 'daemon');
  const shellPaths = createShellPathService({ workingDirectory: env.workspace, homeDirectory: env.home });
  const path = controlPlaneStorePath(shellPaths, 'daemon', 'sessions.json');
  const now = Date.now();
  const sessions = [];
  const messages: SharedSessionMessage[] = [];
  for (let s = 0; s < SESSIONS; s++) {
    const participant = { surfaceKind: 'tui', surfaceId: `tui-${s}`, lastSeenAt: now } as const;
    const record = createSharedSessionRecord({ id: `sess-measure-${s}`, kind: 'tui', project: env.workspace, title: `Session ${s}`, participant } as Parameters<typeof createSharedSessionRecord>[0]);
    sessions.push({ ...record, messageCount: MESSAGES, lastMessageAt: now, lastActivityAt: now });
    for (let m = 0; m < MESSAGES; m++) {
      messages.push({
        id: `msg-${s}-${m}`, sessionId: record.id, role: m % 2 === 0 ? 'user' : 'assistant',
        body: `Message ${m} of session ${s}: ${'a realistic sentence of conversation text. '.repeat(4)}`,
        createdAt: now - (MESSAGES - m) * 1000, metadata: {},
      });
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ sessions, messages, inputs: [] }, null, 2));
  // Route bindings and agents are not part of what is measured; stubbed as test/session-broker.test.ts does.
  const routeBindings = {
    start: async () => {}, stop: async () => {}, list: () => [], find: () => null, resolve: () => null,
    bind: async () => ({}), unbind: async () => {}, patch: async () => null, getBinding: () => null,
    upsertBinding: async (binding: object) => ({ id: 'rb-1', ...binding }),
  } as unknown as RouteBindingManager;
  const broker = new SharedSessionBroker({
    storePath: path, routeBindings,
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: () => true } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]['messageSender'],
  });
  await broker.start();
  return { broker, path, firstId: 'sess-measure-0', restore: () => judgment.restore() };
}

const sessionEntries = [
  `${P}/control-plane/session-broker.ts:104 SharedSessionBroker (storePath as runtime/services.ts:505 gives it)`,
  `${P}/state/persistent-store.ts:314 PersistentStore.persist`,
];

const sessionHeartbeat: Scenario = {
  name: 'session-heartbeat',
  drives: `SharedSessionBroker.register with the same session id and participant (the client heartbeat; daemon/http/router-session-broker-adapter.ts:33) on a store of ${SESSIONS} sessions x ${MESSAGES} messages.`,
  entries: [`${P}/control-plane/session-broker.ts:452 SharedSessionBroker.register`, ...sessionEntries],
  async setup(env): Promise<Instance> {
    const b = await openBroker(env);
    return {
      async op() {
        await b.broker.register({ sessionId: b.firstId, kind: 'tui', project: env.workspace, participant: { surfaceKind: 'tui', surfaceId: 'tui-0', lastSeenAt: Date.now() } } as Parameters<SharedSessionBroker['register']>[0]);
        return { storeBytes: Bun.file(b.path).size };
      },
      async dispose() { await b.broker.stop(); b.restore(); },
    };
  },
};

const sessionAppend: Scenario = {
  name: 'session-append-message',
  drives: `SharedSessionBroker.appendCompanionMessage (one user message) on a store of ${SESSIONS} sessions x ${MESSAGES} messages.`,
  entries: [`${P}/control-plane/session-broker.ts:725 SharedSessionBroker.appendCompanionMessage -> appendMessage :831`, ...sessionEntries],
  async setup(env): Promise<Instance> {
    const b = await openBroker(env);
    return {
      async op(run) {
        await b.broker.appendCompanionMessage(b.firstId, { messageId: `measure-${run}-${Date.now()}`, body: 'one more message from the companion', timestamp: Date.now(), source: 'measure' });
        return { storeBytes: Bun.file(b.path).size };
      },
      async dispose() { await b.broker.stop(); b.restore(); },
    };
  },
};

// ---------------------------------------------------------------- knowledge

const SOURCES = 200;

async function openKnowledge(env: MeasureEnv): Promise<{ service: KnowledgeService; store: KnowledgeStore; memory: MemoryStore; restore(): void }> {
  const judgment = decisions(env);
  const configManager = config(env);
  const store = KnowledgeStore.forFamily({ configManager, dbFileName: 'knowledge-wiki.sqlite', family: 'wiki' });
  await store.init();
  await store.batch(async () => {
    for (let i = 0; i < SOURCES; i++) {
      await store.upsertSource({
        connectorId: 'bookmark', sourceType: 'url', status: 'indexed',
        canonicalUri: `https://docs.example.com/guide/page-${i}`, sourceUri: `https://docs.example.com/guide/page-${i}`,
        title: `Guide page ${i}: ${i % 3 === 0 ? 'deploying the service' : i % 3 === 1 ? 'configuring storage' : 'measuring latency'}`,
        summary: `How to work with topic ${i}. ${'Background and details for the reader. '.repeat(3)}`,
        tags: ['guide', `topic-${i % 10}`],
      });
    }
  });
  const memory = new MemoryStore(':memory:', { embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }), enableVectorIndex: false });
  await memory.init();
  const service = new KnowledgeService(store, new ArtifactStore({ configManager }), undefined, { memoryRegistry: new MemoryRegistry(memory) });
  return { service, store, memory, restore: () => judgment.restore() };
}

const knowledgeEntries = [
  `${P}/knowledge/store.ts:259 KnowledgeStore (forFamily wiki, knowledge-wiki.sqlite under the control-plane dir)`,
  `${P}/knowledge/scope-selection.ts:318 retain (per-source persisted reads)`,
  `${P}/state/sqlite-store.ts:1389 SQLiteStore (sql.js image on disk)`,
];

const knowledgeList: Scenario = {
  name: 'knowledge-list-200',
  runs: 3,
  drives: `KnowledgeService.listSources(${SOURCES}) over a store holding ${SOURCES} sources (added with upsertSource in one batch). No semantic service (the product attaches one; it is not on the list path).`,
  entries: [`${P}/knowledge/service.ts:320 KnowledgeService.listSources`, ...knowledgeEntries],
  async setup(env): Promise<Instance> {
    const k = await openKnowledge(env);
    return {
      async op() { return { listed: (await k.service.listSources(SOURCES)).length }; },
      async dispose() { await k.service.dispose(); await k.store.close(); k.memory.close(); k.restore(); },
    };
  },
};

const knowledgeSearch: Scenario = {
  name: 'knowledge-search-200',
  runs: 3,
  drives: `KnowledgeService.search('deploying the service', 10) over ${SOURCES} sources.`,
  entries: [`${P}/knowledge/service.ts:870 KnowledgeService.search`, `${P}/knowledge/packet.ts:36 searchKnowledge`, ...knowledgeEntries],
  async setup(env): Promise<Instance> {
    const k = await openKnowledge(env);
    return {
      async op() { return { results: (await k.service.search('deploying the service', 10)).length }; },
      async dispose() { await k.service.dispose(); await k.store.close(); k.memory.close(); k.restore(); },
    };
  },
};

// ---------------------------------------------------------------- memory

const MEMORIES = 500;

const memoryAdd: Scenario = {
  name: 'memory-add',
  drives: `MemoryRegistry.add of one record to the project memory store (<workspace>/.goodvibes/tui/memory.sqlite, as runtime/services.ts:562 places it, default options incl. vector index) holding ${MEMORIES} records (prefilled with add()).`,
  entries: [`${P}/state/memory-registry.ts:65 MemoryRegistry.add`, `${P}/state/memory-store.ts:423 MemoryStore.add`, `${P}/state/sqlite-store.ts:1389 SQLiteStore`],
  async setup(env): Promise<Instance> {
    const judgment = decisions(env);
    const configManager = config(env);
    const store = new MemoryStore(join(env.workspace, '.goodvibes', SURFACE, 'memory.sqlite'), { embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }) });
    await store.init();
    const registry = new MemoryRegistry(store);
    for (let i = 0; i < MEMORIES; i++) {
      await registry.add({ cls: i % 2 === 0 ? 'decision' : 'pattern', summary: `Remembered item ${i}: the build uses bun ${i % 7}`, detail: 'Detail text for the record. '.repeat(4), tags: [`t${i % 9}`] } as Parameters<MemoryRegistry['add']>[0]);
    }
    return {
      async op(run) {
        await registry.add({ cls: 'decision', summary: `Measured memory ${run}: keep the harness small`, detail: 'Recorded by the measurement harness.', tags: ['measure'] } as Parameters<MemoryRegistry['add']>[0]);
      },
      async dispose() { store.close(); judgment.restore(); },
    };
  },
};

// ---------------------------------------------------------------- inbound mail

const MAIL_RECORDS = 1000;

const inboundEmailStore: Scenario = {
  name: 'inbound-email-store',
  drives: `InboundMailStore.record of one new IMAP message into <home>/.goodvibes/daemon/email-inbound-records.json holding ${MAIL_RECORDS} records (seeded as test/inbound-mail-record-store.test.ts seeds), default policy.`,
  entries: [`${P}/email/inbound/record-store.ts:515 InboundMailStore.record`, `${P}/daemon/facade-inbound-mail.ts:292 (product path)`],
  async setup(env): Promise<Instance> {
    const path = join(env.home, '.goodvibes', 'daemon', 'email-inbound-records.json');
    mkdirSync(dirname(path), { recursive: true });
    const now = Date.now();
    const records = Array.from({ length: MAIL_RECORDS }, (_, i) => ({
      id: `rec-${i}`, account: 'acct-1', mailbox: 'INBOX', source: 'imap', uidValidity: 100, uid: i + 1,
      senderDisplay: `sender${i}@example.com`, subject: `Message ${i}`, deliveredToAddress: 'owner+alias@example.com',
      deliveryEvidenceSource: 'alias-mailbox', links: [{ registrableDomain: 'example.com', verdict: 'allowed' }],
      outcome: 'matched-expectation', noticeStatus: 'delivered', bodyExcerpt: `Body of message ${i}. ${'Plain text. '.repeat(10)}`,
      receivedAt: new Date(now - (MAIL_RECORDS - i) * 60_000).toISOString(),
    }));
    writeFileSync(path, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, 'utf-8');
    const store = new InboundMailStore(path);
    return {
      async op(run) {
        const input: InboundMailRecordInput = {
          account: 'acct-1', mailbox: 'INBOX', source: 'imap', uidValidity: 100, uid: MAIL_RECORDS + 10 + run,
          senderDisplay: 'noreply@github.com', subject: 'Verify your email', deliveredToAddress: 'owner+alias@example.com',
          deliveryEvidenceSource: 'alias-mailbox', links: [], outcome: 'matched-expectation', noticeStatus: 'delivered',
          body: 'hello world', receivedAt: new Date().toISOString(),
        } as InboundMailRecordInput;
        await store.record(input);
        return { storeBytes: Bun.file(path).size };
      },
    };
  },
};

// ---------------------------------------------------------------- config

const configEntries = [`${P}/config/manager.ts:229 ConfigManager({ surfaceRoot: 'tui', homeDir, workingDir })`];

const configGet: Scenario = {
  name: 'config-get',
  drives: "ConfigManager.get('display.collapseThreshold') on a manager built with the product's home/working-dir derivation.",
  entries: [`${P}/config/manager.ts:640 ConfigManager.get`, ...configEntries],
  async setup(env): Promise<Instance> {
    const manager = config(env);
    return { async op() { return { value: Number(manager.get('display.collapseThreshold')) }; } };
  },
};

const configSet: Scenario = {
  name: 'config-set',
  drives: "ConfigManager.set('display.collapseThreshold', 31|32) (an ordinary surface-tier key).",
  entries: [`${P}/config/manager.ts:1254 ConfigManager.set`, `${P}/utils/atomic-json-store.ts:553 writeJsonFileAtomic`, ...configEntries],
  async setup(env): Promise<Instance> {
    const manager = config(env);
    return { async op(run) { manager.set('display.collapseThreshold', 31 + (run & 1)); } };
  },
};

export const scenarios: Scenario[] = [sessionHeartbeat, sessionAppend, knowledgeList, knowledgeSearch, memoryAdd, inboundEmailStore, configGet, configSet];
