import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sessionModule from '../platform/src/platform/runtime/sandbox/session-registry.js';
import { SandboxSessionRegistry } from '../platform/src/platform/runtime/sandbox/session-registry.js';
import type { SandboxSession } from '../platform/src/platform/runtime/sandbox/types.js';

const workspaces: string[] = [];
afterEach(() => { for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-session-'));
  workspaces.push(dir);
  return dir;
}

/** A session placed straight into the registry's table, so no backend has to start. */
function seeded(
  state: SandboxSession['state'],
  extra: { readonly profileId?: string; readonly shared?: boolean } = {},
): { registry: SandboxSessionRegistry; id: string } {
  const root = workspace();
  const registry = new SandboxSessionRegistry(root);
  const session = Object.freeze({
    id: 's1', profileId: extra.profileId ?? 'p', kind: 'eval', label: 'x', shared: extra.shared ?? false, startedAt: 1, state,
    backend: 'local', resolvedBackend: 'local',
    launchPlan: { backend: 'local', command: 'true', args: [], workspaceRoot: root, summary: 's' },
    startupStatus: 'planned', startupDetail: '', notes: [],
  }) as unknown as SandboxSession;
  (registry as unknown as { sessions: Map<string, SandboxSession> }).sessions.set('s1', session);
  return { registry, id: 's1' };
}

describe('sandbox session lifecycle', () => {
  test('execute on a stopped session is refused with the lifecycle reason and leaves it stopped', async () => {
    const { registry, id } = seeded('stopped');
    await expect(registry.execute(id, 'bash', ['-lc', 'true'])).rejects.toThrow(/final|stopped/);
    expect(registry.get(id)?.state).toBe('stopped');
    expect(registry.get(id)?.executionCount).toBeUndefined();
  });

  test('stop returns the stopped record and removes the session; a later stop or command finds nothing', async () => {
    const { registry, id } = seeded('running');
    expect(registry.stop(id)?.state).toBe('stopped');
    expect(registry.list()).toHaveLength(0);
    expect(registry.stop(id)).toBeNull();
    await expect(registry.execute(id, 'bash', ['-lc', 'exit 3'])).rejects.toThrow();
  });

  test('execute runs asynchronously and returns the command output, input and exit status', async () => {
    const { registry, id } = seeded('running');
    const pending = registry.execute(id, 'bash', ['-lc', 'cat; echo err >&2; exit 4'], { input: 'hello' });
    expect(pending).toBeInstanceOf(Promise);
    const result = await pending;
    expect(result).toEqual({ status: 4, stdout: 'hello', stderr: 'err\n' });
    expect(registry.get(id)?.executionCount).toBe(1);
  });

  test('a command that cannot start reports no exit status and the reason', async () => {
    const { registry, id } = seeded('running');
    const result = await registry.execute(id, 'definitely-not-a-command-xyz', []);
    expect(result.status).toBeNull();
    expect(result.stderr).toContain('definitely-not-a-command-xyz');
  });

  test('declares the table', () => {
    const lifecycle = (sessionModule as unknown as { sandboxSessionLifecycle?: { isTerminal(s: string): boolean } }).sandboxSessionLifecycle;
    expect(lifecycle?.isTerminal('stopped')).toBe(true);
  });
});

describe('shared sandbox sessions', () => {
  // `mcp-shared` is the shared profile; the local backend needs no VM.
  const config = { get: (key: string): unknown => ({ 'sandbox.vmBackend': 'local' } as Record<string, unknown>)[key] };
  const shared = { profileId: 'mcp-shared', shared: true } as const;

  test('one holder stopping a shared session leaves it running for the others', async () => {
    const { registry, id } = seeded('running', shared);
    const second = await registry.start('mcp-shared', undefined, config);
    expect(second.id).toBe(id);
    expect(registry.list()).toHaveLength(1);

    expect(registry.stop(id)?.state).not.toBe('stopped');
    expect(registry.get(id)?.state).not.toBe('stopped');
    expect(registry.stop(id)?.state).toBe('stopped');
  });

  test('two concurrent starts of one shared profile share one session and both must stop it', async () => {
    const registry = new SandboxSessionRegistry(workspace());
    const [a, b] = await Promise.all([
      registry.start('mcp-shared', undefined, config),
      registry.start('mcp-shared', undefined, config),
    ]);
    expect(b.id).toBe(a.id);
    expect(registry.list()).toHaveLength(1);
    expect(registry.stop(a.id)?.state).not.toBe('stopped');
    expect(registry.stop(a.id)?.state).toBe('stopped');
  });

  test('a shared session whose last command failed is reused, not duplicated', async () => {
    const { registry, id } = seeded('failed', shared);
    const again = await registry.start('mcp-shared', undefined, config);
    expect(again.id).toBe(id);
    expect(registry.list()).toHaveLength(1);
  });

  test('a stopped shared session is not handed out again', async () => {
    const { registry, id } = seeded('stopped', shared);
    const next = await registry.start('mcp-shared', undefined, config);
    expect(next.id).not.toBe(id);
  });

  test('inspecting a file that is not a session artifact names the problem', () => {
    const registry = new SandboxSessionRegistry(workspace());
    const path = join(workspace(), 'a.json');
    writeFileSync(path, JSON.stringify({ hello: 'world' }));
    expect(() => registry.inspectArtifact(path)).toThrow(/not a sandbox session artifact/);
  });
});
