/**
 * The product run-through: every journey, each in its own isolated home on
 * loopback (see lib.ts), three at a time. Prints PASS or FAIL per step and per
 * journey and exits non-zero when any journey failed.
 *
 *   bun packages/engine/scripts/runthrough/run.ts [--only j1,j3] [--dir <scratch folder>] [--policies]
 *
 * --policies runs the selected journeys (default j1, j8, j10 and j13) once
 * under each decision policy (No Decision Model, Hybrid, Decision Model Only),
 * each with nothing configured and with the scripted decision model on
 * loopback (fake-decision.ts), every combination in its own folder under
 * <dir>/policies.
 *
 * The web UI journey needs the built web UI: it is built once into
 * <dir>/webui-dist with vite (skipped when RUNTHROUGH_WEBUI_DIST names a
 * built copy). Chromium comes from RUNTHROUGH_CHROMIUM (default
 * /usr/bin/chromium).
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from './lib.ts';
import { answerAsAModelWould, startFakeDecision } from './fake-decision.ts';

const JOURNEYS = [
  'j1-tool-turn', 'j2-delegation', 'j3-channels', 'j4-knowledge', 'j5-purchases', 'j6-pairing', 'j7-webui',
  'j8-permission-modes', 'j9-crash-recovery', 'j10-inbox-and-hosted-agent', 'j11-contracts', 'j12-mail', 'j13-decision-notice',
] as const;
const POLICY_DEFAULT = ['j1', 'j8', 'j10', 'j13'];
const POLICIES = ['No Decision Model', 'Hybrid', 'Decision Model Only'] as const;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const policies = process.argv.includes('--policies');
const only = flag('--only')?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? (policies ? POLICY_DEFAULT : undefined);
const dir = flag('--dir') ?? process.env.RUNTHROUGH_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'goodvibes-runthrough');
const selected = JOURNEYS.filter((name) => !only || only.some((prefix) => name === prefix || name.startsWith(`${prefix}-`)));
mkdirSync(dir, { recursive: true });

/** One journey run: under the journey's own decision settings, or one policy combination. */
interface Task { readonly name: string; readonly label: string; readonly dir: string; readonly env: Record<string, string> }
// The scripted decision model the policy combinations share, answering as a model would (fake-decision.ts).
const decision = policies ? startFakeDecision() : undefined;
if (decision) answerAsAModelWould(decision);
const tasks: Task[] = policies
  ? POLICIES.flatMap((policy) => [false, true].flatMap((scripted) => {
    const slug = `${policy.replace(/\s+/g, '-').toLowerCase()}-${scripted ? 'scripted' : 'none'}`;
    return selected.map((name): Task => ({ name, label: `[${policy}, ${scripted ? 'scripted decision model' : 'nothing configured'}] `, dir: join(dir, 'policies', slug),
      env: { RUNTHROUGH_POLICY: policy, ...(scripted && decision ? { RUNTHROUGH_DECISION_URL: decision.url } : {}) } }));
  }))
  : selected.map((name): Task => ({ name, label: '', dir, env: {} }));

let webuiDist = process.env.RUNTHROUGH_WEBUI_DIST;
if (selected.includes('j7-webui') && !webuiDist) {
  webuiDist = join(dir, 'webui-dist');
  if (!existsSync(join(webuiDist, 'index.html'))) {
    process.stdout.write(`[runthrough] building the web UI into ${webuiDist}\n`);
    const built = Bun.spawnSync([process.execPath, 'run', '--cwd', join(REPO, 'products/webui'), 'vite', 'build', '--outDir', webuiDist, '--emptyOutDir'], { stdout: 'pipe', stderr: 'pipe' });
    if (built.exitCode !== 0) process.stdout.write(`[runthrough] the web UI build failed: ${built.stderr.toString().slice(-600)}\n`);
  }
}

const results: Array<{ task: Task; code: number | null; ms: number }> = [];
const queue = [...tasks];
async function worker(): Promise<void> {
  for (let task = queue.shift(); task; task = queue.shift()) {
    mkdirSync(task.dir, { recursive: true });
    // A journey starts from a fresh home every time.
    rmSync(join(task.dir, task.name.split('-')[0]!), { recursive: true, force: true });
    const t0 = performance.now();
    const child = Bun.spawn([process.execPath, join(import.meta.dir, `${task.name}.ts`)], {
      env: { ...process.env, ...task.env, RUNTHROUGH_DIR: task.dir, ...(webuiDist ? { RUNTHROUGH_WEBUI_DIST: webuiDist } : {}) },
      stdout: 'pipe', stderr: 'pipe',
    });
    const out = await new Response(child.stdout).text();
    const err = await new Response(child.stderr).text();
    const code = await child.exited;
    results.push({ task, code, ms: Math.round(performance.now() - t0) });
    // Twenty-four homes do not fit a scratch quota: a policy run keeps each journey's result file, not its home.
    if (policies) rmSync(join(task.dir, task.name.split('-')[0]!), { recursive: true, force: true });
    process.stdout.write(out.split('\n').filter((line) => /^(PASS|FAIL)/.test(line)).map((line) => `${task.label}${line}\n`).join(''));
    if (code !== 0 && !/^(PASS|FAIL) /m.test(out)) process.stdout.write(`${task.label}FAIL ${task.name}: exited ${code} ${err.slice(-400)}\n`);
  }
}
await Promise.all(Array.from({ length: Math.min(3, tasks.length) }, () => worker()));
decision?.stop();
process.stdout.write('\n');
for (const result of results.sort((a, b) => tasks.indexOf(a.task) - tasks.indexOf(b.task))) {
  process.stdout.write(`${result.code === 0 ? 'PASS' : 'FAIL'} ${result.task.label}${result.task.name} (${(result.ms / 1000).toFixed(0)} s)\n`);
}
process.exit(results.every((result) => result.code === 0) ? 0 : 1);
