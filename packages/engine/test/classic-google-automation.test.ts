import { afterEach, beforeEach, expect, test } from 'bun:test';
import { DecisionModelsDisabledError, decisionModelPolicyState, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { withDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import { createAppPassword } from '../sdk/src/platform/google/app-password-flow.js';
import { captureIcsAddress } from '../sdk/src/platform/google/calendar-ics-flow.js';
import { createDesktopOAuthClient, publishApp, readPublishingStatus } from '../sdk/src/platform/google/console-flow.js';
import { readConsoleStatus } from '../sdk/src/platform/google/console-reading.js';
import { readVerificationArtifact } from '../sdk/src/platform/google/verification-reading.js';
import { googleSetupFixturePort } from './_helpers/google-setup-readings.js';
import { buildGoogleSetupRunners } from '../sdk/src/platform/google/setup-actions.js';
import { runGoogleSetupFlow } from '../sdk/src/platform/google/setup-flow.js';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS, stepSpec } from '../sdk/src/platform/google/setup-plan.js';
import type { GoogleSetupActionDeps } from '../sdk/src/platform/google/setup-action-deps.js';
import type { GoogleMutationOwnership } from '../sdk/src/platform/google/setup-effect.js';
import type { GoogleBrowserElement, GoogleBrowserPort } from '../sdk/src/platform/google/types.js';
import type { CandidateEmail, VerificationExpectation } from '../sdk/src/platform/google/verification-expectations.js';

let prior: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { prior = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(prior); });
function browser() {
  const calls: string[] = [];
  const port: GoogleBrowserPort = {
    async navigate(url) { calls.push('navigate'); return { url, title: 'Fixture' }; },
    async currentUrl() { calls.push('url'); return 'https://console.cloud.google.com/auth/audience'; },
    async snapshot() { calls.push('snapshot'); return []; },
    async readText() { calls.push('text'); return 'Publishing status: Testing'; },
    async click() { calls.push('click'); }, async type() { calls.push('type'); },
  };
  return { calls, port };
}
const flows = [
  (port: GoogleBrowserPort) => readPublishingStatus(port),
  (port: GoogleBrowserPort) => publishApp(port),
  (port: GoogleBrowserPort) => createDesktopOAuthClient(port, { name: 'Fixture' }),
  (port: GoogleBrowserPort) => createAppPassword(port),
  (port: GoogleBrowserPort) => captureIcsAddress(port),
];
for (const [index, flow] of flows.entries()) test(`Classic Google automation ${index} reports a manual alternative before any browser work`, async () => {
  const fixture = browser(); let requests = 0;
  installJudgmentPort({ model: 'fixture', async ask() { requests++; throw new Error('must not ask'); } });
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    await expect(flow(fixture.port)).rejects.toBeInstanceOf(DecisionModelsDisabledError);
    expect(fixture.calls).toEqual([]); expect(requests).toBe(0);
    await expect(readConsoleStatus('Publishing status: Testing')).rejects.toThrow('complete the step manually');
  });
});

test('Preferred missing configuration stops setup before navigation and leaves subsequent calls Classic', async () => {
  const fixture = browser();
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    await expect(publishApp(fixture.port)).rejects.toBeInstanceOf(DecisionModelsDisabledError);
    expect(decisionModelPolicyState()).toMatchObject({ operation: 'classic', reason: 'unavailable' });
    await expect(createAppPassword(fixture.port)).rejects.toBeInstanceOf(DecisionModelsDisabledError);
    expect(fixture.calls).toEqual([]);
  });
});

test('an outage after publishing clicks retains those effects without replay or a success claim', async () => {
  const fixture = browser(); const base = googleSetupFixturePort(); let requests = 0, navigations = 0;
  const clicked: string[] = [];
  fixture.port.navigate = async url => { navigations++; return { url, title: 'Fixture' }; };
  fixture.port.snapshot = async (): Promise<readonly GoogleBrowserElement[]> => [{
    ref: clicked.length === 0 ? 'publish' : 'confirm', role: 'button', tag: 'button',
    name: clicked.length === 0 ? 'PUBLISH APP' : 'Confirm',
  }];
  fixture.port.click = async ref => { clicked.push(ref); };
  installJudgmentPort({ ...base.port, async ask(request) {
    requests++;
    if (clicked.length === 2) throw new JudgmentError('unavailable', 'fixture chain exhausted after publish');
    return base.port.ask(request);
  } });
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    await expect(publishApp(fixture.port)).rejects.toBeInstanceOf(DecisionModelsDisabledError);
    expect(clicked).toEqual(['publish', 'confirm']);
    expect(navigations).toBe(2);
    expect(decisionModelPolicyState()).toMatchObject({ operation: 'classic', reason: 'unavailable' });
    const before = requests;
    await expect(publishApp(fixture.port)).rejects.toBeInstanceOf(DecisionModelsDisabledError);
    expect(clicked).toEqual(['publish', 'confirm']); expect(requests).toBe(before);
  });
});

for (const kind of ['rejected', 'invalid-response', 'invalid-request', 'aborted'] as const) test(`Google setup preserves ${kind} instead of activating Preferred fallback`, async () => {
  const failure = new JudgmentError(kind, 'fixture failure'); const fixture = browser();
  installJudgmentPort({ model: 'fixture', async ask() { throw failure; } });
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    await expect(readPublishingStatus(fixture.port)).rejects.toBe(failure);
    expect(decisionModelPolicyState().operation).toBe('decision');
    expect(fixture.calls).not.toContain('click');
  });
});

test('Classic verification selection is explicit and never screens or returns an inferred private code', async () => {
  const email: CandidateEmail = { messageId: 'fixture', from: 'sender@example.com', deliveredTo: null, toHeaderClaim: 'owner@example.com', subject: 'Verification', body: 'Order: 123456. Verification: 987654.' };
  const expectation: VerificationExpectation = { id: 'fixture', kind: 'signup', serviceDomain: 'example.com', recipientAddress: 'owner@example.com', purpose: 'fixture', openedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), authority: 'evidence-only' };
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    await expect(readVerificationArtifact(email, expectation)).rejects.toBeInstanceOf(DecisionModelsDisabledError);
    expect(expectation.authority).toBe('evidence-only');
  });
});

test('cancelled or replaced native owners cannot downgrade an unavailable Google flow', async () => {
  const abort = new AbortController(); const fixture = browser();
  installJudgmentPort({ model: 'fixture', async ask() { abort.abort('private reason'); throw new JudgmentError('unavailable', 'fixture exhausted'); } });
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    await expect(readPublishingStatus(fixture.port, { signal: abort.signal })).rejects.toThrow();
    expect(decisionModelPolicyState().operation).toBe('decision');
    expect(fixture.calls).not.toContain('click');
  });
});

function setup() {
  const fixture = browser(); let browsers = 0, exchanges = 0, closes = 0;
  const config = new Map<string, unknown>([[GOOGLE_CONFIG_KEYS.oauthClientId, 'fixture.apps.googleusercontent.com'], [GOOGLE_CONFIG_KEYS.oauthPublishingStatus, 'in-production']]);
  const secrets = new Map<string, string>([[GOOGLE_SECRET_KEYS.oauthClientSecret, 'synthetic-private-client-secret']]);
  const publish = (ownership: GoogleMutationOwnership | undefined, write: () => void) => {
    ownership?.assertCurrent(); ownership?.consumeObservation(); write(); ownership?.committed();
  };
  const deps: GoogleSetupActionDeps = {
    config: { get: key => config.get(key), set(key, value, ownership) { publish(ownership, () => config.set(key, value)); } },
    secrets: { async get(key) { return secrets.get(key) ?? null; }, async set(key, value, ownership) { publish(ownership, () => secrets.set(key, value)); } },
    async browser() { browsers++; return fixture.port; },
    commands: { async run() { throw new Error('unexpected command'); } },
    files: { readText() { return null; }, exists() { return false; } }, homeDirectory: '/synthetic',
    fetchPort: { async fetch() { exchanges++; return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'Bearer', scope: 'synthetic' }); } },
    loopback: options => ({ redirectUri: 'http://127.0.0.1:32123/oauth/callback', async waitForCode() { return { code: 'synthetic-code', state: options.expectedState }; }, close() { closes++; } }),
    async proveConnection() { return { ok: true, detail: 'Synthetic mail and calendar reads completed.' }; },
  };
  return { deps, fixture, config, secrets, counts: () => ({ browsers, exchanges, closes }) };
}

test('Classic explicit OAuth consent and credential publication work without page interpretation, and reruns do not repeat the exchange', async () => {
  const fixture = setup(); let requests = 0;
  installJudgmentPort({ model: 'fixture', async ask() { requests++; throw new Error('must not ask'); } });
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const progress = { stepStarted() {}, stepFinished() {}, humanActionNeeded() {}, note() {} };
    const first = await runGoogleSetupFlow('existing-client', { runners: buildGoogleSetupRunners('existing-client', fixture.deps), progress });
    expect(first).toMatchObject({ ok: true, provenance: 'classic' });
    expect(fixture.secrets.get(GOOGLE_SECRET_KEYS.oauthRefreshToken)).toBe('synthetic-refresh');
    expect(fixture.counts()).toEqual({ browsers: 1, exchanges: 1, closes: 1 });
    const second = await runGoogleSetupFlow('existing-client', { runners: buildGoogleSetupRunners('existing-client', fixture.deps), progress });
    expect(second.ok).toBe(true);
    expect(second.steps[0]?.outcome).toBe('already-done');
    expect(fixture.counts()).toEqual({ browsers: 1, exchanges: 1, closes: 1 });
    expect(requests).toBe(0);
  });
});

test('Classic automated account steps hand off before opening a browser, while native stored credentials remain inspectable', async () => {
  const fixture = setup();
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const runners = buildGoogleSetupRunners('app-password', fixture.deps);
    for (const id of ['google-signed-in', 'two-step-verification', 'app-password'] as const) {
      const result = await runners.get(id)!(stepSpec(id));
      expect(result.outcome).toBe('needs-human');
      expect(result.problem).toContain('Classic'); expect(result.fix?.length).toBeGreaterThan(0);
    }
    expect(fixture.counts().browsers).toBe(0);
    fixture.secrets.set(GOOGLE_SECRET_KEYS.appPassword, 'synthetic-stored-app-password');
    const stored = await runners.get('app-password')!(stepSpec('app-password'));
    expect(stored.outcome).toBe('already-done'); expect(fixture.counts().browsers).toBe(0);
  });
});
