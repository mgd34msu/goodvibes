import { describe, expect, test } from 'bun:test';
import * as sessionModule from '../platform/src/platform/runtime/sandbox/session-registry.js';
import { SandboxSessionRegistry } from '../platform/src/platform/runtime/sandbox/session-registry.js';
import type { SandboxSession } from '../platform/src/platform/runtime/sandbox/types.js';

function seeded(state: SandboxSession['state']): { registry: SandboxSessionRegistry; id: string } {
  const registry = new SandboxSessionRegistry('/tmp');
  const session = Object.freeze({
    id: 's1', profileId: 'p', kind: 'eval', label: 'x', shared: false, startedAt: 1, state,
    backend: 'local', resolvedBackend: 'local',
    launchPlan: { backend: 'local', command: 'true', args: [], workspaceRoot: '/tmp', summary: 's' },
    startupStatus: 'verified', startupDetail: '', notes: [],
  }) as unknown as SandboxSession;
  (registry as unknown as { sessions: Map<string, SandboxSession> }).sessions.set('s1', session);
  return { registry, id: 's1' };
}

describe('sandbox session lifecycle', () => {
  test('execute on a stopped session is refused with the lifecycle reason and leaves it stopped', () => {
    const { registry, id } = seeded('stopped');
    expect(() => registry.execute(id, 'bash', ['-lc', 'true'])).toThrow(/final|stopped/);
    expect(registry.get(id)?.state).toBe('stopped');
    expect(registry.get(id)?.executionCount).toBeUndefined();
  });

  test('stop is idempotent and a stopped session never fails from a later non-zero exit', () => {
    const { registry, id } = seeded('running');
    registry.stop(id);
    expect(registry.stop(id)?.state).toBe('stopped');
    expect(() => registry.execute(id, 'bash', ['-lc', 'exit 3'])).toThrow();
    expect(registry.get(id)?.state).toBe('stopped');
  });

  test('declares the table', () => {
    const lifecycle = (sessionModule as unknown as { sandboxSessionLifecycle?: { isTerminal(s: string): boolean } }).sandboxSessionLifecycle;
    expect(lifecycle?.isTerminal('stopped')).toBe(true);
  });
});
