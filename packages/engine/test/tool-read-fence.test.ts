/**
 * A read-only tool body's intermediate currentness checkpoints are bounded
 * liveness fences. Complete owner verification still gates every effect and
 * the published result.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { forgetGateReadings, gateReadingsPort } from './_helpers/gate-readings.ts';
import { PermissionManager, type PermissionConfigReader } from '../platform/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../platform/src/platform/core/orchestrator-tool-runtime.ts';
import { ToolRegistry, assertCurrentToolEffect, assertCurrentToolInvocation, relaxCurrentToolReadFences } from '../platform/src/platform/tools/registry.ts';
import type { Tool, ToolSideEffect } from '../platform/src/platform/types/tools.ts';

let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
beforeEach(() => { forgetGateReadings(); log = new SqliteDecisionLog(':memory:'); previous = installJudgmentPort(withDecisionLog(gateReadingsPort().port, log)); });
afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings(); });

const CHECKPOINTS = 4_000;
function fixture(sideEffects: readonly ToolSideEffect[], body: Tool['execute'], turnSignal?: AbortSignal) {
  const directory = '/synthetic/read-fence';
  const config = { getAutonomousSnapshot: () => ({ permissions: { mode: 'yolo', tools: {} }, autoApprove: false, directory }), isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => directory, getSnapshot: () => ({ permissions: { mode: 'yolo', tools: {} } }) } as PermissionConfigReader;
  const manager = new PermissionManager(undefined, config, new PolicyRuntimeState(), null, { isEnabled: () => false }, null, {});
  const registry = new ToolRegistry();
  registry.register({ definition: { name: 'probe', description: 'Synthetic body; touches nothing', parameters: { type: 'object' }, sideEffects }, execute: body });
  const owner = { verifications: 0, revoked: false };
  const deps: ToolExecutionDeps = { autonomousSource: () => ({ goal: 'Search the synthetic project', criteria: [] }), permissionManager: manager, toolRegistry: registry,
    hookDispatcher: null, runtimeBus: null, sessionId: 'read-fence', emitterContext: () => ({ sessionId: 'read-fence', traceId: 'synthetic', source: 'orchestrator' }),
    assertCurrent: () => { owner.verifications++; if (owner.revoked) throw new Error('synthetic owner revoked'); },
    ...(turnSignal ? { turnSignal } : {}) };
  const run = async () => (await executeToolCalls(deps, 'turn-1', [{ id: 'call-1', name: 'probe', arguments: { queries: [] } }]))[0];
  return { owner, run };
}

test('a relaxed read-only body does not repeat complete verification at every checkpoint', async () => {
  let during = 0;
  const f = fixture(['read_fs'], async (args, options) => {
    relaxCurrentToolReadFences(args, options);
    const before = f.owner.verifications;
    for (let index = 0; index < CHECKPOINTS; index++) expect(assertCurrentToolInvocation(args, options)).toBe(true);
    during = f.owner.verifications - before;
    return { success: true, output: 'found' };
  });
  const result = await f.run();
  expect(result?.success).toBe(true);
  expect(result?.output).toBe('found');
  // Verification count follows elapsed time, not the number of checkpoints.
  expect(during).toBeLessThan(CHECKPOINTS / 10);
});

test.each([
  ['a read-only body that did not ask', ['read_fs'] as const, false],
  ['a definition with a write effect', ['read_fs', 'write_fs'] as const, true],
  ['a definition that declares nothing', [] as const, true],
])('%s keeps complete verification at every checkpoint', async (_label, sideEffects, relax) => {
  let during = 0;
  const f = fixture(sideEffects, async (args, options) => {
    if (relax) relaxCurrentToolReadFences(args, options);
    const before = f.owner.verifications;
    for (let index = 0; index < 200; index++) assertCurrentToolInvocation(args, options);
    during = f.owner.verifications - before;
    return { success: true };
  });
  expect((await f.run())?.success).toBe(true);
  expect(during).toBeGreaterThanOrEqual(200);
});

test('an owner revoked while a relaxed body runs never has that body\'s result published', async () => {
  let finished = false;
  const f = fixture(['read_fs'], async (args, options) => {
    relaxCurrentToolReadFences(args, options);
    assertCurrentToolInvocation(args, options);
    f.owner.revoked = true;
    // Within the window this checkpoint may still pass; the result may not.
    try { assertCurrentToolInvocation(args, options); } catch { /* an immediate stop is also correct */ }
    finished = true;
    return { success: true, output: 'PRIVATE_RESULT_AFTER_REVOCATION' };
  });
  let published: string | undefined;
  try { const result = await f.run(); published = JSON.stringify(result); } catch { published = undefined; }
  expect(finished).toBe(true);
  expect(published ?? '').not.toContain('PRIVATE_RESULT_AFTER_REVOCATION');
});

test('a relaxed body still sees revocation once the window has passed', async () => {
  const f = fixture(['read_fs'], async (args, options) => {
    relaxCurrentToolReadFences(args, options);
    assertCurrentToolInvocation(args, options);
    f.owner.revoked = true;
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(() => assertCurrentToolInvocation(args, options)).toThrow();
    return { success: true, output: 'unreachable publication' };
  });
  let published: string | undefined;
  try { published = JSON.stringify(await f.run()); } catch { published = undefined; }
  expect(published ?? '').not.toContain('unreachable publication');
});

test('cancellation stops a relaxed body at its next checkpoint', async () => {
  const stop = new AbortController();
  let stoppedAtNextCheckpoint = false;
  const f = fixture(['read_fs'], async (args, options) => {
    relaxCurrentToolReadFences(args, options);
    assertCurrentToolInvocation(args, options);
    stop.abort(new Error('synthetic cancellation'));
    try { assertCurrentToolInvocation(args, options); } catch { stoppedAtNextCheckpoint = true; }
    return { success: true, output: 'cancelled publication' };
  }, stop.signal);
  let published: string | undefined;
  try { published = JSON.stringify(await f.run()); } catch { published = undefined; }
  expect(stoppedAtNextCheckpoint).toBe(true);
  expect(published ?? '').not.toContain('cancelled publication');
});

test('an effect check inside a relaxed body is always a complete verification', async () => {
  let effectHeld = false;
  const f = fixture(['read_fs'], async (args, options) => {
    relaxCurrentToolReadFences(args, options);
    assertCurrentToolInvocation(args, options);
    f.owner.revoked = true;
    try { assertCurrentToolEffect(args, options, 'write'); } catch { effectHeld = true; }
    return { success: true };
  });
  try { await f.run(); } catch { /* the revoked call is held */ }
  expect(effectHeld).toBe(true);
});
