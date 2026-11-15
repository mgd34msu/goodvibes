/**
 * The forensics registry keeps a bounded buffer, and a normal stop is not classified as a failure.
 */

import { describe, expect, test } from 'bun:test';
import { classifyFailure } from '../platform/src/platform/runtime/forensics/classifier.js';
import { ForensicsRegistry, DEFAULT_REGISTRY_LIMIT } from '../platform/src/platform/runtime/forensics/registry.js';
import type { FailureReport } from '../platform/src/platform/runtime/forensics/types.js';

const report = (id: string): FailureReport => ({ id, traceId: 't', sessionId: 's', generatedAt: 0, classification: 'unknown', summary: id, phaseTimings: [], slowPhases: [], phaseLedger: [], causalChain: [], cascadeEvents: [], permissionEvidence: [], budgetBreaches: [], jumpLinks: [] });

describe('platform/runtime/forensics: registry limit and classifier', () => {
  test('past DEFAULT_REGISTRY_LIMIT the oldest report is evicted and the newest kept', () => {
    const registry = new ForensicsRegistry();
    for (let index = 0; index <= DEFAULT_REGISTRY_LIMIT; index += 1) registry.push(report(`r${index}`));

    expect(registry.count()).toBe(DEFAULT_REGISTRY_LIMIT);
    expect(registry.getById('r0')).toBeUndefined();
    expect(registry.getById('r1')?.id).toBe('r1');
    expect(registry.latest()?.id).toBe(`r${DEFAULT_REGISTRY_LIMIT}`);
    expect(registry.getAll()[0]?.id).toBe(`r${DEFAULT_REGISTRY_LIMIT}`);
  });

  test('an empty registry has no latest report', () => {
    const registry = new ForensicsRegistry();
    expect(registry.count()).toBe(0);
    expect(registry.latest()).toBeNull();
  });

  test('classifyFailure reads a normal stop with no error message as unknown, without a judgment port', async () => {
    const result = await classifyFailure({
      stopReason: 'end_turn',
      errorMessage: undefined,
      wasCancelled: false,
      hasCascadeEvents: false,
      hasToolFailure: false,
      hasPermissionDenial: false,
      hasCompactionError: false,
    });
    expect(result).toBe('unknown');
  });
});
