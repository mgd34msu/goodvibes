/**
 * What the forensics collector stores must be safe and must be findable: error
 * text has credential-shaped spans masked, a failed MCP server a turn called is
 * recorded and classified, reports sharing a trace each keep their own id, and
 * the call map does not outlive the turn it belongs to.
 */
import { describe, expect, test } from 'bun:test';
import { ForensicsCollector } from '../platform/src/platform/runtime/forensics/collector.ts';
import { ForensicsRegistry } from '../platform/src/platform/runtime/forensics/registry.ts';
import { RuntimeEventBus, createEventEnvelope } from '../platform/src/platform/runtime/events/index.ts';
import type { RuntimeEventDomain } from '../platform/src/platform/runtime/events/index.ts';
import { createWiredHealthSystem } from '../platform/src/platform/runtime/health/index.ts';
import type { FailureReport } from '../platform/src/platform/runtime/forensics/types.ts';
import { useFailureReadings } from './_helpers/failure-readings.ts';

const TRACE = 'abcdef0123456789';
const settle = async (): Promise<void> => { for (let i = 0; i < 500; i++) await Promise.resolve(); };

const tick = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function emit(bus: RuntimeEventBus, domain: string, payload: Record<string, unknown>): void {
  bus.emit(domain as RuntimeEventDomain, createEventEnvelope(payload['type'] as never, payload as never, { sessionId: 's', source: 'test', traceId: TRACE }));
}

function setup() {
  const bus = new RuntimeEventBus();
  const registry = new ForensicsRegistry();
  const collector = new ForensicsCollector(bus, registry);
  return { bus, registry, collector };
}

describe('ForensicsCollector', () => {
  useFailureReadings([]);

  test('a credential echoed in an error is masked in the report, its summary and its causal chain', async () => {
    const { bus, registry, collector } = setup();
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    emit(bus, 'turn', { type: 'TURN_SUBMITTED', turnId: 't1', prompt: 'hi' });
    emit(bus, 'turn', { type: 'TURN_ERROR', turnId: 't1', error: `Incorrect API key provided: ${secret}` });
    await settle();
    const report = registry.latest();
    expect(report).not.toBeNull();
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report?.errorMessage).toContain('[REDACTED_API_KEY]');
    collector.dispose();
  });

  test('a failed MCP server the turn called is recorded and classifies the failure', async () => {
    const { bus, registry, collector } = setup();
    const { wiring } = createWiredHealthSystem(bus);
    emit(bus, 'turn', { type: 'TURN_SUBMITTED', turnId: 't1', prompt: 'hi' });
    emit(bus, 'tools', { type: 'TOOL_RECEIVED', turnId: 't1', callId: 'c1', tool: 'mcp:docs:search', args: {} });
    wiring.evaluateDomain('mcp', 'failed', { serverId: 'docs' });
    wiring.evaluateDomain('mcp', 'failed', { serverId: 'docs' });
    wiring.evaluateDomain('mcp', 'failed', { serverId: 'docs' });
    wiring.evaluateDomain('mcp', 'failed', { serverId: 'docs' });
    await settle();
    emit(bus, 'turn', { type: 'TURN_ERROR', turnId: 't1', error: 'boom' });
    await settle();
    const report = registry.latest();
    expect(report?.classification).toBe('cascade_failure');
    expect(report?.cascadeEvents.length).toBeGreaterThan(0);
    collector.dispose();
  });

  test('a failure elsewhere is not attributed to a turn that did not depend on it', async () => {
    const { bus, registry, collector } = setup();
    const { wiring } = createWiredHealthSystem(bus);
    emit(bus, 'turn', { type: 'TURN_SUBMITTED', turnId: 't1', prompt: 'hi' });
    wiring.evaluateDomain('agents', 'failed', { sessionId: 's', agentId: 'a1' });
    for (let i = 0; i < 4; i++) wiring.evaluateDomain('mcp', 'failed', { serverId: 'unused' });
    await settle();
    emit(bus, 'turn', { type: 'TURN_ERROR', turnId: 't1', error: 'boom' });
    await settle();
    expect(registry.latest()?.cascadeEvents).toEqual([]);
    expect(registry.latest()?.classification).not.toBe('cascade_failure');
    collector.dispose();
  });

  test('a call the gate denied is classified as a permission denial', async () => {
    const { bus, registry, collector } = setup();
    emit(bus, 'turn', { type: 'TURN_SUBMITTED', turnId: 't1', prompt: 'hi' });
    emit(bus, 'tools', { type: 'TOOL_PERMISSIONED', turnId: 't1', callId: 'c1', tool: 'exec', approved: false });
    emit(bus, 'turn', { type: 'TURN_ERROR', turnId: 't1', error: 'boom' });
    await settle();
    expect(registry.latest()?.classification).toBe('permission_denied');
    collector.dispose();
  });

  test('failures sharing one trace keep distinct ids that each resolve to their own report', async () => {
    const { bus, registry, collector } = setup();
    for (const id of ['a', 'b', 'c']) {
      emit(bus, 'turn', { type: 'TURN_SUBMITTED', turnId: id, prompt: 'hi' });
      emit(bus, 'turn', { type: 'TURN_ERROR', turnId: id, error: `failure ${id}` });
      await settle();
    }
    const reports = registry.getAll();
    expect(new Set(reports.map((report) => report.id)).size).toBe(3);
    for (const report of reports) expect(registry.getById(report.id)).toBe(report);
    collector.dispose();
  });

  test('tool calls of a finished turn are not kept', async () => {
    const { bus, collector } = setup();
    const calls = (): number => (Reflect.get(collector, '_callToTurn') as Map<string, string>).size;
    emit(bus, 'turn', { type: 'TURN_SUBMITTED', turnId: 't1', prompt: 'hi' });
    emit(bus, 'tools', { type: 'TOOL_PERMISSIONED', turnId: 't1', callId: 'c1', tool: 'x', approved: true });
    await tick();
    expect(calls()).toBe(1);
    emit(bus, 'turn', { type: 'TURN_CANCEL', turnId: 't1', reason: 'stop' });
    await tick();
    expect(calls()).toBe(0);
    emit(bus, 'tools', { type: 'TOOL_PERMISSIONED', turnId: 't1', callId: 'late', tool: 'x', approved: true });
    await tick();
    expect(calls()).toBe(0);
    collector.dispose();
  });
});

describe('ForensicsRegistry', () => {
  const report = (id: string): FailureReport => ({ id, traceId: 't', sessionId: 's', generatedAt: 0, classification: 'unknown', summary: id, phaseTimings: [], slowPhases: [], phaseLedger: [], causalChain: [], cascadeEvents: [], permissionEvidence: [], budgetBreaches: [], jumpLinks: [] });

  test('evicting an older report does not drop a newer one that reuses its id', () => {
    const registry = new ForensicsRegistry(2);
    const older = report('same');
    const newer = report('same');
    registry.push(older);
    registry.push(newer);
    registry.push(report('other'));
    expect(registry.getById('same')).toBe(newer);
  });
});
