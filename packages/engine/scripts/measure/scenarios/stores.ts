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
import { assertOutcome, type Instance, type MeasureEnv, type Scenario } from '../harness.ts';

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

export async function openBroker(env: MeasureEnv): Promise<{ broker: SharedSessionBroker; path: string; firstId: string; routeBindings: RouteBindingManager; restore(): void }> {
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
  return { broker, path, firstId: 'sess-measure-0', routeBindings, restore: () => judgment.restore() };
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
      settled: () => b.broker.idle(),
      async op() {
        const seen = Date.now();
        const registered = await b.broker.register({ sessionId: b.firstId, kind: 'tui', project: env.workspace, participant: { surfaceKind: 'tui', surfaceId: 'tui-0', lastSeenAt: seen } } as Parameters<SharedSessionBroker['register']>[0]);
        assertOutcome(registered.record.id === b.firstId, `register answered ${registered.record.id} for ${b.firstId}`);
        return { storeBytes: Bun.file(b.path).size };
      },
      verify() {
        const session = b.broker.getSession(b.firstId);
        assertOutcome(session?.participants.some((p) => p.surfaceId === 'tui-0'), 'the session lost its participant after the heartbeat');
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
    let appended = '';
    return {
      settled: () => b.broker.idle(),
      async op(run) {
        appended = `measure-${run}-${Date.now()}`;
        await b.broker.appendCompanionMessage(b.firstId, { messageId: appended, body: 'one more message from the companion', timestamp: Date.now(), source: 'measure' });
        return { storeBytes: Bun.file(b.path).size };
      },
      async verify() {
        // What a restarted daemon would load: a second broker over the same file.
        const reopened = new SharedSessionBroker({ storePath: b.path, routeBindings: b.routeBindings, agentStatusProvider: { getStatus: () => null },
          messageSender: { send: () => true } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]['messageSender'] });
        await reopened.start();
        try {
          const messages = reopened.getMessages(b.firstId, 10_000);
          assertOutcome(messages.some((message) => message.body === 'one more message from the companion' && JSON.stringify(message).includes(appended)),
            `the appended message ${appended} is not in the stored session after reopening`);
        } finally { await reopened.stop(); }
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
  // The first view of new records queues their ordinary-view readings (one decision request per record, once per
  // content version). That is the cost of new records, not of a list: it is paid here, before anything is measured.
  await service.listSources(SOURCES);
  await service.scopeReadingsSettled();
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
  drives: `KnowledgeService.listSources(${SOURCES}) over a store holding ${SOURCES} sources (added with upsertSource in one batch). No semantic service (the product attaches one; it is not on the list path). The records' one-time ordinary-view readings are taken in setup.`,
  entries: [`${P}/knowledge/service.ts:320 KnowledgeService.listSources`, ...knowledgeEntries],
  async setup(env): Promise<Instance> {
    const k = await openKnowledge(env);
    return {
      settled: () => k.service.scopeReadingsSettled(),
      async op() {
        const listed = await k.service.listSources(SOURCES);
        assertOutcome(listed.length === SOURCES && new Set(listed.map((source) => source.id)).size === SOURCES,
          `listed ${listed.length} sources (${new Set(listed.map((source) => source.id)).size} distinct) of ${SOURCES} stored`);
        return { listed: listed.length };
      },
      async dispose() { await k.service.dispose(); await k.store.close(); k.memory.close(); k.restore(); },
    };
  },
};

/** A different wording each run (warm-up included), so every search is read afresh rather than reusing an earlier reading. */
const SEARCH_QUERIES = ['deploying the service', 'steps for deploying the service', 'deploying the service to production', 'what to check before deploying the service', 'deploying the service again', 'notes on deploying the service'];
/** Sources whose title is about deploying the service: every third one. */
const DEPLOY_SOURCES = Math.ceil(SOURCES / 3);

function knowledgeSearchScenario(name: string, drives: string, queryOf: (run: number) => string): Scenario {
  return {
    name, drives, runs: 3,
    entries: [`${P}/knowledge/service.ts:915 KnowledgeService.search`, `${P}/knowledge/packet.ts:35 searchKnowledge`, `${P}/knowledge/public-retrieval.ts:126 readPublicKnowledgeSelection`, ...knowledgeEntries],
    async setup(env): Promise<Instance> {
      const k = await openKnowledge(env);
      return {
        settled: () => k.service.scopeReadingsSettled(),
        async op(run) {
          const results = await k.service.search(queryOf(run), 10);
          const titles = results.map((result) => result.source?.title ?? result.node?.title ?? '');
          assertOutcome(results.length === Math.min(10, DEPLOY_SOURCES), `found ${results.length} results; ${DEPLOY_SOURCES} stored sources are about deploying the service, so 10 were expected`);
          assertOutcome(titles.every((title) => title.includes('deploying the service')), `a result is not about deploying the service: ${titles.find((title) => !title.includes('deploying the service'))}`);
          return { results: results.length };
        },
        async dispose() { await k.service.dispose(); await k.store.close(); k.memory.close(); k.restore(); },
      };
    },
  };
}

const knowledgeSearch = knowledgeSearchScenario('knowledge-search-200',
  `KnowledgeService.search(<a new wording of 'deploying the service' each run>, 10) over ${SOURCES} sources, ${DEPLOY_SOURCES} of them about deploying the service; each search is read afresh. The relevance reading answers yes for a source titled for it.`,
  (run) => SEARCH_QUERIES[run + 1]!);
const knowledgeSearchRepeat = knowledgeSearchScenario('knowledge-search-200-repeat',
  `KnowledgeService.search('deploying the service', 10) repeated over the same ${SOURCES} unchanged sources: the product reuses the earlier reading of the same request.`,
  () => SEARCH_QUERIES[0]!);

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
    let added: Awaited<ReturnType<MemoryRegistry['add']>> | undefined;
    for (let i = 0; i < MEMORIES; i++) {
      await registry.add({ cls: i % 2 === 0 ? 'decision' : 'pattern', summary: `Remembered item ${i}: the build uses bun ${i % 7}`, detail: 'Detail text for the record. '.repeat(4), tags: [`t${i % 9}`] } as Parameters<MemoryRegistry['add']>[0]);
    }
    return {
      async op(run) {
        added = await registry.add({ cls: 'decision', summary: `Measured memory ${run}: keep the harness small`, detail: 'Recorded by the measurement harness.', tags: ['measure'] } as Parameters<MemoryRegistry['add']>[0]);
      },
      verify(run) {
        assertOutcome(added && registry.get(added.id)?.summary === `Measured memory ${run}: keep the harness small`, `the added memory ${added?.id ?? '(none)'} cannot be read back`);
      },
      async dispose() { store.close(); judgment.restore(); },
    };
  },
};

// ---------------------------------------------------------------- inbound mail

const MAIL_RECORDS = 1000;

const inboundEmailStore: Scenario = {
  name: 'inbound-email-store',
  drives: `InboundMailStore.record of one new IMAP message into the record log <home>/.goodvibes/daemon/email-inbound-records.log.jsonl holding ${MAIL_RECORDS} records (seeded as the whole-file store email-inbound-records.json, imported once at setup), default policy.`,
  entries: [`${P}/email/inbound/record-store.ts:731 InboundMailStore.record`, `${P}/daemon/facade-inbound-mail.ts:292 (product path)`],
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
    // The one-time import of the seeded file happens here, so each run measures a steady-state write.
    await store.count();
    const logPath = path.replace(/\.json$/, '.log.jsonl');
    let recorded: Awaited<ReturnType<InboundMailStore['record']>> | undefined;
    return {
      async op(run) {
        const input: InboundMailRecordInput = {
          account: 'acct-1', mailbox: 'INBOX', source: 'imap', uidValidity: 100, uid: MAIL_RECORDS + 10 + run,
          senderDisplay: 'noreply@github.com', subject: 'Verify your email', deliveredToAddress: 'owner+alias@example.com',
          deliveryEvidenceSource: 'alias-mailbox', links: [], outcome: 'matched-expectation', noticeStatus: 'delivered',
          body: 'hello world', receivedAt: new Date().toISOString(),
        } as InboundMailRecordInput;
        recorded = await store.record(input);
        return { storeBytes: Bun.file(logPath).size };
      },
      async verify(run) {
        // What a restarted daemon would load: a second store over the same files.
        const reopened = new InboundMailStore(path);
        const found = recorded ? await reopened.get(recorded.id) : null;
        assertOutcome(found !== null && found.id === recorded?.id && JSON.stringify(found).includes(`"uid":${MAIL_RECORDS + 10 + run}`),
          `the recorded message ${recorded?.id ?? '(none)'} is not in the store after reopening`);
        const { stored } = await reopened.count();
        assertOutcome(stored === MAIL_RECORDS + run + 2, `the store holds ${stored} records; ${MAIL_RECORDS + run + 2} expected`);
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
    return { async op() {
      const value = manager.get('display.collapseThreshold');
      assertOutcome(typeof value === 'number' && Number.isFinite(value), `display.collapseThreshold read as ${JSON.stringify(value)}`);
      return { value };
    } };
  },
};

const configSet: Scenario = {
  name: 'config-set',
  drives: "ConfigManager.set('display.collapseThreshold', 31|32) (an ordinary surface-tier key).",
  entries: [`${P}/config/manager.ts:1254 ConfigManager.set`, `${P}/utils/atomic-json-store.ts:553 writeJsonFileAtomic`, ...configEntries],
  async setup(env): Promise<Instance> {
    const manager = config(env);
    return {
      async op(run) { manager.set('display.collapseThreshold', 31 + (run & 1)); },
      verify(run) {
        // What the next start reads: a new manager over the same files.
        const value = config(env).get('display.collapseThreshold');
        assertOutcome(value === 31 + (run & 1), `display.collapseThreshold reads ${JSON.stringify(value)} after setting ${31 + (run & 1)}`);
      },
    };
  },
};

export const scenarios: Scenario[] = [sessionHeartbeat, sessionAppend, knowledgeList, knowledgeSearch, knowledgeSearchRepeat, memoryAdd, inboundEmailStore, configGet, configSet];
