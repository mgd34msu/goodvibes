// Proves: The shipped goodvibes-agent binary starts and completes a first turn on both of its routes (through a paired daemon, and in its own process when there is none).
// Red when: The daemon cannot start or pair, the compiled Agent does not reach its main screen or writes to stderr, or a first turn (through the daemon or in its own process) is not answered or creates work.
/**
 * The built `goodvibes-agent` binary in a real terminal, against a real daemon
 * and a scripted model at the HTTP wire:
 *
 *   first turn   a home paired with the daemon starts with nothing on stderr,
 *                and under Hybrid, the default policy, a typed prompt reaches
 *                the model, the host asks its scripted decision model about
 *                that turn, and the reply is drawn, with no contract or agent
 *                created for a plain turn.
 *   no host      a home with no connected host runs the prompt in this
 *                process (as its notice says): the reply is drawn and nothing
 *                is submitted.
 *
 * Each journey is split into steps, one test each, so every step stays inside the
 * per-test limit; a failed step fails the ones after it.
 */
import { startE2ENativeHost } from './native-host-fixture.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import {
  answerWorkspaceQuestion,
  inputAreaVisible,
  lastUserText,
  launchAgent,
  makeHome,
  closeE2EFixture,
  screenText,
  startStubModel,
  type AgentSession,
  type E2EHome,
} from './harness.ts';

const PROMPT = 'please answer the e2e marmot question';
const REPLY = 'The marmot answer is forty-two.';

const model = startStubModel((request) => (
  lastUserText(request).includes('marmot question') ? { text: REPLY } : { text: 'E2E side request' }
));
afterAll(() => model.stop());

describe('first turn against a paired host', () => {
  let agent: AgentSession | null = null;
  let home: E2EHome | null = null;
  let host: Awaited<ReturnType<typeof startE2ENativeHost>> | null = null;
  afterAll(() => closeE2EFixture(home, () => agent?.stop(), () => host?.stop()));

  test('a real daemon starts and this home is paired with it', async () => {
    home = await makeHome(model);
    host = await startE2ENativeHost(home);
  });

  test('the binary starts in a real terminal with nothing on stderr', async () => {
    agent = launchAgent(home!, { cols: 100, rows: 30, env: host!.env });
    await agent.waitForScreen('the main screen', inputAreaVisible);
    // A workspace this home has never seen: the first-start question comes first.
    await answerWorkspaceQuestion(agent, 'decline');
    expect(agent.stderr()).toBe('');
  });

  test('a typed prompt reaches the model and its reply is drawn, with no contract or agent created', async () => {
    agent!.type(PROMPT);
    agent!.key('Enter');
    const answered = await agent!.waitForScreen('the scripted reply', (s) => screenText(s).includes(REPLY));
    expect(model.requests.some((request) => lastUserText(request).includes(PROMPT))).toBe(true);
    expect(screenText(answered)).toContain(PROMPT);
    expect(host!.judgments.requests.some((request) => JSON.stringify(request.state).includes(PROMPT))).toBe(true);
    expect(host!.daemon.services.contractRunner.list({ includeTerminal: true })).toHaveLength(0);
    expect(host!.daemon.services.agentManager.list()).toHaveLength(0);
    expect(agent!.alive()).toBe(true);
  });
});

describe('no paired host', () => {
  let agent: AgentSession | null = null;
  let home: E2EHome | null = null;
  afterAll(() => closeE2EFixture(home, () => agent?.stop()));

  test('the binary starts without a host', async () => {
    home = await makeHome(model);
    agent = launchAgent(home, { cols: 100, rows: 30 });
    await agent.waitForScreen('the main screen', inputAreaVisible);
    await answerWorkspaceQuestion(agent, 'decline');
  });

  test('the first prompt runs in this process: its reply is drawn and nothing is submitted', async () => {
    const before = model.requests.length;
    agent!.type(PROMPT); agent!.key('Enter');
    // With no connected host, messages run in this process; the outcome waited on is the turn itself.
    await agent!.waitForScreen('the scripted reply', (s) => screenText(s).includes(REPLY));
    expect(model.requests.slice(before).some((request) => lastUserText(request).includes(PROMPT))).toBe(true);
    expect(existsSync(join(home!.home, '.goodvibes/agent/native-work-submission.json.intake'))).toBe(false);
    expect(agent!.alive()).toBe(true);
  });
});
