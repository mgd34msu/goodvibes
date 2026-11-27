/**
 * A stand-in outside coding agent speaking ACP (JSON-RPC 2.0, one message per line on stdio): the program at the other
 * end of a runner's connection, outside the product. On a prompt it asks permission for one write in the folder its
 * session was opened in (`session/request_permission`, title `write`, kind `edit`), writes `probe.txt` there only when
 * the answer selects allow, says what it was answered as its reply, and ends the turn. It writes nothing else.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

let cwd = process.cwd();
let nextId = 1000;
const waiting = new Map<number, (result: unknown) => void>();
const send = (message: unknown): void => { process.stdout.write(`${JSON.stringify(message)}\n`); };
const ask = (method: string, params: unknown): Promise<unknown> => new Promise((resolve) => {
  const id = nextId++;
  waiting.set(id, resolve);
  send({ jsonrpc: '2.0', id, method, params });
});

async function handle(message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }): Promise<void> {
  if (message.method === undefined && typeof message.id === 'number') {
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    resolve?.(message.result ?? { error: message.error });
    return;
  }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] } });
    return;
  }
  if (message.method === 'session/new') {
    if (typeof message.params?.['cwd'] === 'string') cwd = message.params['cwd'];
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'stand-in-session' } });
    return;
  }
  if (message.method === 'session/prompt') {
    const path = join(cwd, 'probe.txt');
    const answer = await ask('session/request_permission', {
      sessionId: 'stand-in-session',
      toolCall: { toolCallId: 'write-probe', title: 'write', kind: 'edit', status: 'pending', rawInput: { path, content: 'written by the stand-in agent' }, locations: [{ path }] },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
    }) as { outcome?: { outcome?: string; optionId?: string } };
    const allowed = answer?.outcome?.outcome === 'selected' && answer.outcome.optionId === 'allow';
    if (allowed) writeFileSync(path, 'written by the stand-in agent\n');
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'stand-in-session',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? 'allowed' : `refused ${JSON.stringify(answer?.outcome ?? answer)}` } } } });
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (typeof message.id === 'number') send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `no method ${message.method}` } });
}

let buffer = '';
process.stdin.on('data', (chunk: Buffer) => {
  buffer += chunk.toString();
  let at = buffer.indexOf('\n');
  while (at >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line) { try { void handle(JSON.parse(line)); } catch { /* not a message */ } }
    at = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
