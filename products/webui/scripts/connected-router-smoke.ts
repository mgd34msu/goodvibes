/** Real browser/daemon/adapters; local deterministic wires are wiring proof only. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { installTestTempRoot } from './test-temp-root';

// Chromium creates a Unix-domain socket below TMPDIR; the checked-out path
// can exceed its native length limit. Only Chromium uses the original OS base.
const browserTemporaryBase = tmpdir();
const root = installTestTempRoot();
const home = join(root, 'host/home'); mkdirSync(home, { recursive: true });
process.env.HOME = home; process.env.GOODVIBES_HOME = home;
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const enclosingAppState = resolve(project, '../../.goodvibes');
const enclosingAppStateExisted = existsSync(enclosingAppState);
const bundle = resolve(process.env.GOODVIBES_WEBUI_CONNECTED_BUNDLE ?? join(project, 'dist'));
assert.ok(existsSync(join(bundle, 'index.html')), 'Build WebUI before running the connected Router lane');
const output = resolve(process.env.GOODVIBES_WEBUI_CONNECTED_OUTPUT ?? join(project, 'e2e/.artifacts/connected-router'));
mkdirSync(output, { recursive: true });
const allowedOrigins = new Set<string>(), unexpectedNetwork: string[] = [];
const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: string | URL | Request, options?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!allowedOrigins.has(url.origin)) {
    unexpectedNetwork.push(`${url.protocol}//${url.hostname}${url.pathname}`);
    throw new Error('Connected acceptance refused an unowned network destination');
  }
  return nativeFetch(input, { ...options, redirect: 'error' });
}, { preconnect: nativeFetch.preconnect });
const { startDaemonFixture } = await import('@goodvibes-jev/daemon/testing');
const { registerInboxSurface } = await import('@goodvibes-jev/engine/platform/platform/intake');
const { OpenAICompatProvider, BenchmarkStore, getProviderModelsCachePath } = await import('@goodvibes-jev/engine/platform/platform/providers');
const { createShellPathService } = await import('@goodvibes-jev/engine/platform/platform/runtime/shell');
const { DEFAULT_DECISION_ROUTER_SETTINGS } = await import('@goodvibes-jev/engine/platform/browser/decision-router');
type ModelDefinition = import('@goodvibes-jev/engine/platform/platform/providers').ModelDefinition;
type WireJudgment = { state: { context: { request: { text: string; omittedChars: number }; recent: unknown[] }; candidates: { id: string }[] }; questions: Record<string, { type: string; criteria?: Record<string, unknown> }> };
type WireAnswer = { model: string; messages: { role: string; content: unknown }[]; reasoning_effort?: string };
const judgments: WireJudgment[] = [], answers: WireAnswer[] = [], unexpectedJudgments: string[] = [];
let browser: Browser | undefined, host: Awaited<ReturnType<typeof startDaemonFixture>> | undefined;
let connectedChild: ReturnType<typeof Bun.spawn> | undefined;
let removingProvider: (() => void) | undefined;
let closing: Promise<void> | undefined;
const sockets: ReturnType<typeof Bun.serve>[] = [];
async function cleanup(): Promise<void> {
  if (closing) return closing;
  closing = (async () => {
    if (connectedChild) { connectedChild.kill('SIGTERM'); await connectedChild.exited; connectedChild = undefined; }
    try { await browser?.close(); }
    finally {
      try { await host?.stop(); }
      finally { removingProvider?.(); for (const server of sockets) await server.stop(true); globalThis.fetch = nativeFetch; }
    }
  })();
  return closing;
}
const interrupted = () => { void cleanup().then(() => { process.exitCode = 1; }); };
process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
const decisionWire = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (new URL(request.url).pathname !== '/v1/systemone') return new Response(null, { status: 404 });
  const value = await request.json() as WireJudgment;
  const names = Object.keys(value.questions);
  const expectedNames = ['pick', ...Array.from({ length: 10 }, (_, index) => `fits_${index}`)];
  if (names.length !== expectedNames.length || expectedNames.some(name => !names.includes(name))
    || value.questions.pick?.type !== 'choice' || expectedNames.slice(1).some(name => value.questions[name]?.type !== 'noul')
    || !value.state.context?.request || value.state.candidates?.length !== 10) {
    unexpectedJudgments.push(names.join(',')); return Response.json({ error: 'Unknown synthetic judgment recipe' }, { status: 422 });
  }
  judgments.push(value);
  const category = value.state.context.request.text.includes('QUAL_RESEARCH') ? 'research' : 'coding-implementation';
  const criteria = value.questions['pick']?.criteria;
  if (!criteria || !Object.hasOwn(criteria, category)) throw new Error('The actual Router candidate contract changed');
  const probabilities = Object.fromEntries(Object.keys(criteria).map(id => [id, id === category ? 0.99 : 0]));
  const rest = Object.keys(criteria).find(id => id !== category); assert.ok(rest); probabilities[rest] = 0.01;
  return Response.json({ model: 'jev-1.13.0', answers: Object.fromEntries(names.map(name => [name,
    name === 'pick' ? { type: 'choice', choice: category, confidence: 0.99, probabilities }
      : { type: 'noul', noul: value.state.candidates[Number(name.slice(5))]?.id === category ? 0.99 : 0.01 },
  ])), usage: { input_tokens: 1, output_tokens: 1 } });
} });
sockets.push(decisionWire); allowedOrigins.add(decisionWire.url.origin);
const answerWire = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (new URL(request.url).pathname !== '/v1/chat/completions') return new Response(null, { status: 404 });
  const value = await request.json() as WireAnswer; answers.push(value);
  assert.ok(['gpt-6.1-sol', 'fixture-coding'].includes(value.model));
  const content = `Synthetic answer ${answers.length} from ${value.model}.`;
  const chunk = (delta: Record<string, string>, finish_reason: string | null) => ({ id: 'owned-synthetic-completion', object: 'chat.completion.chunk',
    created: 1, model: value.model, choices: [{ index: 0, delta, finish_reason }] });
  return new Response(`data: ${JSON.stringify(chunk({ role: 'assistant', content }, null))}\n\ndata: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
} });
sockets.push(answerWire); allowedOrigins.add(answerWire.url.origin);
const receipts: { viewport: string; proof: string }[] = [];
async function signIn(page: Page, token: string) {
  await page.goto(host!.baseUrl);
  await page.getByLabel('Operator token', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Sign in with token', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
}
async function policy(page: Page, value: string) {
  const sessionId = new URL(page.url()).searchParams.get('session');
  await page.goto(`${host!.baseUrl}/?view=chat&settings=models${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ''}`);
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  const control = dialog.getByRole('combobox', { name: 'judgment.policy', exact: true });
  await control.click(); await page.getByRole('option', { name: value, exact: true }).click();
  await expect.poll(() => host!.services.configManager.get('judgment.policy')).toBe(value);
  await page.reload(); await expect(control).toContainText(value);
}
function menuItem(page: Page, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Native selected rows include a screen-reader-only annotation before or
  // after their exact visible label. Keep the same strict label match.
  return page.getByRole('menuitem', { name: new RegExp(`^(?:\\(selected\\)\\s*)?${escaped}(?:\\s*\\(selected\\))?$`) });
}
async function select(page: Page, provider: string, model: string) {
  const sessionId = new URL(page.url()).searchParams.get('session');
  const originalDefault = host!.services.providerRegistry.getCurrentModel().registryKey;
  await page.goto(`${host!.baseUrl}/?view=chat${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ''}`);
  await page.getByRole('button', { name: /^Model: / }).click();
  await menuItem(page, provider).click();
  const selected = host!.services.providerRegistry.listModels().find(value => value.provider === provider && value.id === model);
  assert.ok(selected, 'The selected model must come from the real runtime catalog');
  await menuItem(page, selected.displayName || selected.id).click();
  if (sessionId) {
    await expect.poll(async () => {
      const response = await host!.fetch(`/api/companion/chat/sessions/${sessionId}`);
      const body = await response.json() as { session: { provider: string; model: string } };
      return [body.session.provider, body.session.model];
    }).toEqual([provider, model]);
    assert.equal(host!.services.providerRegistry.getCurrentModel().registryKey, originalDefault, 'A session selection must not overwrite global defaults');
  } else await expect.poll(() => host!.services.providerRegistry.getCurrentModel().id).toBe(model);
}
async function effort(page: Page, value: 'xhigh' | 'max') {
  const sessionId = new URL(page.url()).searchParams.get('session');
  const originalDefault = host!.services.configManager.get('provider.reasoningEffort');
  await page.getByRole('button', { name: /^Model: / }).click();
  await menuItem(page, value === 'xhigh' ? 'X-high' : 'Max').click();
  if (sessionId) {
    await expect.poll(async () => {
      const body = await host!.fetch(`/api/companion/chat/sessions/${sessionId}`).then(response => response.json()) as { session: { reasoningEffort?: string } };
      return body.session.reasoningEffort;
    }).toBe(value);
    assert.equal(host!.services.configManager.get('provider.reasoningEffort'), originalDefault);
  } else await expect.poll(() => host!.services.configManager.get('provider.reasoningEffort')).toBe(value);
}
async function send(page: Page, prompt: string, answerNumber: number) {
  const composer = page.getByRole('textbox', { name: 'Message GoodVibes', exact: true });
  await composer.fill(prompt); await page.locator('.send-button').click();
  await expect(page.locator('.message.assistant').last()).toContainText(`Synthetic answer ${answerNumber} `, { timeout: 25_000 });
  await expect(page.locator('.send-button')).not.toHaveAttribute('data-pending', 'true');
}
try {
  host = await startDaemonFixture({ root: join(root, 'host'), hostSessions: false,
    inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
    configure(config) {
      const paths = createShellPathService({ homeDirectory: join(root, 'host/home'), workingDirectory: join(root, 'host/workspace') });
      const benchmark = new BenchmarkStore({ dir: paths.resolveUserPath('tui') });
      mkdirSync(dirname(benchmark.getCachePath()), { recursive: true });
      const envelope = { fetchedAt: Date.now(), ttlMs: 86_400_000 };
      writeFileSync(benchmark.getCachePath(), JSON.stringify({ version: 1, ...envelope, entries: [] }));
      const cache = config.getControlPlaneConfigDir(); mkdirSync(cache, { recursive: true });
      writeFileSync(join(cache, 'model-catalog.json'), JSON.stringify({ version: 7, ...envelope, models: [] }));
      writeFileSync(join(cache, 'model-limits.json'), JSON.stringify({ version: 1, ...envelope, models: {} }));
      for (const id of ['aihubmix', 'vercel-ai-gateway']) writeFileSync(join(cache, `gateway-pricing-${id}.json`), JSON.stringify({ version: 1, ...envelope, models: {} }));
      // Actual anonymous builtins attempt startup discovery without a key.
      // Declare fresh empty listings for these unrelated native endpoints.
      for (const id of ['sglang', 'litellm', 'copilot-proxy']) {
        const path = getProviderModelsCachePath(cache, id); mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ version: 1, ...envelope, models: [] }));
      }
      config.set('controlPlane.webui.serve', true); config.set('controlPlane.webui.bundleDir', bundle);
      config.set('judgment.endpoint', decisionWire.url.origin); config.set('judgment.keySource', 'none');
      config.set('judgment.model', 'jev-1.13.0'); config.set('judgment.policy', 'Default - On');
      config.set('provider.decisionRouter', { ...DEFAULT_DECISION_ROUTER_SETTINGS, initialContextChars: 512, expandedContextChars: 1024,
        categories: { ...DEFAULT_DECISION_ROUTER_SETTINGS.categories,
          general: { ...DEFAULT_DECISION_ROUTER_SETTINGS.categories.general, target: { provider: 'synthetic-wire', model: 'gpt-6.1-sol', effort: 'xhigh' } },
          'coding-implementation': { ...DEFAULT_DECISION_ROUTER_SETTINGS.categories['coding-implementation'], target: { provider: 'synthetic-wire', model: 'fixture-coding', effort: 'max' } },
        } });
    },
  });
  await host.services.workspaceCheckpointManager.init();
  assert.equal(host.services.workspaceCheckpointManager.workspaceRoot, host.workingDirectory, 'The connected fixture must retain its owned non-Git workspace');
  allowedOrigins.add(host.baseUrl);
  const models: ModelDefinition[] = ['gpt-6.1-sol', 'fixture-coding'].map((id, index) => ({ id, provider: 'synthetic-wire', registryKey: `synthetic-wire:${id}`,
    displayName: index ? 'Synthetic coding' : 'Synthetic general', description: 'Owned local protocol fixture, not a live model', selectable: true, contextWindow: 65536,
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    reasoningEffort: { kind: 'effort', source: 'declared', values: ['high', 'xhigh', 'max'], defaultValue: 'high' } }));
  removingProvider = host.services.providerRegistry.registerRuntimeProvider({ provider: new OpenAICompatProvider({ name: 'synthetic-wire',
    baseURL: `${answerWire.url.origin}/v1`, apiKey: 'synthetic-local-adapter-placeholder', defaultModel: 'gpt-6.1-sol', models: models.map(value => value.id),
    modelListing: 'none', modelsAsOf: '2026-11-09', reasoningFormat: 'reasoning-effort', allowAnonymous: true, anonymousConfigured: true }), models });
  // Catalog/discovery are unrelated to this protocol-wiring lane. Current
  // native cache envelopes declare only the actual provider's static baseline.
  const cache = host.services.configManager.getControlPlaneConfigDir();
  for (const provider of host.services.providerRegistry.listProviders()) {
    const path = getProviderModelsCachePath(cache, provider.name); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000, models: provider.models }));
  }
  // Existing connected-browser smoke proves real protected routes, sessions and
  // reconnect through the actual daemon-served bundle before synthetic inference.
  connectedChild = Bun.spawn([process.execPath, join(project, 'scripts/connected-browser-smoke.ts')], { cwd: project,
    env: { ...process.env, GOODVIBES_WEBUI_CONNECTED_URL: host.baseUrl, GOODVIBES_WEBUI_CONNECTED_TOKEN: host.token,
      GOODVIBES_WEBUI_CONNECTED_OUTPUT: join(output, 'transport'), TMPDIR: browserTemporaryBase, TMP: browserTemporaryBase, TEMP: browserTemporaryBase }, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  assert.equal(await connectedChild.exited, 0, 'Existing real connected-browser smoke must pass first'); connectedChild = undefined;
  browser = await chromium.launch({ env: { ...process.env, TMPDIR: browserTemporaryBase, TMP: browserTemporaryBase, TEMP: browserTemporaryBase }, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  for (const viewport of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'phone', width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, isMobile: viewport.name === 'phone', hasTouch: viewport.name === 'phone' });
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    try {
      await signIn(page, host.token);
      await policy(page, 'Default - On');
      await select(page, 'synthetic-wire', 'gpt-6.1-sol');
      const startAnswers = answers.length, startJudgments = judgments.length;
      const history = `QUAL_FULL_HISTORY_${viewport.name}_BEGIN ` + 'owned synthetic context '.repeat(600) + ` QUAL_FULL_HISTORY_${viewport.name}_END`;
      await effort(page, 'xhigh');
      await send(page, history, startAnswers + 1);
      assert.equal(answers.at(-1)?.reasoning_effort, 'xhigh');
      await effort(page, 'max');
      await send(page, `QUAL_ORDINARY_MAX_${viewport.name}: Keep the same selected model and history.`, startAnswers + 2);
      assert.equal(answers.at(-1)?.reasoning_effort, 'max');
      assert.equal(judgments.length, startJudgments, 'An ordinary provider must not categorize');
      const sessions = await host.fetch('/api/companion/chat/sessions').then(response => response.json()) as { sessions: { id: string }[] };
      const sessionId = sessions.sessions[0]?.id; assert.ok(sessionId);
      writeFileSync(join(output, 'router-readiness.json'), JSON.stringify({ settings: host.services.configManager.get('provider.decisionRouter'),
        configured: host.services.providerRegistry.require('decision-router').isConfigured?.(),
        generalConfigured: host.services.providerRegistry.getForModel('synthetic-wire:gpt-6.1-sol', 'synthetic-wire').isConfigured?.(),
        targetModels: host.services.providerRegistry.listModels().filter(value => value.provider === 'synthetic-wire') }, null, 2));
      await select(page, 'decision-router', 'auto');
      const prompt = `QUAL_CODING_${viewport.name}: Implement the requested reload behavior.`;
      await send(page, prompt, startAnswers + 3);
      assert.equal(judgments.length, startJudgments + 1, 'Selecting Router on the existing chat must categorize exactly once');
      assert.equal(answers.at(-1)?.model, 'fixture-coding'); assert.equal(answers.at(-1)?.reasoning_effort, 'max');
      assert.ok(answers.at(-1)?.messages.some(message => message.content === history), 'Answer wire must retain the complete authorized earlier user message');
      assert.ok(answers.at(-1)?.messages.some(message => message.content === prompt));
      const selected = judgments.at(-1)!;
      assert.ok(JSON.stringify(selected.state.context).length < 1600, '512-character preview may add structural labels, never full history');
      assert.ok(!JSON.stringify(selected.state).includes(history));
      const persisted = await host.fetch(`/api/companion/chat/sessions/${sessionId}`).then(response => response.json()) as Record<string, unknown>;
      assert.ok(JSON.stringify(persisted).includes('decision-router'), 'Existing chat route must persist Router');
      await page.screenshot({ path: join(output, `${viewport.name}-router.png`), fullPage: true });
      await send(page, `QUAL_RESEARCH_${viewport.name}: Find the requested primary sources.`, startAnswers + 4);
      assert.equal(judgments.length, startJudgments + 2); assert.equal(answers.at(-1)?.model, 'gpt-6.1-sol');
      assert.equal(answers.at(-1)?.reasoning_effort, 'xhigh');
      await policy(page, 'Preferred'); await policy(page, 'Classic - Off');
      const beforeClassic = judgments.length;
      await page.goto(`${host.baseUrl}/?view=chat&session=${encodeURIComponent(sessionId)}`);
      await send(page, `QUAL_CLASSIC_${viewport.name}: Continue the same authorized conversation.`, startAnswers + 5);
      assert.equal(judgments.length, beforeClassic); assert.equal(answers.at(-1)?.model, 'gpt-6.1-sol');
      assert.equal(host.services.configManager.get('judgment.policy'), 'Classic - Off');
      receipts.push({ viewport: viewport.name, proof: 'real config persistence, ordinary xhigh/max actual wire and zero categorization, same-chat Router/full history/category effort, General fallback, Classic no classifier' });
      // Keep each viewport independent without dropping history within its proof.
      assert.equal((await host.fetch(`/api/companion/chat/sessions/${sessionId}/close`, { method: 'POST', body: '{}' })).status, 200);
      assert.equal((await host.fetch(`/api/companion/chat/sessions/${sessionId}`, { method: 'DELETE' })).status, 200);
    } catch (error) {
      await page.screenshot({ path: join(output, `${viewport.name}-failure.png`), fullPage: true }).catch(() => {});
      writeFileSync(join(output, `${viewport.name}-failure-dom.txt`), await page.locator('body').innerText().catch(() => 'Unavailable'));
      writeFileSync(join(output, 'failure-wiring.json'), JSON.stringify({ answerModels: answers.map(value => value.model), categorizationRequests: judgments.length, unexpectedNetwork, unexpectedJudgments }, null, 2));
      throw error;
    } finally { await context.close(); }
  }
  assert.deepEqual(unexpectedNetwork, []); assert.deepEqual(unexpectedJudgments, []);
  writeFileSync(join(output, 'receipts.json'), JSON.stringify({ kind: 'synthetic protocol wiring, not live model quality', receipts,
    answerRequests: answers.length, categorizationRequests: judgments.length, unexpectedNetwork, unexpectedJudgments }, null, 2));
  process.stdout.write(`Connected Router acceptance passed: ${receipts.length} viewports, ${answers.length} answer HTTP calls, ${judgments.length} bounded classifications.\n`);
} catch (error) {
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) {
    await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
    writeFileSync(join(output, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => 'Unavailable'));
  }
  throw error;
} finally {
  await cleanup(); process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
  if (!enclosingAppStateExisted) assert.equal(existsSync(enclosingAppState), false, 'Connected acceptance must not recreate source-checkout app state');
}
