import { describe, expect, test } from 'bun:test';
import { runAcpCommand } from '../../cli/acp-command.ts';

const initializeRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: {} },
};

/** A client that sends the given frames, waits for `expectedReplies` frames back, then closes the agent's stdin. */
function clientPair(frames: readonly unknown[], expectedReplies: number) {
  const received: string[] = [];
  let markReplied: () => void = () => {};
  const replied = new Promise<void>((resolve) => { markReplied = resolve; });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let closeInput: () => void = () => {};
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      closeInput = () => controller.close();
      for (const frame of frames) controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
    },
  });
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      received.push(decoder.decode(chunk));
      const lines = received.join('').split('\n').filter((line) => line.length > 0);
      if (lines.length >= expectedReplies) markReplied();
    },
  });
  void replied.then(() => closeInput());
  const replies = () => received.join('').split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { stdio: { input, output }, replies };
}

function run(args: string[], extra: Partial<Parameters<typeof runAcpCommand>[0]> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const done = (stdio?: Parameters<typeof runAcpCommand>[0]['stdio']) => runAcpCommand({
    args,
    env: { GOODVIBES_HOME: '/unused-home' },
    cwd: '/unused-cwd',
    stdout: (line) => { stdout.push(line); },
    stderr: (line) => { stderr.push(line); },
    stdio,
    ...extra,
  });
  return { stdout, stderr, done };
}

describe('goodvibes acp', () => {
  test('answers the ACP initialize handshake, reports unsupported capabilities honestly, and ends when stdin closes', async () => {
    const client = clientPair([initializeRequest], 1);
    const { stderr, done } = run([]);
    expect(await done(client.stdio)).toBe(0);

    const [reply] = client.replies();
    expect(reply?.['id']).toBe(1);
    const result = reply?.['result'] as { agentCapabilities: { loadSession: boolean; promptCapabilities: Record<string, boolean> } };
    expect(result.agentCapabilities.loadSession).toBe(false);
    expect(result.agentCapabilities.promptCapabilities).toEqual({ image: false, audio: false, embeddedContext: false });
    expect(stderr).toEqual([]);
  });

  test('ends cleanly with no output when the client closes stdin without sending anything', async () => {
    const client = clientPair([], Number.POSITIVE_INFINITY);
    const closeNow = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    const { stderr, done } = run([]);
    expect(await done({ input: closeNow, output: client.stdio.output })).toBe(0);
    expect(client.replies()).toEqual([]);
    expect(stderr).toEqual([]);
  });

  test('a stop signal ends the command even while the client is still connected', async () => {
    const stop = new AbortController();
    const open = new ReadableStream<Uint8Array>({});
    const client = clientPair([], Number.POSITIVE_INFINITY);
    const { done } = run([], { signal: stop.signal });
    const finished = done({ input: open, output: client.stdio.output });
    stop.abort();
    expect(await finished).toBe(0);
  });

  test('console output during serving goes to stderr, never into the protocol stream', async () => {
    const client = clientPair([initializeRequest], 1);
    const { stderr, done } = run([]);
    const finished = done(client.stdio);
    console.log('runtime chatter');
    expect(await finished).toBe(0);
    expect(stderr).toEqual(['runtime chatter']);
    expect(client.replies().every((frame) => frame['jsonrpc'] === '2.0')).toBe(true);
  });

  test('an unexpected argument is a usage error that serves nothing', async () => {
    const { stdout, stderr, done } = run(['--bogus']);
    expect(await done()).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('Usage: goodvibes acp');
  });
});
