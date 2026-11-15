import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { AgentAccountRegistry } from '@goodvibes-jev/engine/platform/platform/google';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createAgentAccountsTool, registerAgentAccountsTool, type AgentAccountsToolOptions } from '../../tools/agent-accounts-tool.ts';
import { containsSecretLikeText } from '../../agent/memory-safety.ts';
import { getSessionExpectationBook, resetSessionExpectationBookForTests } from '../../agent/signup/session-expectations.ts';
import { resetSessionUntrustedContentLedgerForTests } from '../../trust/untrusted-content.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { recordedEffectFixture } from '../helpers/recorded-effect-admission.ts';
import { createShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';

const VALID = { action: 'record', serviceDomain: 'example.com', serviceUrl: 'https://example.com/signup',
  aliasAddress: 'agent+example@owner.test', purpose: 'reading account docs', credentialSecretKey: 'GOODVIBES_ACCOUNT_EXAMPLE_COM' };
let prior: ReturnType<typeof installJudgmentPort>, log: SqliteDecisionLog;
let readings = 0;
const roots: string[] = [];
beforeEach(() => {
  resetSessionExpectationBookForTests(); resetSessionUntrustedContentLedgerForTests(); readings = 0;
  log = new SqliteDecisionLog(':memory:');
  const fake = fakePort((wireName, question) => {
    const name = wireName.replace(/^(effect|risk|edge)__/, '');
    if (!/^(effect|risk|edge)__/.test(wireName)) readings++;
    if (question.type === 'choice') return choiceAnswer(question, name === 'disposition' ? 'act' : name === 'kind' ? 'read' : 'generic', 0.999);
    if (question.type === 'noul') return noulAnswer(0.001);
    throw new Error(`Unexpected question ${name}`);
  });
  prior = installJudgmentPort(withDecisionLog(fake.port, log));
});
afterEach(() => {
  installJudgmentPort(prior); log[Symbol.dispose](); resetSessionExpectationBookForTests(); resetSessionUntrustedContentLedgerForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function scene(knownSecretKeys?: () => Promise<readonly string[]>, nested = false) {
  const root = makeProjectTempDir('account-authority'); roots.push(root);
  const path = join(root, ...(nested ? ['new', 'directory'] : []), 'accounts.json');
  let beforeSafety: (() => void) | undefined;
  const store = new AgentAccountRegistry({ storePath: path, containsSecretLikeText(text) { beforeSafety?.(); return containsSecretLikeText(text); } });
  const options: AgentAccountsToolOptions = { registry: store, shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }), baseAddress: () => 'owner@example.com', ...(knownSecretKeys ? { knownSecretKeys } : {}) };
  const tool = createAgentAccountsTool(options), fixture = recordedEffectFixture(tool, 'prompt', {}, root);
  fixture.registry.unregister('accounts'); registerAgentAccountsTool(fixture.registry, options);
  return { root, path, store, options, tool, fixture, beforeSafety(callback: () => void) { beforeSafety = callback; } };
}
/** A held admission is thrown to the tool runtime, which words it; either way nothing succeeded. */
async function settled(result: Promise<{ success: boolean; error?: string | undefined }>) {
  return result.catch((error: unknown) => ({ success: false, error: String(error) }));
}
function actions() { return [{ action: 'alias', serviceDomain: 'github.com' }, VALID, { action: 'forget', id: 'example-com' }, { action: 'sweep' }]; }

test('raw forged flags cannot open an expectation or mutate the account file', async () => {
  const current = scene();
  for (const args of actions()) expect(await settled(current.tool.execute({ ...args, confirm: true, explicitUserRequest: 'Caller assertion' }))).toMatchObject({ success: false });
  expect(existsSync(current.path)).toBe(false); expect(getSessionExpectationBook().list()).toHaveLength(0); expect(readings).toBe(0);
});

test('real recorded admission performs alias, record, forget and sweep without confirmation flags', async () => {
  const current = scene();
  expect(await current.fixture.run({ action: 'alias', serviceDomain: 'github.com' })).toMatchObject({ success: true });
  expect(getSessionExpectationBook().list()).toHaveLength(1);
  expect(await current.fixture.run(VALID)).toMatchObject({ success: true }); expect(current.store.list()).toHaveLength(1);
  expect(await current.fixture.run({ action: 'forget', id: 'example-com' })).toMatchObject({ success: true }); expect(current.store.list()).toHaveLength(0);
  expect(await current.fixture.run({ action: 'sweep' })).toMatchObject({ success: true }); expect(readings).toBe(0);
});

test('a sweep with no secret store says credential presence was not checked, and one with it does not', async () => {
  const without = scene();
  const unchecked = await without.fixture.run({ action: 'sweep' });
  expect(unchecked).toMatchObject({ success: true });
  expect(unchecked.output).toContain('Credential presence could not be checked');

  const withStore = scene(async () => []);
  const checked = await withStore.fixture.run({ action: 'sweep' });
  expect(checked).toMatchObject({ success: true });
  expect(checked.output).not.toContain('Credential presence could not be checked');
});

test('owned writes create missing parents without invalidating their own source fence', async () => {
  const current = scene(undefined, true);
  expect(await current.fixture.run(VALID)).toMatchObject({ success: true });
  expect(current.store.list()).toHaveLength(1);
});

test('synthetic read admission cannot bypass read-only and custom write-deny floors', async () => {
  for (const mode of ['plan', 'custom'] as const) {
    const current = scene();
    const fixture = recordedEffectFixture(current.tool, mode, mode === 'custom' ? { write: 'deny' } : {}, current.root);
    fixture.registry.unregister('accounts'); registerAgentAccountsTool(fixture.registry, current.options);
    for (const args of actions()) expect(await settled(fixture.run(args))).toMatchObject({ success: false });
    expect(existsSync(current.path)).toBe(false); expect(getSessionExpectationBook().list()).toHaveLength(0);
  }
});

test.each(['cancel', 'revoke'] as const)('sweep holds %s after the awaited key-store read', async change => {
  const abort = new AbortController();
  let mutate: () => void = () => {};
  const current = scene(async () => { await Promise.resolve(); mutate(); return []; });
  current.store.record(VALID);
  const original = readFileSync(current.path, 'utf8');
  mutate = () => { if (change === 'cancel') abort.abort(); else current.fixture.setMode('plan'); };
  expect(await settled(current.fixture.run({ action: 'sweep' }, abort.signal))).toMatchObject({ success: false });
  expect(readFileSync(current.path, 'utf8')).toBe(original);
});

test('a file created in the workspace during a call does not fail it', async () => {
  const current = scene(async () => { writeFileSync(join(current.root, 'unrelated.txt'), 'x'); return []; });
  current.store.record(VALID);
  expect(await current.fixture.run({ action: 'sweep' })).toMatchObject({ success: true });
  expect(await current.fixture.run({ action: 'list' })).toMatchObject({ success: true });
});

test('a secret-looking record value is refused with where the secret goes instead', async () => {
  const current = scene();
  const result = await current.fixture.run({ ...VALID, credentialSecretKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD' });
  expect(result).toMatchObject({ success: false });
  expect(result.error).toContain('record only its key name');
  expect(existsSync(current.path)).toBe(false);
});

test.each(['cancel', 'revoke'] as const)('the final rename is held for late %s and cleans its private temporary file', async change => {
  const current = scene(), abort = new AbortController(); current.store.record(VALID);
  const original = readFileSync(current.path, 'utf8'); let observedTemporary = false;
  current.beforeSafety(() => current.fixture.beforeAuthorityRead(() => {
    if (!readdirSync(current.root).some(name => name.endsWith('.tmp'))) return;
    observedTemporary = true;
    if (change === 'cancel') abort.abort(); else current.fixture.setMode('plan');
  }));
  expect(await settled(current.fixture.run({ action: 'forget', id: 'example-com' }, abort.signal))).toMatchObject({ success: false });
  expect(observedTemporary).toBe(true); expect(readFileSync(current.path, 'utf8')).toBe(original);
  expect(readdirSync(current.root).filter(name => name.endsWith('.tmp'))).toEqual([]);
});
