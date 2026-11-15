import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { McpRegistry } from '@goodvibes-jev/engine/platform/platform/mcp';
import { SandboxSessionRegistry } from '@goodvibes-jev/engine/platform/platform/runtime/sandbox';
import { createShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { ConversationManager } from '../../core/conversation.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { browserPwaReadModelSnapshot, isCertifiedBrowserPwaCategoryRoute, isCertifiedBrowserPwaFirstRunReceipt } from '../../tools/agent-harness-browser-pwa-read-models.ts';
import { deviceLiveReadModelSnapshot, isCertifiedDeviceLiveRecord } from '../../tools/agent-harness-device-live-read-models.ts';
import { acquireInteractiveRuntimeSnapshot } from '../../tools/agent-harness-interactive-runtime-records.ts';
import { captureBrowserControlPosture } from '../../tools/agent-harness-browser-control.ts';
import { registerAgentBrowserTool } from '../../tools/agent-browser-tool.ts';
import { redactSecretText } from '../../tools/agent-harness-secret-redaction.ts';
import type { CatalogRankingOptions } from '../../tools/agent-harness-catalog-ranking.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { createTestProviderRegistry } from '../helpers/test-managers.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
afterAll(cleanupResearchScreeningFixtures);
const options = (): CatalogRankingOptions => ({ sourceOwner: ordinaryResearchOwner() });

function fixture(readModels: unknown = {}) {
  const root = makeProjectTempDir('read-model-certification');
  const workingDirectory = join(root, 'workspace'), homeDirectory = join(root, 'home');
  mkdirSync(workingDirectory); mkdirSync(homeDirectory);
  const paths = createShellPathService({ workingDirectory, homeDirectory });
  const config = new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT), workingDir: workingDirectory, homeDir: homeDirectory });
  const context: CommandContext = {
    print: () => {}, renderRequest: () => {}, exit: () => {},
    workspace: { shellPaths: paths }, platform: { config: config.getAll(), configManager: config },
    session: { conversationManager: new ConversationManager(() => 80, config), runtime: {
      sessionId: 'read-model-certification', model: 'fixture', provider: 'fixture', debugMode: false, systemPrompt: '', reasoningEffort: 'medium' } },
    provider: { providerRegistry: createTestProviderRegistry() }, ops: {}, clients: {},
    extensions: { toolRegistry: new ToolRegistry(), mcpRegistry: new McpRegistry({
      hookDispatcher: { fire: async () => { throw new Error('MCP hooks must not run in a metadata fixture.'); } },
      sandboxSessions: new SandboxSessionRegistry(workingDirectory) }) },
  };
  Object.defineProperty(context.platform, 'readModels', { value: readModels, configurable: true, enumerable: true });
  return context;
}

// Every certification field a publisher can supply, so the one field a test omits or breaks is the only reason a record is not certified.
const CERTIFIED = { schemaVersion: '1', publicationGuarantee: 'durable', publisher: 'synthetic-host', cursor: 'cursor-1' };
const receipt = (extra: Record<string, unknown>) => ({ ...CERTIFIED, id: 'receipt-1', status: 'ready', modelRoute: 'computer action:"browser" receiptId:"receipt-1"',
  manifestStatus: 'ready', serviceWorkerStatus: 'ready', installStatus: 'ready', offlineStatus: 'ready', ...extra });

describe('browser and PWA certification', () => {
  test('a ready receipt whose own statuses say manifest, service worker or offline are broken is not certified', async () => {
    const broken = receipt({ manifestStatus: 'missing', serviceWorkerStatus: 'failed', offlineStatus: 'unavailable' });
    const snapshot = await browserPwaReadModelSnapshot(fixture({ browserPwa: { firstRunReceipts: [receipt({ id: 'good' }), { ...broken, id: 'bad' }] } }), options());
    const [good, bad] = [snapshot.firstRunReceipts.find(r => r.id === 'good')!, snapshot.firstRunReceipts.find(r => r.id === 'bad')!];
    expect(isCertifiedBrowserPwaFirstRunReceipt(good)).toBe(true);
    expect(isCertifiedBrowserPwaFirstRunReceipt(bad)).toBe(false);
    expect(bad.certification.missingSignals.join('\n')).toContain('manifest status is published but not ready');
  });

  test('a receipt with no published id or route is not certified by its position-based stand-ins', async () => {
    const { id: _id, modelRoute: _route, ...anonymous } = receipt({});
    const snapshot = await browserPwaReadModelSnapshot(fixture({ browserPwa: { firstRunReceipts: [anonymous] } }), options());
    const record = snapshot.firstRunReceipts[0]!;
    expect(record.id).toBe('browser-pwa-first-run:0');
    expect(isCertifiedBrowserPwaFirstRunReceipt(record)).toBe(false);
    const signals = record.certification.missingSignals.join('\n');
    expect(signals).toContain('Durable browser/PWA first-run receipt id is not published');
    expect(signals).toContain('inspect/open route is not published');
  });

  test('a category route with no published category ids is not certified', async () => {
    const route = { ...CERTIFIED, id: 'route-1', status: 'ready', route: 'computer action:"browser"', mobileReady: true, pwaReady: true };
    const snapshot = await browserPwaReadModelSnapshot(fixture({ browserPwa: { categoryRoutes: [route, { ...route, id: 'route-2', categoryId: 'home' }] } }), options());
    const [anonymous, named] = snapshot.categoryRoutes;
    expect(isCertifiedBrowserPwaCategoryRoute(anonymous!)).toBe(false);
    expect(anonymous!.certification.missingSignals.join('\n')).toContain('category ids are not published');
    expect(isCertifiedBrowserPwaCategoryRoute(named!)).toBe(true);
  });

  test('published ids, statuses and routes are bounded, and urls lose fragments', async () => {
    const snapshot = await browserPwaReadModelSnapshot(fixture({ browserPwa: { firstRunReceipts: [receipt({
      id: `receipt-${'i'.repeat(500)}`, status: `ready ${'s'.repeat(500)}`, modelRoute: `computer action:"browser" ${'x'.repeat(5000)}`,
      url: 'https://example.com/page#fragment-part' })] } }), options());
    const record = snapshot.firstRunReceipts[0]!;
    expect(record.id.length).toBeLessThanOrEqual(120);
    expect(record.status.length).toBeLessThanOrEqual(80);
    expect(record.modelRoute.length).toBeLessThanOrEqual(240);
    expect(record.url).toBe('https://example.com/page');
  });

  test('a producer that throws or answers asynchronously is reported and the snapshot still resolves', async () => {
    const snapshot = await browserPwaReadModelSnapshot(fixture({ browserPwa: { firstRunReceipts: [receipt({})],
      receipts: { list() { throw new Error('producer exploded'); } },
      runtimeReceipts: { async list() { return [receipt({ id: 'late' })]; } } } }), options());
    expect(snapshot.firstRunReceipts.map(r => r.id)).toEqual(['receipt-1']);
    const errors = (snapshot.sourceErrors ?? []).join('\n');
    expect(errors).toContain('producer exploded');
    expect(errors).toContain('was refused by the source guard');
  });
});

describe('device capability certification', () => {
  const capability = (extra: Record<string, unknown>) => ({ ...CERTIFIED, id: 'cap-record-1', capabilityId: 'camera', status: 'ready',
    permissionScope: 'camera', routes: { inspect: 'device action:"capability" capabilityId:"camera"' }, ...extra });

  test('a capability with no published record id is not certified by its position-based stand-in', async () => {
    const { id: _id, ...anonymous } = capability({});
    const snapshot = await deviceLiveReadModelSnapshot(fixture({ device: { capabilities: [capability({ id: 'named' }), anonymous] } }), options());
    const named = snapshot.capabilities.find(c => c.id === 'named')!;
    const stood = snapshot.capabilities.find(c => c.id.startsWith('device-live:'))!;
    expect(isCertifiedDeviceLiveRecord(named)).toBe(true);
    expect(isCertifiedDeviceLiveRecord(stood)).toBe(false);
    expect(stood.certification.missingSignals.join('\n')).toContain('Durable device capability record id is not published');
  });

  test('published status, domain and route are bounded', async () => {
    const snapshot = await deviceLiveReadModelSnapshot(fixture({ device: { capabilities: [capability({
      status: `ready ${'s'.repeat(500)}`, domain: 'd'.repeat(500), modelRoute: `device ${'y'.repeat(5000)}` })] } }), options());
    const record = snapshot.capabilities[0]!;
    expect(record.status.length).toBeLessThanOrEqual(80);
    expect(record.domain.length).toBeLessThanOrEqual(80);
    expect(record.modelRoute.length).toBeLessThanOrEqual(240);
  });

  test('a throwing or asynchronous producer is reported beside the records that did read', async () => {
    const snapshot = await deviceLiveReadModelSnapshot(fixture({ device: { capabilities: [capability({})],
      sensors: { list() { throw new Error('sensor producer exploded'); } } },
    voice: { workflows: { async list() { return []; } } } }), options());
    expect(snapshot.capabilities).toHaveLength(1);
    const errors = (snapshot.sourceErrors ?? []).join('\n');
    expect(errors).toContain('sensor producer exploded');
    expect(errors).toContain('was refused by the source guard');
  });
});

describe('shared secret redaction', () => {
  test.each([
    'credential=hunter2', 'token: hunter2', 'API_KEY=hunter2', 'Authorization: Bearer hunter2', 'bearer hunter2', 'secret://vault/hunter2',
    '{"password": "hunter2"}',
  ])('%s never survives', input => {
    expect(redactSecretText(`label ${input} tail`)).not.toContain('hunter2');
  });
});

function runtimeContext(records: readonly Record<string, unknown>[] | null, toolNames: readonly string[] = []) {
  const registry = new ToolRegistry();
  for (const name of toolNames) registry.register({ definition: { name, description: `Synthetic ${name}`, parameters: { type: 'object' } }, execute: async () => ({ success: true }) });
  const platform: CommandContext['platform'] = {
    get config(): never { throw new Error('read config'); }, get configManager(): never { throw new Error('read config manager'); },
  };
  Object.defineProperty(platform, 'readModels', { value: records === null ? {} : { execution: { interactiveRuntime: { getSnapshot: () => ({ sessions: records }) } } }, enumerable: true, configurable: true });
  const context: CommandContext = {
    platform, clients: {}, extensions: { toolRegistry: registry, mcpRegistry: new McpRegistry({
      hookDispatcher: { fire: async () => { throw new Error('MCP hooks must not run in a metadata fixture.'); } },
      sandboxSessions: new SandboxSessionRegistry('/synthetic/read-model-certification') }) },
    renderRequest: () => {}, print: () => {}, exit: () => {},
    get session(): never { throw new Error('read session'); }, get provider(): never { throw new Error('read provider'); },
    get workspace(): never { throw new Error('read workspace'); }, get ops(): never { throw new Error('read ops'); },
  };
  return { context, registry };
}

function runtimeReadings(kind: 'process-output' | 'browser-desktop-receipt', roles: Readonly<Record<string, string>>) {
  return fakePort((name, question, state) => {
    if (question.type === 'noul') return noulAnswer(0.999);
    if (question.type !== 'choice') throw new Error('Unexpected runtime reading question');
    if (Object.hasOwn(question.criteria, 'pty-session')) return choiceAnswer(question, kind, 0.999);
    if (Object.hasOwn(question.criteria, 'ready')) return choiceAnswer(question, 'ready', 0.999);
    if (Object.hasOwn(question.criteria, 'credential')) {
      if (!state || typeof state !== 'object' || Array.isArray(state) || typeof state.key !== 'string') throw new Error('Route key missing');
      return choiceAnswer(question, roles[state.key] ?? 'none', 0.999);
    }
    if (Object.hasOwn(question.criteria, 'neither')) return choiceAnswer(question, 'false', 0.999);
    if (name === 'kind' && Object.hasOwn(question.criteria, 'other')) return choiceAnswer(question, 'other', 0.999);
    throw new Error('Unexpected runtime reading');
  });
}

const processRecord = (extra: Record<string, unknown>) => ({ id: 'proc-1', publisher: 'synthetic-host', publicationGuarantee: 'durable', schemaStatus: 'certified',
  rawSecretReturned: false, rawValueReturned: false, status: 'running', ...extra });

describe('interactive runtime records', () => {
  test('a clipped output chunk and dropped chunks are reported as truncated, and route text is bounded', async () => {
    const { context } = runtimeContext([processRecord({
      outputChunks: Array.from({ length: 7 }, (_, index) => ({ id: `c${index}`, text: index === 0 ? 'z'.repeat(700) : `line ${index}`, truncated: false })),
      routes: { log: `process action:output ${'r'.repeat(500)}` } })]);
    installJudgmentPort(runtimeReadings('process-output', { log: 'log' }).port);
    const snapshot = await acquireInteractiveRuntimeSnapshot(context, { sourceOwner: ordinaryResearchOwner() });
    const record = snapshot.records[0]!;
    expect(record.outputChunks).toHaveLength(5);
    expect(record.outputChunks![0]).toMatchObject({ truncated: true });
    expect(record.outputChunks![1]).toMatchObject({ truncated: false });
    expect(record.droppedChunks).toBe(2);
    expect(record.routes[0]!.modelRoute.length).toBeLessThanOrEqual(240);
  });
});

describe('browser control readiness', () => {
  test('the first-class browser route is a template with a placeholder, not a live example address', async () => {
    const { context, registry } = runtimeContext(null);
    registerAgentBrowserTool(registry);
    const { posture } = await captureBrowserControlPosture(context, undefined, options());
    expect(posture.invocationRoutes[0]!.modelRoute).toContain('<page url>');
    expect(JSON.stringify(posture)).not.toContain('example.com');
  });

  const receiptRecord = { id: 'browser-receipt', receiptId: 'receipt-9', publisher: 'synthetic-host', publicationGuarantee: 'durable', schemaStatus: 'certified',
    rawSecretReturned: false, rawValueReturned: false, status: 'ready',
    routes: { run: 'ghost_browser action:"drive"', inspect: 'ghost_browser action:"receipt"' } };
  const roles = { run: 'execute', inspect: 'receipt' };

  test('a published execute route is context only when no registered tool starts it', async () => {
    const { context } = runtimeContext([receiptRecord]);
    installJudgmentPort(runtimeReadings('browser-desktop-receipt', roles).port);
    const { posture } = await captureBrowserControlPosture(context, undefined, options());
    expect(posture.configured).toBe(false);
    expect(posture.status).not.toBe('ready');
    expect(posture.certifiedRuntimeRecords).toHaveLength(1);
    expect(posture.blockers.join('\n')).toContain('context only');
  });

  test('the same route is invocable, and says why, once its tool is registered', async () => {
    const { context } = runtimeContext([receiptRecord], ['ghost_browser']);
    installJudgmentPort(runtimeReadings('browser-desktop-receipt', roles).port);
    const { posture } = await captureBrowserControlPosture(context, undefined, options());
    expect(posture.configured).toBe(true);
    expect(posture.invocationRoutes[0]).toMatchObject({ kind: 'daemon-certified-route', toolName: 'ghost_browser' });
  });
});
