import { afterEach, expect, test } from 'bun:test';
import { installJudgmentPort, judgmentPort, type DecisionModelPolicy } from '@goodvibes-jev/engine/errors';
import { DEFAULT_MODEL, JudgmentError, noul, type JudgmentPort } from '@goodvibes-jev/judgment';
import { judgmentConfigDefaults } from '../platform/src/platform/config/schema-domain-judgment.ts';
import { decisionModelSet, decisionModelSettings } from '../platform/src/platform/config/decision-model-set.ts';
import {
  configureDecisionModelPolicy, decisionModelUse, decisionOrClassic, onDecisionModelEpisode, resetDecisionModelEpisode,
  withConfiguredDecisionModelPolicy, type DecisionModelEpisodeNotice,
} from '../platform/src/platform/runtime/decision-policy.ts';
import { createSettingsJudgmentPort, type JudgmentSettingsSource } from '../platform/src/platform/runtime/judgment-services.ts';

// The real settings port, decision policy and failure episodes; the decision
// model is a loopback server, absent (connection refused) or answering.

type Settings = Record<string, unknown>;
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); resetDecisionModelEpisode(); });

/** Composes the policy and the settings port over `settings`, as composeJudgment does, and counts what reaches the port. */
function compose(settings: Settings): { readonly asked: () => number; readonly notices: DecisionModelEpisodeNotice[] } {
  const defaults: Settings = Object.fromEntries(Object.entries(judgmentConfigDefaults.judgment).map(([key, value]) => [`judgment.${key}`, value]));
  const all = { ...defaults, ...settings };
  const env: Record<string, string | undefined> = {};
  const source: JudgmentSettingsSource = {
    config: { get: key => all[key] },
    secrets: { get: async () => null },
    env,
  };
  cleanups.push(configureDecisionModelPolicy(() => all['judgment.policy'], () => decisionModelSet(decisionModelSettings(key => all[key]), env)));
  const settingsPort = createSettingsJudgmentPort(source);
  let asked = 0;
  const port: JudgmentPort = { get model() { return settingsPort.model; }, ask(request) { asked += 1; return settingsPort.ask(request); } };
  const previous = installJudgmentPort(port);
  cleanups.push(() => { installJudgmentPort(previous); });
  const notices: DecisionModelEpisodeNotice[] = [];
  cleanups.push(onDecisionModelEpisode(notice => { notices.push(notice); }));
  return { asked: () => asked, notices };
}

/** One operation with one decision, as a decision site asks it: the model's answer, or the fallback. */
function decideOnce(): Promise<'model' | 'fallback'> {
  return withConfiguredDecisionModelPolicy(() => decisionOrClassic(async () => {
    await judgmentPort('proof.decision').ask({ state: 'state', questions: { yes: noul('Is it so?') }, signal: new AbortController().signal });
    return 'model' as const;
  }, () => 'fallback' as const));
}

/** A loopback address where nothing listens: every connection is refused. */
function refusingEndpoint(): { readonly url: string; readonly port: number } {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('unused') });
  const port = server.port!;
  server.stop(true);
  return { url: `http://127.0.0.1:${port}`, port };
}

/** A decision model answering on `port`. */
function answerOn(port: number): void {
  const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => Response.json({ model: DEFAULT_MODEL, answers: { yes: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } }) });
  cleanups.push(() => { server.stop(true); });
}

const setModel = (url: string, policy: DecisionModelPolicy): Settings => ({
  'judgment.policy': policy, 'judgment.endpoint': url, 'judgment.keySource': 'none', 'judgment.model': DEFAULT_MODEL,
});

test('with no decision model set, every policy continues on the fallback with no request and no error', async () => {
  for (const policy of ['Hybrid', 'Decision Model Only'] as const) {
    const composed = compose({ 'judgment.policy': policy });
    expect([await decideOnce(), await decideOnce(), await decideOnce()]).toEqual(['fallback', 'fallback', 'fallback']);
    expect(composed.asked()).toBe(0);
    expect(composed.notices).toEqual([]);
    // The standing indication says so.
    expect(decisionModelUse()).toMatchObject({ inUse: false, reason: 'not-set' });
    while (cleanups.length > 0) cleanups.pop()!();
  }
});

test('Hybrid: a set model that refuses the connection continues on the fallback with one error per episode, and recovery is told once', async () => {
  const endpoint = refusingEndpoint();
  const composed = compose(setModel(endpoint.url, 'Hybrid'));
  expect([await decideOnce(), await decideOnce(), await decideOnce()]).toEqual(['fallback', 'fallback', 'fallback']);
  expect(composed.asked()).toBe(3);
  expect(composed.notices).toHaveLength(1);
  const failing = composed.notices[0]!;
  expect(failing).toMatchObject({ kind: 'failing', level: 'error', model: DEFAULT_MODEL });
  expect(failing.message).toContain(`The decision model ${DEFAULT_MODEL} is unavailable`);
  expect(failing.message).toContain('Next:');
  expect(decisionModelUse()).toMatchObject({ inUse: false, reason: 'unavailable', failure: { model: DEFAULT_MODEL } });

  answerOn(endpoint.port);
  expect(await decideOnce()).toBe('model');
  expect(composed.notices.map(notice => notice.kind)).toEqual(['failing', 'recovered']);
  expect(decisionModelUse()).toMatchObject({ inUse: true, reason: null });
});

test('Decision Model Only: a set model that refuses the connection halts the operation and reports it once', async () => {
  const composed = compose(setModel(refusingEndpoint().url, 'Decision Model Only'));
  for (let call = 0; call < 2; call += 1) {
    const halted = await decideOnce().then(() => undefined, (error: unknown) => error);
    expect(halted).toBeInstanceOf(JudgmentError);
    expect((halted as JudgmentError).kind).toBe('unavailable');
  }
  expect(composed.notices).toHaveLength(1);
  expect(composed.notices[0]!.message).toContain('work that needs it stops');
});
