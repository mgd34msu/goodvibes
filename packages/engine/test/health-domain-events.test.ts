/**
 * Each domain's health follows its own entities: one entity failing or
 * recovering does not change what the others report.
 */
import { expect, test } from 'bun:test';
import { createWiredHealthSystem } from '../platform/src/platform/runtime/health/index.ts';
import { bindHealthDomainEvents } from '../platform/src/platform/runtime/health/domain-events.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { emitTurnCompleted, emitTurnError } from '../platform/src/platform/runtime/emitters/turn.ts';
import { emitAgentCompleted, emitAgentFailed } from '../platform/src/platform/runtime/emitters/agents.ts';
import { emitMcpConnected, emitMcpDisconnected } from '../platform/src/platform/runtime/emitters/mcp.ts';

const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const ctx = { sessionId: 's1', traceId: 't', source: 'test' };

function system() {
  const bus = new RuntimeEventBus();
  const health = createWiredHealthSystem(bus);
  const unbind = bindHealthDomainEvents(bus, health.wiring);
  return { bus, unbind, ...health };
}

test('one MCP server down of two is degraded and named; its reconnect returns the domain to healthy', async () => {
  const { bus, aggregator } = system();
  emitMcpConnected(bus, ctx, { serverId: 'a', toolCount: 1, resourceCount: 0 });
  emitMcpConnected(bus, ctx, { serverId: 'b', toolCount: 1, resourceCount: 0 });
  emitMcpDisconnected(bus, ctx, { serverId: 'b', willRetry: true });
  await flush();
  expect(aggregator.getDomainHealth('mcp').status).toBe('degraded');
  expect(aggregator.getDomainHealth('mcp').failureReason).toContain('b');
  emitMcpConnected(bus, ctx, { serverId: 'b', toolCount: 1, resourceCount: 0 });
  await flush();
  expect(aggregator.getDomainHealth('mcp').status).toBe('healthy');
});

test('unbinding stops following the bus', async () => {
  const { bus, unbind, aggregator } = system();
  unbind();
  emitMcpDisconnected(bus, ctx, { serverId: 'a', willRetry: false });
  await flush();
  expect(aggregator.getDomainHealth('mcp').status).toBe('unknown');
});

test('a failed agent stays reported when another agent completes, and never marks tasks failed', async () => {
  const { bus, aggregator } = system();
  emitAgentFailed(bus, ctx, { agentId: 'a', error: 'boom', durationMs: 1 });
  emitAgentCompleted(bus, ctx, { agentId: 'b', durationMs: 1 });
  await flush();
  expect(aggregator.getDomainHealth('agents').status).toBe('failed');
  expect(aggregator.getDomainHealth('tasks').status).toBe('unknown');
});

test('a turn failing in one session does not make another session look failed or healthy', async () => {
  const { bus, aggregator } = system();
  emitTurnError(bus, ctx, { turnId: 'u1', error: 'boom', stopReason: 'unexpected_error' });
  emitTurnCompleted(bus, { ...ctx, sessionId: 's2' }, { turnId: 'u2', response: 'ok', stopReason: 'completed' });
  await flush();
  expect(aggregator.getDomainHealth('turn').status).toBe('degraded');
  emitTurnCompleted(bus, ctx, { turnId: 'u3', response: 'ok', stopReason: 'completed' });
  await flush();
  expect(aggregator.getDomainHealth('turn').status).toBe('healthy');
  expect(aggregator.getDomainHealth('toolExecution').status).toBe('unknown');
});
