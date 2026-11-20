/**
 * Journey 1: a turn with tools, in both headless products.
 *
 * For `goodvibes run` and `goodvibes-agent run` (--output stream-json):
 *  - read a file, edit it, run a command: the files really change and the
 *    model receives the real tool results;
 *  - eight independent reads in one response run together and their results
 *    come back in the order the model issued them;
 *  - one failing call among three does not fail the other two;
 *  - Ctrl-C while commands run stops every call: nothing after it happens.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENTRY, TUI_ENTRY, Journey, framesOf, permissionAnswerer, runProduct, short, stage, type RunResult } from './lib.ts';

const journey = new Journey('j1-tool-turn');
const s = await stage('j1');
const ws = s.home.workspace;

async function turn(entry: string, prompt: string, extra: Partial<Parameters<typeof runProduct>[3]> = {}): Promise<RunResult> {
  return runProduct(s.home, entry, ['run', '--output', 'stream-json', '--omit-accumulated', prompt], { timeoutMs: 120_000, ...extra });
}
/** With decision models off every command is the owner's to approve: the owner (this script) approves each prompt. */
const approveAll = permissionAnswerer(() => true);
async function ownerTurn(entry: string, prompt: string, extra: Partial<Parameters<typeof runProduct>[3]> = {}): Promise<RunResult> {
  return runProduct(s.home, entry, ['run', '--output', 'stream-json', '--omit-accumulated', '--answer-permissions', prompt], { timeoutMs: 120_000, onLine: approveAll, ...extra });
}
function final(result: RunResult): Record<string, unknown> { return result.frames.find((frame) => frame.type === 'NATIVE_INTAKE_RESULT') ?? result.json ?? {}; }

try {
  const agentRegistered = await s.registerWorkspace();
  journey.check('agent: register the workspace for native work', 'goodvibes-agent workspaces register --yes', short(agentRegistered.stdout + agentRegistered.stderr), agentRegistered.code === 0);

  // The terminal app asks once per new workspace before writes, commands or delegation run there.
  const registerPath = join(s.home.home, '.goodvibes', 'shared', 'workspace-registrations.json');
  const trustRows = (): string => existsSync(registerPath) ? JSON.stringify((JSON.parse(readFileSync(registerPath, 'utf8')) as { trust?: unknown }).trust ?? []) : '[]';
  s.model.script('RTJ1TRUSTNONE', [{ calls: [{ name: 'exec', args: { commands: [{ cmd: 'echo x > untrusted.txt' }] } }] }, { text: 'Could not run it.' }]);
  const untrusted = await turn(TUI_ENTRY, 'RTJ1TRUSTNONE run a command');
  const refusal = s.model.toolResults('RTJ1TRUSTNONE')[0]?.content ?? '';
  // With a working decision model (the run's policy is not No Decision Model and the scripted model is set),
  // Jev judges each action in an undecided workspace itself: nobody is asked and no workspace grant is kept.
  const modelInUse = (process.env.RUNTHROUGH_POLICY ?? 'No Decision Model') !== 'No Decision Model' && Boolean(process.env.RUNTHROUGH_DECISION_URL);
  if (modelInUse) {
    journey.check('tui: with a decision model a command in an undecided workspace is judged by Jev, nobody is asked, nothing is kept', 'goodvibes run "RTJ1TRUSTNONE ..." (no --answer-permissions)',
      `exit ${untrusted.code}; tool result ${short(refusal, 220)}; untrusted.txt ${existsSync(join(ws, 'untrusted.txt'))}; trust rows ${trustRows()}`,
      untrusted.code === 0 && existsSync(join(ws, 'untrusted.txt')) && trustRows() === '[]');
  } else {
    journey.check('tui: a command in an undecided workspace with nobody to ask is refused, the turn goes on', 'goodvibes run "RTJ1TRUSTNONE ..." (no --answer-permissions)',
      `exit ${untrusted.code}; tool result ${short(refusal, 220)}; trust rows ${trustRows()}`,
      untrusted.code === 0 && /undecided/.test(refusal) && !existsSync(join(ws, 'untrusted.txt')) && trustRows() === '[]');
  }
  const prompts: Array<Record<string, unknown>> = [];
  s.model.script('RTJ1TRUST', [{ calls: [{ name: 'exec', args: { commands: [{ cmd: 'echo x > trusted.txt' }] } }] }, { text: 'Ran it.' }]);
  const trusted = await runProduct(s.home, TUI_ENTRY, ['run', '--output', 'stream-json', '--answer-permissions', 'RTJ1TRUST run a command'],
    { onLine: permissionAnswerer(() => true, prompts) });
  if (modelInUse) {
    journey.check('tui: with a decision model and the owner present, the command runs on Jev\'s judgment', 'goodvibes run --answer-permissions "RTJ1TRUST ..."',
      `exit ${trusted.code}; prompts ${JSON.stringify(prompts.map((frame) => frame.tool))}; trusted.txt ${existsSync(join(ws, 'trusted.txt'))}; trust rows ${trustRows()}`,
      trusted.code === 0 && existsSync(join(ws, 'trusted.txt')));
  } else {
    journey.check('tui: answering the workspace-trust prompt trusts the workspace and the command that asked runs', 'goodvibes run --answer-permissions "RTJ1TRUST ..." answering the workspace-trust prompt',
      `exit ${trusted.code}; prompts ${JSON.stringify(prompts.map((frame) => frame.tool))}; trusted.txt ${existsSync(join(ws, 'trusted.txt'))}; trust rows ${trustRows()}`,
      trusted.code === 0 && prompts.some((frame) => frame.tool === 'workspace-trust') && existsSync(join(ws, 'trusted.txt')) && trustRows().includes('"trusted"'));
  }

  for (const [product, entry] of [['tui', TUI_ENTRY], ['agent', AGENT_ENTRY]] as const) {
    const tag = product.toUpperCase();
    // 1. read, edit, run a command.
    const notes = `notes-${product}.txt`;
    writeFileSync(join(ws, notes), 'status: alpha\n');
    const m1 = `RTJ1${tag}EDIT`;
    s.model.script(m1, [
      { calls: [{ name: 'read', args: { files: [{ path: notes }] } }] },
      { calls: [{ name: 'edit', args: { edits: [{ path: notes, find: 'alpha', replace: 'beta' }] } }] },
      { calls: [{ name: 'exec', args: { commands: [{ cmd: `cat ${notes} && echo ran > ran-${product}.txt` }] } }] },
      { text: 'The status is now beta.' },
    ]);
    const r1 = await ownerTurn(entry, `${m1} change the status in ${notes} to beta and show it`);
    const results1 = s.model.toolResults(m1);
    const fileNow = readFileSync(join(ws, notes), 'utf8');
    journey.check(`${product}: read+edit+exec turn completes`, `${product} run --output stream-json "${m1} ..."`, `exit ${r1.code}; final ${short(final(r1), 300)}; stderr ${short(r1.stderr.split('\n').filter((line) => !line.includes('runthrough')).join(' '), 300)}`, r1.code === 0 && final(r1).ok === true);
    journey.check(`${product}: the file really changed`, `read ${notes}`, JSON.stringify(fileNow), fileNow === 'status: beta\n');
    journey.check(`${product}: the command really ran`, `exists ran-${product}.txt`, String(existsSync(join(ws, `ran-${product}.txt`))), existsSync(join(ws, `ran-${product}.txt`)));
    const readResult = results1.find((entry) => entry.name === 'read')?.content ?? '';
    const execResult = results1.find((entry) => entry.name === 'exec')?.content ?? '';
    const editResult = results1.find((entry) => entry.name === 'edit')?.content ?? '';
    journey.check(`${product}: the model received real tool results`, 'tool messages in the last model request',
      `read: ${short(readResult, 160)} | edit: ${short(editResult, 160)} | exec: ${short(execResult, 200)}`,
      readResult.includes('status: alpha') && /beta/.test(execResult) && results1.length === 3 && /applied: 1, failed: 0/.test(editResult));
    const succeeded = framesOf(r1, 'TOOL_SUCCEEDED').map((frame) => frame.tool);
    journey.check(`${product}: the stream shows each call succeeding`, 'TOOL_SUCCEEDED frames', JSON.stringify(succeeded), ['read', 'edit', 'exec'].every((tool) => succeeded.includes(tool)));

    // 2. Eight independent reads in one response.
    const m2 = `RTJ1${tag}EIGHT`;
    const paths = Array.from({ length: 8 }, (_, index) => `eight-${product}-${index + 1}.txt`);
    paths.forEach((path, index) => writeFileSync(join(ws, path), `content number ${index + 1}\n`));
    s.model.script(m2, [{ calls: paths.map((path) => ({ name: 'read', args: { files: [{ path }] } })) }, { text: 'Read all eight.' }]);
    const r2 = await ownerTurn(entry, `${m2} read the eight files`);
    const results2 = s.model.toolResults(m2);
    const inOrder = results2.length === 8 && results2.every((entry, index) => entry.content.includes(`content number ${index + 1}`));
    const frames = r2.frames.filter((frame) => typeof frame.type === 'string' && String(frame.type).startsWith('TOOL_'));
    const firstDone = frames.findIndex((frame) => frame.type !== 'TOOL_EXECUTING');
    const startedBeforeFirstDone = frames.slice(0, firstDone < 0 ? frames.length : firstDone).filter((frame) => frame.type === 'TOOL_EXECUTING').length;
    journey.check(`${product}: eight reads complete`, `${product} run "${m2} ..."`, `exit ${r2.code}; results ${results2.length}`, r2.code === 0 && results2.length === 8);
    journey.check(`${product}: eight results come back in the order issued`, 'tool messages order', results2.map((entry) => short(entry.content, 40)).join(' | '), inOrder);
    journey.check(`${product}: the eight reads were started together`, 'TOOL_EXECUTING frames before the first finished frame',
      `${startedBeforeFirstDone} started before the first finished; frame order ${frames.map((frame) => String(frame.type).replace('TOOL_', '')[0]).join('')}`, startedBeforeFirstDone >= 2);

    // 3. One failing call among three.
    const m3 = `RTJ1${tag}FAIL`;
    writeFileSync(join(ws, `ok-a-${product}.txt`), 'first ok\n');
    writeFileSync(join(ws, `ok-b-${product}.txt`), 'second ok\n');
    s.model.script(m3, [{ calls: [
      { name: 'read', args: { files: [{ path: `ok-a-${product}.txt` }] } },
      { name: 'read', args: { files: [{ path: `missing-${product}.txt` }] } },
      { name: 'read', args: { files: [{ path: `ok-b-${product}.txt` }] } },
    ] }, { text: 'Two of three read.' }]);
    const r3 = await ownerTurn(entry, `${m3} read three files`);
    const results3 = s.model.toolResults(m3);
    journey.check(`${product}: a failing call does not fail the others`, `${product} run "${m3} ..."`,
      `exit ${r3.code}; ${results3.map((entry) => short(entry.content, 90)).join(' | ')}`,
      r3.code === 0 && results3.length === 3 && results3[0]!.content.includes('first ok') && results3[2]!.content.includes('second ok')
      && !/first ok|second ok/.test(results3[1]!.content) && /not found|no such|does not exist|ENOENT/i.test(results3[1]!.content));

    // 4. Cancel while commands run.
    const m4 = `RTJ1${tag}CANCEL`;
    s.model.script(m4, [{ calls: [
      { name: 'exec', args: { commands: [{ cmd: `sleep 6 && echo late > late-1-${product}.txt` }] } },
      { name: 'exec', args: { commands: [{ cmd: `sleep 6 && echo late > late-2-${product}.txt` }] } },
    ] }, { text: 'should never be asked' }]);
    const t0 = Date.now();
    let sent = false;
    const r4 = await ownerTurn(entry, `${m4} run two slow commands`, {
      onLine(line, child) {
        approveAll(line, child);
        if (!sent && line.includes('TOOL_EXECUTING')) { sent = true; setTimeout(() => child.kill('SIGINT'), 500); }
      },
    });
    const stoppedMs = Date.now() - t0;
    await Bun.sleep(8_000);
    const late = [1, 2].filter((n) => existsSync(join(ws, `late-${n}-${product}.txt`)));
    const askedAfter = s.model.requests.filter((entry) => entry.marker === m4).length;
    journey.check(`${product}: Ctrl-C mid-turn stops every call`, `${product} run "${m4} ..." then SIGINT after the first TOOL_EXECUTING`,
      `exit ${r4.code} after ${stoppedMs} ms; files written after cancel: ${JSON.stringify(late)}; model requests ${askedAfter}; frames ${framesOf(r4, 'TOOL_CANCELLED').length} cancelled / ${framesOf(r4, 'TOOL_FAILED').length} failed`,
      // The commands were stopped, not waited out: neither wrote its file (checked after their own six seconds),
      // the model was not asked again, and every call ends cancelled. How long the program took to start is not the product's promise.
      sent && r4.code === 130 && late.length === 0 && askedAfter === 1
      && framesOf(r4, 'TOOL_CANCELLED').length >= 1 && framesOf(r4, 'TOOL_FAILED').length === 0);
  }
} catch (error) {
  journey.check('journey ran to the end', 'j1', error instanceof Error ? error.stack ?? error.message : String(error), false);
} finally {
  await s.close();
}
journey.finish(s.base);
