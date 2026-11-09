import { expect, test } from 'bun:test';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { captureDecisionRouterSettings, DEFAULT_DECISION_ROUTER_SETTINGS } from '../sdk/src/platform/config/decision-router-settings.ts';
import { DecisionRouterProvider, prepareDecisionRouterTurn, chatWithDecisionRoute } from '../sdk/src/platform/providers/decision-router.ts';
import { buildDecisionRoutingPreview, selectedRoutingFiles } from '../sdk/src/platform/providers/decision-router-context.ts';
import type { ChatRequest, ChatResponse, LLMProvider } from '../sdk/src/platform/providers/interface.ts';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry-types.ts';

const general = { provider: 'answer', model: 'general' };
const coding = { provider: 'other', model: 'coding', effort: 'high' };
const response: ChatResponse = { content: 'answered', toolCalls: [], usage: { inputTokens: 17, outputTokens: 3 }, stopReason: 'completed' };
function model(provider: string, id: string): ModelDefinition {
  return { provider, id, registryKey: `${provider}:${id}`, displayName: id, description: '', selectable: true,
    contextWindow: id === 'coding' ? 8192 : 4096, capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    reasoningEffort: { kind: 'effort', source: 'declared', values: ['low', 'medium'], defaultValue: 'low' } };
}
function fixture(picks = ['coding-implementation'], confidence = 0.97) {
  const calls: ChatRequest[] = []; let selection = -1, current = true;
  const fake = fakePort((name, question, state) => {
    if (name === 'pick') selection++;
    const chosen = picks[Math.min(selection, picks.length - 1)] ?? 'general';
    if (name === 'pick') return choiceAnswer(question, chosen, confidence);
    const entries = (state as { candidates: { id: string }[] }).candidates;
    return noulAnswer(entries[Number(name.slice(5))]?.id === chosen ? 0.97 : 0.03);
  });
  let settings: unknown = { categories: { general: { target: general }, 'coding-implementation': { target: coding } } };
  const target: LLMProvider = { name: 'answer', models: ['general', 'coding'], isConfigured: () => true,
    async chat(request) { await request.beforeAttempt?.(); calls.push(request); request.onDelta?.({ content: 'answered' }); return response; } };
  const router = new DecisionRouterProvider({ settings: () => settings,
    resolveTarget: selected => ({ provider: { ...target, name: selected.provider }, model: model(selected.provider, selected.model) }),
    capturePort: () => ({ port: fake.port, assertCurrent: () => { if (!current) throw new Error('retired'); } }),
  });
  return { router, target, fake, calls, retire: () => { current = false; }, settings: (value: unknown) => { settings = value; } };
}

test('all ten categories are available, custom categories describe themselves, and General is required before use', async () => {
  const settings = captureDecisionRouterSettings({ categories: { custom: { description: 'A user-defined category', target: null } } });
  expect(Object.keys(settings.categories)).toHaveLength(11);
  expect(Object.keys(DEFAULT_DECISION_ROUTER_SETTINGS.categories)).toHaveLength(10);
  expect(settings.categories['custom']?.description).toBe('A user-defined category');
  expect(() => captureDecisionRouterSettings({ categories: { custom: {} } })).toThrow('description');
  expect(() => captureDecisionRouterSettings({ categories: { general: { target: { provider: 'decision-router', model: 'auto' } } } })).toThrow('itself');
  const f = fixture(); f.settings({});
  expect(f.router.isConfigured()).toBe(false);
  await expect(f.router.prepare({ messages: [] })).rejects.toThrow('General');
  expect(f.fake.requests).toHaveLength(0);
});

test('settings reject accessors without invoking them and detach targets', () => {
  let reads = 0;
  expect(() => captureDecisionRouterSettings({ get categories() { reads++; return {}; } })).toThrow();
  expect(reads).toBe(0);
  const input = { categories: { general: { target: { ...general } } } };
  const result = captureDecisionRouterSettings(input);
  input.categories.general.target.model = 'changed';
  expect(result.categories['general']?.target?.model).toBe('general');
  expect(Object.isFrozen(result.categories)).toBe(true);
});

test('ordinary providers add zero categorization decisions and do not touch their input', async () => {
  const f = fixture();
  expect(await prepareDecisionRouterTurn(f.target, { messages: [{ role: 'user', content: 'hello' }] })).toBeUndefined();
  expect(f.fake.requests).toHaveLength(0); expect(f.calls).toHaveLength(0);
});

test('one classification pins an actual provider/model/effort across streaming and tool rounds', async () => {
  const f = fixture(); const owner = new AbortController(); const deltas: unknown[] = [];
  const messages: ChatRequest['messages'] = [{ role: 'user', content: 'older conversation'.repeat(3000) }, { role: 'user', content: 'Implement reload' }];
  const tools = [{ name: 'inspect', description: 'inspect', parameters: { type: 'object' as const } }];
  const params: ChatRequest = { model: 'auto', messages, tools, signal: owner.signal,
    routingContext: { sessionId: 'session', turnId: 'turn-1' }, onDelta: delta => deltas.push(delta) };
  const first = await f.router.chat(params);
  messages.push({ role: 'assistant', content: 'checking' }, { role: 'tool', callId: 'call', content: 'the complete tool result'.repeat(10000) });
  await f.router.chat(params);
  expect(f.fake.requests).toHaveLength(1); // one logical decision / one wire request with eleven fixed questions
  expect(Object.keys(f.fake.requests[0]?.questions ?? {})).toHaveLength(11);
  expect(f.calls).toHaveLength(2); expect(f.calls.every(call => call.messages === messages && call.tools === tools)).toBe(true);
  expect(f.calls.every(call => !Object.hasOwn(call, 'routingContext'))).toBe(true);
  expect(params.routingContext).toEqual({ sessionId: 'session', turnId: 'turn-1' });
  expect(f.calls[0]).toMatchObject({ model: 'coding', reasoningEffort: 'medium' });
  expect(first.decisionRoute).toMatchObject({ provider: 'other', model: 'coding', category: 'coding-implementation', requestedEffort: 'high', effort: 'medium' });
  expect(first.usage).toEqual(response.usage); expect(deltas).toHaveLength(2);
  expect(JSON.stringify(f.fake.requests[0]?.state).length).toBeLessThan(9000);
  await f.router.chat({ ...params, routingContext: { sessionId: 'session', turnId: 'turn-2' } });
  expect(f.fake.requests).toHaveLength(2);
});

test('empty categories use General without an extra decision or answer-provider fallback', async () => {
  const f = fixture(['research']);
  const result = await f.router.chat({ model: 'auto', messages: [{ role: 'user', content: 'Research this protocol' }] });
  expect(result.decisionRoute).toMatchObject({ category: 'research', resolvedCategory: 'general', fallback: 'empty-category', model: 'general' });
  expect(f.fake.requests).toHaveLength(1); expect(f.calls).toHaveLength(1);
});

test('route effort uses the exact documented model controls when discovery has no effort metadata', async () => {
  const f = fixture(['general']);
  const sol = model('openai-subscriber', 'gpt-6.1-sol');
  delete sol.reasoningEffort;
  for (const effort of ['xhigh', 'max']) {
    const router = new DecisionRouterProvider({
      settings: () => ({ categories: { general: { target: { provider: sol.provider, model: sol.id, effort } } } }),
      resolveTarget: () => ({ provider: f.target, model: sol }),
      capturePort: () => ({ port: f.fake.port, assertCurrent() {} }),
    });
    const route = await router.prepare({ messages: [{ role: 'user', content: 'Hello' }] });
    expect(route.effort.value).toBe(effort);
    expect(route.info.effort).toBe(effort);
    expect(route.effort.spec.values).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  }
});

test('uncertainty expands bounded context once, then uses General; it never expands the answer transcript', async () => {
  const f = fixture(['coding-implementation'], 0.5);
  const messages: ChatRequest['messages'] = [{ role: 'user', content: 'prior'.repeat(20000) }, { role: 'assistant', content: 'reference'.repeat(20000) }, { role: 'user', content: 'do that' }];
  const result = await f.router.chat({ model: 'auto', messages });
  expect(f.fake.requests).toHaveLength(2);
  expect(result.decisionRoute).toMatchObject({ fallback: 'uncertain', expandedContext: true, resolvedCategory: 'general' });
  expect(f.calls[0]?.messages).toBe(messages);
  const states = f.fake.requests.map(request => JSON.stringify(request.state));
  expect(states[1]?.length).toBeGreaterThan(states[0]?.length ?? 0); expect(states[1]?.length).toBeLessThan(16000);
});

test('a lookup interruption retains a bounded active task for the next follow-up', async () => {
  const f = fixture(['coding-implementation', 'lookup-navigation', 'coding-implementation']);
  for (const [index, prompt] of ['Implement reload', 'Where is its schema?', 'Now finish it'].entries())
    await f.router.chat({ model: 'auto', messages: [{ role: 'user', content: prompt }], routingContext: { sessionId: 'session', turnId: String(index) } });
  const context = (f.fake.requests[2]?.state as { context: { activeTask: { text: string } } }).context;
  expect(context.activeTask.text).toBe('Implement reload');
});

test('previews exclude tool payloads, bound text, preserve exact selected file identities and leave messages unchanged', () => {
  const messages: ChatRequest['messages'] = [{ role: 'user', content: 'task'.repeat(50000) }, { role: 'tool', callId: 'tool', content: 'UNSENT_TOOL_PAYLOAD' }, { role: 'user', content: 'Where is x?' }];
  const saved = JSON.stringify(messages);
  const preview = buildDecisionRoutingPreview(messages, { turnId: 'turn', selectedFiles: ['src/exact-file.ts', 'x'.repeat(400)] }, undefined, 512, false);
  expect(JSON.stringify(preview)).not.toContain('UNSENT_TOOL_PAYLOAD');
  expect(preview.selectedFiles).toEqual(['src/exact-file.ts']);
  expect(preview.recent[0]?.content.omittedChars).toBeGreaterThan(0);
  expect(JSON.stringify(messages)).toBe(saved);
  expect(selectedRoutingFiles('--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-SECRET\n+SECRET')).toEqual(['a/x.ts', 'b/x.ts']);
});

test('actual model limits are available before answer dispatch', async () => {
  const f = fixture(); const route = await f.router.prepare({ messages: [{ role: 'user', content: 'implement' }] });
  expect(route.model.contextWindow).toBe(8192); expect(route.model.provider).toBe('other');
  expect(f.calls).toHaveLength(0);
  await chatWithDecisionRoute(route, { model: route.model.id, messages: [] });
  expect(f.calls).toHaveLength(1);
});

test('decision-target exhaustion halts without dispatching an answering model', async () => {
  let reads = 0, answers = 0;
  const port: JudgmentPort = { model: 'local', async ask() { reads++; throw new JudgmentError('unavailable', 'No decision models are currently available.'); } };
  const router = new DecisionRouterProvider({ settings: () => ({ categories: { general: { target: general } } }),
    resolveTarget: () => ({ provider: { name: 'answer', models: ['general'], async chat() { answers++; return response; } }, model: model('answer', 'general') }),
    capturePort: () => ({ port, assertCurrent() {} }) });
  await expect(router.chat({ model: 'auto', messages: [] })).rejects.toMatchObject({ kind: 'unavailable' });
  expect(reads).toBe(1); expect(answers).toBe(0);
});

test('nested routes fail instead of recursively categorizing', async () => {
  const f = fixture(); const route = await f.router.prepare({ messages: [] });
  const recursive = { ...route, provider: { ...f.target, async chat(request: ChatRequest) { return f.router.chat(request); } } };
  await expect(chatWithDecisionRoute(recursive, { model: 'general', messages: [] })).rejects.toThrow('Nested');
  expect(f.fake.requests).toHaveLength(1); expect(f.calls).toHaveLength(0);
});

test('retired decision authority and cancellation prevent answer dispatch', async () => {
  const f = fixture(); const owner = new AbortController();
  const route = await f.router.prepare({ messages: [], signal: owner.signal });
  owner.abort();
  await expect(chatWithDecisionRoute(route, { model: 'coding', messages: [] })).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  const retired = fixture(); retired.retire();
  await expect(retired.router.prepare({ messages: [] })).rejects.toThrow('retired');
  expect(retired.calls).toHaveLength(0);
});

test('the supported minimum expanded context keeps all six recent text previews inside their per-message and total allowance', () => {
  const messages: ChatRequest['messages'] = [...Array.from({ length: 6 }, (_, index) => ({ role: 'user' as const, content: `Earlier turn ${index} `.repeat(100) })),
    { role: 'user', content: 'Current request '.repeat(100) }];
  const original = JSON.stringify(messages);
  const result = buildDecisionRoutingPreview(messages, { turnId: 'minimum-context', activeTask: 'Active task '.repeat(100) }, undefined, 512, true);
  const allowance = Math.floor(512 * 0.2 / 6);
  expect(result.recent).toHaveLength(6);
  expect(result.recent.every(message => message.content.text.length <= allowance && message.content.omittedChars > 0)).toBe(true);
  expect(result.request.text.length + result.activeTask.text.length + result.selectedFiles.reduce((sum, file) => sum + file.length, 0)
    + result.recent.reduce((sum, message) => sum + message.content.text.length, 0)).toBeLessThanOrEqual(512);
  expect(JSON.stringify(messages)).toBe(original);
});


test('Router runtime authentication metadata follows the actual General target without claiming its credentials', () => {
  const f = fixture();
  expect(f.router.describeRuntime().auth).toMatchObject({ mode: 'anonymous', configured: true,
    routes: [{ route: 'anonymous', configured: true, usable: true, freshness: 'healthy' }] });
  expect(f.router.describeRuntime().auth?.detail).toContain('own authentication');
  expect(f.fake.requests).toHaveLength(0); expect(f.calls).toHaveLength(0);
  f.settings({});
  expect(f.router.describeRuntime().auth).toMatchObject({ configured: false,
    routes: [{ route: 'anonymous', configured: false, usable: false, freshness: 'unconfigured' }] });
  f.settings({ categories: { general: { target: general } } });
  expect(f.router.describeRuntime().auth?.configured).toBe(true);
  expect(f.fake.requests).toHaveLength(0);
});
