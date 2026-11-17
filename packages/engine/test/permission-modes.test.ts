/**
 * Who is asked in each mode. ask-me asks the owner; jev-decides asks Jev on a
 * judgment call when a decision model works and is ask-me when none does,
 * also when a hosted session chose it; just-vibes interrupts no one and holds
 * what needs the owner for the end of the run, where approving it lets the same
 * call run; yolo asks no one. An owner-only item reaches the owner in every
 * mode but yolo.
 *
 * Real settings manager, permission manager, tool registry, executor and
 * held-call ledger over a temp directory; the two tools only count their runs.
 * Decision models are off except where the case is about one working; Jev's
 * port counts every question and answers none.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { createPermissionConfigReader, PermissionManager } from '../platform/src/platform/permissions/manager.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../platform/src/platform/core/orchestrator-tool-runtime.ts';
import type { ToolResult } from '../platform/src/platform/types/tools.ts';
import { HeldForOwnerLedger } from '../platform/src/platform/permissions/held-for-owner.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { configureDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.ts';
import { withExecutionModeOwner } from '../platform/src/platform/gate/execution-context.ts';
import type { GatePresetName } from '../platform/src/platform/gate/presets.ts';

let dir: string;
let jevQuestions = 0;
let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-permission-modes-'));
  jevQuestions = 0;
  const port: JudgmentPort = { model: 'fixture', async ask() { jevQuestions++; throw new Error('Jev was asked'); } };
  previousPort = installJudgmentPort(port);
});
afterEach(() => {
  installJudgmentPort(previousPort);
  rmSync(dir, { recursive: true, force: true });
});

/** An owner-only call: changing an MCP server's trust. */
const TRUST = { tool: 'mcp', args: { mode: 'set-trust', server: 'fixture', trust: 'trusted' } } as const;
/** A judgment call: a command the defaults do not settle. */
const PUSH = { tool: 'exec', args: { commands: [{ cmd: 'git push origin main' }] } } as const;

function gate(mode: GatePresetName, options: { readonly decisionModel?: boolean } = {}) {
  const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: join(dir, 'workspace'), homeDir: join(dir, 'home'), configDir: join(dir, 'config'), ownsDaemonTier: true });
  const settings: { key: ConfigKey; value: unknown }[] = [{ key: 'permissions.mode' as ConfigKey, value: mode }];
  if (options.decisionModel) {
    settings.push(
      { key: 'judgment.endpoint' as ConfigKey, value: 'http://127.0.0.1:9/v1' },
      { key: 'judgment.model' as ConfigKey, value: 'fixture-model' },
      { key: 'judgment.keySource' as ConfigKey, value: 'secret' },
    );
  }
  expect(config.setMany(settings, { kind: 'owner', surface: 'fixture' }).ok).toBe(true);
  let ownerAsked = 0;
  const held = new HeldForOwnerLedger();
  const manager = new PermissionManager(async () => { ownerAsked++; return { approved: false }; },
    createPermissionConfigReader(config), new PolicyRuntimeState(), null, null, null, { heldForOwner: held, surfaceOf: () => undefined });
  const registry = new ToolRegistry(manager);
  const ran: string[] = [];
  for (const [name, sideEffects] of [['mcp', ['state']], ['exec', ['exec']]] as const) {
    registry.register({ definition: { name, description: name, parameters: { type: 'object' }, sideEffects: [...sideEffects], core: true },
      execute: async () => { ran.push(name); return { success: true, output: 'ran' }; } });
  }
  const deps: ToolExecutionDeps = { permissionManager: manager, toolRegistry: registry,
    autonomousSource: () => ({ goal: 'Work on the fixture project', criteria: [] }),
    hookDispatcher: null, runtimeBus: null, sessionId: 'modes', emitterContext: () => ({ sessionId: 'modes', traceId: 'modes', source: 'orchestrator' }) };
  let calls = 0;
  const check = async (call: { readonly tool: string; readonly args: Record<string, unknown> }): Promise<ToolResult> =>
    (await executeToolCalls(deps, `turn-${++calls}`, [{ id: `call-${calls}`, name: call.tool, arguments: { ...call.args } }]))[0]!;
  return { manager, held, check, ran, asked: () => ({ owner: ownerAsked, jev: jevQuestions }) };
}

/** What one call came to: whether it ran, its decision, and who was asked. */
async function outcome(mode: GatePresetName, call: typeof TRUST | typeof PUSH) {
  const g = gate(mode);
  const result = await g.check(call);
  return { ran: g.ran.length, state: result.decision?.state, decidedBy: result.decision?.decidedBy, held: g.held.list().length, ...g.asked() };
}

test('with decision models off: who is asked about an owner-only item and a judgment call, in each mode', async () => {
  const retire = configureDecisionModelPolicy(() => 'Classic - Off');
  try {
    expect(await outcome('ask-me', TRUST)).toMatchObject({ ran: 0, decidedBy: 'owner', owner: 1, jev: 0, held: 0 });
    expect(await outcome('jev-decides', TRUST)).toMatchObject({ ran: 0, decidedBy: 'owner', owner: 1, jev: 0, held: 0 });
    expect(await outcome('just-vibes', TRUST)).toMatchObject({ ran: 0, state: 'queued-for-owner', owner: 0, jev: 0, held: 1 });
    expect(await outcome('yolo', TRUST)).toMatchObject({ ran: 1, owner: 0, jev: 0, held: 0 });

    expect(await outcome('just-vibes', PUSH)).toMatchObject({ ran: 0, state: 'queued-for-owner', owner: 0, jev: 0, held: 1 });
    expect(await outcome('yolo', PUSH)).toMatchObject({ ran: 1, owner: 0, jev: 0, held: 0 });
    expect(await outcome('ask-me', PUSH)).toMatchObject({ ran: 0, decidedBy: 'owner', owner: 1, jev: 0, held: 0 });
    // jev-decides without a decision model is ask-me: the same answer from the same party.
    expect(await outcome('jev-decides', PUSH)).toEqual(await outcome('ask-me', PUSH));
  } finally { retire(); }
});

test('with decision models on but none set up, just-vibes holds a judgment call without asking anyone', async () => {
  expect(await outcome('just-vibes', PUSH)).toMatchObject({ ran: 0, state: 'queued-for-owner', owner: 0, jev: 0, held: 1 });
  expect(gate('jev-decides').manager.getMode()).toBe('ask-me');
});

test('jev-decides chosen by a hosted session is ask-me while no decision model works', async () => {
  const retire = configureDecisionModelPolicy(() => 'Classic - Off');
  try {
    // The settings say yolo; the session's own choice is what holds inside it.
    const g = gate('yolo');
    const session = { getMode: (): GatePresetName => 'jev-decides', getRevision: () => 1 };
    const result = await withExecutionModeOwner(session, async () => {
      expect(g.manager.getMode()).toBe('ask-me');
      return g.check(TRUST);
    });
    expect(result.decision?.decidedBy).toBe('owner');
    expect(g.ran).toEqual([]);
    expect(g.asked()).toEqual({ owner: 1, jev: 0 });
  } finally { retire(); }
});

test('jev-decides with a working decision model asks Jev, not the owner, on a judgment call; never on an owner-only item', async () => {
  const g = gate('jev-decides', { decisionModel: true });
  expect(g.manager.getMode()).toBe('jev-decides');
  await g.check(PUSH).catch(() => null);
  expect(g.asked().owner).toBe(0);
  expect(g.asked().jev).toBeGreaterThan(0);
  const before = jevQuestions;
  expect((await g.check(TRUST)).decision?.decidedBy).toBe('owner');
  expect(g.asked()).toEqual({ owner: 1, jev: before });
  expect(g.ran).toEqual([]);
});

test('just-vibes reports what it held, and the owner\'s approval at the end lets that same call run', async () => {
  const retire = configureDecisionModelPolicy(() => 'Classic - Off');
  try {
    const g = gate('just-vibes');
    const first = await g.check(TRUST);
    expect(first.decision?.state).toBe('queued-for-owner');
    const [held] = g.manager.listHeldForOwner();
    expect(held?.toolName).toBe('mcp');
    expect(g.held.approve([held!.id])).toEqual([held!.id]);
    expect((await g.check(TRUST)).success).toBe(true);
    expect(g.ran).toEqual(['mcp']);
    // The approval covers that call, not another server's trust.
    expect((await g.check({ tool: 'mcp', args: { mode: 'set-trust', server: 'other', trust: 'trusted' } })).decision?.state).toBe('queued-for-owner');
    expect(g.ran).toEqual(['mcp']);
    expect(g.asked()).toEqual({ owner: 0, jev: 0 });
  } finally { retire(); }
});
