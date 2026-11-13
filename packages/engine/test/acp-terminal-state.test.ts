import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { join } from 'node:path';
import { AcpHostService, type DiscoveredAcpAgent } from '../platform/src/platform/acp/host.ts';
import { AcpConnection } from '../platform/src/platform/acp/connection.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'fake-acp-agent.ts');
let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previousPort = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previousPort); });

const slowAgent = (): DiscoveredAcpAgent => ({ id: 'fake', title: 'Fake Agent', binaryPath: process.execPath, args: ['run', FIXTURE, 'slow-turn'] });

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('AcpHostService: an agent-cancelled turn', () => {
  test('returns the live session to idle instead of a stopped row that still owns a child', async () => {
    const host = new AcpHostService({});
    const hosted = await host.spawnAgent({ agent: slowAgent(), cwd: import.meta.dir, prompt: 'long task' });
    try {
      await waitUntil(() => (host.get(hosted.id)?.progress ?? '').length > 0);
      // The agent (not stop()) ends the turn with stopReason 'cancelled'.
      const record = (host as unknown as { records: Map<string, { conn: { cancel(p: { sessionId: string }): Promise<void> } | null; acpSessionId: string | null }> }).records.get(hosted.id)!;
      await record.conn!.cancel({ sessionId: record.acpSessionId! });
      await waitUntil(() => host.get(hosted.id)?.state !== 'prompting');
      const info = host.get(hosted.id)!;
      // A 'stopped' row would refuse prompts while its child is alive and could
      // not be dismissed; whatever the state is, it must match what is alive.
      expect(info.state).toBe('idle');
      expect(host.prompt(hosted.id, 'again').queued).toBe(true);
    } finally {
      await host.stop(hosted.id);
    }
  }, 30_000);
});

describe('AcpConnection: one terminal outcome per run', () => {
  test('cancelling a running prompt emits exactly one terminal agent event', async () => {
    const bus = new RuntimeEventBus();
    const terminal: string[] = [];
    bus.onDomain('agents', (envelope: { type: string }) => {
      if (['AGENT_COMPLETED', 'AGENT_FAILED', 'AGENT_CANCELLED'].includes(envelope.type)) terminal.push(envelope.type);
    });
    const connection = new AcpConnection('terminal-once', {
      description: 'long task', context: '', tools: [], workingDirectory: import.meta.dir,
    }, [process.execPath, 'run', FIXTURE, 'slow-turn'], async () => ({ approved: false, remember: false }), bus);
    const running = connection.run();
    await waitUntil(() => (connection as unknown as { sessionId: string | null }).sessionId !== null);
    await new Promise((resolve) => setTimeout(resolve, 200)); // prompt is parked in the agent
    await connection.cancel();
    await running;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(terminal.length).toBe(1);
    expect(connection.getInfo().status).toBe(terminal[0] === 'AGENT_CANCELLED' ? 'cancelled' : 'error');
  }, 30_000);
});
