/**
 * The product run-through: every journey, each in its own isolated home on
 * loopback (see lib.ts), three at a time. Prints PASS or FAIL per step and per
 * journey and exits non-zero when any journey failed.
 *
 *   bun packages/engine/scripts/runthrough/run.ts [--only j1,j3] [--dir <scratch folder>]
 *
 * The web UI journey needs the built web UI: it is built once into
 * <dir>/webui-dist with vite (skipped when RUNTHROUGH_WEBUI_DIST names a
 * built copy). Chromium comes from RUNTHROUGH_CHROMIUM (default
 * /usr/bin/chromium).
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from './lib.ts';

const JOURNEYS = [
  'j1-tool-turn', 'j2-delegation', 'j3-channels', 'j4-knowledge', 'j5-purchases', 'j6-pairing', 'j7-webui',
  'j8-permission-modes', 'j9-crash-recovery', 'j10-inbox-and-hosted-agent',
] as const;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const only = flag('--only')?.split(',').map((entry) => entry.trim()).filter(Boolean);
const dir = flag('--dir') ?? process.env.RUNTHROUGH_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'goodvibes-runthrough');
const selected = JOURNEYS.filter((name) => !only || only.some((prefix) => name === prefix || name.startsWith(`${prefix}-`)));
mkdirSync(dir, { recursive: true });

let webuiDist = process.env.RUNTHROUGH_WEBUI_DIST;
if (selected.includes('j7-webui') && !webuiDist) {
  webuiDist = join(dir, 'webui-dist');
  if (!existsSync(join(webuiDist, 'index.html'))) {
    process.stdout.write(`[runthrough] building the web UI into ${webuiDist}\n`);
    const built = Bun.spawnSync([process.execPath, 'run', '--cwd', join(REPO, 'products/webui'), 'vite', 'build', '--outDir', webuiDist, '--emptyOutDir'], { stdout: 'pipe', stderr: 'pipe' });
    if (built.exitCode !== 0) process.stdout.write(`[runthrough] the web UI build failed: ${built.stderr.toString().slice(-600)}\n`);
  }
}

const results: Array<{ name: string; code: number | null; ms: number }> = [];
const queue = [...selected];
async function worker(): Promise<void> {
  for (let name = queue.shift(); name; name = queue.shift()) {
    // A journey starts from a fresh home every time.
    rmSync(join(dir, name.split('-')[0]!), { recursive: true, force: true });
    const t0 = performance.now();
    const child = Bun.spawn([process.execPath, join(import.meta.dir, `${name}.ts`)], {
      env: { ...process.env, RUNTHROUGH_DIR: dir, ...(webuiDist ? { RUNTHROUGH_WEBUI_DIST: webuiDist } : {}) },
      stdout: 'pipe', stderr: 'pipe',
    });
    const out = await new Response(child.stdout).text();
    const err = await new Response(child.stderr).text();
    const code = await child.exited;
    results.push({ name, code, ms: Math.round(performance.now() - t0) });
    process.stdout.write(out.split('\n').filter((line) => /^(PASS|FAIL)/.test(line)).map((line) => `${line}\n`).join(''));
    if (code !== 0 && !/^(PASS|FAIL) /m.test(out)) process.stdout.write(`FAIL ${name}: exited ${code} ${err.slice(-400)}\n`);
  }
}
await Promise.all(Array.from({ length: Math.min(3, selected.length) }, () => worker()));
process.stdout.write('\n');
for (const result of results.sort((a, b) => selected.indexOf(a.name as typeof selected[number]) - selected.indexOf(b.name as typeof selected[number]))) {
  process.stdout.write(`${result.code === 0 ? 'PASS' : 'FAIL'} ${result.name} (${(result.ms / 1000).toFixed(0)} s)\n`);
}
process.exit(results.every((result) => result.code === 0) ? 0 : 1);
