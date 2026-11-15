/** An agent a daemon spawns for a session runs under that session's channel surface, and a local session keeps the owner's. */
import { expect, test } from 'bun:test';
import { DaemonServer } from '../platform/src/platform/daemon/facade.js';
import { currentTurnSurfaceId } from '../platform/src/platform/security/turn-boundary.js';

type TrySpawn = (this: unknown, input: { readonly task: string }, logLabel: string, sessionId?: string) => unknown;
const trySpawnAgent = Reflect.get(DaemonServer.prototype, 'trySpawnAgent') as TrySpawn;

function spawnFor(surfaceKinds: readonly string[]): string | undefined {
  let seen: string | undefined = 'unset';
  const host = {
    sessionBroker: { getSession: () => ({ surfaceKinds }) },
    agentManager: { spawn: () => { seen = currentTurnSurfaceId(); return { id: 'agent-1', task: 'work' }; } },
    syncSpawnedAgentTask: () => {},
    agentTaskAdapter: undefined,
  };
  trySpawnAgent.call(host, { task: 'work' }, 'test', 'session-1');
  return seen;
}

test('an agent spawned for a channel session runs under that channel surface', () => {
  expect(spawnFor(['tui', 'telegram'])).toBe('telegram');
});

test('an agent spawned for a local session runs under no channel surface', () => {
  expect(spawnFor(['tui'])).toBeUndefined();
});
