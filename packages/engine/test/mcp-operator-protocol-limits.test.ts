import { expect, test } from 'bun:test';
import { getOperatorContract } from '../contracts/src/index.ts';
import { buildOperatorMcpTools, OperatorMcpServer, serveOperatorMcp } from '../platform/src/platform/mcp/server/index.ts';

test('a union of object inputs keeps its alternatives instead of becoming an empty schema', () => {
  const { tools } = buildOperatorMcpTools(getOperatorContract());
  const union = tools.find((tool) => tool.operatorMethodId === 'payments.purchase.cancel');
  const schema = union?.inputSchema as { type?: string; anyOf?: unknown[]; oneOf?: unknown[]; properties?: Record<string, unknown> } | undefined;
  expect(schema?.type).toBe('object');
  expect(Object.keys(schema?.properties ?? {}).length + (schema?.anyOf?.length ?? 0) + (schema?.oneOf?.length ?? 0)).toBeGreaterThan(0);
});

test('initialize answers with a version it serves, not whatever the client asked for', async () => {
  const server = new OperatorMcpServer({ toolSet: { tools: [], methodIdByToolName: new Map() }, invoke: () => null });
  const reply = async (protocolVersion: string) => {
    const line = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion } }));
    return (JSON.parse(line!) as { result: { protocolVersion: string } }).result.protocolVersion;
  };
  expect(await reply('2025-03-26')).toBe('2025-03-26');
  expect(await reply('2099-01-01')).toBe('2025-06-18');
});

test('a long tools/call does not hold up a ping sent after it', async () => {
  let release!: () => void;
  const finish = new Promise<void>((resolve) => { release = resolve; });
  const server = new OperatorMcpServer({
    toolSet: { tools: [], methodIdByToolName: new Map([['slow', 'slow.method']]) },
    invoke: async () => { await finish; return 'done'; },
  });
  const written: string[] = [];
  let pinged!: () => void;
  const pingAnswered = new Promise<void>((resolve) => { pinged = resolve; });
  const lines = (async function* () {
    yield JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow', arguments: {} } });
    yield JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await pingAnswered; // the stream stays open until the ping has been answered
  })();
  const serving = serveOperatorMcp(server, { lines, write: (line) => { written.push(line); if (line.includes('"id":2')) pinged(); } });
  await pingAnswered;
  release();
  await serving;
  expect(written.map((line) => (JSON.parse(line) as { id: number }).id)).toEqual([2, 1]);
});
