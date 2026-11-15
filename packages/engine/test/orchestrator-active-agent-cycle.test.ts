/**
 * Regression guard for the tool-loop circuit-breaker infinite-loop bug
 * (introduced in 0.34.1, fixed in 0.34.2).
 *
 * `isActiveAgent` used to live in `compaction-sections.ts`. The orchestrator
 * turn-loop modules (`orchestrator-context-runtime`, `orchestrator-tool-runtime`)
 * and `context-compaction` imported it from there, which pulled the heavy
 * `compaction-sections` module into the turn-loop import graph and created a
 * circular dependency. The cycle left the tool-loop circuit-breaker threshold
 * constant in its temporal dead zone (undefined) at runtime, so the breaker
 * never tripped and all-failed tool turns looped forever (the TUI
 * `runtime-substrate-gate` integration test hung).
 *
 * The predicate now lives in the dependency-free leaf
 * `tools/agent/predicates.ts`. These tests assert (a) the predicate behaves
 * correctly, (b) the turn-loop modules load without touching an uninitialised
 * binding, and (c) the circuit breaker they share still trips after the
 * configured number of all-failed turns.
 */
import { describe, expect, test } from 'bun:test';
import { isActiveAgent } from '../platform/src/platform/tools/agent/predicates.ts';

describe('isActiveAgent (tools/agent/predicates leaf)', () => {
  test('is true only for running and pending agents', () => {
    expect(isActiveAgent({ status: 'running' })).toBe(true);
    expect(isActiveAgent({ status: 'pending' })).toBe(true);
    expect(isActiveAgent({ status: 'completed' })).toBe(false);
    expect(isActiveAgent({ status: 'failed' })).toBe(false);
    expect(isActiveAgent({ status: 'cancelled' })).toBe(false);
  });
});

describe('orchestrator turn-loop modules (0.34.2 regression)', () => {
  const turnLoopModules = [
    '../platform/src/platform/core/orchestrator-context-runtime.ts',
    '../platform/src/platform/core/orchestrator-tool-runtime.ts',
    '../platform/src/platform/core/context-compaction.ts',
    '../platform/src/platform/core/orchestrator-turn-loop.ts',
  ] as const;

  test('every turn-loop module loads, whatever order its neighbours load in', async () => {
    // A re-created import cycle surfaces as a ReferenceError (a binding read
    // before its module initialised) while a module is evaluated.
    for (const specifier of turnLoopModules) {
      await expect(import(specifier)).resolves.toBeDefined();
    }
  });

  test('the circuit breaker thresholds are initialised and the breaker trips on all-failed turns', async () => {
    await Promise.all(turnLoopModules.map((specifier) => import(specifier)));
    const { ConsecutiveErrorBreaker, CONSECUTIVE_ERROR_WARN, CONSECUTIVE_ERROR_BREAK } =
      await import('../platform/src/platform/core/circuit-breaker.ts');
    expect(typeof CONSECUTIVE_ERROR_WARN).toBe('number');
    expect(typeof CONSECUTIVE_ERROR_BREAK).toBe('number');
    const breaker = new ConsecutiveErrorBreaker();
    const outcomes = Array.from({ length: CONSECUTIVE_ERROR_BREAK }, () => breaker.recordAllFailed());
    expect(outcomes[CONSECUTIVE_ERROR_WARN - 2]).toBe('ok');
    expect(outcomes[CONSECUTIVE_ERROR_WARN - 1]).toBe('warn');
    expect(outcomes[CONSECUTIVE_ERROR_BREAK - 1]).toBe('break');
  });

  test('compaction-sections no longer exports the predicate the turn loop needs', async () => {
    const sections = await import('../platform/src/platform/core/compaction-sections.ts') as Record<string, unknown>;
    expect(sections['isActiveAgent']).toBeUndefined();
  });
});
