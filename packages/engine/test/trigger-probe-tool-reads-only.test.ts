// Proves: A trigger's probe runs unattended, so it may call only a tool call that reads.
// Red when: ProbeToolHost.call runs a tool whose declaration writes.
// Proves: An unattended trigger's probe reads a file the owner denied.
// Red when: ProbeToolHost.call stops asking the registry's permission owner before it runs a reading tool, so a probe reads a file the owner's rules deny.
/**
 * A trigger's platform-tool probe runs unattended, so it may call only a tool
 * call that reads: a tool that writes is refused before it runs, and a reading
 * tool's output is what the check observes.
 *
 * Real tool registry and probe host; the two tools are minimal stand-ins.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { createPermissionConfigReader, PermissionManager } from '../platform/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { ProjectIndex } from '../platform/src/platform/state/project-index.ts';
import { ReadTool } from '../platform/src/platform/tools/read/index.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
import { ProbeToolHost } from '../platform/src/platform/triggers/probe-tools.ts';

function registryWith(calls: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  const parameters = { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false };
  registry.register({
    definition: { name: 'note_write', description: 'Writes a note.', parameters, category: 'write', sideEffects: ['write_fs'] },
    async execute() { calls.push('note_write'); return { success: true, output: 'written' }; },
  });
  registry.register({
    definition: { name: 'note_read', description: 'Reads a note.', parameters, category: 'read', sideEffects: ['read_fs'] },
    async execute() { calls.push('note_read'); return { success: true, output: 'ready' }; },
  });
  return registry;
}

test('a probe that names a writing tool is refused and the tool never runs', async () => {
  const calls: string[] = [];
  const host = new ProbeToolHost();
  host.attach(registryWith(calls), () => 'session-1');
  expect(host.refusal('note_write', { path: 'a' }, 'session-1')).toContain('does not only read');
  await expect(host.call('note_write', { path: 'a' }, 1_000, 'session-1')).rejects.toThrow('does not only read');
  expect(calls).toEqual([]);
});

test('a probe that reads a file the owner denied is refused; the same probe reads it before the denial', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-probe-deny-')));
  try {
    writeFileSync(join(root, 'private.txt'), 'PRIVATE_PROBE_TEXT\n');
    const config = new ConfigManager({ configDir: join(root, 'config'), workingDir: root, surfaceRoot: 'goodvibes' });
    let asked = 0;
    const manager = new PermissionManager(async () => { asked++; return { approved: true }; }, createPermissionConfigReader(config), new PolicyRuntimeState());
    const registry = new ToolRegistry(manager);
    registry.register(new ReadTool(new ProjectIndex(root)));
    const host = new ProbeToolHost();
    host.attach(registry, () => 'session-1');
    const probe = { files: [{ path: 'private.txt' }] };
    expect(String(await host.call('read', probe, 2_000, 'session-1'))).toContain('PRIVATE_PROBE_TEXT');
    config.set('permissions.tools.read', 'deny');
    await expect(host.call('read', probe, 2_000, 'session-1')).rejects.toThrow("The owner's rules do not let");
    expect(asked).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
