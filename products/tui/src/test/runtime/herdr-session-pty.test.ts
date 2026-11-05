import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SessionManager } from '@goodvibes-jev/engine/sdk/platform/sessions';
import { createSessionSurface } from '@/runtime/index.ts';
import { inputAreaVisible, isolatedEnv, makeHome, startStubModel, waitFor } from '../e2e/harness.ts';
import { TerminalFrame } from '../helpers/terminal-frame.ts';

test('the real TUI reports resumed identity and actual owner choice, then drains release on quit', async () => {
  const model = startStubModel(() => ({ text: 'Unexpected lifecycle fixture request' }));
  const home = await makeHome(model);
  const surface = createSessionSurface({ surfaceRoot: 'tui', workingDirectory: home.workspace, homeDirectory: home.home });
  const manager = new SessionManager(home.workspace, { surface });
  for (const id of ['herdr-fixture', 'other-fixture']) manager.save(id, [], { title: id, timestamp: Date.now(), model: 'e2e-stub:stub-model', provider: 'e2e-stub' });
  const bin = join(home.root, 'bin');
  const callsPath = join(home.root, 'herdr-calls.jsonl');
  const releaseGate = join(home.root, 'release-herdr');
  const hookGate = join(home.root, 'release-startup-hook');
  const startupHook = join(home.root, 'startup-hook.ts');
  writeFileSync(startupHook, `import { existsSync } from 'node:fs'; while (!existsSync(${JSON.stringify(hookGate)})) await Bun.sleep(10);`);
  const hooksPath = join(home.root, 'native-hooks.json');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(hooksPath, JSON.stringify({ hooks: { 'Lifecycle:session:start': [{ type: 'command', match: 'Lifecycle:session:start', command: `${quote(process.execPath)} ${quote(startupHook)}` }] } }));
  home.setTuiSetting('tools.hooksFile', hooksPath);
  mkdirSync(bin); mkdirSync(join(home.root, 'tmp'));
  const executable = join(bin, 'herdr');
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync, existsSync } from 'node:fs';
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('herdr 0.9.3'); process.exit(0); }
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(argv) + ${JSON.stringify('\n')});
if (argv[1] === 'release-agent' && argv[argv.indexOf('--source') + 1] === 'goodvibes') {
  const deadline = Date.now() + 10_000;
  while (!existsSync(${JSON.stringify(releaseGate)}) && Date.now() < deadline) await Bun.sleep(10);
}
`);
  chmodSync(executable, 0o755);
  const frame = new TerminalFrame(150, 45);
  const child = Bun.spawn([process.execPath, '--tsconfig-override', resolve(import.meta.dir, '../../../tsconfig.json'), resolve(import.meta.dir, '../../main.ts'), '--working-dir', home.workspace, '--resume', 'herdr-fixture'], {
    cwd: home.workspace,
    env: isolatedEnv(home, { PATH: `${bin}:/usr/bin:/bin`, HERDR_ENV: '1', HERDR_PANE_ID: 'w4:p2', HERDR_BIN_PATH: executable, HERDR_SOCKET_PATH: join(home.root, 'synthetic-herdr.sock') }),
    terminal: { cols: 150, rows: 45, data(terminal, bytes) { frame.write(new TextDecoder().decode(bytes), answer => terminal.write(answer)); } },
  });
  const calls = (): string[][] => existsSync(callsPath) ? readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const reports = () => calls().filter(argv => argv[1] === 'report-agent');
  const state = (argv: string[]) => argv[argv.indexOf('--state') + 1];
  try {
    await waitFor('working while an actual startup hook remains active', () => reports().find(argv => state(argv) === 'working'), 20_000, 20);
    expect(state(reports().at(-1) ?? [])).toBe('working');
    writeFileSync(hookGate, 'release');
    await waitFor('resumed native TUI session report', () => reports().find(argv => argv.includes('--agent-session-id=herdr-fixture')), 20_000, 20);
    await waitFor('idle after startup hook settlement', () => state(reports().at(-1) ?? []) === 'idle', 10_000, 20);
    await waitFor('the real TUI composer', () => inputAreaVisible(frame.text()), 20_000, 20);
    const resumed = reports().find(argv => argv.includes('--agent-session-id=herdr-fixture'));
    if (!resumed) throw new Error('Resumed session report disappeared');
    expect(resumed).toContain(`--agent-session-path=${join(surface.sessionsDir, 'herdr-fixture.jsonl')}`);
    expect(resumed.slice(resumed.indexOf('--') + 1)).toEqual(['goodvibes', '--working-dir', home.workspace, '--resume', 'herdr-fixture']);
    child.terminal?.write('/resume\r');
    await waitFor('the actual owner choice dialog', () => reports().find(argv => state(argv) === 'blocked'), 10_000, 20);
    child.terminal?.write('\x1b');
    await waitFor('idle after cancelling the choice', () => state(reports().at(-1) ?? []) === 'idle', 10_000, 20);
    child.terminal?.write('/exit\r');
    await waitFor('release before normal process exit', () => calls().find(argv => argv[1] === 'release-agent' && argv[argv.indexOf('--source') + 1] === 'goodvibes'), 10_000, 20);
    expect(child.exitCode).toBeNull();
    writeFileSync(releaseGate, 'release');
    expect(await child.exited).toBe(0);
    expect(calls().at(-1)?.[1]).toBe('release-agent');
    expect(calls().every(argv => argv[2] === 'w4:p2')).toBe(true);
    expect(model.requests).toHaveLength(0);
  } finally {
    writeFileSync(hookGate, 'release');
    writeFileSync(releaseGate, 'release');
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited; child.terminal?.close();
    model.stop(); rmSync(home.root, { recursive: true, force: true });
  }
}, 60_000);
