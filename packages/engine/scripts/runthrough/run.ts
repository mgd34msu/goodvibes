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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { done, exitCodeOfTally, failedOutcome, observe, refusal, tally, type EffectOutcome } from '../../errors/src/index.ts';
import { REPO } from './lib.ts';
import { answerAsAModelWould, startFakeDecision } from './fake-decision.ts';

const JOURNEYS = [
  'j1-tool-turn', 'j2-delegation', 'j3-channels', 'j4-knowledge', 'j5-purchases', 'j6-pairing', 'j7-webui',
  'j8-permission-modes', 'j9-crash-recovery', 'j10-inbox-and-hosted-agent', 'j11-contracts', 'j12-mail', 'j13-decision-notice',
  'j14-save-then-acknowledge', 'j15-guided-commands', 'j16-approvals-across-nodes',
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
const unmatched = (only ?? []).filter((prefix) => !JOURNEYS.some((name) => name === prefix || name.startsWith(`${prefix}-`)));
if (selected.length === 0 || unmatched.length > 0) {
  // A selector that names no journey is a usage error, never a run of nothing that passes.
  process.stdout.write(`[runthrough] --only ${unmatched.join(',') || (only ?? []).join(',')} names no journey. Journeys: ${JOURNEYS.join(', ')}\n`);
  process.exit(2);
}
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
/**
 * The source the built web UI came from: the commit, the uncommitted changes
 * and the untracked files. A build is reused only when it was made from the
 * same source, so the journey never drives a stale copy.
 */
function sourceStamp(): string {
  const git = (...args: string[]): string => Bun.spawnSync(['git', '-C', REPO, ...args], { stdout: 'pipe', stderr: 'pipe' }).stdout.toString();
  return createHash('sha256')
    .update(git('rev-parse', 'HEAD'))
    .update(git('diff', 'HEAD', '--', 'products/webui', 'packages/engine'))
    .update(git('ls-files', '--others', '--exclude-standard', '--', 'products/webui', 'packages/engine'))
    .digest('hex');
}
if (selected.includes('j7-webui') && !webuiDist) {
  webuiDist = join(dir, 'webui-dist');
  const stampPath = join(dir, 'webui-dist.source');
  const stamp = sourceStamp();
  const builtFrom = existsSync(stampPath) ? readFileSync(stampPath, 'utf8') : undefined;
  if (!existsSync(join(webuiDist, 'index.html')) || builtFrom !== stamp) {
    process.stdout.write(`[runthrough] building the web UI into ${webuiDist}\n`);
    rmSync(stampPath, { force: true });
    const built = Bun.spawnSync([process.execPath, 'run', '--cwd', join(REPO, 'products/webui'), 'vite', 'build', '--outDir', webuiDist, '--emptyOutDir'], { stdout: 'pipe', stderr: 'pipe' });
    if (built.exitCode !== 0) process.stdout.write(`[runthrough] the web UI build failed: ${built.stderr.toString().slice(-600)}\n`);
    else writeFileSync(stampPath, stamp);
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
const outcomes: { id: string; outcome: EffectOutcome<unknown> }[] = [];
for (const result of results.sort((a, b) => tasks.indexOf(a.task) - tasks.indexOf(b.task))) {
  process.stdout.write(`${result.code === 0 ? 'PASS' : 'FAIL'} ${result.task.label}${result.task.name} (${(result.ms / 1000).toFixed(0)} s)\n`);
  const id = `${result.task.label}${result.task.name}`;
  const seen = await observe('the journey exited 0', () => (result.code === 0 ? result.code : undefined));
  outcomes.push({ id, outcome: seen ? done(seen) : failedOutcome(refusal({ code: 'JOURNEY_FAILED', state: 'failed', reason: `exited ${result.code}` })) });
}
// Every selected journey counts: one that never reported is not a pass.
const summary = tally(tasks.length, outcomes);
process.stdout.write(`${summary.done.length} of ${summary.requested} journeys passed\n`);
process.exit(exitCodeOfTally(summary));
