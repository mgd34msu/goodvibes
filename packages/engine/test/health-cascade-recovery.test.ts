/**
 * The health cascade pipeline: a recovery-first rule is applied once recovery
 * attempts run out, a healthy domain starts over, an event says when nothing
 * was enforced, and one failing subscriber cannot hide a change from the rest.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { createWiredHealthSystem, handleCascadeEffect } from '../platform/src/platform/runtime/health/index.ts';
import type { CascadeResult } from '../platform/src/platform/runtime/health/index.ts';
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
    expect(applied.map((event) => event.effect.type)).toEqual(['BLOCK_DISPATCH']);
    expect(aggregator.canExecute('toolExecution', 'mcp-tools').allowed).toBe(false);
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

describe('cascade effects', () => {
  const resultFor = (target: CascadeResult['target'], effect: CascadeResult['effect'], sourceContext?: Record<string, string>): CascadeResult =>
    ({ ruleId: 'r', source: 'turn', target, effect, timestamp: 0, recoveryExhausted: false, sourceContext });

  test('cancellation and deregistration are reported as requests, not as done', async () => {
    const { aggregator, applied } = recordingSystem();
    const bus = new RuntimeEventBus();
    const seen: Array<boolean | undefined> = [];
    bus.onDomain('session' as RuntimeEventDomain, (env) => { seen.push((env.payload as { enforced?: boolean }).enforced); });
    const context = { aggregator, eventBus: bus };
    handleCascadeEffect({ type: 'CANCEL_INFLIGHT', scope: 'all-tools' }, resultFor('toolExecution', { type: 'CANCEL_INFLIGHT', scope: 'all-tools' }), context);
    handleCascadeEffect({ type: 'DEREGISTER_TOOLS' }, resultFor('toolExecution', { type: 'DEREGISTER_TOOLS' }), context);
    handleCascadeEffect({ type: 'BLOCK_NEW', scope: 'x' }, resultFor('toolExecution', { type: 'BLOCK_NEW', scope: 'x' }), context);
    await flush();
    expect(seen).toEqual([false, false, true]);
    expect(applied).toEqual([]);
  });

  test('MARK_CHILDREN honours the status: blocked is degraded with dispatch withheld, failed is failed', () => {
    const { aggregator } = recordingSystem();
    const context = { aggregator, eventBus: new RuntimeEventBus() };
    handleCascadeEffect({ type: 'MARK_CHILDREN', status: 'blocked', notifyParent: false }, resultFor('tasks', { type: 'MARK_CHILDREN', status: 'blocked', notifyParent: false }), context);
    expect(aggregator.getDomainHealth('tasks').status).toBe('degraded');
    expect(aggregator.canExecute('tasks', 'dispatch').allowed).toBe(false);
    handleCascadeEffect({ type: 'MARK_CHILDREN', status: 'failed', notifyParent: false }, resultFor('tasks', { type: 'MARK_CHILDREN', status: 'failed', notifyParent: false }), context);
    expect(aggregator.getDomainHealth('tasks').status).toBe('failed');
  });

  test('a plugin named on the effect scopes the deregistration', () => {
    const { aggregator } = recordingSystem();
    handleCascadeEffect({ type: 'DEREGISTER_TOOLS', pluginId: 'p1' }, resultFor('toolExecution', { type: 'DEREGISTER_TOOLS', pluginId: 'p1' }), { aggregator, eventBus: new RuntimeEventBus() });
    expect(aggregator.getDomainHealth('toolExecution').degradedCapabilities).toEqual(['tool-dispatch:plugin:p1']);
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
