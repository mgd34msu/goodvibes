import { describe, expect, test } from 'bun:test';
import { McpPermissionManager } from '../platform/src/platform/runtime/mcp/index.ts';

describe('MCP security decision subscription', () => {
  test('a subscriber hears each recorded decision and nothing after unsubscribing', async () => {
    const manager = new McpPermissionManager();
    manager.registerServer('docs', 'restricted', { role: 'docs', mode: 'constrained' });
    let heard = 0;
    const off = manager.subscribeDecisions(() => { heard += 1; });
    await manager.evaluateToolCall('docs', 'read_docs', {});
    expect(heard).toBe(1);
    expect(manager.listRecentDecisions(8)).toHaveLength(1);
    off();
    await manager.evaluateToolCall('docs', 'read_docs', {});
    expect(heard).toBe(1);
  });

  test('a listener that throws does not stop the decision from being recorded', async () => {
    const manager = new McpPermissionManager();
    manager.registerServer('docs', 'restricted', { role: 'docs', mode: 'constrained' });
    manager.subscribeDecisions(() => { throw new Error('listener broke'); });
    await manager.evaluateToolCall('docs', 'read_docs', {});
    expect(manager.listRecentDecisions(8)).toHaveLength(1);
  });
});
