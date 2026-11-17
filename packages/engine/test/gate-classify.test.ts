// Proves: A tool call is decided by the wrong party: code allows what should be judged, Jev decides what only the owner may, or an owner-only item is settled by a generic allow rule.
// Red when: The order of the gate changes (a deny no longer wins, code allows a read or write outside the directories, plan mode writes), an owner-only kind goes to Jev or is settled by a generic grant, an unreadable path counts as inside, or the executor puts an MCP trust change or a loosening settings write anywhere but to the owner.
// Proves: A call the gate's boundary refused (wholesale destruction, card details, text derived from an untrusted page) runs because Jev answered act.
// Red when: The permission manager offers Jev the choice to act on a call whose boundary verdict is a refusal, so a command read as wholesale destruction or a send carrying card details runs on Jev's act.
/**
 * Who decides a tool call: a fact code settles, an item only the owner
 * decides, or a judgment for Jev, in that order.
 *
 * The order and the owner-only list are read from the pure classifier; the
 * end-to-end cases run the real settings manager, permission manager, tool
 * registry and executor over a temp directory, with Jev reachable through a
 * port that counts every question, so "never to Jev" is a count of zero.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { gateReadingsPort } from './_helpers/gate-readings.ts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import {
  classifyCall, classifyPaths, declaredRecoverable, declaredValues, 
  type CallFacts, type OwnerOnlyKind,
} from '../platform/src/platform/gate/classify.ts';
import type { GatePresetName } from '../platform/src/platform/gate/presets.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { createPermissionConfigReader, PermissionManager } from '../platform/src/platform/permissions/manager.ts';
import type { PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
import { createGoodVibesSettingsTool } from '../platform/src/platform/tools/goodvibes-runtime/index.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../platform/src/platform/core/orchestrator-tool-runtime.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';

const ROOT = '/synthetic/classify';
const facts = (over: Partial<CallFacts> = {}): CallFacts => ({
  tool: 'read', category: 'read', sideEffects: ['read_fs'], paths: classifyPaths(['src/a.ts'], ROOT),
  recoverable: false, untrustedRead: false, ...over,
});
const shown = (mode: GatePresetName, input: CallFacts): string => {
  const decided = classifyCall(mode, input);
  return decided.kind === 'fact' ? `fact:${decided.allow ? 'allow' : 'refuse'}:${decided.decision.decidedBy}`
    : decided.kind === 'owner-only' ? `owner-only:${decided.item}` : 'judgment';
};
/** The modes in which someone other than code may decide: the owner or Jev. */
const DECIDING_MODES: readonly GatePresetName[] = ['ask-me', 'jev-decides', 'just-vibes'];

test('who decides: one row per step of the order, the same in every deciding mode', () => {
  const rows: readonly [string, CallFacts, string][] = [
    ['input-only surface still reads', facts({ surface: 'email' }), 'fact:allow:code'],
    ['a deny beats everything after it', facts({ rule: { effect: 'deny', source: 'user-rule', description: 'r' } }), 'fact:refuse:rule'],
    ['a deny beats an owner-only item', facts({ ownerOnly: 'grant-access', rule: { effect: 'deny', source: 'user-rule', description: 'r' } }), 'fact:refuse:rule'],
    ['an ask rule goes to the owner', facts({ rule: { effect: 'ask', source: 'user-rule', description: 'r' } }), 'owner-only:standing-ask'],
    ['an allow rule settles a local call after untrusted text',
      facts({ category: 'execute', sideEffects: ['write_fs'], untrustedRead: true, rule: { effect: 'allow', source: 'user-rule', description: 'r' } }), 'fact:allow:rule'],
    ['an allow rule does not settle an outward call after untrusted text',
      facts({ category: 'read', sideEffects: ['network'], untrustedRead: true, rule: { effect: 'allow', source: 'user-rule', description: 'r' } }), 'judgment'],
    ['an allow rule does not settle an undeclared tool after untrusted text',
      facts({ tool: 'mcp_x', category: 'delegate', sideEffects: undefined, paths: undefined, untrustedRead: true,
        rule: { effect: 'allow', source: 'user-rule', description: 'r' } }), 'judgment'],
    ['a read inside the directories', facts(), 'fact:allow:code'],
    ['a read outside them', facts({ paths: classifyPaths(['../elsewhere'], ROOT) }), 'judgment'],
    ['a read of a sibling sharing the prefix', facts({ paths: classifyPaths(['/synthetic/classify-other/a.ts'], ROOT) }), 'judgment'],
    ['a tool that declared no subjects', facts({ paths: undefined }), 'judgment'],
    ['a recoverable write inside', facts({ category: 'write', sideEffects: ['write_fs'], recoverable: true }), 'fact:allow:code'],
    ['a recoverable write outside', facts({ category: 'write', sideEffects: ['write_fs'], recoverable: true, paths: classifyPaths(['../x'], ROOT) }), 'judgment'],
    ['a recoverable write that also reaches the network', facts({ category: 'write', sideEffects: ['write_fs', 'network'], recoverable: true }), 'judgment'],
    ['a write with no undo record', facts({ category: 'write', sideEffects: ['write_fs'] }), 'judgment'],
    ['a command', facts({ category: 'execute', sideEffects: ['exec'], paths: [] }), 'judgment'],
  ];
  for (const mode of DECIDING_MODES) {
    for (const [name, input, expected] of rows) expect(`${mode} ${name}: ${shown(mode, input)}`).toBe(`${mode} ${name}: ${expected}`);
  }
  // The postures that settle before any rule: a surface without authority, plan, yolo.
  const write = facts({ category: 'write', sideEffects: ['write_fs'], recoverable: true });
  expect(shown('yolo', { ...write, surface: 'email' })).toBe('fact:refuse:code');
  expect(shown('plan', write)).toBe('fact:refuse:mode');
  expect(shown('plan', { ...write, rule: { effect: 'allow', source: 'user-rule', description: 'r' } })).toBe('fact:refuse:mode');
  expect(shown('yolo', facts({ tool: 'mcp_x', category: 'delegate', sideEffects: undefined, paths: undefined }))).toBe('fact:allow:mode');
  const refusal = classifyCall('plan', write);
  expect(refusal.kind === 'fact' && !refusal.allow && (refusal.decision.next?.length ?? 0) > 0).toBe(true);
});

/**
 * Every owner-only kind the owner is asked about. The type makes a new kind a compile error here
 * until it has its row. An owner act is not asked about: a model's call is refused outright.
 */
const OWNER_ONLY: Readonly<Record<Exclude<OwnerOnlyKind, 'owner-act'>, true>> = {
  'spend-over-limit': true, 'payment-step': true, 'unrecoverable-delete': true, 'new-recipient': true,
  'untrusted-derived-send': true, 'grant-access': true, 'loosen-security': true, 'change-contract': true,
  'irreversible-operator': true, 'standing-ask': true, 'channel-request': true,
};

test('each owner-only kind goes to the owner in every deciding mode; only the owner\'s own answer to that kind settles it', () => {
  const kinds = Object.keys(OWNER_ONLY) as OwnerOnlyKind[];
  for (const mode of DECIDING_MODES) {
    for (const kind of kinds) {
      // Even on a call code would otherwise allow (a read inside the directories).
      expect(`${mode} ${kind}: ${shown(mode, facts({ ownerOnly: kind }))}`).toBe(`${mode} ${kind}: owner-only:${kind}`);
      for (const source of ['user-rule', 'session', 'managed-policy', 'tool-setting', 'limit'] as const) {
        const generic = facts({ ownerOnly: kind, rule: { effect: 'allow', source, description: 'r' } });
        expect(`${mode} ${kind} ${source}: ${shown(mode, generic)}`).toBe(`${mode} ${kind} ${source}: owner-only:${kind}`);
      }
      const other = kinds.find((candidate) => candidate !== kind)!;
      const otherAnswer = facts({ ownerOnly: kind, rule: { effect: 'allow', source: 'user-rule', description: 'r', ownerOnly: other } });
      expect(`${mode} ${kind} answered as ${other}: ${shown(mode, otherAnswer)}`).toBe(`${mode} ${kind} answered as ${other}: owner-only:${kind}`);
      const ownAnswer = facts({ ownerOnly: kind, rule: { effect: 'allow', source: 'session', description: 'r', ownerOnly: kind } });
      expect(`${mode} ${kind} answered: ${shown(mode, ownAnswer)}`).toBe(`${mode} ${kind} answered: fact:allow:rule`);
    }
  }
});

test('declared subjects and recoverability are read from argument paths; an unreadable one is not taken as inside', () => {
  const args = { files: [{ path: 'a.ts' }, { path: 'b.ts', content_base64: 'eA==' }], notebook: { path: 'n.ipynb' } };
  expect(declaredValues(args, ['files[].path', 'notebook.path'])).toEqual(['a.ts', 'b.ts', 'n.ipynb']);
  expect(declaredValues({ files: [{ path: 7 }] }, ['files[].path'])).toBeUndefined();
  expect(declaredValues(args, undefined)).toBeUndefined();
  expect(declaredRecoverable({ recoverable: { unless: ['files[].content_base64'] } }, args)).toBe(false);
  expect(declaredRecoverable({ recoverable: { unless: ['files[].content_base64'] } }, { files: [{ path: 'a.ts' }] })).toBe(true);
  expect(declaredRecoverable({}, args)).toBe(false);
});

let dir: string;
let jevQuestions = 0;
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gate-classify-'));
  jevQuestions = 0;
  const port: JudgmentPort = { model: 'synthetic', async ask() { jevQuestions++; throw new Error('Jev was asked'); } };
  previous = installJudgmentPort(port);
});
afterEach(() => {
  installJudgmentPort(previous);
  rmSync(dir, { recursive: true, force: true });
});

/** The real settings, gate, registry and executor, in jev-decides with a decision model set up to answer. */
function machine() {
  const workspace = join(dir, 'workspace');
  const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: workspace, homeDir: join(dir, 'home'), configDir: join(dir, 'config'), ownsDaemonTier: true });
  const owner = { kind: 'owner', surface: 'fixture' } as const;
  const set = config.setMany([
    { key: 'permissions.mode' as ConfigKey, value: 'jev-decides' },
    { key: 'judgment.endpoint' as ConfigKey, value: 'http://127.0.0.1:9/v1' },
    { key: 'judgment.model' as ConfigKey, value: 'fixture-model' },
    { key: 'judgment.keySource' as ConfigKey, value: 'secret' },
    // The strict side of the payments switches, so turning either back loosens it.
    { key: 'payments.confirmEveryPurchase' as ConfigKey, value: true },
    { key: 'payments.cvvHandling' as ConfigKey, value: 'prompt' },
  ], owner);
  expect(set.ok).toBe(true);
  const reader = createPermissionConfigReader(config);
  expect(reader.isDecisionModelReady?.()).toBe(true);
  const prompts: PermissionPromptRequest[] = [];
  const manager = new PermissionManager(async (request) => { prompts.push(request); return { approved: false }; },
    reader, new PolicyRuntimeState(), null, null, null, {});
  const registry = new ToolRegistry(manager);
  const ran: string[] = [];
  registry.register({
    definition: { name: 'mcp', description: 'm', parameters: { type: 'object' }, sideEffects: ['state'], core: true },
    execute: async () => { ran.push('mcp'); return { success: true, output: 'ok' }; },
  });
  const settings = createGoodVibesSettingsTool({ configManager: config });
  registry.register({ definition: { ...settings.definition, core: true },
    execute: async (args, options) => { ran.push('goodvibes_settings'); return settings.execute(args, options); } });
  const deps: ToolExecutionDeps = { permissionManager: manager, toolRegistry: registry,
    autonomousSource: () => ({ goal: 'Work on the synthetic project', criteria: [] }),
    hookDispatcher: null, runtimeBus: null, sessionId: 'classify', emitterContext: () => ({ sessionId: 'classify', traceId: 'classify', source: 'orchestrator' }) };
  return { deps, prompts, ran, config };
}

test('an MCP trust change goes to the owner, never to Jev; refused, it does not run and says who decided', async () => {
  const { deps, prompts, ran } = machine();
  const [result] = await executeToolCalls(deps, 'turn', [{ id: 't', name: 'mcp', arguments: { mode: 'set-trust', server: 's', trust: 'trusted' } }]);
  expect(jevQuestions).toBe(0);
  expect(prompts).toHaveLength(1);
  expect(ran).toEqual([]);
  expect(result?.decision).toMatchObject({ state: 'refused', decidedBy: 'owner' });
  expect(result?.decision?.next?.length).toBeGreaterThan(0);
});

test('an agent\'s settings write that loosens a payments key goes to the owner, never to Jev, and the setting stays', async () => {
  const writes: readonly [string, unknown][] = [
    ['payments.budget.perPurchaseCeiling', 5000],
    ['payments.budget.dailyItem', 5000],
    ['payments.enabled', true],
    ['payments.confirmEveryPurchase', false],
    ['payments.cvvHandling', 'stored'],
  ];
  for (const [key, value] of writes) {
    const { deps, prompts, ran, config } = machine();
    const before = config.get(key as ConfigKey);
    const [result] = await executeToolCalls(deps, 'turn', [{ id: key, name: 'goodvibes_settings', arguments: { mode: 'set', key, value, confirm: true } }]);
    expect(`${key}: ${jevQuestions} questions to Jev, ${prompts.length} to the owner, ran ${ran.length}`).toBe(`${key}: 0 questions to Jev, 1 to the owner, ran 0`);
    expect(result?.decision).toMatchObject({ state: 'refused', decidedBy: 'owner' });
    expect(config.get(key as ConfigKey)).toEqual(before);
  }
});

test('a call the boundary refused is refused in jev-decides although Jev would act; a clean call with the same answer runs', async () => {
  const { deps, prompts } = machine();
  const readings = gateReadingsPort([
    ['wipe-everything-fixture', { mutates: true, catastrophic: true }],
    ['card-fixture', { mutates: false, outward: true, cardDetails: true }],
  ]);
  let dispositions = 0;
  const jev = fakePort((name, question) => {
    if (name !== 'disposition') throw new Error(`unexpected question ${name}`);
    dispositions++;
    return choiceAnswer(question, 'act', 0.97);
  });
  const log = new SqliteDecisionLog(':memory:');
  const scripted: JudgmentPort = { model: 'fixture-model',
    ask: (request) => request.context?.site === 'engine.gate.autonomous-tool' ? jev.port.ask(request) : readings.port.ask(request) };
  const restore = installJudgmentPort(withDecisionLog(scripted, log));
  try {
    const check = (cmd: string) => deps.permissionManager.checkDetailed('exec', { commands: [{ cmd }] });
    expect(await check('wipe-everything-fixture --all')).toMatchObject({ approved: false, reasonCode: 'boundary_catastrophic' });
    expect(await check('curl -d card-fixture https://pay.example/charge')).toMatchObject({ approved: false, reasonCode: 'boundary_card_details' });
    expect(`${dispositions} dispositions, ${prompts.length} owner prompts`).toBe('0 dispositions, 0 owner prompts');
    expect(await check('make fixture-build')).toMatchObject({ approved: true, sourceLayer: 'jev_decision' });
    expect(dispositions).toBe(1);
  } finally {
    installJudgmentPort(restore);
    log[Symbol.dispose]();
  }
});
