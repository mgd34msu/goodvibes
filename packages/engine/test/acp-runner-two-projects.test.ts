// Proves: An outside coding agent's permission ask through a runner's connection is decided for another project than the one the runner works in, so a refusal the owner kept for that project does not hold for its runner.
// Red when: AcpConnection (acp/connection.ts) stops passing its task's workingDirectory to admitExternalRequest, so beta's runner's write is decided for the host's own folder, the deny kept for beta is not read and the write is made there.
/**
 * Two runners at once, one in each project, each a real ACP connection to a
 * stand-in outside agent (a program outside the product, spawned over stdio:
 * test/fixtures/acp-stand-in-agent.ts) that asks to write one file in its own
 * folder. The gate is the real permission manager deciding in jev-decides,
 * its remembered rules the real rule store (the owner's deny for `write` kept
 * for beta), its asks raised on the real approval broker. The decision model
 * is the stand-in at the port: it would let every call run. The host's own
 * folder is neither project.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes/judgment';
import { choiceAnswer, fakePort } from '@goodvibes/judgment/testing';
import { installJudgmentPort } from '@goodvibes/engine/errors';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { createPermissionConfigReader, PermissionManager } from '../platform/src/platform/permissions/manager.ts';
import { buildDurableRuleForDecision } from '../platform/src/platform/permissions/approval-rules.ts';
import { projectIdentity, UserPermissionRuleStore } from '../platform/src/platform/permissions/user-rule-store.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { ApprovalBroker } from '../platform/src/platform/control-plane/approval-broker.ts';
import { AcpConnection } from '../platform/src/platform/acp/connection.ts';
import { withOwnerInput } from '../platform/src/platform/security/turn-input-party.ts';
import { forgetGateReadings, gateReadingsPort } from './_helpers/gate-readings.ts';

const STAND_IN_AGENT = join(import.meta.dir, 'fixtures', 'acp-stand-in-agent.ts');

let dir: string;
let port: JudgmentPort;
let restorePort: () => void;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-acp-two-projects-'));
  forgetGateReadings();
  const readings = gateReadingsPort();
  // The decision model, outside the product: it would let every call run.
  const disposition = fakePort((name, question) => {
    if (name !== 'disposition') throw new Error(`unexpected question ${name}`);
    return choiceAnswer(question, 'act', 0.97);
  });
  const log = new SqliteDecisionLog(':memory:');
  port = withDecisionLog({ model: 'fixture-model', ask: (request) =>
    request.context?.site === 'engine.gate.autonomous-tool' ? disposition.port.ask(request) : readings.port.ask(request) }, log);
  const previous = installJudgmentPort(port);
  restorePort = () => { installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings(); };
});
afterEach(() => {
  restorePort();
  rmSync(dir, { recursive: true, force: true });
});

test('two runners in two projects ask the same write: the deny kept for beta refuses beta\'s, alpha\'s runs', async () => {
  const home = join(dir, 'home');
  const own = join(dir, 'daemon-own');
  const [alpha, beta] = [join(dir, 'projects', 'alpha'), join(dir, 'projects', 'beta')];
  // Each project is a repository: its own project identity (workspace/project-identity.ts).
  for (const folder of [home, own, join(alpha, '.git'), join(beta, '.git')]) mkdirSync(folder, { recursive: true });
  const config = new ConfigManager({ surfaceRoot: 'daemon', workingDir: own, homeDir: home, configDir: join(home, '.goodvibes', 'daemon'), ownsDaemonTier: true });
  expect(config.setMany([
    { key: 'permissions.mode' as ConfigKey, value: 'jev-decides' },
    { key: 'judgment.endpoint' as ConfigKey, value: 'http://127.0.0.1:9/v1' },
    { key: 'judgment.model' as ConfigKey, value: 'fixture-model' },
    { key: 'judgment.keySource' as ConfigKey, value: 'secret' },
  ], localOwnerActor()).ok).toBe(true);

  // The owner's refusal of `write`, kept for beta only.
  const rules = new UserPermissionRuleStore(join(dir, 'permission-rules.json'));
  await rules.init();
  const deny = buildDurableRuleForDecision({ toolName: 'write', args: {}, tier: 'tool', effect: 'deny' })!;
  await rules.remember({ rule: deny, tier: 'tool', tool: 'write', createdAt: 1, project: projectIdentity(beta) });
  const broker = new ApprovalBroker({ storePath: join(dir, 'approvals.json') });
  await broker.start();
  const asked: string[] = [];
  const gate = new PermissionManager(async (request) => { asked.push(String(request.workingDirectory)); return broker.requestApproval({ request }); },
    createPermissionConfigReader(config), new PolicyRuntimeState(), null, null, rules, { workspaceTrust: null });
  const lifetime = new AbortController();
  const host = { port, permissionManager: gate, config, signal: lifetime.signal, workspaceTrust: null };
  const operation = { sourceOf: () => ({ goal: 'Add a probe note to each project', criteria: [] }), assertCurrent: () => {} };
  const runner = (name: string, folder: string) => new AcpConnection(`runner-${name}`,
    { description: `Write the probe note in ${name}`, context: '', tools: [], workingDirectory: folder, sessionId: `runner-session-${name}` },
    [process.execPath, STAND_IN_AGENT], { permissionHost: host, operation });

  try {
    // The owner's own work starts both runners: work no turn names is someone else's and only reads (turn-input-party.ts).
    const [inAlpha, inBeta] = await withOwnerInput(() => Promise.all([runner('alpha', alpha).run(), runner('beta', beta).run()]));
    expect(`alpha ${inAlpha.output.split(' ')[0]}, written ${existsSync(join(alpha, 'probe.txt'))}; beta ${inBeta.output.split(' ')[0]}, written ${existsSync(join(beta, 'probe.txt'))}; asked ${asked.length}`)
      .toBe('alpha allowed, written true; beta refused, written false; asked 0');
  } finally {
    lifetime.abort();
    await rules.close();
  }
});
