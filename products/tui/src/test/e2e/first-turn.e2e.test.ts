/**
 * The built `goodvibes` binary on a fresh home, against a real daemon and a
 * scripted model at the HTTP wire: it starts in a real terminal with nothing on
 * stderr, a typed prompt reaches the model, and the model's reply is drawn; the
 * same prompt through the headless entry point exits 0 with the reply as JSON.
 * No contract or agent is created for a plain conversation turn, and the
 * compiled process makes no external network request.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TuiConfigManager } from '../../config/host-settings.ts';
import { startE2ENativeHost } from './native-host-fixture.ts';
import { closeE2EFixture, inputAreaVisible, isolatedEnv, lastUserText, launchTui, makeHome, resolveBinary, screenText, startStubModel, type E2EHome, type TuiSession } from './harness.ts';

const PROMPT = 'give this project a code review';
const REPLY = 'I will review the project code.';

const model = startStubModel((request) => (
  lastUserText(request).includes(PROMPT) ? { text: REPLY } : { text: 'E2E side request' }
));
let tui: TuiSession | null = null;
let host: Awaited<ReturnType<typeof startE2ENativeHost>> | null = null;
let ownedHome: E2EHome | null = null;
afterAll(() => closeE2EFixture(ownedHome, () => tui?.stop(), () => host?.stop(), () => model.stop()));

// One journey in steps: each step is a test so each stays inside the per-test limit; a failed step fails the ones after it.
describe('first turn', () => {
  test('a real daemon starts and this home is paired with it', async () => {
    const home = await makeHome(model);
    ownedHome = home;
    host = await startE2ENativeHost(home);
    // The proof is about the program's own path to the model, not a decision model's judgment: Jev is switched off.
    new TuiConfigManager({ configDir: join(home.home, '.goodvibes/tui'), homeDir: home.home, workingDir: home.workspace, surfaceRoot: 'tui' })
      .set('judgment.policy', 'Classic - Off', { daemonNotRunning: true });
  });

  test('the binary starts in a real terminal with nothing on stderr', async () => {
    const home = ownedHome!;
    tui = launchTui(home, { cols: 100, rows: 30, env: host!.env });
    await tui.waitForScreen('the input area', inputAreaVisible);
    const stderrFile = readdirSync(home.root).find((name) => name.endsWith('.stderr'))!;
    expect(readFileSync(join(home.root, stderrFile), 'utf8')).toBe('');
  });

  test('a typed prompt reaches the model and its reply is drawn, with no contract or agent created', async () => {
    tui!.type(PROMPT);
    tui!.key('Enter');
    const screen = await tui!.waitForScreen('the scripted reply', (s) => screenText(s).includes(REPLY));
    expect(model.requests.some((request) => lastUserText(request).includes(PROMPT))).toBe(true);
    expect(screenText(screen)).toContain(PROMPT);
    expect(tui!.alive()).toBe(true);
    expect(host!.daemon.services.contractRunner.list({ includeTerminal: true })).toHaveLength(0);
    expect(host!.daemon.services.agentManager.list()).toHaveLength(0);
    await tui!.stop();
  });

  test('the headless entry point exits 0 with the reply, and nothing reached the outside network', async () => {
    const home = ownedHome!;
    const child = Bun.spawn([resolveBinary(), '--prompt', PROMPT, '--output-format', 'json'], {
      cwd: home.workspace, env: isolatedEnv(home, host!.env), stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ exitCode, stderr: exitCode ? stderr : '' }).toEqual({ exitCode: 0, stderr: '' });
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, response: REPLY });
      // The interactive session's check ran inside stop(); the headless child writes to the same log.
      const violations = join(home.root, 'network-violations.log');
      expect(existsSync(violations) ? readFileSync(violations, 'utf8') : '').toBe('');
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; }
  });
});
