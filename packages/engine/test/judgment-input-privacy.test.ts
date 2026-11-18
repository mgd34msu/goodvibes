// Proves: A credential, private key, URL password or card number in a call's arguments is sent to the hosted decision model.
// Red when: The permission manager reads a call with the decision model although the judgment-input boundary refused its arguments, or the hosted decision port sends the literal of a credential the boundary passed (a short password, an environment credential), so the secret reaches the model's request.
/**
 * A hosted decision is itself an outward transmission. In jev-decides the real
 * permission manager over a real settings manager checks one call of each kind
 * of secret: none reaches the decision model, and none is approved. A short
 * literal in a credential declaration is not refused: that call is read and
 * decided, so the refusals are not a model that is never reached, and the
 * request carries a marker where the literal was.
 *
 * The decision port is the product's own (composeJudgment: settings, masking,
 * decision log). The hosted model is the stand-in: a loopback decision server
 * that records every request and answers the gate's readings and an act
 * disposition.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { choiceAnswer, startScriptedDecisionServer, type ScriptedDecisionServer } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { createPermissionConfigReader, PermissionManager } from '../platform/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { composeJudgment } from '../platform/src/platform/runtime/judgment-services.ts';
import { forgetGateReadings, gateReadingAnswers } from './_helpers/gate-readings.ts';
import { syntheticCredential } from '../platform/src/platform/utils/fixture-credentials.ts';

// Credential-shaped values are assembled at run time (utils/fixture-credentials.ts), so no
// file holds a whole shape a secret scanner reports.
const OPENAI_FIXTURE_KEY = syntheticCredential('sk-proj-', 'privacy openai key', 32);
const GITHUB_FIXTURE_TOKEN = syntheticCredential('ghp_', 'privacy github token', 36);

let dir: string;
let model: ScriptedDecisionServer;
let teardowns: Array<() => unknown>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-judgment-privacy-'));
  teardowns = [];
  forgetGateReadings();
  const readings = gateReadingAnswers();
  model = startScriptedDecisionServer({ model: 'fixture-model', script: (name, question, state) =>
    name.endsWith('disposition') && question.type === 'choice' ? choiceAnswer(question, 'act', 0.97) : readings(name, question, state) });
});
afterEach(async () => {
  for (const teardown of teardowns.reverse()) await teardown();
  await model.stop();
  forgetGateReadings();
  rmSync(dir, { recursive: true, force: true });
});

test('no secret in a call reaches the decision model and the call is not approved; a credential the screen passes is read with its value masked', async () => {
  const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: join(dir, 'workspace'), homeDir: join(dir, 'home'), configDir: join(dir, 'config'), ownsDaemonTier: true });
  expect(config.setMany([
    { key: 'permissions.mode' as ConfigKey, value: 'jev-decides' },
    { key: 'judgment.endpoint' as ConfigKey, value: model.baseURL },
    { key: 'judgment.model' as ConfigKey, value: 'fixture-model' },
    { key: 'judgment.keySource' as ConfigKey, value: 'secret' },
  ], { kind: 'owner', surface: 'fixture' }).ok).toBe(true);
  composeJudgment({ config, env: {}, stateRoot: join(dir, 'state'),
    secrets: { get: async (key) => (key === 'TYPESAFE_API_KEY' ? 'fixture-decision-key' : null) },
    disposal: { add: (_label, dispose) => { teardowns.push(dispose); } } });
  const reader = createPermissionConfigReader(config);
  expect(reader.isDecisionModelReady?.()).toBe(true);
  const manager = new PermissionManager(async () => ({ approved: false }), reader, new PolicyRuntimeState(), null, null, null, {});
  const exec = (cmd: string) => ['exec', { commands: [{ cmd }] }] as const;
  const secrets: ReadonlyArray<readonly [string, string, Record<string, unknown>]> = [
    ['a declared credential field', 'mcp_fixture_login', { username: 'owner', password: 'correct-horse-battery' }],
    ['a key-shaped literal in a command', ...exec(`export OPENAI_API_KEY=${OPENAI_FIXTURE_KEY}`)],
    ['a private key block', 'write', { files: [{ path: 'id_fixture', content: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n' }] }],
    ['a URL with a password', ...exec('curl https://admin:Tr0ub4dor-fixture@example.com/export')],
    ['a card number', ...exec('echo 4111 1111 1111 1111 > card.txt')],
  ];
  for (const [kind, tool, args] of secrets) {
    const result = await manager.checkDetailed(tool, args);
    expect(`${kind}: ${model.requests.length} requests, approved ${result.approved}, ${result.reasonCode}`)
      .toBe(`${kind}: 0 requests, approved false, boundary_judgment_input`);
  }
  // The control: a credential the screen passes (a short password, an environment credential of
  // any shape) is read and decided, and what reached the model names it without its value.
  const passed = [
    ['DB_PASSWORD=hunter2 make migrate', 'hunter2', 'DB_PASSWORD=[credential]'],
    [`GITHUB_TOKEN=${GITHUB_FIXTURE_TOKEN} gh repo list`, GITHUB_FIXTURE_TOKEN, 'GITHUB_TOKEN=[credential]'],
  ] as const;
  for (const [cmd, literal, marker] of passed) {
    const before = model.requests.length;
    const result = await manager.checkDetailed(...exec(cmd));
    const wire = JSON.stringify(model.requests.slice(before));
    expect({ cmd, read: model.requests.length > before, literal: wire.includes(literal), marker: wire.includes(marker), approved: result.approved, by: result.sourceLayer })
      .toEqual({ cmd, read: true, literal: false, marker: true, approved: true, by: 'jev_decision' });
  }
  model.assertNoUnexpected();
});
