/**
 * The gate: the deterministic boundary, the Jev stakes reading composed in
 * code, the presets over the stakes table, the trust-gated approval for a
 * tainted outward call, MCP capability reading, and the gate events the tool
 * pipeline emits. Every reading comes from a fake port (gate-readings.ts).
 */
import { describe, expect, test } from 'bun:test';
import { READ_ONLY, useGateReadings } from './_helpers/gate-readings.ts';
import { PermissionManager, type PermissionConfigReader } from '../platform/src/platform/permissions/manager.js';
import type { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.js';
import type { PermissionMode } from '../platform/src/platform/config/schema.js';
import type { PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.js';
import { UntrustedContentLedger } from '../platform/src/platform/security/untrusted-content.js';
import { runBoundary, stringFieldsOf } from '../platform/src/platform/gate/boundary.js';
import { stakesFromFacts, readingArguments, type GateReading } from '../platform/src/platform/gate/reading.js';
import { decideByPreset, GATE_PRESETS, presetForMode } from '../platform/src/platform/gate/presets.js';
import { McpPermissionManager } from '../platform/src/platform/runtime/mcp/permissions.js';
import { permissionPhase } from '../platform/src/platform/runtime/tools/phases/permission.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';

function reader(mode: PermissionMode): PermissionConfigReader {
  return {
    isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => '/tmp/gate-tests',
    getSnapshot: () => ({ permissions: { mode, tools: {} } }),
  } as unknown as PermissionConfigReader;
}

const policyState = (): Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'> => ({
  recordPermissionRequest: () => {},
  recordPermissionDecision: () => {},
  getRegistry: () => ({ getCurrent: () => undefined }) as unknown as ReturnType<PolicyRuntimeState['getRegistry']>,
});

function gate(mode: PermissionMode, options: { approve?: boolean; surface?: string; ledger?: UntrustedContentLedger } = {}) {
  const asks: PermissionPromptRequest[] = [];
  const manager = new PermissionManager(
    async (request) => { asks.push(request); return { approved: options.approve ?? false, remember: false }; },
    reader(mode),
    policyState(),
    null,
    null,
    null,
    { surfaceOf: () => options.surface, ...(options.ledger ? { ledger: options.ledger } : {}) },
  );
  return { manager, asks };
}

describe('the stakes rule (composed in code from the readings)', () => {
  const none = { mutates: false, outward: false, secrets: false, irreversible: false, beyondProject: false, weakensSecurity: false, obfuscated: false };
  test('each fact moves the stakes as the rule says', () => {
    expect(stakesFromFacts(none)).toBe('low');
    expect(stakesFromFacts({ ...none, mutates: true })).toBe('medium');
    expect(stakesFromFacts({ ...none, mutates: true, beyondProject: true })).toBe('high');
    expect(stakesFromFacts({ ...none, secrets: true })).toBe('high');
    expect(stakesFromFacts({ ...none, outward: true })).toBe('high');
    expect(stakesFromFacts({ ...none, irreversible: true })).toBe('high');
    expect(stakesFromFacts({ ...none, irreversible: true, outward: true })).toBe('critical');
    expect(stakesFromFacts({ ...none, secrets: true, outward: true })).toBe('critical');
    expect(stakesFromFacts({ ...none, weakensSecurity: true })).toBe('critical');
    expect(stakesFromFacts({ ...none, obfuscated: true })).toBe('critical');
  });

  test('long argument strings reach the reading completely', () => {
    const content = `${'x'.repeat(5000)} TAIL_SCOPE_SENTINEL`;
    const complete = readingArguments({ content }) as { content: string };
    expect(complete.content).toBe(content);
    expect(Object.isFrozen(complete)).toBe(true);
  });
});

describe('the shared execution presets', () => {
  test('saved modes normalize to one of the three execution policies', () => {
    expect(presetForMode('prompt').name).toBe('safe-owner');
    expect(presetForMode('accept-edits').name).toBe('safe-owner');
    expect(presetForMode('plan').name).toBe('plan');
    expect(presetForMode('allow-all').name).toBe('yolo');
    expect(presetForMode('auto').name).toBe('safe-jev');
    expect(presetForMode('custom').name).toBe('safe-owner');
    expect(presetForMode('something-else').name).toBe('safe-owner');
  });

  test('ordinary actions are permitted in both safe modes and YOLO permits critical actions too', () => {
    for (const mode of ['safe-owner', 'safe-jev'] as const) {
      for (const stakes of ['low', 'medium', 'high'] as const) {
        expect(decideByPreset(GATE_PRESETS[mode], { stakes, family: 'generic', changesState: true }).action).toBe('allow');
      }
      expect(decideByPreset(GATE_PRESETS[mode], { stakes: 'critical', family: 'generic', changesState: true }).action).toBe('ask');
    }
    expect(decideByPreset(GATE_PRESETS.yolo, { stakes: 'critical', family: 'shell-destructive', changesState: true }).action).toBe('allow');
    expect(decideByPreset(GATE_PRESETS.plan, { stakes: 'low', family: 'generic', changesState: true }).action).toBe('deny');
  });
});

/** A reading built in code, for exercising the boundary composition directly. */
function reading(over: Partial<GateReading> & { boundary?: GateReading['boundary'] } = {}): GateReading {
  return {
    mutates: false, outward: false, secrets: false, irreversible: false, beyondProject: false, weakensSecurity: false, obfuscated: false,
    family: 'generic', familyConfident: true, stakes: 'low', uncertain: [],
    boundary: { cardDetails: 'no' },
    recordAction: () => {},
    ...over,
  };
}

describe('the boundary composition', () => {
  test('a catastrophic reading refuses; an uncertain one passes for the presets to ask', async () => {
    const refused = await runBoundary({ toolName: 'exec', args: { command: 'x' }, reading: reading({ boundary: { catastrophic: 'yes', cardDetails: 'no' } }) });
    expect(refused.passed).toBe(false);
    if (!refused.passed) expect(refused.refusedBy).toBe('catastrophic');
    const unsure = await runBoundary({ toolName: 'exec', args: { command: 'x' }, reading: reading({ boundary: { catastrophic: 'uncertain', cardDetails: 'no' } }) });
    expect(unsure.passed).toBe(true);
  });

  test('surface authority: an input-only surface cannot direct a change; reads pass anywhere; a command surface can', async () => {
    const change = reading({ mutates: true });
    const email = await runBoundary({ toolName: 'write', args: { path: 'a' }, reading: change, surfaceId: 'email' });
    expect(email.passed).toBe(false);
    if (!email.passed) expect(email.refusedBy).toBe('surface-authority');
    expect((await runBoundary({ toolName: 'write', args: { path: 'a' }, reading: change, surfaceId: 'telegram' })).passed).toBe(true);
    expect((await runBoundary({ toolName: 'read', args: { path: 'a' }, reading: null, surfaceId: 'email' })).passed).toBe(true);
  });

  test('card details on an outward call: a yes refuses outright, an uncertain reading is approvable, a local call is not checked', async () => {
    const ledger = new UntrustedContentLedger();
    const yes = await runBoundary({ toolName: 'channel', args: { text: 'x' }, reading: reading({ outward: true, boundary: { cardDetails: 'yes' } }), ledger });
    expect(yes.passed).toBe(false);
    if (!yes.passed) {
      expect(yes.refusedBy).toBe('card-details');
      expect(yes.approvable).toBeUndefined();
    }
    const unsure = await runBoundary({ toolName: 'channel', args: { text: 'x' }, reading: reading({ outward: true, boundary: { cardDetails: 'uncertain' } }), ledger });
    if (!unsure.passed) expect(unsure.approvable?.content).toEqual({ text: 'x' });
    expect(unsure.passed).toBe(false);
    expect((await runBoundary({ toolName: 'write', args: { content: 'x' }, reading: reading({ mutates: true, boundary: { cardDetails: 'yes' } }) })).passed).toBe(true);
  });

  test('a turn with no untrusted reads passes the outward check without a reading', async () => {
    const verdict = await runBoundary({ toolName: 'channel', args: { text: 'hi' }, reading: reading({ outward: true }), ledger: new UntrustedContentLedger() });
    expect(verdict.passed).toBe(true);
    expect(stringFieldsOf({ a: 'x', b: [{ c: 'y' }], d: 3 })).toEqual({ a: 'x', 'b.0.c': 'y' });
  });
});

describe('execution-mode decisions', () => {
  const readings = useGateReadings([['synthetic-danger', { catastrophic: true, weakensSecurity: true }]]);
  test('owner safety permits ordinary tool effects without human prompts', async () => {
    const { manager, asks } = gate('safe-owner');
    for (const tool of ['read', 'repo_map', 'find', 'exec', 'write', 'edit']) {
      expect((await manager.checkDetailed(tool, { path: '.', command: 'synthetic-ordinary' })).approved).toBe(true);
    }
    expect(asks).toEqual([]);
  });

  test.each([false, true])('owner safety honors reply %s for the exact dangerous invocation', async approved => {
    const { manager, asks } = gate('safe-owner', { approve: approved });
    const args = { command: 'synthetic-danger', target: '/synthetic/fixture' };
    const result = await manager.checkDetailed('exec', args);
    expect(result.approved).toBe(approved);
    expect(result.reasonCode).toBe(approved ? 'user_approved' : 'user_denied');
    expect(asks).toHaveLength(1);
    expect(asks[0]?.args).toEqual(args);
    expect(asks[0]?.args).not.toBe(args);
  });

  test('YOLO bypasses catastrophic safety decisions while preserving host surface restrictions', async () => {
    const { manager, asks } = gate('yolo');
    expect((await manager.checkDetailed('write', { path: '/synthetic/file', content: 'synthetic-danger' })).approved).toBe(true);
    expect((await manager.checkDetailed('exec', { command: 'synthetic-danger' })).approved).toBe(true);
    const restricted = gate('yolo', { surface: 'web-page' });
    expect((await restricted.manager.checkDetailed('write', { path: '/synthetic/file', content: 'synthetic-danger' })).approved).toBe(false);
    expect(asks).toHaveLength(0);
    expect(readings.requests).toHaveLength(0);
  });

  test('standalone MCP configuration keeps its explicit allow/deny contract', async () => {
    const before = readings.requests.length;
    const manager = new McpPermissionManager();
    manager.registerServer('fixture');
    expect((await manager.evaluateToolCall('fixture', 'list_directory', { path: '.' })).allowed).toBe(true);
    manager.denyTool('fixture', 'list_directory');
    expect((await manager.evaluateToolCall('fixture', 'list_directory', { path: '.' })).allowed).toBe(false);
    expect(readings.requests.slice(before).filter(request => 'capability' in (request.questions ?? {}) || 'disposition' in (request.questions ?? {}))).toHaveLength(0);
  });
});

describe('the tool pipeline emits the gate events', () => {
  useGateReadings([['"ls"', READ_ONLY]]);

  test('YOLO reports the execution decision without pretending a boundary or stakes reading ran', async () => {
    const bus = new RuntimeEventBus();
    const seen: string[] = [];
    bus.onDomain('gate', (env) => { seen.push(env.type); });
    const { manager } = gate('yolo');
    const result = await permissionPhase(
      { id: 'c1', name: 'exec', arguments: { command: 'ls' } },
      {} as never,
      { permissionManager: manager, runtimeBus: bus, ids: { sessionId: 's', traceId: 't' } } as never,
      {} as never,
    );
    expect(result.success).toBe(true);
    await Promise.resolve();
    expect(seen[0]).toBe('GATE_REQUESTED');
    expect(seen.at(-1)).toBe('DECISION_EMITTED');
    expect(seen).not.toContain('BOUNDARY_CHECKED');
    expect(seen).not.toContain('STAKES_READ');
  });
});
