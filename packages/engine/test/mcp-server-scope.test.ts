// Proves: A call outside an MCP server's allowed paths or hosts, to a blocked or quarantined server, or to a tool the owner denied, is sent.
// Red when: The registry sends a tool call its scope check refused (a path outside allowedPaths, by `..`, relative or direct, or a host outside allowedHosts), one to a blocked server or a quarantined one the owner has not approved, or one to a tool the owner denied with `/mcp deny`.
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
