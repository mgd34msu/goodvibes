/**
 * home-single-writer.test.ts, one live process per surface home.
 *
 * The defect: a turn forked a SECOND agent onto the home a live agent was
 * already running out of, and two writers over one `.goodvibes/agent/` tree
 * produced a process-killing temp-file race and a session left marked "active"
 * by a writer that no longer existed.
 *
 * The claim is a kernel lock held for the life of the process, so the cases
 * that matter need real processes: a second one is refused naming the first,
 * and a killed holder frees the home with nothing left to clean up.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimSurfaceHome,
  surfaceHomeClaimPath,
  type HomeOwnerClaim,
} from '../platform/src/platform/runtime/home-single-writer.ts';
import { createClientRuntimeServices } from '../platform/src/platform/runtime/client-services.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.ts';

const MODULE = new URL('../platform/src/platform/runtime/home-single-writer.ts', import.meta.url).href;
const HOLD_SCRIPT = `
  const { claimSurfaceHome } = await import(process.argv[1]);
  try {
    claimSurfaceHome({ homeDirectory: process.argv[2], surfaceRoot: 'agent' });
    console.log('acquired');
    setInterval(() => {}, 1000);
  } catch (error) { console.log(error && error.name === 'SurfaceHomeInUseError' ? 'refused ' + error.holderPid : 'error: ' + error); }
`;

describe('claimSurfaceHome', () => {
  const roots: string[] = [];
  const newHome = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'gv-home-claim-'));
    roots.push(root);
    return root;
  };
  const spawnHolder = (home: string) => Bun.spawn(['bun', '-e', HOLD_SCRIPT, MODULE, home], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const firstLine = async (child: ReturnType<typeof spawnHolder>): Promise<string> => {
    const reader = child.stdout.getReader();
    try { return new TextDecoder().decode((await reader.read()).value).trim(); } finally { reader.releaseLock(); }
  };

  test('simultaneous processes cannot both acquire an empty home', async () => {
    const home = newHome();
    const children = Array.from({ length: 6 }, () => Bun.spawn(['bun', '-e', `
      const { claimSurfaceHome } = await import(process.argv[1]);
      console.log('ready');
      await new Promise(resolve => process.stdin.once('data', resolve));
      try {
        claimSurfaceHome({ homeDirectory: process.argv[2], surfaceRoot: 'agent' });
        console.log('acquired');
        setInterval(() => {}, 1000);
      } catch (error) { console.log(error && error.name === 'SurfaceHomeInUseError' ? 'refused' : 'error: ' + error); }
    `, MODULE, home], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }));
    const readers = children.map(child => child.stdout.getReader());
    try {
      await Promise.all(readers.map(async reader => expect(new TextDecoder().decode((await reader.read()).value)).toContain('ready')));
      for (const child of children) child.stdin.write('start\n');
      const results = await Promise.all(readers.map(async reader => new TextDecoder().decode((await reader.read()).value).trim()));
      expect(results.filter(value => value === 'acquired')).toHaveLength(1);
      expect(results.filter(value => value === 'refused')).toHaveLength(5);
      const winner = children[results.indexOf('acquired')]!;
      expect((JSON.parse(readFileSync(surfaceHomeClaimPath(home, 'agent'), 'utf8')) as HomeOwnerClaim).pid).toBe(winner.pid);
    } finally {
      for (const child of children) child.kill();
      await Promise.all(children.map(child => child.exited));
      for (const reader of readers) reader.releaseLock();
    }
  });

  test('a second process is refused naming the first; once the first is killed the home is free', async () => {
    const home = newHome();
    const first = spawnHolder(home);
    let second: ReturnType<typeof spawnHolder> | undefined;
    let third: ReturnType<typeof spawnHolder> | undefined;
    try {
      expect(await firstLine(first)).toBe('acquired');
      second = spawnHolder(home);
      expect((await new Response(second.stdout).text()).trim()).toBe(`refused ${first.pid}`);
      first.kill('SIGKILL');
      await first.exited;
      third = spawnHolder(home);
      expect(await firstLine(third)).toBe('acquired');
    } finally {
      for (const child of [first, second, third]) child?.kill();
      await Promise.all([first.exited, second?.exited, third?.exited]);
    }
  });

  test('claiming an empty home writes an owner record, and release removes it', () => {
    const home = newHome();
    const held = claimSurfaceHome({ homeDirectory: home, surfaceRoot: 'agent', now: () => 123 });
    const onDisk = JSON.parse(readFileSync(held.path, 'utf-8')) as HomeOwnerClaim;
    expect(onDisk).toMatchObject({ pid: process.pid, claimedAt: 123 });
    held.release();
    expect(existsSync(held.path)).toBe(false);
  });

  test('several holders in ONE process: the claim stands until the last release', () => {
    const home = newHome();
    const first = claimSurfaceHome({ homeDirectory: home, surfaceRoot: 'daemon' });
    const second = claimSurfaceHome({ homeDirectory: home, surfaceRoot: 'daemon' });
    first.release();
    expect(existsSync(first.path)).toBe(true);
    second.release();
    expect(existsSync(first.path)).toBe(false);
  });

  test('a different surface is a different home', () => {
    const home = newHome();
    const agent = claimSurfaceHome({ homeDirectory: home, surfaceRoot: 'agent' });
    const tui = claimSurfaceHome({ homeDirectory: home, surfaceRoot: 'tui' });
    expect(tui.path).toBe(surfaceHomeClaimPath(home, 'tui'));
    agent.release();
    tui.release();
  });

  test('cleanup', () => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    expect(roots).toHaveLength(0);
  });
});

// ── The composition wiring ──────────────────────────────────────────────────

/**
 * The guard existing and a composition USING it are two claims. A wiring that
 * silently stops claiming would leave every unit test above passing.
 */
describe('createClientRuntimeServices homeSingleWriter', () => {
  const roots: string[] = [];
  const compose = (homeSingleWriter?: 'claim' | 'off') => {
    const home = mkdtempSync(join(tmpdir(), 'gv-home-claim-wiring-'));
    roots.push(home);
    const workingDir = join(home, 'work');
    mkdirSync(workingDir, { recursive: true });
    const services = createClientRuntimeServices({
      configManager: new ConfigManager({
        surfaceRoot: 'agent', configDir: join(home, 'cfg'), workingDir, homeDir: home,
      }),
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      surfaceRoot: 'agent',
      workingDir,
      homeDirectory: home,
      requestApproval: async () => ({ approved: true }),
      modelDiscovery: 'skip',
      ...(homeSingleWriter === undefined ? {} : { homeSingleWriter }),
    });
    return { home, services, claimPath: surfaceHomeClaimPath(home, 'agent') };
  };

  test("'claim' records this process as the home's owner, and dispose gives it back", async () => {
    const { services, claimPath } = compose('claim');
    const record = JSON.parse(readFileSync(claimPath, 'utf-8')) as HomeOwnerClaim;
    expect(record.pid).toBe(process.pid);
    await services.close();
    expect(existsSync(claimPath)).toBe(false);
  });

  test('the default claims nothing: a terminal is legitimately run twice', async () => {
    const { services, claimPath } = compose();
    expect(existsSync(claimPath)).toBe(false);
    await services.close();
  });

  test('cleanup', () => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    expect(roots).toHaveLength(0);
  });
});
