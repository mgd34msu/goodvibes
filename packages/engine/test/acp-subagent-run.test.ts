import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { AcpConnection } from '../platform/src/platform/acp/connection.ts';
import { messageChunkText } from '../platform/src/platform/acp/protocol.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/acp/subagent-script.ts', import.meta.url));

function run(mode: string, handshakeTimeoutMs?: number) {
  const bus = new RuntimeEventBus();
  const events: string[] = [];
  const deltas: string[] = [];
  bus.onDomain('agents', (envelope) => {
    events.push(envelope.type);
    if (envelope.payload.type === 'AGENT_STREAM_DELTA' && envelope.payload.content) deltas.push(envelope.payload.content);
  });
  const connection = new AcpConnection(
    'script-run',
    { description: 'scripted task', context: '', tools: [], workingDirectory: import.meta.dir },
    [process.execPath, '--no-env-file', FIXTURE, mode],
    { runtimeBus: bus, ...(handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs }) },
  );
  return { connection, events, deltas };
}

describe('AcpConnection: what the subagent returns', () => {
  test('a compliant child sends one content block and its text becomes the output and the stream deltas', async () => {
    const { connection, events, deltas } = run('answer');
    const result = await connection.run();
    expect(result.success).toBe(true);
    expect(result.output).toBe('the answer');
    expect(deltas).toEqual(['the answer']);
    expect(events).toContain('AGENT_COMPLETED');
  }, 20_000);

  test('an answer longer than the progress tail is returned whole', async () => {
    const { connection } = run('text:5000');
    const result = await connection.run();
    expect(result.output.length).toBe(5000);
    expect(result.output.startsWith('HEAD')).toBe(true);
    expect(result.output.endsWith('TAIL')).toBe(true);
  }, 20_000);

  test('an answer beyond the cap is cut and says so', async () => {
    const { connection } = run('text:70000');
    const result = await connection.run();
    expect(result.output.startsWith('HEAD')).toBe(true);
    expect(result.output).toContain('[output truncated at 64000 characters]');
    expect(result.output.endsWith('TAIL')).toBe(false);
  }, 20_000);
});

describe('AcpConnection: stop reasons other than end_turn are not success', () => {
  for (const stopReason of ['refusal', 'max_tokens', 'max_turn_requests']) {
    test(`${stopReason} reports failure with the reason, and emits AGENT_FAILED`, async () => {
      const { connection, events } = run(`stop:${stopReason}`);
      const result = await connection.run();
      expect(result.success).toBe(false);
      expect(result.output).toContain(stopReason);
      expect(result.output).toContain('the answer');
      expect(events).toContain('AGENT_FAILED');
      expect(events).not.toContain('AGENT_COMPLETED');
      expect(connection.getInfo().status).toBe('error');
    }, 20_000);
  }
});

describe('AcpConnection: a child that never answers', () => {
  test('one that never answers initialize fails the run at the handshake bound', async () => {
    const { connection, events } = run('hang', 300);
    const result = await connection.run();
    expect(result.success).toBe(false);
    expect(result.output).toContain('ACP initialize timed out');
    expect(events).toContain('AGENT_FAILED');
  }, 20_000);
});

describe('messageChunkText', () => {
  test('reads one block, an array of blocks, and ignores other updates and non-text blocks', () => {
    expect(messageChunkText({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } })).toBe('a');
    expect(messageChunkText({ sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] })).toBe('ab');
    expect(messageChunkText({ sessionUpdate: 'tool_call', content: { type: 'text', text: 'a' } })).toBe('');
    expect(messageChunkText({ sessionUpdate: 'agent_message_chunk' })).toBe('');
  });
});
