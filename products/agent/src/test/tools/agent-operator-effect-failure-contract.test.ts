import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { createShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createAgentOperatorMethodTool } from '../../tools/agent-operator-method-tool.ts';
import { createAgentOperatorActionTool } from '../../tools/agent-operator-action-tool.ts';
import { createOperatorInputProjector, operatorMethodIsOutward } from '../../tools/agent-operator-input-projector.ts';
import { recordedEffectFixture } from '../helpers/recorded-effect-admission.ts';
import { getSessionUntrustedContentLedger, resetSessionUntrustedContentLedgerForTests } from '../../trust/untrusted-content.ts';

let prior: ReturnType<typeof installJudgmentPort>, log: SqliteDecisionLog;
const roots: string[] = [], servers: Array<ReturnType<typeof Bun.serve>> = [];
beforeEach(() => {
  resetSessionUntrustedContentLedgerForTests();
  log = new SqliteDecisionLog(':memory:');
  const fake = fakePort((wireName, question) => {
    const name = wireName.replace(/^(effect|risk|edge)__/, '');
    if (question.type === 'choice') return choiceAnswer(question, name === 'disposition' ? 'act'
      : name === 'kind' ? Object.hasOwn(question.criteria, 'other') ? 'other' : 'read' : 'generic', 0.999);
    if (question.type === 'noul') return noulAnswer(0.001);
    throw new Error(`Unexpected question ${name}`);
  });
  prior = installJudgmentPort(withDecisionLog(fake.port, log));
});
afterEach(() => {
  resetSessionUntrustedContentLedgerForTests();
  installJudgmentPort(prior); log[Symbol.dispose]();
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scene(kind: 'action' | 'method') {
  const root = mkdtempSync(join(tmpdir(), 'agent-operator-failure-')); roots.push(root);
  mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(join(root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'fixture-private-operator-token' }));
  const requests: Array<{ url: string; method: string; body: string; ownerRequest: string | null }> = [];
  let duringRequest: (() => void) | undefined, beforeBody: (() => void) | undefined;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push({ url: request.url, method: request.method, body: await request.text(), ownerRequest: request.headers.get('x-goodvibes-explicit-user-request') });
    duringRequest?.();
    return Response.json({ status: 'queued' });
  } }); servers.push(server);
  const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'agent') });
  config.set('controlPlane.port', server.port!);
  const tool = kind === 'action' ? createAgentOperatorActionTool(paths, config) : createAgentOperatorMethodTool(paths, config);
  const execute = tool.execute;
  tool.execute = (args, options) => { beforeBody?.(); return execute(args, options); };
  const fixture = recordedEffectFixture(tool, 'prompt', {}, root);
  fixture.registry.unregister(tool.definition.name);
  fixture.registry.register(tool, { inputProjection: createOperatorInputProjector(paths, config, kind) });
  return { tool, fixture, requests,
    duringRequest(callback: () => void) { duringRequest = callback; },
    beforeBody(callback: () => void) { beforeBody = callback; } };
}
const untrusted = () => getSessionUntrustedContentLedger().record({ surface: 'web-page', origin: 'https://changed.example', at: new Date().toISOString() });
const errorOf = (result: { success: boolean; error?: string; output?: string }) => `${result.error ?? ''}`;

test.each(['.', '..'])('a method path parameter of %p is refused before any request', async segment => {
  const f = scene('method');
  const result = await f.fixture.run({ methodId: 'automation.jobs.run', input: { jobId: segment } });
  expect(result.success).toBe(false); expect(errorOf(result)).toContain('real identifier'); expect(f.requests).toHaveLength(0);
});
test('a path parameter that merely contains dots still dispatches to its own route', async () => {
  const f = scene('method');
  expect(await f.fixture.run({ methodId: 'automation.jobs.run', input: { jobId: 'nightly.v2' } })).toMatchObject({ success: true });
  expect(new URL(f.requests[0]!.url).pathname).toBe('/api/automation/jobs/nightly.v2/run');
});
test('an action target of ".." is refused before any request', async () => {
  const f = scene('action');
  const result = await f.fixture.run({ action: 'automation.jobs.run', jobId: '..' });
  expect(result.success).toBe(false); expect(errorOf(result)).toContain('real identifier'); expect(f.requests).toHaveLength(0);
});
test.each(['profile.read', 'profile.person', 'profile.get'])('%s is not readable through the generic method tool', async methodId => {
  const f = scene('method');
  const result = await f.fixture.run({ methodId, input: { name: 'Sam', fieldId: 'location.timezone' } });
  expect(result.success).toBe(false); expect(errorOf(result)).toContain('profile tool'); expect(f.requests).toHaveLength(0);
});
test.each(['payments.purchase.approve', 'payments.purchase.securityCode', 'payments.checkout.approve'])('%s is owner-only and never sent', async methodId => {
  const f = scene('method');
  const result = await f.fixture.run({ methodId, input: { purchaseId: 'p1' }, confirm: true, explicitUserRequest: 'owner asked to stop it' });
  expect(result.success).toBe(false); expect(errorOf(result)).toContain('/payments'); expect(f.requests).toHaveLength(0);
});
test('an admitted purchase stop is sent with the owner-request signal; an unadmitted one is not sent', async () => {
  const f = scene('method');
  const held = await f.tool.execute({ methodId: 'payments.purchase.cancel', input: { purchaseId: 'p1', operationId: 'o1' } });
  expect(held.success).toBe(false); expect(f.requests).toHaveLength(0);
  expect(await f.fixture.run({ methodId: 'payments.purchase.cancel', input: { purchaseId: 'p1', operationId: 'o1' } })).toMatchObject({ success: true });
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]!.ownerRequest).toBe('true'); expect(JSON.parse(f.requests[0]!.body)).toMatchObject({ purchaseId: 'p1', confirm: true });
});
test('an ordinary write carries no owner-request signal', async () => {
  const f = scene('method');
  expect(await f.fixture.run({ methodId: 'automation.jobs.run', input: { jobId: 'nightly' } })).toMatchObject({ success: true });
  expect(f.requests[0]!.ownerRequest).toBeNull();
});
test('removing an occasion through the method tool needs the ask-once confirmation', async () => {
  const f = scene('method');
  const refused = await f.fixture.run({ methodId: 'occasions.remove', input: { occasionId: 'fixture-occasion' } });
  expect(refused.success).toBe(false); expect(errorOf(refused)).toContain('confirmed:true'); expect(f.requests).toHaveLength(0);
  expect(await f.fixture.run({ methodId: 'occasions.remove', input: { occasionId: 'fixture-occasion', confirmed: true } })).toMatchObject({ success: true });
  expect(f.requests).toHaveLength(1);
});
test('a read-scoped GraphQL execute is treated as an effect, so an unadmitted call is held', async () => {
  const f = scene('method');
  const result = await f.tool.execute({ methodId: 'knowledge.graphql.execute', input: { query: 'mutation { x }' } });
  expect(result.success).toBe(false); expect(errorOf(result)).toContain('recorded effect admission'); expect(f.requests).toHaveLength(0);
});

for (const methodId of ['multimodal.analyze', 'homeassistant.conversation.submit', 'homeassistant.conversation.stream', 'batch.run', 'knowledge.ask', 'homeassistant.homeGraph.askHomeGraph']) {
  test(`${methodId} is treated as an effect, so an unadmitted call is held`, async () => {
    const f = scene('method');
    const result = await f.tool.execute({ methodId, input: {} });
    expect(result.success).toBe(false); expect(errorOf(result)).toContain('recorded effect admission'); expect(f.requests).toHaveLength(0);
  });
  // Write-scoped methods are held by the plain write check anyway, so the outward flag is asserted directly.
  test(`${methodId} is classed as an outward method`, () => { expect(operatorMethodIsOutward(methodId)).toBe(true); });
}

test('a failure after the write was sent says the outcome is unknown, not that admission is missing (method)', async () => {
  const f = scene('method'); f.duringRequest(untrusted);
  const result = await f.fixture.run({ methodId: 'services.start', input: {} });
  expect(f.requests).toHaveLength(1);
  expect(result.success).toBe(false); expect(errorOf(result)).toContain('outcome_unknown'); expect(errorOf(result)).toContain('before retrying');
  expect(errorOf(result)).not.toContain('connected_host_unavailable');
});
test('a failure after the write was sent says the outcome is unknown (action)', async () => {
  const f = scene('action'); f.duringRequest(untrusted);
  const result = await f.fixture.run({ action: 'automation.jobs.run', jobId: 'fixture-job' });
  expect(f.requests).toHaveLength(1);
  expect(result.success).toBe(false); expect(errorOf(result)).toContain('outcome_unknown'); expect(errorOf(result)).toContain('before retrying');
});
test('a failure before the request left says it was not sent (method)', async () => {
  const f = scene('method'); f.beforeBody(untrusted);
  const result = await f.fixture.run({ methodId: 'services.start', input: {} });
  expect(f.requests).toHaveLength(0);
  expect(result.success).toBe(false); expect(errorOf(result)).toContain('was not sent');
  expect(errorOf(result)).not.toContain('outcome_unknown');
});
