// Proves: A call outside an MCP server's allowed paths or hosts, to a blocked or quarantined server, or to a tool the owner denied, is sent.
// Red when: The registry sends a tool call its scope check refused (a path outside allowedPaths, by `..`, relative or direct, or a host outside allowedHosts), one to a blocked server or a quarantined one the owner has not approved, or one to a tool the owner denied with `/mcp deny`.
// Proves: Another program's MCP file replaces the owner's server of the same name, so the tools he denied and the trust he set stop applying.
// Red when: The merge of MCP files lets Claude Desktop's or ~/.mcp's entry win over the owner's own file, or a later file of a name drops a tool an earlier one denied or loosens its trust mode.
// Proves: A trust mode the owner set this session for one MCP program applies to another program that later takes the same server name.
// Red when: A reload that puts a different program (file, command, arguments, address or environment) behind a server name keeps the trust mode set this session for the earlier one, so a call outside the new server's scope is sent.
/**
 * An MCP server is third-party code; the scope the owner gives it (allowed
 * paths and hosts, its trust mode, a quarantine, a tool he denied) is his only hold on what it
 * is asked to do. The real registry and client, connected over stdio to a
 * stand-in MCP server that records every tool call it receives, show which
 * calls reach it.
 * The owner's approval of a quarantine lets the call through again, so the
 * refusals are the scope's and not a broken connection; the tool the owner
 * then denies (`registry.denyServerTool`, what `/mcp deny` calls) is the one
 * that call just reached.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookDispatcher } from '../platform/src/platform/hooks/dispatcher.ts';
import { McpRegistry } from '../platform/src/platform/mcp/registry.ts';
import { loadMcpEffectiveConfig, type McpServerConfigEntry } from '../platform/src/platform/mcp/config.ts';
import { SandboxSessionRegistry } from '../platform/src/platform/runtime/sandbox/session-registry.ts';

/** A legacy stdio MCP server with one tool, `read_file`, that appends each call's path to the record file. */
const STAND_IN = `
const { appendFileSync } = require('node:fs');
const record = process.argv[2];
let buffer = '';
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stand-in', version: '1' } } });
    else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, url: { type: 'string' } }, required: ['path'] } }] } });
    else if (m.method === 'tools/call') { appendFileSync(record, m.params.arguments.path + '\\n'); send({ id: m.id, result: { content: [{ type: 'text', text: 'ok' }] } }); }
    else send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
  }
});
`;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test('only calls inside the server\'s scope reach it; a blocked or unapproved quarantined server, or a tool the owner denied, receives nothing', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-mcp-scope-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const allowed = join(root, 'allowed'), record = join(root, 'received.log'), script = join(root, 'stand-in.cjs');
  mkdirSync(allowed);
  writeFileSync(script, STAND_IN);
  const registry = new McpRegistry({ hookDispatcher: new HookDispatcher(), sandboxSessions: new SandboxSessionRegistry(root) });
  cleanups.push(() => registry.disconnectAll());
  const server = (name: string) => registry.connectServer({ name, command: process.execPath, args: [script, record], allowedPaths: [allowed], allowedHosts: ['docs.example'] });
  await server('files');
  await server('locked');

  const call = (server: string, path: string, url?: string) => registry.callTool(`mcp:${server}:read_file`, { path, ...(url ? { url } : {}) }).then(() => 'sent', () => 'refused');
  const outcome = {
    inside: await call('files', join(allowed, 'notes.txt')),
    outside: await call('files', join(root, 'secret.txt')),
    climbsOut: await call('files', `${allowed}/../secret.txt`),
    relative: await call('files', '../../../../../../etc/passwd'),
    otherHost: await call('files', join(allowed, 'host.txt'), 'https://evil.example/collect'),
    blocked: (registry.setServerTrustMode('locked', 'blocked'), await call('locked', join(allowed, 'blocked.txt'))),
    quarantined: (registry.quarantineSchema('files', 'operator_flagged'), await call('files', join(allowed, 'quarantined.txt'))),
    approved: (registry.approveSchemaQuarantine('files', 'owner'), await call('files', join(allowed, 'approved.txt'))),
    denied: (registry.denyServerTool('files', 'read_file'), await call('files', join(allowed, 'denied.txt'))),
  };
  const received = existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n') : [];
  expect({ outcome, received }).toEqual({
    outcome: { inside: 'sent', outside: 'refused', climbsOut: 'refused', relative: 'refused', otherHost: 'refused', blocked: 'refused', quarantined: 'refused', approved: 'sent', denied: 'refused' },
    received: [join(allowed, 'notes.txt'), join(allowed, 'approved.txt')],
  });
});

/**
 * Other programs' MCP files (~/.mcp, Claude Desktop's) name a server the owner
 * also configured. The owner's own entry is the one that runs, with the trust
 * he set; a denial any of the files made is kept, so a file can only tighten.
 */
test('another program\'s MCP file of the same name neither replaces the owner\'s server nor drops a tool he denied', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-mcp-merge-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), project = join(root, 'project');
  const write = (path: string, body: unknown) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(body)); };
  write(join(home, '.mcp', 'mcp.json'), { mcpServers: { github: { command: '/opt/dotdir/github-mcp', deniedTools: ['force_push'] } } });
  write(join(home, '.config', 'claude', 'claude_desktop_config.json'), { mcpServers: { github: { command: '/opt/other/github-mcp', trustMode: 'allow-all' } } });
  write(join(home, '.config', 'mcp', 'mcp.json'), { servers: [{ name: 'github', command: '/opt/owner/github-mcp', deniedTools: ['delete_repo'], trustMode: 'constrained' }] });
  const effective = loadMcpEffectiveConfig({ homeDirectory: home, workingDirectory: project });
  const github = effective.servers.filter((entry) => entry.server.name === 'github');
  expect(github.map(({ server }) => ({ command: server.command, deniedTools: server.deniedTools, trustMode: server.trustMode }))).toEqual([
    { command: '/opt/owner/github-mcp', deniedTools: ['force_push', 'delete_repo'], trustMode: 'constrained' },
  ]);
});

/**
 * The owner sets allow-all for his own server this session; a reload then puts a
 * repository's program behind the same name (a workspace he trusts defines a
 * server called the same). The trust he gave belongs to his program: a reload
 * that keeps it keeps the trust, one that changes it ends it before it connects.
 */
test('allow-all set this session for one program does not pass to another program that takes its name', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-mcp-trust-name-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const allowed = join(root, 'allowed'), record = join(root, 'received.log'), script = join(root, 'stand-in.cjs');
  mkdirSync(allowed);
  writeFileSync(script, STAND_IN);
  const registry = new McpRegistry({ hookDispatcher: new HookDispatcher(), sandboxSessions: new SandboxSessionRegistry(root) });
  cleanups.push(() => registry.disconnectAll());
  const owners: McpServerConfigEntry = { server: { name: 'github', command: process.execPath, args: [script, record], allowedPaths: [allowed] },
    source: { scope: 'global', kind: 'global-xdg', path: join(root, 'home', 'mcp.json'), writable: true } };
  const repository: McpServerConfigEntry = { server: { name: 'github', command: process.execPath, args: [script, record, 'repository-build'], allowedPaths: [allowed] },
    source: { scope: 'project', kind: 'project-mcp', path: join(root, 'repo', '.mcp.json'), writable: true } };
  const outside = (file: string) => registry.callTool('mcp:github:read_file', { path: join(root, file) }).then(() => 'sent', () => 'refused');

  await registry.applyConfig([owners]);
  registry.setServerTrustMode('github', 'allow-all');
  const ownProgram = await outside('own.txt');
  await registry.applyConfig([owners]);
  const afterReload = await outside('reloaded.txt');
  await registry.applyConfig([repository]);
  const otherProgram = await outside('repository.txt');
  const received = existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n') : [];
  expect({ ownProgram, afterReload, otherProgram, received }).toEqual({
    ownProgram: 'sent', afterReload: 'sent', otherProgram: 'refused',
    received: [join(root, 'own.txt'), join(root, 'reloaded.txt')],
  });
});
