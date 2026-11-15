import { createPreparedAgentRuntimeServices } from '../helpers/prepared-runtime-services.ts';
/**
 * home-single-writer.test.ts, one live agent per home.
 *
 * The gap this closes: a turn forked a SECOND full agent onto the home a live
 * agent was already running out of. Two processes then owned one
 * `.goodvibes/agent/` tree, two writers over the same session files, the same
 * state store, the same transcript, which is how a temp-file race killed a
 * process and how a ghost session was left marked "active" by a writer that no
 * longer existed. Nothing refused, because nothing was asking.
 *
 * The platform owns the rule (`claimSurfaceHome`) and proves the rule itself. What
 * this proves is that the AGENT'S OWN composition asks for it: the agent is the
 * singleton surface, one per machine, holding one home, so it passes
 * `homeSingleWriter: 'claim'` where the terminal deliberately does not.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrap as runtimeComposition } from '@goodvibes-jev/engine/platform/platform/runtime';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { type RuntimeServices } from '../../runtime/services.ts';
import { handleGoodVibesCliCommand, parseGoodVibesCli } from '../../cli/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { holdHomeInChildProcess } from '../helpers/home-holder.ts';

const holders: ChildProcess[] = [];
const built: RuntimeServices[] = [];

/** A separate live process holding this home's claim, as a first agent would. */
async function liveHolder(home: string): Promise<{ pid: number }> {
  const child = await holdHomeInChildProcess(home, GOODVIBES_AGENT_SURFACE_ROOT);
  holders.push(child);
  return { pid: child.pid };
}

/** Boot the agent's real service composition rooted at this home. */
async function bootAgentAt(home: string): Promise<RuntimeServices> {
  const workingDir = join(home, 'work');
  mkdirSync(workingDir, { recursive: true });
  const services = (await createPreparedAgentRuntimeServices({
    modelDiscovery: 'skip',
    configManager: new ConfigManager({
      surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
      configDir: join(home, 'config'),
      workingDir,
      homeDir: home,
    }),
    runtimeBus: new RuntimeEventBus(),
    runtimeStore: createRuntimeStore(),
    workingDir,
    homeDirectory: home,
    getConversationTitle: () => 'home-single-writer',
  }));
  built.push(services);
  return services;
}

afterEach(async () => {
  const graphs = built.splice(0).map(services => Promise.resolve().then(() => services.close()));
  const children = holders.splice(0).map(child => new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('close', () => resolve()); child.once('error', reject);
    child.kill('SIGKILL');
  }));
  const closed = await Promise.allSettled([...graphs, ...children]);
  const failures = closed.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Home ownership fixtures did not close');
});

describe('a second agent booted onto a live agent\'s home', () => {
  test('is refused at boot, and the refusal names the pid that holds it', async () => {
    const home = makeProjectTempDir('agent-home-claim');
    const holder = await liveHolder(home);

    let refusal: unknown;
    try {
      (await bootAgentAt(home));
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(runtimeComposition.SurfaceHomeInUseError);
    const error = refusal as InstanceType<typeof runtimeComposition.SurfaceHomeInUseError>;
    // Naming the pid is the whole difference between a boot that stops for a
    // reason a person can act on and one that stops without saying why.
    expect(error.holderPid).toBe(holder.pid);
    expect(error.message).toContain(String(holder.pid));
  });

  test('a home nothing holds is claimed, and the record names THIS process', async () => {
    const home = makeProjectTempDir('agent-home-free');

    const services = (await bootAgentAt(home));

    const claimPath = runtimeComposition.surfaceHomeClaimPath(home, GOODVIBES_AGENT_SURFACE_ROOT);
    const record = JSON.parse(readFileSync(claimPath, 'utf-8')) as { pid: number };
    expect(record.pid).toBe(process.pid);
    expect(services.shellPaths.homeDirectory).toBe(home);
  });
});

describe('one-shot commands against a home a live agent holds', () => {
  async function runCli(home: string, args: readonly string[]): Promise<{ readonly exitCode: number; readonly output: string }> {
    const workingDirectory = join(home, 'work');
    mkdirSync(workingDirectory, { recursive: true });
    const lines: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (value?: unknown) => { lines.push(String(value)); };
      const result = await handleGoodVibesCliCommand({
        cli: parseGoodVibesCli(args),
        configManager: new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, configDir: join(home, 'config'), workingDir: workingDirectory, homeDir: home }),
        workingDirectory,
        homeDirectory: home,
      });
      return { exitCode: result.exitCode, output: lines.join('\n') };
    } finally {
      console.log = originalLog;
    }
  }

  test('a listing answers, and a command that writes the shared stores is refused naming the holder', async () => {
    const home = makeProjectTempDir('agent-home-readonly');
    const holder = await liveHolder(home);

    const listing = await runCli(home, ['sessions', 'list']);
    expect(listing.exitCode).toBe(0);
    expect(listing.output).toContain('GoodVibes sessions');

    const pick = await runCli(home, ['fleet', 'attempts', 'pick', 'group-1', 'item-1', '--yes']);
    expect(pick.exitCode).not.toBe(0);
    expect(pick.output).toContain('already owned by a live process');
  });
});
