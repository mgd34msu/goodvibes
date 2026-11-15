/**
 * The health cascade pipeline: a recovery-first rule is reported once recovery
 * attempts run out, as a report that enforces nothing, a healthy domain starts
 * over, and one failing subscriber cannot hide a change from the rest.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { createWiredHealthSystem } from '../platform/src/platform/runtime/health/index.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import type { RuntimeEventDomain } from '../platform/src/platform/runtime/events/index.ts';
import { logger } from '../platform/src/platform/utils/logger.ts';

const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function recordingSystem() {
  const bus = new RuntimeEventBus();
  const applied: Array<{ effect: { type: string }; enforced?: boolean }> = [];
  bus.onDomain('session' as RuntimeEventDomain, (env) => {
    const payload = env.payload as { type: string; effect?: { type: string }; enforced?: boolean };
    if (payload.type === 'CASCADE_APPLIED' && payload.effect) applied.push({ effect: payload.effect, ...(payload.enforced !== undefined ? { enforced: payload.enforced } : {}) });
  });
  return { ...createWiredHealthSystem(bus), applied };
}

describe('recovery-first cascades', () => {
  test('a domain that keeps failing has its cascade applied once the recovery attempts are spent', async () => {
    const { wiring, aggregator, applied } = recordingSystem();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = wiring.evaluateDomain('mcp', 'failed');
      expect(result.pendingRecovery.length).toBeGreaterThan(0);
      expect(result.cascades).toEqual([]);
      expect(aggregator.getDomainHealth('mcp').recoveryAttempts).toBe(attempt);
    }
    await flush();
    expect(applied).toEqual([]);
    const fourth = wiring.evaluateDomain('mcp', 'failed');
    expect(fourth.cascades.map((cascade) => cascade.effect.type)).toEqual(['BLOCK_DISPATCH']);
    await flush();
    expect(applied).toEqual([{ effect: expect.objectContaining({ type: 'BLOCK_DISPATCH' }), enforced: false }]);
    // A cascade reports; it does not change the target domain.
    expect(aggregator.getDomainHealth('toolExecution').status).toBe('unknown');
  });

  test('returning to healthy resets the attempts', () => {
    const { wiring, aggregator } = recordingSystem();
    wiring.evaluateDomain('mcp', 'failed');
    wiring.evaluateDomain('mcp', 'failed');
    expect(aggregator.getDomainHealth('mcp').recoveryAttempts).toBe(2);
    wiring.evaluateDomain('mcp', 'healthy');
    expect(aggregator.getDomainHealth('mcp').recoveryAttempts).toBe(0);
  });
});

describe('aggregator subscribers', () => {
  test('a throwing subscriber does not stop the others or fail the update', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    const { aggregator } = recordingSystem();
    let reached = 0;
    aggregator.subscribe(() => { throw new Error('bad subscriber'); });
    aggregator.subscribe(() => { reached++; });
    expect(() => aggregator.updateDomainHealth('git', 'failed')).not.toThrow();
    expect(reached).toBe(1);
    expect(aggregator.getDomainHealth('git').status).toBe('failed');
    warn.mockRestore();
  });
});
