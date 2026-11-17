/**
 * Journey 8: one risky call under each permission mode, in `goodvibes run`.
 *
 * The call deletes a directory in the workspace (`rm -rf`), and the run
 * answers owner prompts as a script (`--answer-permissions`), refusing each:
 *  - ask-me: the owner is asked and, refused, nothing is deleted;
 *  - jev-decides with no working decision model (the decision endpoint is a
 *    loopback port that answers 503): it behaves as ask-me;
 *  - just-vibes: nobody is interrupted; the call is held and listed at the end;
 *  - yolo: the call runs without asking.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Journey, TUI_ENTRY, framesOf, permissionAnswerer, runProduct, short, stage, type Stage } from './lib.ts';

const journey = new Journey('j8-permission-modes');
const deadDecisions = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(JSON.stringify({ detail: 'unavailable' }), { status: 503 }) });
const stages: Stage[] = [];

async function trusted(s: Stage): Promise<void> {
  s.model.script('RTJ8TRUST', [{ calls: [{ name: 'exec', args: { commands: [{ cmd: 'true' }] } }] }, { text: 'ok' }]);
  await runProduct(s.home, TUI_ENTRY, ['run', '--output', 'stream-json', '--answer-permissions', 'RTJ8TRUST trust this workspace'], { onLine: permissionAnswerer(() => true) });
}

try {
  const classic = await stage('j8/classic');
  stages.push(classic);
  await trusted(classic);
  const noModel = await stage('j8/nomodel', { judgment: { endpoint: `http://127.0.0.1:${deadDecisions.port}` } });
  noModel.home.allow(deadDecisions.port!);
  stages.push(noModel);
  await trusted(noModel);

  for (const [mode, s] of [['ask-me', classic], ['jev-decides', noModel], ['just-vibes', classic], ['yolo', classic]] as const) {
    const dir = `build-output-${mode}`;
    mkdirSync(join(s.home.workspace, dir), { recursive: true });
    writeFileSync(join(s.home.workspace, dir, 'artifact.bin'), 'data');
    const marker = `RTJ8${mode.replace(/-/g, '').toUpperCase()}`;
    s.model.script(marker, [{ calls: [{ name: 'exec', args: { commands: [{ cmd: `rm -rf ${dir}` }] } }] }, { text: `Done in ${mode}.` }]);
    const prompts: Array<Record<string, unknown>> = [];
    const run = await runProduct(s.home, TUI_ENTRY, ['run', '--output', 'stream-json', '--answer-permissions', '--config', `permissions.mode=${mode}`, `${marker} clean the build output`],
      { onLine: permissionAnswerer((frame) => frame.tool === 'workspace-trust', prompts), timeoutMs: 120_000 });
    const final = run.frames.at(-1) ?? {};
    const deleted = !existsSync(join(s.home.workspace, dir));
    const decided = framesOf(run, 'PERMISSION_DECIDED').filter((frame) => frame.tool === 'exec');
    const execPrompts = prompts.filter((frame) => frame.tool === 'exec');
    const got = `exit ${run.code}; exec prompts ${execPrompts.length}; decided ${JSON.stringify(decided.map((frame) => `${frame.approved}/${frame.source}`))}; deleted ${deleted}; held ${short(final.heldForOwner ?? 'none', 200)}; response ${short(final.response, 120)}`;
    if (mode === 'ask-me' || mode === 'jev-decides') {
      journey.check(`${mode}${mode === 'jev-decides' ? ' (no working decision model)' : ''}: the owner is asked, and a refusal deletes nothing`, `goodvibes run --config permissions.mode=${mode} --answer-permissions (refuse)`, got,
        run.code === 0 && execPrompts.length === 1 && !deleted && decided.every((frame) => frame.approved === false));
    } else if (mode === 'just-vibes') {
      journey.check('just-vibes: nobody is interrupted; the call is held and listed at the end', 'goodvibes run --config permissions.mode=just-vibes', got,
        run.code === 0 && execPrompts.length === 0 && !deleted && JSON.stringify(final.heldForOwner ?? '').includes('exec'));
    } else {
      journey.check('yolo: the call runs without asking', 'goodvibes run --config permissions.mode=yolo', got, run.code === 0 && execPrompts.length === 0 && deleted);
    }
  }
} catch (error) {
  journey.check('journey ran to the end', 'j8', error instanceof Error ? error.stack ?? error.message : String(error), false);
} finally {
  for (const s of stages) await s.close();
  deadDecisions.stop(true);
}
journey.finish(process.env.RUNTHROUGH_DIR ?? '/tmp');
