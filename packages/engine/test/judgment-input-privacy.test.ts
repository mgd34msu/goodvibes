// Proves: A credential, private key, URL password or card number in a call's arguments is sent to the hosted decision model.
// Red when: The permission manager reads a call with the decision model although the judgment-input boundary refused its arguments, so the secret reaches the model's request.
/**
 * A hosted decision is itself an outward transmission. In jev-decides the real
 * permission manager over a real settings manager checks one call of each kind
 * of secret: none reaches the decision port, and none is approved. A short
 * literal in a credential declaration is not refused: that call is read and
 * decided, so the refusals are not a port that is never reached. (Masking the
 * short literal is the hosted port's own step, runtime/judgment-services.ts.)
 *
 * The decision port is the stand-in for the hosted model: it records every
 * request and answers the gate's readings and an act disposition.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { createPermissionConfigReader, PermissionManager } from '../platform/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { forgetGateReadings, gateReadingsPort } from './_helpers/gate-readings.ts';

let dir: string;
let sent: string[];
let restore: () => void;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-judgment-privacy-'));
  sent = [];
  forgetGateReadings();
  const readings = gateReadingsPort();
  const disposition = fakePort((name, question) => {
    if (name !== 'disposition') throw new Error(`unexpected question ${name}`);
    return choiceAnswer(question, 'act', 0.97);
  });
  const log = new SqliteDecisionLog(':memory:');
  const port: JudgmentPort = { model: 'fixture-model', ask: (request) => {
    sent.push(JSON.stringify(request));
    return request.context?.site === 'engine.gate.autonomous-tool' ? disposition.port.ask(request) : readings.port.ask(request);
  } };
  const previous = installJudgmentPort(withDecisionLog(port, log));
  restore = () => { installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings(); };
});
afterEach(() => { restore(); rmSync(dir, { recursive: true, force: true }); });

test('no secret in a call reaches the decision model and the call is not approved; a call the screen passes is read', async () => {
  const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: join(dir, 'workspace'), homeDir: join(dir, 'home'), configDir: join(dir, 'config'), ownsDaemonTier: true });
  expect(config.setMany([
    { key: 'permissions.mode' as ConfigKey, value: 'jev-decides' },
    { key: 'judgment.endpoint' as ConfigKey, value: 'http://127.0.0.1:9/v1' },
    { key: 'judgment.model' as ConfigKey, value: 'fixture-model' },
    { key: 'judgment.keySource' as ConfigKey, value: 'secret' },
  ], { kind: 'owner', surface: 'fixture' }).ok).toBe(true);
  const reader = createPermissionConfigReader(config);
  expect(reader.isDecisionModelReady?.()).toBe(true);
  const manager = new PermissionManager(async () => ({ approved: false }), reader, new PolicyRuntimeState(), null, null, null, {});
  const exec = (cmd: string) => ['exec', { commands: [{ cmd }] }] as const;
  const secrets: ReadonlyArray<readonly [string, string, Record<string, unknown>]> = [
    ['a declared credential field', 'mcp_fixture_login', { username: 'owner', password: 'correct-horse-battery' }],
    ['a key-shaped literal in a command', ...exec('export OPENAI_API_KEY=sk-proj-Q7vR2mX9kL4pT8wZ3nB6yC1dF5gH0jK2')],
    ['a private key block', 'write', { files: [{ path: 'id_fixture', content: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n' }] }],
    ['a URL with a password', ...exec('curl https://admin:Tr0ub4dor-fixture@example.com/export')],
    ['a card number', ...exec('echo 4111 1111 1111 1111 > card.txt')],
  ];
  for (const [kind, tool, args] of secrets) {
    const result = await manager.checkDetailed(tool, args);
    expect(`${kind}: ${sent.length} requests, approved ${result.approved}, ${result.reasonCode}`)
      .toBe(`${kind}: 0 requests, approved false, boundary_judgment_input`);
  }
  // The control: a short literal in a credential declaration passes the screen, and the call is read and decided.
  const short = await manager.checkDetailed(...exec('DB_PASSWORD=hunter2 make migrate'));
  expect(sent.length).toBeGreaterThan(0);
  expect(short).toMatchObject({ approved: true, sourceLayer: 'jev_decision' });
});
