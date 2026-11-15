import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadMcpEffectiveConfig, removeMcpServerConfig, upsertMcpServerConfig } from '../platform/src/platform/mcp/config.js';

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function roots() {
  const base = mkdtempSync(join(tmpdir(), 'mcp-config-'));
  made.push(base);
  const workingDirectory = join(base, 'project'), homeDirectory = join(base, 'home');
  mkdirSync(workingDirectory, { recursive: true }); mkdirSync(homeDirectory, { recursive: true });
  return { workingDirectory, homeDirectory };
}
function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

test('an entry the product could not add does not block, or get deleted by, later edits', () => {
  const r = roots();
  const path = join(r.homeDirectory, '.config', 'mcp', 'mcp.json');
  write(path, { mcpServers: { 'github/mcp': { command: 'legacy-server' } } });
  expect(() => upsertMcpServerConfig(r, 'global', { name: 'docs', url: 'https://example.invalid/mcp' })).not.toThrow();
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { servers: { name: string }[] };
  expect(saved.servers.map(server => server.name).sort()).toEqual(['docs', 'github/mcp']);
  expect(() => removeMcpServerConfig(r, 'global', 'docs')).not.toThrow();
  // The unaddressable entry cannot be used as a server, so the effective config leaves it out.
  expect(loadMcpEffectiveConfig(r).servers.map(entry => entry.server.name)).toEqual([]);
});

test('headers and fields the product does not model survive a rewrite triggered by another server', () => {
  const r = roots();
  const path = join(r.homeDirectory, '.config', 'mcp', 'mcp.json');
  write(path, { mcpServers: { remote: { type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer synthetic' }, disabled: false } } });
  expect(loadMcpEffectiveConfig(r).servers[0]?.server.headers).toEqual({ Authorization: 'Bearer synthetic' });
  upsertMcpServerConfig(r, 'global', { name: 'other', command: 'other-server' });
  const entry = (JSON.parse(readFileSync(path, 'utf8')) as { servers: Record<string, unknown>[] }).servers.find(server => server.name === 'remote');
  expect(entry).toMatchObject({ headers: { Authorization: 'Bearer synthetic' }, type: 'http', disabled: false });
  // Editing the server itself without resending its headers keeps them, like env.
  upsertMcpServerConfig(r, 'global', { name: 'remote', url: 'https://example.invalid/v2' });
  expect(loadMcpEffectiveConfig(r).servers.find(server => server.server.name === 'remote')?.server.headers).toEqual({ Authorization: 'Bearer synthetic' });
});

test('a project file cannot grant its own servers allow-all trust', () => {
  const r = roots();
  write(join(r.workingDirectory, '.goodvibes', 'mcp.json'), { servers: [{ name: 'cloned', command: 'from-the-repo', trustMode: 'allow-all' }, { name: 'strict', command: 'x', trustMode: 'blocked' }] });
  write(join(r.homeDirectory, '.config', 'mcp', 'mcp.json'), { servers: [{ name: 'mine', command: 'mine', trustMode: 'allow-all' }] });
  const byName = new Map(loadMcpEffectiveConfig(r).servers.map(entry => [entry.server.name, entry.server.trustMode]));
  expect(byName.get('cloned')).toBeUndefined();
  expect(byName.get('strict')).toBe('blocked');
  expect(byName.get('mine')).toBe('allow-all');
});
