// Ported from goodvibes-agent src/test/runtime/mcp/permissions-coherence.test.ts.
//
// An MCP call is decided in code from the server's trust mode, per-tool
// overrides and scopes; no decision model is asked. The fake port here only
// proves that nothing reads one.
import { describe, expect, test } from 'bun:test';
import { McpPermissionManager } from '../platform/src/platform/runtime/mcp/index.ts';
import { useGateReadings } from './_helpers/gate-readings.ts';

const readings = useGateReadings([
  ['write_file', { capability: 'write_fs', mutates: true, beyondProject: true }],
  ['exec_shell', { capability: 'exec', mutates: true, irreversible: true }],
  ['read_docs', { capability: 'read_fs', mutates: false }],
]);

describe('MCP tool permissions', () => {
  test('role and old risk modes do not require a Jev permission decision', async () => {
    for (const mode of ['constrained', 'ask-on-risk', 'allow-all'] as const) {
      const manager = new McpPermissionManager();
      manager.registerServer('fixture', { role: 'docs', mode });
      const result = await manager.evaluateToolCall('fixture', 'write_file', { path: '/tmp/output.md' });
      expect(result.allowed).toBe(true);
      expect(result.riskLevel).toBeUndefined();
    }
    expect(readings.requests.filter(request => 'capability' in (request.questions ?? {}) || 'mutates' in (request.questions ?? {}))).toHaveLength(0);
  });
  test('explicit tool denies and configured path scope remain authoritative', async () => {
    const manager = new McpPermissionManager();
    manager.registerServer('fixture', { allowedPaths: ['/workspace'] });
    expect((await manager.evaluateToolCall('fixture', 'read_file', { path: '/workspace/file' })).allowed).toBe(true);
    expect((await manager.evaluateToolCall('fixture', 'read_file', { path: '/elsewhere/file' })).allowed).toBe(false);
    manager.denyTool('fixture', 'read_file');
    expect((await manager.evaluateToolCall('fixture', 'read_file', { path: '/workspace/file' })).allowed).toBe(false);
  });
});
