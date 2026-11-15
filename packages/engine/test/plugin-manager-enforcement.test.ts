/**
 * Plugin manager guarantees an operator relies on: a quarantined plugin stops
 * running and stays unloaded, a failed cleanup does not wedge later lifecycle
 * calls, lifecycle calls do not interleave, a decision that could not be saved
 * is not reported as applied, and an enabled flag belongs to the directory it
 * was given for.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverPlugins, type PluginLoaderDeps } from '../platform/src/platform/plugins/loader.ts';
import { PluginManager } from '../platform/src/platform/plugins/manager.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';

interface Probe {
  inits: number;
  /** Resolve to let a held init finish. */
  holdInit?: Promise<void> | undefined;
  /** Called when an init begins. */
  onInit?: (() => void) | undefined;
  failCleanup: boolean;
  failInit: boolean;
}

const probes = new Map<string, Probe>();
(globalThis as unknown as { __pluginEnforcement: Map<string, Probe> }).__pluginEnforcement = probes;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { probes.delete(root); rmSync(root, { recursive: true, force: true }); } });

function pluginSource(root: string, label: string): string {
  return `
const probe = globalThis.__pluginEnforcement.get(${JSON.stringify(root)});
export async function init(api) {
  probe.inits++;
  if (probe.onInit) probe.onInit();
  if (probe.holdInit) await probe.holdInit;
  api.registerTool('who', { type: 'object', description: ${JSON.stringify(label)} }, async () => ({ success: true, output: ${JSON.stringify(label)} }));
  if (probe.failCleanup) api.registerCommand('boom', 'boom', () => {});
  if (probe.failInit) throw new Error('init failed');
}
`;
}

function writePlugin(root: string, where: 'project' | 'home', name: string, label: string, manifest: Record<string, unknown> = {}) {
  const dir = where === 'project'
    ? join(root, 'project', '.goodvibes', 'plugins', name)
    : join(root, 'home', '.goodvibes', 'plugins', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name, version: '1.0.0', description: label, ...manifest }));
  writeFileSync(join(dir, 'index.js'), pluginSource(root, label));
  return dir;
}

function setup(options: { stateFilePath?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'plugin-enforcement-'));
  roots.push(root);
  mkdirSync(join(root, 'project'), { recursive: true });
  mkdirSync(join(root, 'home'), { recursive: true });
  const probe: Probe = { inits: 0, failCleanup: false, failInit: false };
  probes.set(root, probe);
  const toolRegistry = new ToolRegistry();
  const deps = {
    runtimeBus: { on: () => () => undefined },
    commandRegistry: {
      register: () => undefined,
      unregister: () => { if (probe.failCleanup) throw new Error('unregister failed'); },
    },
    toolRegistry,
    getPluginConfig: () => ({}),
    isEnabled: () => true,
  } as unknown as PluginLoaderDeps;
  const stateFilePath = options.stateFilePath ?? join(root, 'state.json');
  const manager = new PluginManager({ pathOptions: { cwd: join(root, 'project'), homeDir: join(root, 'home') }, stateFilePath });
  return { root, probe, toolRegistry, deps, manager, stateFilePath };
}

describe('quarantine', () => {
  test('stops a running plugin and keeps it unloaded across reloads', async () => {
    const fx = setup();
    writePlugin(fx.root, 'project', 'quiet', 'quiet');
    await fx.manager.init(fx.deps);
    expect((await fx.manager.enable('quiet')).ok).toBe(true);
    expect(fx.toolRegistry.has('plugin_quiet_who')).toBe(true);

    const result = fx.manager.quarantine('quiet', 'misbehaving');
    expect(result.ok).toBe(true);
    await result.unloading;
    expect(fx.toolRegistry.has('plugin_quiet_who')).toBe(false);
    expect(fx.manager.list()[0]).toMatchObject({ name: 'quiet', quarantined: true, active: false });

    const summary = await fx.manager.reload();
    expect(summary.reloaded).toBe(0);
    expect(summary.quarantined).toEqual(['quiet']);
    expect(fx.toolRegistry.has('plugin_quiet_who')).toBe(false);

    // A restart reads the saved quarantine and does not load it either.
    const restarted = new PluginManager({ pathOptions: { cwd: join(fx.root, 'project'), homeDir: join(fx.root, 'home') }, stateFilePath: fx.stateFilePath });
    const before = fx.probe.inits;
    await restarted.init({ ...fx.deps, inFlight: undefined } as PluginLoaderDeps);
    expect(fx.probe.inits).toBe(before);
    expect(fx.toolRegistry.has('plugin_quiet_who')).toBe(false);
    await restarted.close();
  });

  test('lifting it and reloading loads the plugin again; enable of a quarantined plugin names the next step', async () => {
    const fx = setup();
    writePlugin(fx.root, 'project', 'quiet', 'quiet');
    await fx.manager.init(fx.deps);
    await fx.manager.enable('quiet');
    await fx.manager.quarantine('quiet', 'x').unloading;
    await fx.manager.disable('quiet');
    const refused = await fx.manager.enable('quiet');
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('lift the quarantine');

    expect(fx.manager.liftQuarantine('quiet').ok).toBe(true);
    expect((await fx.manager.enable('quiet')).ok).toBe(true);
    expect(fx.toolRegistry.has('plugin_quiet_who')).toBe(true);
  });
});

describe('quarantine during a slow start', () => {
  test('a plugin still initialising when it is quarantined is unloaded once it has started', async () => {
    const fx = setup();
    writePlugin(fx.root, 'project', 'slow', 'slow');
    await fx.manager.init(fx.deps);
    let release: () => void = () => undefined;
    fx.probe.holdInit = new Promise<void>((resolve) => { release = resolve; });

    const started = new Promise<void>((resolve) => { fx.probe.onInit = resolve; });
    const enabling = fx.manager.enable('slow');
    await started;
    const result = fx.manager.quarantine('slow', 'misbehaving');
    expect(result.ok).toBe(true);
    release();
    await enabling;
    await result.unloading;

    expect(fx.toolRegistry.has('plugin_slow_who')).toBe(false);
    expect(fx.manager.list()[0]).toMatchObject({ name: 'slow', quarantined: true, active: false });
  });
});

describe('cleanup failure', () => {
  test('a plugin whose cleanup throws does not block later reloads or disable', async () => {
    const fx = setup();
    writePlugin(fx.root, 'project', 'a-first', 'a-first');
    writePlugin(fx.root, 'project', 'b-flaky', 'b-flaky');
    await fx.manager.init(fx.deps);
    await fx.manager.enable('a-first');
    await fx.manager.enable('b-flaky');
    fx.probe.failCleanup = true;

    const first = await fx.manager.reload();
    // Both plugins register the throwing command cleanup on their new instance.
    expect(first.cleanupFailed ?? []).toEqual([]);
    expect(first.reloaded).toBe(2);

    // The second reload unloads instances whose cleanup throws: it still
    // reloads everything and names the plugins instead of rejecting.
    const second = await fx.manager.reload();
    expect(second.reloaded).toBe(2);
    expect([...(second.cleanupFailed ?? [])].sort()).toEqual(['a-first', 'b-flaky']);

    // Disable of a stuck plugin completes its state change, then reports the cleanup error once.
    fx.probe.failCleanup = true;
    await expect(fx.manager.disable('a-first')).rejects.toThrow('cleanup did not complete');
    expect(fx.manager.isEnabled('a-first')).toBe(false);
    expect(fx.manager.list().find((p) => p.name === 'a-first')?.active).toBe(false);
    fx.probe.failCleanup = false;
    expect((await fx.manager.enable('a-first')).ok).toBe(true);
  });

  test('enable of a plugin whose init and cleanup both throw returns not-ok and leaves it disabled', async () => {
    const fx = setup();
    writePlugin(fx.root, 'project', 'broken', 'broken');
    await fx.manager.init(fx.deps);
    fx.probe.failInit = true;
    fx.probe.failCleanup = true;
    const result = await fx.manager.enable('broken');
    expect(result.ok).toBe(false);
    expect(fx.manager.isEnabled('broken')).toBe(false);
  });
});

describe('lifecycle ordering', () => {
  test('a reload asked for during a slow enable waits for it and loads one instance', async () => {
    const fx = setup();
    writePlugin(fx.root, 'project', 'slow', 'slow');
    await fx.manager.init(fx.deps);
    let release!: () => void;
    fx.probe.holdInit = new Promise<void>((resolve) => { release = resolve; });

    const enabling = fx.manager.enable('slow');
    const reloading = fx.manager.reload();
    for (let turn = 0; turn < 1000 && fx.probe.inits < 1; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
    // Only the enable has started loading; the reload has not begun a second load.
    expect(fx.probe.inits).toBe(1);
    release();
    expect((await enabling).ok).toBe(true);
    const summary = await reloading;
    expect(summary.reloaded).toBe(1);
    // One instance per lifecycle call, and exactly one tool handler registered.
    expect(fx.probe.inits).toBe(2);
    expect(fx.toolRegistry.list().filter((t) => t.definition.name === 'plugin_slow_who')).toHaveLength(1);
  });
});

describe('state that could not be saved', () => {
  test('trust, quarantine and enable are refused instead of reported as applied', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-enforcement-state-'));
    roots.push(root);
    // The parent of the state file is a regular file, so every write fails.
    writeFileSync(join(root, 'not-a-directory'), '');
    const fx = setup({ stateFilePath: join(root, 'not-a-directory', 'state.json') });
    writePlugin(fx.root, 'project', 'quiet', 'quiet');
    await fx.manager.init(fx.deps);

    const trust = fx.manager.trust('quiet', 'limited');
    expect(trust.ok).toBe(false);
    expect(trust.error).toContain('not saved');
    expect(fx.manager.getTrustRecord('quiet')).toBeUndefined();

    const quarantine = fx.manager.quarantine('quiet', 'x');
    expect(quarantine.ok).toBe(false);
    expect(fx.manager.list()[0]?.quarantined).toBe(false);

    const enable = await fx.manager.enable('quiet');
    expect(enable.ok).toBe(false);
    expect(fx.manager.isEnabled('quiet')).toBe(false);
    expect(fx.toolRegistry.has('plugin_quiet_who')).toBe(false);
  });
});

describe('disable that could not be saved', () => {
  test('disable stops the plugin but does not report success when the state file cannot be written', async () => {
    const fx = setup();
    writePlugin(fx.root, 'project', 'quiet', 'quiet');
    await fx.manager.init(fx.deps);
    expect((await fx.manager.enable('quiet')).ok).toBe(true);
    expect(fx.toolRegistry.has('plugin_quiet_who')).toBe(true);

    // A directory where the state file belongs makes the next write fail.
    rmSync(fx.stateFilePath, { force: true });
    mkdirSync(fx.stateFilePath);
    const result = await fx.manager.disable('quiet');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('enabled again on restart');
    expect(fx.toolRegistry.has('plugin_quiet_who')).toBe(false);
  });
});

describe('enabled flag and directory', () => {
  test('a repository copy of a plugin enabled from the home directory is not loaded', async () => {
    const fx = setup();
    writePlugin(fx.root, 'home', 'shared', 'home-copy');
    await fx.manager.init(fx.deps);
    expect((await fx.manager.enable('shared')).ok).toBe(true);
    await fx.manager.close();

    // A repository opened later ships its own plugin of the same name; it is found first.
    writePlugin(fx.root, 'project', 'shared', 'repo-copy');
    const restarted = new PluginManager({ pathOptions: { cwd: join(fx.root, 'project'), homeDir: join(fx.root, 'home') }, stateFilePath: fx.stateFilePath });
    await restarted.init({ ...fx.deps, inFlight: undefined } as PluginLoaderDeps);
    const tool = fx.toolRegistry.list().find((t) => t.definition.name === 'plugin_shared_who');
    expect(tool?.definition.description).toBe('home-copy');
    await restarted.close();
  });
});

describe('enable recorded before directories were kept', () => {
  test('a copy inside the repository is not run, and the owner\'s own copy is', async () => {
    const fx = setup();
    writePlugin(fx.root, 'home', 'shared', 'home-copy');
    writePlugin(fx.root, 'project', 'shared', 'repo-copy');
    writeFileSync(fx.stateFilePath, JSON.stringify({ enabled: { shared: true }, config: {}, trust: {}, quarantine: {} }));
    const manager = new PluginManager({ pathOptions: { cwd: join(fx.root, 'project'), homeDir: join(fx.root, 'home') }, stateFilePath: fx.stateFilePath });
    await manager.init(fx.deps);
    expect(fx.toolRegistry.list().find((t) => t.definition.name === 'plugin_shared_who')?.definition.description).toBe('home-copy');
    await manager.close();
  });

  test('a plugin that exists only in the repository stays unloaded until it is enabled again', async () => {
    const fx = setup();
    writePlugin(fx.root, 'project', 'solo', 'repo-copy');
    writeFileSync(fx.stateFilePath, JSON.stringify({ enabled: { solo: true }, config: {}, trust: {}, quarantine: {} }));
    const manager = new PluginManager({ pathOptions: { cwd: join(fx.root, 'project'), homeDir: join(fx.root, 'home') }, stateFilePath: fx.stateFilePath });
    await manager.init(fx.deps);
    expect(fx.toolRegistry.has('plugin_solo_who')).toBe(false);
    expect((await manager.enable('solo')).ok).toBe(true);
    expect(fx.toolRegistry.has('plugin_solo_who')).toBe(true);
    await manager.close();
  });
});

describe('manifest names', () => {
  test('a name with a space or a dot is not discovered', () => {
    const fx = setup();
    writePlugin(fx.root, 'project', 'spaced', 'x', { name: 'My Plugin' });
    writePlugin(fx.root, 'project', 'dotted', 'x', { name: 'a.b' });
    writePlugin(fx.root, 'project', 'fine', 'x', { name: 'fine-1' });
    expect(discoverPlugins({ cwd: join(fx.root, 'project'), homeDir: join(fx.root, 'home') }).map((p) => p.manifest.name)).toEqual(['fine-1']);
  });
});
