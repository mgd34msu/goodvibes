/**
 * The built `goodvibes-agent` binary in a real terminal, against a real daemon
 * and a scripted model at the HTTP wire:
 *
 *   first turn   a home paired with the daemon starts with nothing on stderr,
 *                and a typed prompt reaches the model and its reply is drawn,
 *                with no contract or agent created for a plain turn.
 *   no host      a home with no paired host never sends the prompt to the model
 *                and writes no submission.
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
    // The proof is about the program's own path to the model, not a decision model's judgment: Jev is switched off.
    home.setAgentSetting('judgment.policy', 'No Decision Model');
    host = await startE2ENativeHost(home, { policy: 'No Decision Model' });
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
    home.setAgentSetting('judgment.policy', 'No Decision Model');
    agent = launchAgent(home, { cols: 100, rows: 30 });
    await agent.waitForScreen('the main screen', inputAreaVisible);
    await answerWorkspaceQuestion(agent, 'decline');
  });

  test('the first prompt never reaches the model and writes no submission', async () => {
    const before = model.requests.length;
    agent!.type(PROMPT); agent!.key('Enter');
    // The composer clears once the prompt was taken and refused; nothing is sent anywhere.
    await agent!.waitForScreen('the refused prompt taken from the composer', (s) => !screenText(s).includes(REPLY) && /operator token/i.test(screenText(s)));
    expect(model.requests).toHaveLength(before);
    expect(existsSync(join(home!.home, '.goodvibes/agent/native-work-submission.json.intake'))).toBe(false);
    expect(agent!.alive()).toBe(true);
  });
});
