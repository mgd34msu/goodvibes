// Proves: A trigger's probe runs unattended, so it may call only a tool call that reads.
// Red when: ProbeToolHost.call runs a tool whose declaration writes.
// Proves: An unattended trigger's probe reads a file the owner denied.
// Red when: ProbeToolHost.call stops asking the registry's permission owner before it runs a reading tool, so a probe reads a file the owner's rules deny.
// Proves: An unattended trigger's http probe reaches a service on this machine or the cloud metadata address that the fetch tool refuses.
// Red when: The default probe effects send an http probe with a plain fetch instead of the fetch tool's host admission, so a loopback service answers it.
/**
 * A trigger's platform-tool probe runs unattended, so it may call only a tool
 * call that reads: a tool that writes is refused before it runs, and a reading
 * tool's output is what the check observes.
 *
 * Real tool registry and probe host; the two tools are minimal stand-ins.
 * A file probe's path is a subject of the trigger tool's create, so the
 * owner's path deny refuses it at the real gate (the trigger tool's body is a
 * stand-in that only counts). An http probe goes through the fetch tool's host
 * admission; a loopback server records whether anything arrived.
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
import { createDefaultProbeIo, type ProbeHostPolicy } from '../platform/src/platform/triggers/probes.ts';
import { TRIGGER_TOOL_DEFINITION } from '../platform/src/platform/triggers/trigger-tool.ts';
import { UserPermissionRuleStore } from '../platform/src/platform/permissions/user-rule-store.ts';
import { executeToolCalls } from '../platform/src/platform/core/orchestrator-tool-runtime.ts';

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

test('a trigger whose file probe names a file the owner denied is refused at create; one probing another file is created', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-probe-path-deny-')));
  try {
    const config = new ConfigManager({ configDir: join(root, 'config'), workingDir: root, surfaceRoot: 'goodvibes' });
    const rules = new UserPermissionRuleStore(':memory:');
    await rules.add({ rule: { id: 'no-secrets', type: 'path-scope', origin: 'user', effect: 'deny', toolPattern: '*', pathPatterns: [join(root, 'secrets')] }, tier: 'exact', createdAt: 1, tool: 'read' });
    let asked = 0;
    const manager = new PermissionManager(async () => { asked++; return { approved: true }; }, createPermissionConfigReader(config), new PolicyRuntimeState(), null, null, rules);
    const registry = new ToolRegistry(manager);
    const created: string[] = [];
    registry.register({ definition: TRIGGER_TOOL_DEFINITION, async execute(args) { created.push(JSON.stringify(args)); return { success: true, output: 'created' }; } });
    const deps = { permissionManager: manager, toolRegistry: registry, autonomousSource: () => ({ goal: 'Watch the project', criteria: [] }),
      hookDispatcher: null, runtimeBus: null, sessionId: 'probe-path', emitterContext: () => ({ sessionId: 'probe-path', traceId: 'probe-path', source: 'orchestrator' as const }) };
    const create = async (path: string) => (await executeToolCalls(deps, `turn-${path}`, [{ id: `call-${created.length}-${asked}`, name: 'trigger', arguments: {
      action: 'create', definition: { id: 'watch', spec: { kind: 'condition', probe: { kind: 'file', path }, rule: { op: 'changed' } } },
    } }]))[0]!;

    expect((await create(join(root, 'secrets', 'id_ed25519'))).success).toBe(false);
    expect({ created: created.length, asked }).toEqual({ created: 0, asked: 0 });
    // Control: a probe of a file the rule does not name reaches the owner, who approves it.
    expect((await create(join(root, 'status.txt'))).success).toBe(true);
    expect(created).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an http probe of this machine or the metadata address is refused unsent; with localhost allowed by the owner it is sent', async () => {
  const arrived: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) { arrived.push(request.url); return new Response('INTERNAL_SERVICE_TEXT'); } });
  try {
    const policy = (localhost: boolean): ProbeHostPolicy => ({ trustedHosts: () => undefined, blockedHosts: () => undefined, localhostAllowed: () => localhost, allowedPrivateHosts: () => [] });
    const strict = createDefaultProbeIo({ hostPolicy: policy(false) });
    for (const url of [`http://127.0.0.1:${server.port}/`, `http://localhost:${server.port}/`, `http://2130706433:${server.port}/`, 'http://169.254.169.254/latest/meta-data/']) {
      await expect(strict.fetch(url, {}, 2_000)).rejects.toThrow('Request blocked');
    }
    expect(arrived).toEqual([]);
    // Control: the owner's fetch.allowLocalhost lets the same probe through, so the refusals above are the host admission.
    const response = await createDefaultProbeIo({ hostPolicy: policy(true) }).fetch(`http://127.0.0.1:${server.port}/`, {}, 2_000);
    expect(await response.text()).toBe('INTERNAL_SERVICE_TEXT');
    expect(arrived).toHaveLength(1);
  } finally { await server.stop(true); }
});
