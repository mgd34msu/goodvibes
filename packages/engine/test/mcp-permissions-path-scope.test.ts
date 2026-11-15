// An MCP server's allowedPaths scope is judged by where a path lands, not by
// how it is spelled: `..` segments, sibling directories that share a prefix
// and symlinks out of an allowed directory all fall outside the scope. Which
// argument holds a path or a destination is decided in code from its name and
// the value's shape.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpPermissionManager } from '../platform/src/platform/runtime/mcp/index.ts';
import { useGateReadings } from './_helpers/gate-readings.ts';

useGateReadings([
  ['read_docs', { capability: 'read_fs', mutates: false }],
]);

let root = '';
let allowed = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-scope-'));
  allowed = join(root, 'allowed');
  mkdirSync(allowed);
  mkdirSync(join(root, 'allowed-2'));
  mkdirSync(join(root, 'elsewhere'));
  writeFileSync(join(allowed, 'a.md'), 'a');
  writeFileSync(join(root, 'elsewhere', 'secret.md'), 's');
  symlinkSync(join(root, 'elsewhere'), join(allowed, 'link-out'));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

async function verdict(path: string): Promise<string | undefined> {
  const manager = new McpPermissionManager();
  manager.registerServer('docs', 'standard', { role: 'docs', mode: 'constrained', allowedPaths: [allowed] });
  return (await manager.evaluateToolCall('docs', 'read_docs', { path })).verdict;
}

describe('McpPermissionManager path scope', () => {
  test('a file inside the allowed directory is in scope', async () => {
    expect(await verdict(join(allowed, 'a.md'))).toBe('allow');
    expect(await verdict(join(allowed, 'not-yet', 'new.md'))).toBe('allow');
  });

  test('a path that climbs out with .. is out of scope', async () => {
    expect(await verdict(`${allowed}/../elsewhere/secret.md`)).toBe('deny');
  });

  test('a sibling directory sharing the prefix is out of scope', async () => {
    expect(await verdict(join(root, 'allowed-2', 'x.md'))).toBe('deny');
  });

  test('a symlink inside the allowed directory that points out is out of scope', async () => {
    expect(await verdict(join(allowed, 'link-out', 'secret.md'))).toBe('deny');
  });

  test('a path under any argument name is held to the scope', async () => {
    const manager = new McpPermissionManager();
    manager.registerServer('docs', 'standard', { role: 'docs', mode: 'constrained', allowedPaths: [allowed] });
    expect((await manager.evaluateToolCall('docs', 'read_docs', { filename: join(root, 'elsewhere', 'secret.md') })).verdict).toBe('deny');
    expect((await manager.evaluateToolCall('docs', 'read_docs', { filename: join(allowed, 'a.md'), query: 'setup' })).verdict).toBe('allow');
  });

  test('a destination under any argument name is held to the host scope', async () => {
    const manager = new McpPermissionManager();
    manager.registerServer('docs', 'standard', { role: 'docs', mode: 'constrained', allowedHosts: ['docs.example.com'] });
    expect((await manager.evaluateToolCall('docs', 'read_docs', { endpoint: 'https://api.docs.example.com/v1' })).verdict).toBe('allow');
    expect((await manager.evaluateToolCall('docs', 'read_docs', { endpoint: 'https://paste.example.net/x' })).verdict).toBe('deny');
  });

  test('prose with a slash and dotted file names are not paths or hosts; a bare name under a path argument is', async () => {
    const manager = new McpPermissionManager();
    manager.registerServer('docs', 'standard', { role: 'docs', mode: 'constrained', allowedPaths: [allowed], allowedHosts: ['docs.example.com'] });
    expect((await manager.evaluateToolCall('docs', 'read_docs', { query: 'TCP/IP tuning', name: 'report.pdf' })).verdict).toBe('allow');
    expect((await manager.evaluateToolCall('docs', 'read_docs', { target: 'secrets' }, { workingDirectory: root })).verdict).toBe('deny');
    expect((await manager.evaluateToolCall('docs', 'read_docs', { target: 'a.md' }, { workingDirectory: allowed })).verdict).toBe('allow');
  });

  test('a capability list admits a tool whose class it names and denies one it does not', async () => {
    const reads = new McpPermissionManager();
    reads.registerServer('docs', 'standard', { role: 'docs', mode: 'constrained', allowedCapabilities: ['read_fs'] });
    expect((await reads.evaluateToolCall('docs', 'read_docs', {})).verdict).toBe('allow');
    const writes = new McpPermissionManager();
    writes.registerServer('docs', 'standard', { role: 'docs', mode: 'constrained', allowedCapabilities: ['write_fs'] });
    const denied = await writes.evaluateToolCall('docs', 'read_docs', {});
    expect(denied.verdict).toBe('deny');
    expect(denied.causes).toEqual(['capability-out-of-scope']);
    expect(denied.capability).toBe('read_fs');
  });
});
