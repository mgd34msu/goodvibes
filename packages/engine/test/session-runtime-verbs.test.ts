/**
 * session-runtime-verbs.test.ts
 *
 * The session-scoped operator verbs: sessions.permissionMode.get/set and
 * sessions.contextUsage.get. Pins the operator<->config mode vocabulary
 * mapping, the honest 404 for a non-local session, the previousMode reported
 * on a set, and the context-usage figures (derived from the estimator, flagged
 * `estimated`).
 */
import { describe, expect, test } from 'bun:test';
import { GATE_PRESETS, SESSION_GATE_PRESET_NAMES, isGatePresetName, isSettableGatePresetName, gatePresetLabel } from '@goodvibes-jev/engine/platform/platform/gate/presets';
import { ModelLimitsService } from '../platform/src/platform/providers/model-limits.js';
import type { ModelDefinition } from '../platform/src/platform/providers/registry-types.js';
import { deriveContextUsage } from '../platform/src/platform/runtime/context-usage.js';
import { firstJsonSchemaFailure } from '../transport-http/src/client-plumbing.js';
import type { GatewayMethodInvocation } from '../platform/src/platform/control-plane/method-catalog-shared.js';
import type { PermissionMode } from '../platform/src/platform/config/schema-types.js';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';
import { GatewayVerbError } from '../platform/src/platform/control-plane/routes/gateway-verb-error.js';
import {
  createSessionRuntimeControls,
  SessionLiveTurnControlsHolder,
  createSessionPermissionModeGetHandler,
  createSessionPermissionModeSetHandler,
  createSessionContextUsageGetHandler,
  registerSessionRuntimeGatewayMethods,
  toOperatorPermissionMode,
  toConfigPermissionMode,
  type PermissionModeConfig,
  type SessionRuntimeStateReader,
} from '../platform/src/platform/control-plane/routes/session-runtime.js';

function invoke(body: Record<string, unknown>): GatewayMethodInvocation {
  return { body, context: {} };
}

/** A config double storing a single permissions.mode value. */
function makeConfig(initial: PermissionMode): PermissionModeConfig & { current: PermissionMode; autoApprove: boolean } {
  return {
    current: initial, autoApprove: false,
    get(key) {
      return key === 'behavior.autoApprove' ? this.autoApprove : this.current;
    },
    set(key, value) {
      if (key === 'behavior.autoApprove') {
        if (typeof value !== 'boolean') throw new Error('Expected boolean auto-approval flag');
        this.autoApprove = value;
      } else {
        if (typeof value !== 'string') throw new Error('Expected permission mode');
        this.current = value;
      }
    },
  };
}

function makeStore(sessionId: string, usedTokens: number, contextWindow: number): SessionRuntimeStateReader {
  return {
    getState: () => ({
      session: { id: sessionId },
      conversation: { estimatedContextTokens: usedTokens },
      model: { tokenLimits: { contextWindow } },
    }),
  };
}

const model: ModelDefinition = {
  id: 'fixture-model', provider: 'fixture-provider', registryKey: 'fixture-provider:fixture-model',
  displayName: 'Fixture model', description: '', selectable: true, contextWindow: 100_000,
  capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
};
const limits = new ModelLimitsService({ cachePath: '/unused/session-context-limits.json' });
function registry(getCurrentModel: () => ModelDefinition = () => model) {
  return {
    getCurrentModel,
    getContextWindowForModel: (entry: ModelDefinition) => limits.getContextWindowForModel(entry),
    getKnownContextWindowForModel: (entry: ModelDefinition) => limits.getKnownContextWindowForModel(entry),
  };
}

// ── vocabulary mapping ───────────────────────────────────────────────────────

describe('permission mode vocabulary', () => {
  test('config -> operator vocabulary', () => {
    expect(toOperatorPermissionMode('prompt')).toBe('safe-owner');
    expect(toOperatorPermissionMode('allow-all')).toBe('yolo');
    expect(toOperatorPermissionMode('plan')).toBe('plan');
    expect(toOperatorPermissionMode('accept-edits')).toBe('safe-owner');
    expect(toOperatorPermissionMode('custom')).toBe('safe-owner');
  });

  test('operator -> config vocabulary (settable only)', () => {
    expect(toConfigPermissionMode('safe-owner')).toBe('safe-owner');
    expect(toConfigPermissionMode('safe-jev')).toBe('safe-jev');
    expect(toConfigPermissionMode('yolo')).toBe('yolo');
    expect(toConfigPermissionMode('plan')).toBe('plan');
    expect(() => toConfigPermissionMode('accept-edits')).toThrow(GatewayVerbError);
  });

  test('an unknown or non-settable mode is a 400', () => {
    expect(() => toConfigPermissionMode('custom')).toThrow(GatewayVerbError);
    expect(() => toConfigPermissionMode('nope')).toThrow(GatewayVerbError);
  });
});

// ── get / set handlers ───────────────────────────────────────────────────────

describe('sessions.permissionMode get/set', () => {
  test('a hosted mode selection changes only its owning session and awaits persistence', async () => {
    const config = makeConfig('safe-owner');
    const holder = new SessionLiveTurnControlsHolder();
    let firstMode: 'safe-owner' | 'safe-jev' | 'yolo' | 'plan' = 'safe-owner';
    let secondMode: 'safe-owner' | 'safe-jev' | 'yolo' | 'plan' = 'safe-jev';
    let saved = false;
    const turnControls = {
      cancelToolCall: () => false, listQueuedMessages: () => [],
      editQueuedMessage: () => false, deleteQueuedMessage: () => false,
    };
    holder.bindSession('first', { ...turnControls, getPermissionMode: () => firstMode,
      async setPermissionMode(mode) { firstMode = mode; await Promise.resolve(); saved = true; } });
    holder.bindSession('second', { ...turnControls, getPermissionMode: () => secondMode,
      async setPermissionMode(mode) { secondMode = mode; } });
    const controls = createSessionRuntimeControls({ config, store: makeStore('daemon', 0, 0), liveTurnHolder: holder });
    const result = await createSessionPermissionModeSetHandler(controls)(invoke({ sessionId: 'first', mode: 'yolo' }));
    expect(saved).toBe(true);
    expect(result).toEqual({ sessionId: 'first', mode: 'yolo', previousMode: 'safe-owner' });
    expect(controls.getPermissionMode('second')).toBe('safe-jev');
    expect(controls.getPermissionMode('daemon')).toBe('safe-owner');
    expect(config.current).toBe('safe-owner');
    expect(config.autoApprove).toBe(false);
  });

  test('a hosted binding without a mode owner cannot mutate daemon configuration', () => {
    const config = makeConfig('safe-owner');
    const holder = new SessionLiveTurnControlsHolder();
    holder.bindSession('hosted', { cancelToolCall: () => false, listQueuedMessages: () => [],
      editQueuedMessage: () => false, deleteQueuedMessage: () => false });
    const controls = createSessionRuntimeControls({ config, store: makeStore('daemon', 0, 0), liveTurnHolder: holder });
    expect(() => createSessionPermissionModeSetHandler(controls)(invoke({ sessionId: 'hosted', mode: 'yolo' })))
      .toThrow(expect.objectContaining({ code: 'LIVE_MODE_UNAVAILABLE' }));
    expect(config.current).toBe('safe-owner');
  });

  test('an explicit safe selection exits the legacy auto-approval override', () => {
    const config = makeConfig('safe-owner');
    config.autoApprove = true;
    const controls = createSessionRuntimeControls({ config, store: makeStore('sess-1', 0, 0) });
    expect(createSessionPermissionModeGetHandler(controls)(invoke({ sessionId: 'sess-1' })))
      .toEqual({ sessionId: 'sess-1', mode: 'yolo' });
    expect(createSessionPermissionModeSetHandler(controls)(invoke({ sessionId: 'sess-1', mode: 'safe-jev' })))
      .toEqual({ sessionId: 'sess-1', mode: 'safe-jev', previousMode: 'yolo' });
    expect(config.autoApprove).toBe(false);
    expect(controls.getPermissionMode()).toBe('safe-jev');
  });

  test.each([...SESSION_GATE_PRESET_NAMES])('the advertised %s preset round-trips through the real local handlers', (name) => {
    const config = makeConfig('custom');
    const controls = createSessionRuntimeControls({ config, store: makeStore('sess-1', 0, 0) });
    const get = createSessionPermissionModeGetHandler(controls);
    const set = createSessionPermissionModeSetHandler(controls);
    expect(get(invoke({ sessionId: 'sess-1' }))).toEqual({ sessionId: 'sess-1', mode: 'safe-owner' });
    expect(isSettableGatePresetName(name)).toBe(true);
    expect(set(invoke({ sessionId: 'sess-1', mode: name })))
      .toEqual({ sessionId: 'sess-1', mode: name, previousMode: 'safe-owner' });
    expect(config.current).toBe(GATE_PRESETS[name].mode);
    expect(get(invoke({ sessionId: 'sess-1' }))).toEqual({ sessionId: 'sess-1', mode: name });
  });

  test.each(['custom', 'future-mode', '', 'toString'])('the unadvertised %s value cannot mutate session configuration', (name) => {
    const config = makeConfig('custom');
    const controls = createSessionRuntimeControls({ config, store: makeStore('sess-1', 0, 0) });
    expect(isSettableGatePresetName(name)).toBe(false);
    expect(() => createSessionPermissionModeSetHandler(controls)(invoke({ sessionId: 'sess-1', mode: name })))
      .toThrow(GatewayVerbError);
    expect(config.current).toBe('custom');
  });

  test('a preset choice for another session leaves the local owner configuration untouched', () => {
    const config = makeConfig('custom');
    const controls = createSessionRuntimeControls({ config, store: makeStore('sess-1', 0, 0) });
    expect(() => createSessionPermissionModeSetHandler(controls)(invoke({ sessionId: 'other-session', mode: 'safe-jev' })))
      .toThrow(expect.objectContaining({ code: 'SESSION_NOT_LOCAL' }));
    expect(config.current).toBe('custom');
  });

  test('get returns the operator-vocabulary mode for the local runtime', () => {
    const config = makeConfig('prompt');
    const controls = createSessionRuntimeControls({ config, store: makeStore('sess-1', 0, 0) });
    const out = createSessionPermissionModeGetHandler(controls)(invoke({ sessionId: 'sess-1' }));
    expect(out).toEqual({ sessionId: 'sess-1', mode: 'safe-owner' });
  });

  test('the stable "runtime" alias always resolves the local runtime', () => {
    const config = makeConfig('plan');
    const controls = createSessionRuntimeControls({ config, store: makeStore('sess-1', 0, 0) });
    const out = createSessionPermissionModeGetHandler(controls)(invoke({ sessionId: 'runtime' }));
    expect(out).toEqual({ sessionId: 'runtime', mode: 'plan' });
  });

  test('set writes config and reports the previous mode', () => {
    const config = makeConfig('prompt');
    const controls = createSessionRuntimeControls({ config, store: makeStore('sess-1', 0, 0) });
    const out = createSessionPermissionModeSetHandler(controls)(invoke({ sessionId: 'sess-1', mode: 'plan' }));
    expect(out).toEqual({ sessionId: 'sess-1', mode: 'plan', previousMode: 'safe-owner' });
    expect(config.current).toBe('plan'); // config actually mutated (fires the wire event via the binding)
  });

  test('a non-local session id is an honest 404, never a fabricated answer', () => {
    const controls = createSessionRuntimeControls({ config: makeConfig('prompt'), store: makeStore('sess-1', 0, 0) });
    let thrown: unknown;
    try {
      createSessionPermissionModeGetHandler(controls)(invoke({ sessionId: 'other-session' }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GatewayVerbError);
    expect((thrown as GatewayVerbError).code).toBe('SESSION_NOT_LOCAL');
  });

  test('a missing sessionId is a 400', () => {
    const controls = createSessionRuntimeControls({ config: makeConfig('prompt'), store: makeStore('sess-1', 0, 0) });
    expect(() => createSessionPermissionModeGetHandler(controls)(invoke({}))).toThrow(GatewayVerbError);
  });
});

// ── context usage ─────────────────────────────────────────────────────────────

describe('sessions.contextUsage.get', () => {
  test('reports estimated tokens + derived pct/remaining, flagged estimated', () => {
    const controls = createSessionRuntimeControls({
      config: makeConfig('prompt'),
      store: makeStore('sess-1', 40_000, 200_000),
      providerRegistry: registry(),
    });
    const out = createSessionContextUsageGetHandler(controls)(invoke({ sessionId: 'sess-1' }));
    expect(out).toEqual({
      sessionId: 'sess-1',
      estimatedContextTokens: 40_000,
      contextWindow: 100_000,
      contextWindowSource: 'registry',
      contextUsagePct: 40,
      contextRemainingTokens: 60_000,
      estimated: true,
    });
  });

  test('missing registry stays unknown despite a positive store budget', () => {
    const controls = createSessionRuntimeControls({
      config: makeConfig('prompt'),
      store: makeStore('sess-1', 1234, 200_000),
    });
    const out = createSessionContextUsageGetHandler(controls)(invoke({ sessionId: 'sess-1' })) as {
      contextUsagePct: number | null;
      contextRemainingTokens: number | null;
    };
    expect(out.contextUsagePct).toBeNull();
    expect(out.contextRemainingTokens).toBeNull();
  });
});

// ── descriptor + handler register together (the HTTP 501 response class) ────────────

describe('session-runtime gateway registration', () => {
  const IDS = ['sessions.permissionMode.get', 'sessions.permissionMode.set', 'sessions.contextUsage.get'];

  function makeCatalog() {
    const catalog = new GatewayMethodCatalog();
    const controls = createSessionRuntimeControls({
      config: makeConfig('prompt'),
      store: makeStore('sess-1', 40_000, 200_000),
      providerRegistry: registry(),
    });
    registerSessionRuntimeGatewayMethods(catalog, controls);
    return catalog;
  }

  test('all three verbs are cataloged with handlers attached', () => {
    const catalog = makeCatalog();
    for (const id of IDS) {
      expect(catalog.get(id)).not.toBeNull();
      expect(catalog.hasHandler(id)).toBe(true);
    }
  });

  test('the verbs round-trip through catalog.invoke', async () => {
    const catalog = makeCatalog();
    const ctx = { context: { admin: true } } as const;
    const got = await catalog.invoke('sessions.permissionMode.get', { ...ctx, body: { sessionId: 'sess-1' } }) as { mode: string };
    expect(got.mode).toBe('safe-owner');
    const set = await catalog.invoke('sessions.permissionMode.set', { ...ctx, body: { sessionId: 'sess-1', mode: 'safe-jev' } }) as { mode: string; previousMode: string };
    expect(set).toMatchObject({ mode: 'safe-jev', previousMode: 'safe-owner' });
    const usage = await catalog.invoke('sessions.contextUsage.get', { ...ctx, body: { sessionId: 'sess-1' } }) as { contextUsagePct: number; estimated: boolean };
    expect(usage.contextUsagePct).toBe(40);
    expect(usage.estimated).toBe(true);
  });
});


describe('session context provenance and identity', () => {
  test.each(['provider_api', 'configured_cap', 'observed_limit', 'catalog'] as const)('%s supplies a known denominator', source => {
    const controls = createSessionRuntimeControls({ config: makeConfig('prompt'), store: makeStore('local', 40_000, 200_000),
      providerRegistry: registry(() => ({ ...model, contextWindowProvenance: source })) });
    expect(controls.getContextUsage('local')).toMatchObject({ contextWindow: 100_000, contextUsagePct: 40,
      contextRemainingTokens: 60_000, contextWindowSource: source });
  });

  test.each(['fallback', 'accepted_floor'] as const)('%s keeps numeric estimates and accepted floors out of capacity', source => {
    const definition: ModelDefinition = { ...model, contextWindow: 128_000, contextWindowProvenance: source,
      contextWindowAcceptedFloor: 24_000, contextWindowOrigin: { kind: 'family_default' } };
    const controls = createSessionRuntimeControls({ config: makeConfig('prompt'), store: makeStore('local', 40_000, 200_000),
      providerRegistry: registry(() => definition) });
    expect(controls.getContextUsage('runtime')).toEqual({ estimatedContextTokens: 40_000, contextWindow: null,
      contextUsagePct: null, contextRemainingTokens: null, contextWindowSource: source,
      contextWindowAcceptedFloor: 24_000, contextWindowOrigin: { kind: 'family_default' } });
  });

  test('consensus retains its origin without claiming a ceiling', () => {
    const origin = { kind: 'consensus' as const, providers: 4, agreeing: 3 };
    const controls = createSessionRuntimeControls({ config: makeConfig('prompt'), store: makeStore('local', 40_000, 200_000),
      providerRegistry: registry(() => ({ ...model, contextWindowProvenance: 'catalog', contextWindowOrigin: origin })) });
    expect(controls.getContextUsage('local')).toMatchObject({ contextWindow: null, contextUsagePct: null,
      contextRemainingTokens: null, contextWindowSource: 'catalog', contextWindowOrigin: origin });
  });

  test('each read follows known, unknown, unresolvable and known-again model changes', () => {
    let current: ModelDefinition | null = model;
    const controls = createSessionRuntimeControls({ config: makeConfig('prompt'), store: makeStore('local', 40_000, 200_000),
      providerRegistry: registry(() => { if (!current) throw new Error('No current model'); return current; }) });
    expect(controls.getContextUsage('local').contextWindow).toBe(100_000);
    current = { ...model, contextWindowProvenance: 'fallback' };
    expect(controls.getContextUsage('local').contextWindow).toBeNull();
    current = null;
    expect(controls.getContextUsage('local')).toEqual({ estimatedContextTokens: 40_000, contextWindow: null,
      contextUsagePct: null, contextRemainingTokens: null });
    current = { ...model, contextWindow: 80_000, contextWindowProvenance: 'configured_cap' };
    expect(controls.getContextUsage('local')).toMatchObject({ contextWindow: 80_000, contextUsagePct: 50 });
  });

  test('hosted-only controls stay usable but cannot borrow the store context snapshot', () => {
    const holder = new SessionLiveTurnControlsHolder();
    const hosted = { cancelToolCall: () => true, listQueuedMessages: () => [], editQueuedMessage: () => true, deleteQueuedMessage: () => true };
    holder.bindSession('hosted', hosted);
    const controls = createSessionRuntimeControls({ config: makeConfig('prompt'), store: makeStore('local', 40_000, 200_000),
      providerRegistry: registry(), liveTurnHolder: holder });
    expect(controls.isLocalSession('hosted')).toBe(true);
    expect(controls.getLiveTurnControls('hosted')).toBe(hosted);
    for (const id of ['hosted', 'absent']) {
      expect(() => createSessionContextUsageGetHandler(controls)(invoke({ sessionId: id }))).toThrow(GatewayVerbError);
      try { controls.getContextUsage(id); } catch (error) { expect(error).toMatchObject({ code: 'SESSION_NOT_LOCAL', status: 404 }); }
    }
    expect(controls.getContextUsage('runtime')).toEqual(controls.getContextUsage('local'));
    expect(() => createSessionContextUsageGetHandler(controls)(invoke({}))).toThrow(GatewayVerbError);
  });

  test('actual nullable responses obey the canonical typed schema', () => {
    const schema = new GatewayMethodCatalog().get('sessions.contextUsage.get')!.outputSchema!;
    for (const definition of [model, { ...model, contextWindowProvenance: 'fallback' as const, contextWindowAcceptedFloor: 24_000 },
      { ...model, contextWindowProvenance: 'catalog' as const, contextWindowOrigin: { kind: 'consensus' as const, providers: 4, agreeing: 3 } }]) {
      const controls = createSessionRuntimeControls({ config: makeConfig('prompt'), store: makeStore('local', 40_000, 200_000), providerRegistry: registry(() => definition) });
      const output = createSessionContextUsageGetHandler(controls)(invoke({ sessionId: 'local' }));
      expect(firstJsonSchemaFailure(schema, output)).toBeUndefined();
    }
    const base = { sessionId: 'local', estimatedContextTokens: 0, contextWindow: null, contextUsagePct: null, contextRemainingTokens: null, estimated: true };
    expect(firstJsonSchemaFailure(schema, { ...base, contextWindowSource: 'guessed' })).toBeDefined();
    expect(firstJsonSchemaFailure(schema, { ...base, contextWindowOrigin: { kind: 'consensus' } })).toBeDefined();
  });
});

describe('nullable context arithmetic', () => {
  test.each([null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])('unknown %s stays distinct from exhausted', window => {
    expect(deriveContextUsage(100_000, window)).toEqual({ contextUsagePct: null, contextRemainingTokens: null });
  });
  test('known windows keep rounding, clamping and remaining semantics', () => {
    expect(deriveContextUsage(40_400, 100_000)).toEqual({ contextUsagePct: 40, contextRemainingTokens: 59_600 });
    expect(deriveContextUsage(120_000, 100_000)).toEqual({ contextUsagePct: 100, contextRemainingTokens: 0 });
    expect(deriveContextUsage(0, 100_000)).toEqual({ contextUsagePct: 0, contextRemainingTokens: 100_000 });
  });
});

// Presentation reads the operator name, never the config-vocabulary fallback.
describe('session gate preset presentation', () => {
  test('known wire names resolve to their authoritative gate table labels, including the separate plan posture', () => {
    for (const preset of Object.values(GATE_PRESETS)) {
      expect(isGatePresetName(preset.name)).toBe(true);
      expect(gatePresetLabel(toOperatorPermissionMode(preset.mode))).toBe(preset.label);
    }
  });

  test.each(['future-mode', 'prompt', 'allow-all', 'toString', '__proto__'])('unknown wire name %s stays visible without claiming a known preset', (name) => {
    expect(isGatePresetName(name)).toBe(false);
    expect(gatePresetLabel(name)).toBe(name);
  });

  test('an absent wire name has no selected preset', () => {
    expect(isGatePresetName('')).toBe(false);
    expect(gatePresetLabel('')).toBe('Unknown');
  });
});
