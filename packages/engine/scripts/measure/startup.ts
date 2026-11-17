/**
 * Start-up timing: spawn each product's source entry with bun in an isolated
 * home and time from spawn to exit (or, for the daemon, to its ready line).
 * The preload refuses every network attempt (loopback is allowed only for the
 * daemon, which must bind its own listener).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface StartupScenario {
  readonly name: string;
  /** Path of the source entry, relative to the repository root. */
  readonly entry: string;
  readonly args: readonly string[] | ((port: number) => readonly string[]);
  /** A line on stdout that means ready; absent means "the process exited". */
  readonly readyPattern?: RegExp;
  readonly allowLoopback?: boolean;
  /** What the output must show for the run to count as a success. */
  readonly expect?: RegExp;
  readonly note: string;
}

export interface StartupReport {
  readonly name: string;
  readonly command: string;
  readonly wallMs: { readonly median: number; readonly min: number; readonly max: number; readonly samples: readonly number[] };
  readonly exitCodes: readonly (number | null)[];
  readonly note?: string;
  readonly error?: string;
}

const RUNS = 3;

export const STARTUP_SCENARIOS: readonly StartupScenario[] = [
  { name: 'startup-bun-floor', entry: 'packages/engine/scripts/measure/instrument.ts', args: [], note: 'reference: bun plus this harness preload, no product code' },
  { name: 'startup-tui-version', entry: 'products/tui/src/main.ts', args: ['--version'], expect: /\d+\.\d+\.\d+/, note: 'spawn to exit; metadata fast path' },
  { name: 'startup-tui-status', entry: 'products/tui/src/main.ts', args: ['status'], note: 'spawn to exit; config, sandbox probe, report' },
  { name: 'startup-agent-version', entry: 'products/agent/src/main.ts', args: ['--version'], expect: /\d+\.\d+\.\d+/, note: 'spawn to exit; metadata fast path' },
  { name: 'startup-agent-status', entry: 'products/agent/src/main.ts', args: ['status'], note: 'spawn to exit; the status command graph only, report' },
  { name: 'startup-daemon-version', entry: 'products/daemon/src/cli/entrypoint.ts', args: ['--version'], expect: /\d+\.\d+\.\d+/, note: 'spawn to exit' },
  {
    name: 'startup-daemon-serve', entry: 'products/daemon/src/cli/entrypoint.ts',
    args: (port) => ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
    readyPattern: /host started \((ready|degraded)\)/, allowLoopback: true,
    note: 'spawn to "host started (ready)" line, then SIGTERM',
  },
];

function freePort(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

async function once(scenario: StartupScenario, repo: string, envFor: (root: string, extra: Record<string, string>) => Record<string, string>): Promise<{ ms: number; code: number | null; output: string }> {
  const root = mkdtempSync(join(tmpdir(), `gv-measure-${scenario.name}-`));
  const workdir = join(root, 'workspace');
  mkdirSync(workdir, { recursive: true });
  const env = envFor(root, {
    GOODVIBES_WORKING_DIR: workdir,
    ...(scenario.allowLoopback ? { MEASURE_ALLOW_LOOPBACK: '1' } : {}),
  });
  const args = typeof scenario.args === 'function' ? scenario.args(freePort()) : scenario.args;
  try {
    const t0 = performance.now();
    const child = Bun.spawn([process.execPath, '--no-env-file', '--preload', join(import.meta.dir, 'instrument.ts'), join(repo, scenario.entry), ...args], {
      cwd: workdir, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const killer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    let output = '';
    let ms: number | undefined;
    const decoder = new TextDecoder();
    const readStdout = (async () => {
      for await (const chunk of child.stdout) {
        output += decoder.decode(chunk);
        if (ms === undefined && scenario.readyPattern?.test(output)) {
          ms = performance.now() - t0;
          child.kill('SIGTERM');
        }
      }
    })();
    const stderr = new Response(child.stderr).text();
    const code = await child.exited;
    const exitMs = performance.now() - t0;
    clearTimeout(killer);
    await readStdout;
    output += await stderr;
    if (scenario.readyPattern && ms === undefined) throw new Error(`no ready line (exit ${code}): ${output.slice(-400)}`);
    if (!scenario.readyPattern && code !== 0) throw new Error(`exited ${code}: ${output.slice(-400)}`);
    if (scenario.expect && !scenario.expect.test(output)) throw new Error(`output does not show ${scenario.expect}: ${output.slice(-400)}`);
    return { ms: ms ?? exitMs, code: scenario.readyPattern ? 0 : code, output };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function measureStartup(scenario: StartupScenario, repo: string, envFor: (root: string, extra: Record<string, string>) => Record<string, string>): Promise<StartupReport> {
  const command = `bun ${scenario.entry} ${(typeof scenario.args === 'function' ? scenario.args(0) : scenario.args).join(' ')}`;
  try {
    await once(scenario, repo, envFor);
    const samples: number[] = [];
    const exitCodes: (number | null)[] = [];
    for (let i = 0; i < RUNS; i++) {
      const result = await once(scenario, repo, envFor);
      samples.push(result.ms);
      exitCodes.push(result.code);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    return { name: scenario.name, command, wallMs: { median: sorted[Math.floor(sorted.length / 2)]!, min: sorted[0]!, max: sorted.at(-1)!, samples }, exitCodes, note: scenario.note };
  } catch (error) {
    return { name: scenario.name, command, wallMs: { median: 0, min: 0, max: 0, samples: [] }, exitCodes: [], error: error instanceof Error ? error.message : String(error) };
  }
}
