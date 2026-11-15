/**
 * Spawn policy decisions: which cap refuses a spawn and what it reports.
 */

import { describe, expect, test } from 'bun:test';
import { evaluateOrchestrationSpawn } from '../platform/src/platform/runtime/orchestration/spawn-policy.js';

describe('platform/runtime/orchestration: spawn-policy smoke', () => {

  test('evaluateOrchestrationSpawn denies plan-auto when recursion is disabled', () => {
    const configManager = {
      get: (_key: string) => null,
    };
    const result = evaluateOrchestrationSpawn({
      configManager: configManager as never,
      mode: 'plan-auto',
      activeAgents: 0,
      requestedDepth: 0,
      overrides: { recursionEnabled: false },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('orchestration.recursionEnabled=false');
    expect(result.boundCap).toEqual({ key: 'orchestration.recursionEnabled', value: false });
  });

  test('evaluateOrchestrationSpawn allows manual-batch mode regardless of recursion flag', () => {
    const configManager = {
      get: (_key: string) => null,
    };
    const result = evaluateOrchestrationSpawn({
      configManager: configManager as never,
      mode: 'manual-batch',
      activeAgents: 1,
      requestedDepth: 1,
      overrides: { recursionEnabled: false, maxAgents: 5, maxDepth: 3 },
    });
    // manual-batch bypasses the recursionEnabled guard (only recursive-child/plan-auto are gated)
    expect(result.allowed).toBe(true);
    expect(result.availableSlots).toBe(4);
  });

  test('evaluateOrchestrationSpawn denies when no capacity', () => {
    const configManager = {
      get: (_key: string) => null,
    };
    const result = evaluateOrchestrationSpawn({
      configManager: configManager as never,
      mode: 'manual-batch',
      activeAgents: 5,
      overrides: { maxAgents: 5 },
    });
    expect(result.allowed).toBe(false);
    expect(result.availableSlots).toBe(0);
    expect(result.boundCap).toEqual({ key: 'fleet.maxSize', value: 5 });
    expect(result.reason).toContain('5/5');
  });
});
