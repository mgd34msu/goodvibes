import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { judgmentConfigFromSettings } from '../sdk/src/platform/runtime/judgment-services.js';
import { openSettingsChoice, type SettingsChoiceAction } from '../terminal-shell/src/settings-choice-actions.js';
import { SelectionModal, type OpenSelection } from '../terminal-shell/src/selection-modal.js';
import { handleSelectionModalToken } from '../terminal-shell/src/modal-input-routes.js';
import { DECISION_MODEL_PROFILES } from '@goodvibes-jev/judgment';
import { openDecisionRouterSettings } from '../terminal-shell/src/decision-router-settings-actions.js';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry-types.js';
import { createSettingsValueHelpers } from '../terminal-shell/src/renderer/settings-value-helpers.js';

const owned: string[] = [];
afterEach(() => { for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(action: Exclude<SettingsChoiceAction, 'decision-router'>) {
  const root = mkdtempSync(join(tmpdir(), 'settings-controls-')); owned.push(root);
  const config = new ConfigManager({ surfaceRoot: 'tui', configDir: root, workingDir: root, homeDir: root });
  const modal = new SelectionModal();
  const state = { selectionModal: modal, selectionCallback: null as Parameters<OpenSelection>[3] | null,
    modalStack: [] as string[], requestRender() {}, handleEscape() { modal.close(); } };
  const errors: string[] = [];
  const openSelection: OpenSelection = (title, items, options, callback) => {
    modal.open(title, items, { allowSearch: options?.allowSearch ?? true,
      ...(options?.preSelectId ? { preSelectId: options.preSelectId } : {}), customItem: options?.customItem });
    state.selectionCallback = callback;
  };
  const context = { platform: { configManager: config }, openSelection, print: (message: string) => errors.push(message), renderRequest() {} };
  expect(openSettingsChoice(context, action)).toBe(true);
  const enter = () => handleSelectionModalToken(state, { type: 'key', name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false });
  const choose = (id: string) => {
    const index = modal.filteredItems.findIndex(item => item.id === id);
    expect(index).toBeGreaterThanOrEqual(0);
    modal.selectedIndex = index; enter();
  };
  const type = (text: string) => handleSelectionModalToken(state, { type: 'text', value: text });
  return { config, modal, errors, choose, type, enter, root, context,
    reopen: () => openSettingsChoice(context, action) };
}

for (const profile of DECISION_MODEL_PROFILES) test(`${profile.name} selection persists the correct adapter, endpoint and credential reference`, async () => {
  const f = fixture('judgment-model');
  const chat = f.config.get('provider.model');
  f.choose(profile.id);
  const endpoint = profile.adapter === 'cloudflare-workers-ai'
    ? `https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/cloudflare/${profile.model}`
    : profile.id === 'jev' ? 'https://api.typesafe.ai' : 'http://127.0.0.1:4321';
  if (profile.id === 'jev') f.choose(endpoint);
  else { f.type(endpoint); f.enter(); }
  f.choose(profile.adapter === 'cloudflare-workers-ai' || profile.id === 'jev' ? 'official' : 'none');
  expect(f.errors).toEqual([]);
  expect(f.config.get('judgment.model')).toBe(profile.model);
  expect(f.config.get('judgment.backend')).toMatchObject({ adapter: profile.adapter });
  expect(f.config.get('judgment.endpoint')).toBe(endpoint);
  expect(f.config.get('provider.model')).toBe(chat);
  const live = await judgmentConfigFromSettings({ config: f.config, secrets: { async get() { return null; } }, env: {
    TYPESAFE_API_KEY: 'synthetic-typesafe-value', CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-value',
  } });
  expect(live.model).toBe(profile.model);
  expect(live.endpoint.baseURL).toBe(endpoint);
  expect(live.endpoint.adapter).toBe(profile.adapter);
  const saved = readFileSync(join(f.root, 'settings.json'), 'utf8');
  expect(saved).not.toContain('synthetic-typesafe-value'); expect(saved).not.toContain('synthetic-cloudflare-value');
  expect(new ConfigManager({ surfaceRoot: 'tui', configDir: f.root, workingDir: f.root, homeDir: f.root }).get('judgment.model')).toBe(profile.model);
});

test('canceling a decision picker leaves settings untouched', () => {
  const f = fixture('judgment-provider');
  const before = f.config.get('judgment.model');
  f.choose('laya'); f.choose('laya');
  handleSelectionModalToken({ selectionModal: f.modal, selectionCallback: null, modalStack: [], requestRender() {}, handleEscape() { f.modal.close(); } },
    { type: 'key', name: 'escape', logicalName: 'escape', ctrl: false, shift: false, meta: false });
  expect(f.config.get('judgment.model')).toBe(before);
});

test('Classic policy is selectable without a working decision endpoint', () => {
  const f = fixture('decision-policy'); f.choose('Classic - Off');
  expect(f.config.get('judgment.policy')).toBe('Classic - Off');
  expect(f.errors).toEqual([]);
});

test('fallback order can be changed through the shared picker', () => {
  const f = fixture('judgment-fallbacks');
  const first = { endpoint: 'http://127.0.0.1:4321', model: 'dgemma', keySource: 'none' as const, keyName: '' };
  const second = { ...first, model: 'kev-latest' };
  f.config.set('judgment.fallbacks', [first, second]);
  // Reopen after the external seed so the rendered list reflects current config.
  const chooseAgain: OpenSelection = (title, items, options, callback) => {
    f.modal.open(title, items, { allowSearch: options?.allowSearch ?? true });
    const item = items.find(entry => entry.id === (title === 'Decision fallback order' ? '1' : 'up'));
    expect(item).toBeDefined(); callback({ item: item!, action: 'select' });
  };
  openSettingsChoice({ platform: { configManager: f.config }, openSelection: chooseAgain, print() {}, renderRequest() {} }, 'judgment-fallbacks');
  expect(f.config.get('judgment.fallbacks').map(target => target.model)).toEqual(['kev-latest', 'dgemma']);
});

test('fallback deletion and reference-only authentication survive reloading', () => {
  const f = fixture('judgment-fallbacks');
  f.config.set('judgment.fallbacks', [{ endpoint: 'http://127.0.0.1:4321', model: 'kev-latest', keySource: 'none', keyName: '' }]);
  f.reopen(); f.choose('0'); f.choose('remove');
  expect(f.config.get('judgment.fallbacks')).toEqual([]);
  f.reopen(); f.choose('add'); f.choose('laya'); f.type('http://127.0.0.1:4322'); f.enter();
  f.choose('secret'); f.type('decision/local-token'); f.enter();
  expect(f.errors).toEqual([]);
  expect(f.config.get('judgment.fallbacks')).toMatchObject([
    { model: 'english', keySource: 'secret', keyName: 'decision/local-token', backend: { adapter: 'laya' } },
  ]);
});

test('a stale fallback picker cannot delete a replacement target', () => {
  const f = fixture('judgment-fallbacks');
  const first = { endpoint: 'http://127.0.0.1:4321', model: 'kev-latest', keySource: 'none' as const, keyName: '' };
  f.config.set('judgment.fallbacks', [first]); f.reopen(); f.choose('0');
  f.config.set('judgment.fallbacks', [{ ...first, model: 'dgemma' }]);
  f.choose('remove');
  expect(f.config.get('judgment.fallbacks')[0]?.model).toBe('dgemma');
  expect(f.errors[0]).toContain('Settings changed');
});

test('editing a custom fallback preserves that target protocol rather than inheriting the primary provider', () => {
  const f = fixture('judgment-fallbacks');
  f.config.set('judgment.backend', { adapter: 'system-one' });
  f.config.set('judgment.fallbacks', [{ endpoint: 'http://127.0.0.1:4322', model: 'english', keySource: 'none', keyName: '',
    backend: { adapter: 'laya', responseModels: ['laya-rl-agent', 'local-checkpoint'] } }]);
  f.reopen(); f.choose('0'); f.choose('edit');
  expect(f.modal.getSelected()?.id).toBe('laya');
  f.type('custom-checkpoint'); f.enter(); f.choose('http://127.0.0.1:4322'); f.choose('none');
  expect(f.config.get('judgment.fallbacks')[0]).toMatchObject({ model: 'custom-checkpoint',
    backend: { adapter: 'laya', responseModels: ['laya-rl-agent', 'local-checkpoint'] } });
  expect(f.config.get('judgment.backend')).toEqual({ adapter: 'system-one' });
  expect(f.errors).toEqual([]);
});

test('execution permission selection uses the active-session owner callback', () => {
  const f = fixture('permission-mode'); const selected: string[] = [];
  openSettingsChoice(f.context, 'permission-mode', () => {}, value => selected.push(value));
  const previous = f.config.get('permissions.mode'); f.choose('yolo');
  expect(selected).toEqual(['yolo']);
  expect(f.config.get('permissions.mode')).toBe(previous);
});

test('Decision Router category controls save provider, model and supported effort without switching chat', () => {
  const f = fixture('decision-policy');
  const answer: ModelDefinition = { provider: 'answer', id: 'code', registryKey: 'answer:code', displayName: 'Code', description: '',
    selectable: true, contextWindow: 8192, capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    reasoningEffort: { kind: 'effort', source: 'declared', values: ['low', 'high', 'xhigh', 'max'], defaultValue: 'high' } };
  const context = { ...f.context, provider: { providerRegistry: { listModels: () => [answer] } } };
  const chat = f.config.get('provider.model');
  openDecisionRouterSettings(context);
  expect(f.modal.items).toHaveLength(11); // Ten categories and advanced controls.
  f.choose('general'); f.choose('answer'); f.choose('answer:code'); f.choose('max');
  expect(f.config.get('provider.decisionRouter').categories['general']?.target).toEqual({ provider: 'answer', model: 'code', effort: 'max' });
  openDecisionRouterSettings(context); f.choose('coding-implementation'); f.choose('__general__');
  expect(f.config.get('provider.decisionRouter').categories['coding-implementation']?.target).toBeNull();
  expect(f.config.get('provider.model')).toBe(chat);
  expect(f.errors).toEqual([]);
});

test('a stale Decision Router advanced editor cannot overwrite a newer category target', () => {
  const f = fixture('decision-policy');
  const context = { ...f.context, provider: { providerRegistry: { listModels: () => [] } } };
  openDecisionRouterSettings(context); f.choose('__advanced__');
  const old = f.modal.items[0]?.id;
  expect(old).toBeDefined();
  const replacement = { categories: { general: { target: { provider: 'answer', model: 'newer' } } } };
  f.config.set('provider.decisionRouter', replacement);
  f.choose(old!);
  expect(f.config.get('provider.decisionRouter').categories['general']?.target?.model).toBe('newer');
  expect(f.errors[0]).toContain('Routing settings changed');
});

test('a stale Decision Router category picker cannot clear a newer override', () => {
  const f = fixture('decision-policy');
  const context = { ...f.context, provider: { providerRegistry: { listModels: () => [] } } };
  openDecisionRouterSettings(context); f.choose('research');
  f.config.set('provider.decisionRouter', { categories: { research: { target: { provider: 'answer', model: 'newer' } } } });
  f.choose('__general__');
  expect(f.config.get('provider.decisionRouter').categories['research']?.target?.model).toBe('newer');
  expect(f.errors[0]).toContain('Routing settings changed');
});

test('structured terminal settings describe their actual picker controls', () => {
  const helpers = createSettingsValueHelpers({ richValues: true, featureLabels: false,
    isSecretKey: () => false, isSecretReference: () => false, labels: {}, panelDescription: '', bothDescription: '' });
  const value = (key: string, currentValue: unknown) => helpers.formatValue({ setting: { key }, currentValue, isDefault: false });
  expect(value('judgment.fallbacks', [])).toBe('0 fallback targets (Enter to add)');
  expect(value('judgment.fallbacks', [{ model: 'english' }])).toBe('1 fallback target (Enter to edit order)');
  expect(value('provider.decisionRouter', {})).toBe('Enter to configure category routes');
});


test('terminal decision endpoint chooser refuses the same unsafe destinations that native settings and transport refuse', () => {
  for (const endpoint of ['https://user:pass@example.test', 'https://example.test?token=example', 'https://example.test#fragment', ' https://example.test', 'https://example.test\\private']) {
    const f = fixture('judgment-model'); f.choose('kev-9b');
    f.type(endpoint);
    expect(f.modal.filteredItems.some(item => item.id === endpoint)).toBe(false);
    expect(f.config.get('judgment.endpoint')).toBe('');
  }
});
