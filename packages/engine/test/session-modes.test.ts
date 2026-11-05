/** Execution modes, persisted selections and live mode-change events. */
import { gateReadingsPort, forgetGateReadings } from './_helpers/gate-readings.ts';
import { withDecisionLog, SqliteDecisionLog, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { LayeredPolicyEvaluator } from '../sdk/src/platform/runtime/permissions/evaluator.js';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.js';
import type { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.js';
import type { PermissionMode } from '../sdk/src/platform/config/schema.js';
import { buildToolDenial, buildDenialErrorMessage, PLAN_MODE_DENIAL_REASON } from '../sdk/src/platform/permissions/denial.js';
import { bindPermissionModeChangeEvent } from '../sdk/src/platform/permissions/mode-change-emitter.js';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import {
  appendPlanModeInstruction,
  PLAN_MODE_INSTRUCTION_MARKER,
} from '../sdk/src/platform/permissions/plan-mode-instructions.js';
import { buildReinjectedInstructions } from '../sdk/src/platform/core/compaction-sections.js';

// ── helpers ────────────────────────────────────────────────────────────────

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function configFixture() {
  const root = mkdtempSync(join(tmpdir(), 'gv-execution-mode-'));
  roots.push(root);
  return new ConfigManager({ configDir: join(root, 'config'), surfaceRoot: 'agent' });
}

function makeConfigReader(mode: PermissionMode): PermissionConfigReader {
  return {
    isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => '/tmp/session-modes-tests',
    getSnapshot: () => ({ permissions: { mode, tools: {} } }),
  } as unknown as PermissionConfigReader;
}

function makePolicyRuntimeState(): Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'> {
  return {
    recordPermissionRequest: () => {},
    recordPermissionDecision: () => {},
    getRegistry: () => ({ getCurrent: () => undefined }) as unknown as ReturnType<PolicyRuntimeState['getRegistry']>,
  };
}

/** Build a manager and record whether the user was prompted (i.e. the mode "asked"). */
function makeManager(mode: PermissionMode, promptApproves = false) {
  const prompts: string[] = [];
  const manager = new PermissionManager(
    async ({ tool }) => { prompts.push(tool); return { approved: promptApproves, remember: false }; },
    makeConfigReader(mode),
    makePolicyRuntimeState(),
    null,
    null,
  );
  return { manager, prompts };
}

// ── evaluator mode matrix ────────────────────────────────────────────────────

describe('LayeredPolicyEvaluator mode matrix', () => {
  // The classification is what the gate's Jev reading says the call does
  // (gate/reading.ts classificationFromReading); the evaluator no longer
  // guesses it from the tool name.
  test('plan mode allows reads and denies write/exec/delegate', () => {
    const e = new LayeredPolicyEvaluator({ mode: 'plan' });
    expect(e.evaluate('read', { path: 'a.ts' }, 'read').allowed).toBe(true);
    expect(e.evaluate('write', { path: 'a.ts' }, 'write').allowed).toBe(false);
    expect(e.evaluate('write', { path: 'a.ts' }, 'write').reason).toBe('MODE_DENY_PLAN');
    expect(e.evaluate('exec', { command: 'ls' }, 'read').allowed).toBe(true); // a read-only command reads
    expect(e.evaluate('exec', { command: 'rm x' }, 'destructive').allowed).toBe(false);
    expect(e.evaluate('agent', {}, 'escalation').allowed).toBe(false);
  });

  test('accept-edits auto-approves the engine file tools but still gates exec', () => {
    const e = new LayeredPolicyEvaluator({ mode: 'accept-edits', defaultEffect: 'deny' });
    const w = e.evaluate('write', { path: 'a.ts' }, 'write');
    expect(w.allowed).toBe(true);
    expect(w.reason).toBe('MODE_ALLOW_ACCEPT_EDITS');
    expect(e.evaluate('edit', { path: 'a.ts' }, 'write').allowed).toBe(true);
    // A shell command that writes is not one of the engine's file tools.
    expect(e.evaluate('exec', { command: 'rm x' }, 'write').allowed).toBe(false);
  });

  test('allow-all approves everything; default gates writes', () => {
    expect(new LayeredPolicyEvaluator({ mode: 'allow-all' }).evaluate('exec', { command: 'x' }, 'write').allowed).toBe(true);
    const def = new LayeredPolicyEvaluator({ mode: 'default', defaultEffect: 'deny' });
    expect(def.evaluate('read', {}, 'read').allowed).toBe(true);
    expect(def.evaluate('write', { path: 'a' }, 'write').allowed).toBe(false);
  });

  test('a call named like no built-in tool is classified by its reading, not its name', () => {
    const e = new LayeredPolicyEvaluator({ mode: 'plan' });
    expect(e.evaluate('curl', { url: 'https://example.com' }, 'read').allowed).toBe(true);
    expect(e.evaluate('notes_sync', { text: 'x' }, 'network').allowed).toBe(false);
  });
});

// ── PermissionManager mode matrix (authoritative path) ───────────────────────

describe('configured permission modes', () => {
  let previous: ReturnType<typeof installJudgmentPort>;
  let log: SqliteDecisionLog;
  let requests: JudgmentRequest<Questions>[];
  let choice: 'act' | 'reject';
  beforeEach(() => {
    forgetGateReadings();
    log = new SqliteDecisionLog(':memory:'); requests = []; choice = 'act';
    const gate = gateReadingsPort([['synthetic-danger', { catastrophic: true, weakensSecurity: true }]]);
    const semantic = fakePort((_name, question) => choiceAnswer(question, choice, 0.99));
    const port: JudgmentPort = { model: gate.port.model, async ask(request) {
      requests.push(request);
      return 'disposition' in request.questions ? semantic.port.ask(request) : gate.port.ask(request);
    } };
    previous = installJudgmentPort(withDecisionLog(port, log));
  });
  afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings(); });

  test.each(['safe-owner', 'safe-jev', 'yolo'] as const)('%s permits ordinary tools without an owner prompt', async mode => {
    const { manager, prompts } = makeManager(mode);
    for (const tool of ['read', 'write', 'edit', 'agent', 'exec', 'goodvibes_settings']) {
      expect((await manager.checkDetailed(tool, { path: 'a', task: 'x', command: 'synthetic command' })).approved).toBe(true);
    }
    expect(prompts).toEqual([]);
    if (mode === 'yolo') expect(requests).toHaveLength(0);
  });

  test.each([false, true])('owner safety uses the owner reply %s for a dangerous action', async approved => {
    const { manager, prompts } = makeManager('safe-owner', approved);
    expect(await manager.checkDetailed('exec', { command: 'synthetic-danger' }))
      .toMatchObject({ approved, sourceLayer: 'user_prompt', reasonCode: approved ? 'user_approved' : 'user_denied' });
    expect(prompts).toEqual(['exec']);
  });

  test.each(['act', 'reject'] as const)('Jev safety uses the recorded %s decision without asking a human', async outcome => {
    choice = outcome;
    const { manager, prompts } = makeManager('safe-jev', true);
    const result = await manager.checkDetailed('exec', { command: 'synthetic-danger' });
    expect(result).toMatchObject({ approved: outcome === 'act', sourceLayer: 'jev_decision', reasonCode: `jev_${outcome}` });
    expect(result.autonomousDecision?.outcome).toBe(outcome);
    expect(result.autonomousDecision?.judgmentDecisionIds.length).toBeGreaterThan(0);
    expect(prompts).toEqual([]);
  });

  test('YOLO skips safety decisions even when the installed judgment port cannot answer', async () => {
    installJudgmentPort({ model: 'unavailable-fixture', async ask() { throw new Error('A safety reading ran in YOLO'); } });
    const { manager, prompts } = makeManager('yolo');
    expect(await manager.checkDetailed('exec', { command: 'synthetic-danger' }))
      .toMatchObject({ approved: true, reasonCode: 'mode_allow_all' });
    expect(prompts).toEqual([]);
  });

  test('plan mode allows reads and refuses execution without consulting Jev or the owner', async () => {
    const { manager, prompts } = makeManager('plan');
    expect((await manager.checkDetailed('read', { path: 'a' })).approved).toBe(true);
    for (const tool of ['write', 'edit', 'agent', 'exec']) {
      expect(await manager.checkDetailed(tool, { path: 'a', task: 'x', command: 'ls' }))
        .toMatchObject({ approved: false, reasonCode: 'plan_mode', sourceLayer: 'runtime_mode' });
    }
    expect(prompts).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  test('getMode and getPreset decode saved aliases into canonical execution modes', () => {
    expect(makeManager('plan').manager.getMode()).toBe('plan');
    expect(makeManager('allow-all').manager.getMode()).toBe('yolo');
    expect(makeManager('allow-all').manager.getPreset().name).toBe('yolo');
    expect(makeManager('prompt').manager.getPreset().name).toBe('safe-owner');
  });
});

// ── structured plan-mode denial ──────────────────────────────────────────────

describe('structured plan-mode denial', () => {
  test('plan_mode reason code surfaces ToolDenial reason "plan-mode" + steering', () => {
    const denial = buildToolDenial({ reasonCode: 'plan_mode', sourceLayer: 'runtime_mode' });
    expect(denial).toEqual({ denied: true, reason: PLAN_MODE_DENIAL_REASON, scope: 'runtime_mode' });
    expect(PLAN_MODE_DENIAL_REASON).toBe('plan-mode');
    const msg = buildDenialErrorMessage('exec', { reasonCode: 'plan_mode', sourceLayer: 'runtime_mode' });
    expect(msg).toContain('plan mode');
    expect(msg.toLowerCase()).toContain('present a');
  });

  test('non-plan denials pass their reason code through unchanged', () => {
    const denial = buildToolDenial({ reasonCode: 'user_denied', sourceLayer: 'user_prompt' });
    expect(denial).toEqual({ denied: true, reason: 'user_denied', scope: 'user_prompt' });
  });
});

// ── mode-change runtime event ────────────────────────────────────────────────

describe('permission mode-change event', () => {
  test('real config changes publish only effective canonical transitions and unsubscribe cleanly', async () => {
    const manager = configFixture();
    const bus = new RuntimeEventBus();
    const events: unknown[] = [];
    bus.onDomain('gate', envelope => { if (envelope.payload.type === 'PRESET_CHANGED') events.push(envelope.payload); });
    const unsub = bindPermissionModeChangeEvent(manager, bus, 'sess-1');
    manager.set('permissions.mode', 'plan');
    manager.set('permissions.mode', 'plan');
    await Promise.resolve();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'PRESET_CHANGED', mode: 'plan', previousMode: 'safe-owner', preset: 'plan', previousPreset: 'safe-owner' });
    unsub();
    manager.set('permissions.mode', 'safe-jev');
    await Promise.resolve();
    expect(events).toHaveLength(1);
  });

  test('legacy auto-approve alone changes the effective mode and selecting safety clears it', async () => {
    const manager = configFixture();
    const bus = new RuntimeEventBus();
    const transitions: Array<{ mode: string; previous: string }> = [];
    bus.onDomain('gate', envelope => {
      const event = envelope.payload;
      if (event.type === 'PRESET_CHANGED') transitions.push({ mode: event.mode, previous: event.previousMode });
    });
    const unsub = bindPermissionModeChangeEvent(manager, bus, 'sess-2');
    manager.set('behavior.autoApprove', true);
    await Promise.resolve();
    expect(transitions).toEqual([{ mode: 'yolo', previous: 'safe-owner' }]);
    manager.set('permissions.mode', 'safe-owner');
    expect(manager.get('behavior.autoApprove')).toBe(false);
    await Promise.resolve();
    expect(transitions).toEqual([
      { mode: 'yolo', previous: 'safe-owner' },
      { mode: 'safe-owner', previous: 'yolo' },
    ]);
    unsub();
  });
});

// ── plan-mode instruction: injected + survives compaction ────────────────────

describe('plan-mode standing instruction', () => {
  test('appended to the system prompt only while plan mode is active', () => {
    expect(appendPlanModeInstruction('BASE', 'plan')).toContain(PLAN_MODE_INSTRUCTION_MARKER);
    expect(appendPlanModeInstruction('BASE', 'plan')).toContain('BASE');
    expect(appendPlanModeInstruction('BASE', 'prompt')).toBe('BASE');
    expect(appendPlanModeInstruction('BASE', 'accept-edits')).toBe('BASE');
    expect(appendPlanModeInstruction('BASE', 'allow-all')).toBe('BASE');
  });

  test('survives compaction: the instruction chain is re-injected verbatim', () => {
    // getSystemPrompt() (with plan instruction appended) is the instruction
    // chain compaction re-injects, so the plan instruction rides through.
    const chain = appendPlanModeInstruction('SYSTEM PROMPT', 'plan');
    const section = buildReinjectedInstructions(chain, undefined);
    expect(section).not.toBeNull();
    expect(section!.content).toContain(PLAN_MODE_INSTRUCTION_MARKER);
    expect(section!.id).toBe('reinjected-instructions');
  });
});
