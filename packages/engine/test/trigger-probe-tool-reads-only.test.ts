/**
 * A trigger's platform-tool probe runs unattended, so it may call only a tool
 * call that reads: a tool that writes is refused before it runs, and a reading
 * tool's output is what the check observes.
 *
 * Real tool registry and probe host; the two tools are minimal stand-ins.
 */
import { expect, test } from 'bun:test';
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

test('a probe with a reading tool observes its output', async () => {
  const calls: string[] = [];
  const host = new ProbeToolHost();
  host.attach(registryWith(calls), () => 'session-1');
  expect(host.refusal('note_read', { path: 'a' }, 'session-1')).toBeUndefined();
  expect(await host.call('note_read', { path: 'a' }, 1_000, 'session-1')).toBe('ready');
  expect(calls).toEqual(['note_read']);
});
