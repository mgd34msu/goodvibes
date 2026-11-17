// An MCP server's allowedPaths scope is judged by where a path lands, not by
// how it is spelled: `..` segments, sibling directories that share a prefix
// and symlinks out of an allowed directory all fall outside the scope. Which
// argument holds a path or a destination is decided in code from the tool's
// input schema, the argument's name and whether the value names a location.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpPermissionManager } from '../platform/src/platform/runtime/mcp/index.ts';
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
  manager.registerServer('docs', { role: 'docs', mode: 'constrained', allowedPaths: [allowed] });
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
    manager.registerServer('docs', { role: 'docs', mode: 'constrained', allowedPaths: [allowed] });
    expect((await manager.evaluateToolCall('docs', 'read_docs', { filename: join(root, 'elsewhere', 'secret.md') })).verdict).toBe('deny');
    expect((await manager.evaluateToolCall('docs', 'read_docs', { filename: join(allowed, 'a.md'), query: 'setup' })).verdict).toBe('allow');
  });

  test('a destination under any argument name is held to the host scope', async () => {
    const manager = new McpPermissionManager();
    manager.registerServer('docs', { role: 'docs', mode: 'constrained', allowedHosts: ['docs.example.com'] });
    expect((await manager.evaluateToolCall('docs', 'read_docs', { endpoint: 'https://api.docs.example.com/v1' })).verdict).toBe('allow');
    expect((await manager.evaluateToolCall('docs', 'read_docs', { endpoint: 'https://paste.example.net/x' })).verdict).toBe('deny');
  });

  test('prose with a slash and dotted file names are not paths or hosts; a bare name under a path argument is', async () => {
    const manager = new McpPermissionManager();
    manager.registerServer('docs', { role: 'docs', mode: 'constrained', allowedPaths: [allowed], allowedHosts: ['docs.example.com'] });
    expect((await manager.evaluateToolCall('docs', 'read_docs', { query: 'TCP/IP tuning', name: 'report.pdf' })).verdict).toBe('allow');
    expect((await manager.evaluateToolCall('docs', 'read_docs', { target: 'secrets' }, { workingDirectory: root })).verdict).toBe('deny');
    expect((await manager.evaluateToolCall('docs', 'read_docs', { target: 'a.md' }, { workingDirectory: allowed })).verdict).toBe('allow');
  });

  test('text that holds a slash is not a path; a real path outside the scope names its argument', async () => {
    const manager = new McpPermissionManager();
    manager.registerServer('docs', { role: 'docs', mode: 'constrained', allowedPaths: [allowed] });
    const note = join(allowed, 'a.md');
    for (const args of [{ path: note, content: 'either/or' }, { path: note, content: 'due 11/14/2026' },
      { path: note, mimeType: 'text/plain' }, { query: 'what does a/b testing mean?' }]) {
      expect((await manager.evaluateToolCall('docs', 'write_note', args)).verdict).toBe('allow');
    }
    const outside = await manager.evaluateToolCall('docs', 'write_note', { path: join(root, 'elsewhere', 'secret.md') });
    expect(outside.verdict).toBe('deny');
    expect(outside.reason).toContain("argument 'path'");
  });

  test('an argument the tool schema declares a path or URI is held to the scope whatever its name', async () => {
    const manager = new McpPermissionManager();
    manager.registerServer('docs', { role: 'docs', mode: 'constrained', allowedPaths: [allowed] });
    const inputSchema = { type: 'object', properties: { note: { type: 'string', format: 'uri-reference' } } };
    expect((await manager.evaluateToolCall('docs', 'open', { note: 'sub/a.md' }, { inputSchema, workingDirectory: root })).verdict).toBe('deny');
    expect((await manager.evaluateToolCall('docs', 'open', { note: 'a.md' }, { inputSchema, workingDirectory: allowed })).verdict).toBe('allow');
  });
});
