import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isolatedEnv, makeHome, closeE2EFixture, startStubModel, waitFor } from '../e2e/harness.ts';
import { createSessionSurface } from '@/runtime/index.ts';
import { TerminalFrame } from '../e2e/terminal-frame.ts';

test.each(['SIGTERM', 'SIGHUP', 'normal'] as const)('the real Agent terminal reports its owner question and drains Herdr release before %s exits', async (exitKind) => {
  const model = startStubModel(() => ({ text: 'Unused native lifecycle fixture' }));
  const home = await makeHome(model);
  home.setAgentSetting('permissions.mode', 'yolo');
  const surface = createSessionSurface({ surfaceRoot: 'agent', workingDirectory: home.workspace, homeDirectory: home.home });
  const bin = join(home.root, 'bin');
  const callsPath = join(home.root, 'herdr-calls.jsonl');
  const releaseGate = join(home.root, 'release-herdr');
  mkdirSync(bin); mkdirSync(join(home.root, 'tmp'));
  const executable = join(bin, 'herdr');
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync, existsSync } from 'node:fs';
const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.stdout.write('herdr 0.9.3\\n'); process.exit(0); }
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(argv) + '\\n');
if (argv[1] === 'release-agent' && argv[argv.indexOf('--source') + 1] === 'goodvibes') {
  const deadline = Date.now() + 10_000;
  while (!existsSync(${JSON.stringify(releaseGate)}) && Date.now() < deadline) await Bun.sleep(10);
}
`);
  chmodSync(executable, 0o755);
  const frame = new TerminalFrame(150, 45);
  const child = Bun.spawn([process.execPath, '--tsconfig-override', resolve(import.meta.dir, '../../../tsconfig.json'), resolve(import.meta.dir, '../../interactive.ts'), '--working-dir', home.workspace], {
    cwd: home.workspace,
    env: isolatedEnv(home, { PATH: `${bin}:/usr/bin:/bin`, GOODVIBES_AGENT_HOME: home.home, HERDR_ENV: '1', HERDR_PANE_ID: 'w4:p2', HERDR_BIN_PATH: executable, HERDR_SOCKET_PATH: join(home.root, 'herdr.sock') }),
    terminal: { cols: 150, rows: 45, data(terminal, bytes) { frame.write(new TextDecoder().decode(bytes), answer => terminal.write(answer)); } },
  });
  const calls = (): string[][] => existsSync(callsPath) ? readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const state = (argv: string[]) => argv[argv.indexOf('--state') + 1];
  try {
    await waitFor('native Agent initial report', () => calls().find(argv => argv[1] === 'report-agent'), 20_000, 20);
    await waitFor('native Agent owner question report', () => calls().find(argv => argv[1] === 'report-agent' && state(argv) === 'blocked'), 20_000, 20);
    const reports = calls().filter(argv => argv[1] === 'report-agent');
    const sessionFlag = reports[0]?.find(flag => flag.startsWith('--agent-session-id='));
    expect(sessionFlag).toBeDefined();
    if (!sessionFlag) throw new Error('Native session identity was not reported');
    const sessionId = sessionFlag.slice('--agent-session-id='.length);
    expect(reports[0]).toContain(`--agent-session-path=${join(surface.sessionsDir, `${sessionId}.jsonl`)}`);
    expect(reports.every(argv => argv[2] === 'w4:p2')).toBe(true);
    expect(JSON.stringify(calls())).not.toContain('Register this workspace');
    expect(reports.at(-1)?.slice((reports.at(-1)?.indexOf('--') ?? -1) + 1)).toEqual(['goodvibes-agent', '--working-dir', home.workspace, '--resume', sessionId]);
    if (exitKind === 'normal') {
      child.terminal?.write('\x1b');
      await waitFor('owner question dismissal', () => state(calls().filter(argv => argv[1] === 'report-agent').at(-1) ?? []) === 'idle', 10_000, 20);
      child.terminal?.write('/quit\r');
    } else child.kill(exitKind);
    await waitFor('native Herdr release before process exit', () => calls().find(argv => argv[1] === 'release-agent' && argv[argv.indexOf('--source') + 1] === 'goodvibes'), 10_000, 20).catch(error => { throw new Error(`${String(error)}\n${frame.text()}\n${JSON.stringify(calls())}`); });
    expect(child.exitCode).toBeNull();
    writeFileSync(releaseGate, 'release');
    expect(await child.exited).toBe(0);
    expect(calls().at(-1)?.[1]).toBe('release-agent');
  } finally {
    writeFileSync(releaseGate, 'release');
    await closeE2EFixture(home,
      async () => {
        try { if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; }
        finally { child.terminal?.close(); }
      },
      () => model.stop(),
    );
  }
}, 60_000);
