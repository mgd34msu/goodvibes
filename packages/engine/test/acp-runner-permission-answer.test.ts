// Proves: A remote runner's permission ask reaches the runner as it was answered: the owner's yes lets the runner act, his no, a withdrawn ask and a timed-out ask are told to it as exactly that, and a runner someone else started is refused without anyone being asked.
// Red when: The runner's connection or its permission wire (acp/connection.ts, acp/permission-wire.ts) sends the runner something other than what was decided, so an approved ask reaches it as cancelled and it never acts, a withdrawn or timed-out ask reaches it as the owner's refusal, or someone else's runner is put to the owner.
/**
 * Each row is one runner: a real ACP connection (acp/connection.ts) to a stand-in outside agent (a program outside the
 * product, spawned over stdio: test/fixtures/acp-stand-in-agent.ts) that asks to write one file in its folder and writes
 * it only when the answer selects allow. The gate is the real permission manager in ask-me, its asks raised on the real
 * approval broker; the owner answers on the broker as Waiting for you does. The decision model is the stand-in at the
 * port. What the runner received is its own reply ("allowed" or "refused <what it was told>").
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes/judgment';
import { installJudgmentPort } from '@goodvibes/engine/errors';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { createPermissionConfigReader, PermissionManager } from '../platform/src/platform/permissions/manager.ts';
import { UserPermissionRuleStore } from '../platform/src/platform/permissions/user-rule-store.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { ApprovalBroker } from '../platform/src/platform/control-plane/approval-broker.ts';
import { AcpConnection } from '../platform/src/platform/acp/connection.ts';
import type { SubagentTask } from '../platform/src/platform/acp/protocol.ts';
import { forgetGateReadings, gateReadingsPort } from './_helpers/gate-readings.ts';

const STAND_IN_AGENT = join(import.meta.dir, 'fixtures', 'acp-stand-in-agent.ts');

let dir: string;
let port: JudgmentPort;
let restorePort: () => void;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-acp-answer-'));
  forgetGateReadings();
  const log = new SqliteDecisionLog(':memory:');
  // The decision model reads the runner's write as one that cannot be undone, so ask-me puts it to the owner.
  const readings = gateReadingsPort([['probe.txt', { irreversible: true }]]);
  port = withDecisionLog({ model: 'fixture-model', ask: (request) => readings.port.ask(request) }, log);
  const previous = installJudgmentPort(port);
  restorePort = () => { installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings(); };
});
afterEach(() => {
  restorePort();
  rmSync(dir, { recursive: true, force: true });
});

type Answer = 'yes' | 'no' | 'withdraw' | 'time out' | 'nobody';

test('a runner\'s permission ask reaches the runner as the owner answered it', async () => {
  const home = join(dir, 'home');
  const own = join(dir, 'daemon-own');
  for (const folder of [home, own]) mkdirSync(folder, { recursive: true });
  const config = new ConfigManager({ surfaceRoot: 'daemon', workingDir: own, homeDir: home, configDir: join(home, '.goodvibes', 'daemon'), ownsDaemonTier: true });
  expect(config.setMany([{ key: 'permissions.mode' as ConfigKey, value: 'ask-me' }], localOwnerActor()).ok).toBe(true);
  const rules = new UserPermissionRuleStore(join(dir, 'permission-rules.json'));
  await rules.init();
  const broker = new ApprovalBroker({ storePath: join(dir, 'approvals.json') });
  await broker.start();
  let answer: Answer = 'nobody';
  let asked = 0;
  // The owner in Waiting for you: he answers each new ask as the row says (a timed-out one he leaves).
  broker.subscribe((approval) => {
    if (approval.status !== 'pending') return;
    const owner = { actor: 'owner', actorSurface: 'tui', expectedRevision: approval.revision };
    if (answer === 'yes' || answer === 'no') void broker.resolveApproval(approval.id, { ...owner, approved: answer === 'yes' });
    if (answer === 'withdraw') void broker.cancelApproval(approval.id, owner);
  });
  const gate = new PermissionManager(async (request) => {
    asked += 1;
    return broker.requestApproval({ request, ...(answer === 'time out' ? { timeoutMs: 1 } : {}) });
  }, createPermissionConfigReader(config), new PolicyRuntimeState(), null, null, rules, { workspaceTrust: null });
  const lifetime = new AbortController();
  const host = { port, permissionManager: gate, config, signal: lifetime.signal, workspaceTrust: null };
  const operation = { sourceOf: () => ({ goal: 'Write the probe note', criteria: [] }), assertCurrent: () => {} };

  const row = async (name: string, given: Answer, inputParty: SubagentTask['inputParty']): Promise<string> => {
    answer = given; asked = 0;
    const folder = join(dir, 'projects', name);
    mkdirSync(join(folder, '.git'), { recursive: true });
    const runner = new AcpConnection(`runner-${name}`, { description: 'Write the probe note', context: '', tools: [], workingDirectory: folder,
      sessionId: `remote-runner:${name}`, inputParty }, [process.execPath, STAND_IN_AGENT], { permissionHost: host, operation });
    const result = await runner.run();
    const refusal = runner.getInfo().lastRefusal?.reason;
    return `${name}: ${result.output}; written ${existsSync(join(folder, 'probe.txt'))}; asked ${asked}${refusal ? `; why: ${refusal}` : ''}`;
  };

  try {
    const owner = { party: 'owner' } as const;
    const rows = [
      await row('yes', 'yes', owner),
      await row('no', 'no', owner),
      await row('withdrawn', 'withdraw', owner),
      await row('timed-out', 'time out', owner),
      await row('device', 'yes', { party: 'other', who: 'the paired device "kiosk"' }),
    ];
    expect(rows.join('\n')).toBe([
      'yes: allowed; written true; asked 1',
      'no: refused {"outcome":"selected","optionId":"reject"}; written false; asked 1',
      'withdrawn: refused {"outcome":"cancelled"}; written false; asked 1; why: nobody answered: the ask was withdrawn',
      'timed-out: refused {"outcome":"cancelled"}; written false; asked 1; why: nobody answered before the ask timed out',
      'device: refused {"outcome":"selected","optionId":"reject"}; written false; asked 0; why: this turn acts on someone else\'s input (the paired device "kiosk"), and such a turn only reads outside a real sandbox, whatever the mode: write would change or start something',
    ].join('\n'));
  } finally {
    lifetime.abort();
    await rules.close();
  }
});
