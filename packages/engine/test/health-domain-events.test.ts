/**
 * The runtime events that mean a subsystem failed or came back drive the
 * health aggregator and its cascades.
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

test('repeated MCP disconnects block MCP tool dispatch once recovery is spent, and a reconnect lifts the block', async () => {
  const { bus, aggregator } = system();
  const disconnect = () => emitMcpDisconnected(bus, ctx, { serverId: 'a', willRetry: true });
  for (let i = 0; i < 3; i++) disconnect();
  await flush();
  expect(aggregator.getDomainHealth('mcp').status).toBe('failed');
  expect(aggregator.canExecute('toolExecution', 'mcp-tools').allowed).toBe(true);
  disconnect();
  await flush();
  expect(aggregator.canExecute('toolExecution', 'mcp-tools').allowed).toBe(false);

  emitMcpConnected(bus, ctx, { serverId: 'a', toolCount: 1, resourceCount: 0 });
  await flush();
  expect(aggregator.getDomainHealth('mcp').status).toBe('healthy');
  expect(aggregator.getDomainHealth('mcp').recoveryAttempts).toBe(0);
  expect(aggregator.canExecute('toolExecution', 'mcp-tools').allowed).toBe(true);
});

test('unbinding stops following the bus', async () => {
  const { bus, unbind, aggregator } = system();
  unbind();
  emitMcpDisconnected(bus, ctx, { serverId: 'a', willRetry: false });
  await flush();
  expect(aggregator.getDomainHealth('mcp').status).toBe('unknown');
});

test('a failed turn cancels tool execution and a completed turn returns it to healthy', async () => {
  const { bus, aggregator } = system();
  emitTurnError(bus, ctx, { turnId: 'u1', error: 'boom', stopReason: 'unexpected_error' });
  await flush();
  expect(aggregator.getDomainHealth('toolExecution').status).toBe('degraded');
  emitTurnCompleted(bus, ctx, { turnId: 'u2', response: 'ok', stopReason: 'completed' });
  await flush();
  expect(aggregator.getDomainHealth('turn').status).toBe('healthy');
  expect(aggregator.getDomainHealth('toolExecution').status).toBe('healthy');
});

test('a failed agent marks tasks failed and a completed agent returns them to healthy', async () => {
  const { bus, aggregator } = system();
  emitAgentFailed(bus, ctx, { agentId: 'a', error: 'boom', durationMs: 1 });
  await flush();
  expect(aggregator.getDomainHealth('tasks').status).toBe('failed');
  emitAgentCompleted(bus, ctx, { agentId: 'a', durationMs: 1 });
  await flush();
  expect(aggregator.getDomainHealth('tasks').status).toBe('healthy');
});

test('a recovered source does not clear a target that another failed source still holds', async () => {
  const { bus, aggregator, wiring } = system();
  emitTurnError(bus, ctx, { turnId: 'u1', error: 'boom', stopReason: 'unexpected_error' });
  wiring.evaluateDomain('plugins', 'failed');
  await flush();
  emitTurnCompleted(bus, ctx, { turnId: 'u2', response: 'ok', stopReason: 'completed' });
  await flush();
  expect(aggregator.getDomainHealth('toolExecution').status).toBe('degraded');
});

test('a target whose cascade reason was overwritten by another source is released once every source recovers', async () => {
  const { bus, wiring, aggregator } = system();
  emitTurnError(bus, ctx, { turnId: 'u1', error: 'boom', stopReason: 'unexpected_error' });
  await flush();
  wiring.evaluateDomain('plugins', 'failed');
  expect(aggregator.getDomainHealth('toolExecution').failureReason).toStartWith('Tool deregistration requested');
  wiring.evaluateDomain('plugins', 'healthy');
  expect(aggregator.getDomainHealth('toolExecution').status).toBe('degraded');
  emitTurnCompleted(bus, ctx, { turnId: 'u2', response: 'ok', stopReason: 'completed' });
  await flush();
  expect(aggregator.getDomainHealth('toolExecution').status).toBe('healthy');
});
