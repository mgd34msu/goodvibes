// Proves: The shipped goodvibes binary starts, completes an interactive first turn, and its headless entry point exits 0 with the reply as JSON and reaches no outside network.
// Red when: The daemon cannot start or pair, the compiled terminal does not reach its input area or writes to stderr, a first turn is not answered or creates work, or the headless run does not exit 0 with JSON, or tries the network.
// Proves: A headless run whose turn failed at the provider exits with a code other than the documented failure code 1, so a script or CI job takes the failure for done or for an outcome it must not retry.
// Red when: The headless entry point does not set exit code 1 when the turn ends in an error (it exits 0, or 3 for an unknown outcome), or writes more than the one JSON result to stdout.
/**
 * The built `goodvibes` binary on a fresh home, against a real daemon and a
 * scripted model at the HTTP wire: it starts in a real terminal with nothing on
 * stderr, a typed prompt reaches the model, and the model's reply is drawn; the
 * same prompt through the headless entry point exits 0 with the reply as JSON.
 * The interactive turn runs under Hybrid, the default policy, against a scripted
 * decision model on the HTTP wire, which it asks; the headless run is set to No
 * Decision Model and asks it nothing. No contract or agent is created for a
 * plain conversation turn, and the compiled process makes no external network
 * request.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startE2ENativeHost } from './native-host-fixture.ts';
import { closeE2EFixture, inputAreaVisible, isolatedEnv, lastUserText, launchTui, makeHome, resolveBinary, screenText, startStubModel, type E2EHome, type TuiSession } from './harness.ts';

const PROMPT = 'give this project a code review';
const REPLY = 'I will review the project code.';

const FAILING = 'this request is refused by the provider';

const model = startStubModel((request) => (
  lastUserText(request).includes(PROMPT) ? { text: REPLY }
    : lastUserText(request).includes(FAILING) ? { status: 400, error: 'The request was refused.' }
      : { text: 'E2E side request' }
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
  });

  test('the binary starts in a real terminal with nothing on stderr', async () => {
    const home = ownedHome!;
    tui = launchTui(home, { cols: 100, rows: 30, env: host!.env });
    await tui.waitForScreen('the input area', inputAreaVisible);
    const stderrFile = readdirSync(home.root).find((name) => name.endsWith('.stderr'))!;
    expect(readFileSync(join(home.root, stderrFile), 'utf8')).toBe('');
  });

  test('under Hybrid a typed prompt reaches the model, the decision model is asked, and the reply is drawn, with no contract or agent created', async () => {
    tui!.type(PROMPT);
    tui!.key('Enter');
    const screen = await tui!.waitForScreen('the scripted reply', (s) => screenText(s).includes(REPLY));
    expect(model.requests.some((request) => lastUserText(request).includes(PROMPT))).toBe(true);
    expect(screenText(screen)).toContain(PROMPT);
    expect(host!.judgments.requests.length).toBeGreaterThan(0);
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

  test('a headless run whose turn fails at the provider exits 1 with one JSON result that says so', async () => {
    const home = ownedHome!;
    const child = Bun.spawn([resolveBinary(), '--prompt', FAILING, '--output-format', 'json'], {
      cwd: home.workspace, env: isolatedEnv(home, host!.env), stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(exitCode).toBe(1);
      // stdout is the one JSON object a script parses, and nothing else.
      const result = JSON.parse(stdout) as { ok?: unknown; stopReason?: unknown };
      expect(result.ok).toBe(false);
      expect(typeof result.stopReason).toBe('string');
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; }
  });
});
