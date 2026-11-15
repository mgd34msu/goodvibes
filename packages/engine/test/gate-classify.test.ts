import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { classifyCall, classifyPaths, declaredRecoverable, declaredValues, type CallFacts } from '../platform/src/platform/gate/classify.ts';
import { PermissionManager, type PermissionConfigReader } from '../platform/src/platform/permissions/manager.ts';
import type { PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../platform/src/platform/core/orchestrator-tool-runtime.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { cloneDefaultConfig } from '../platform/src/platform/config/manager-bootstrap.ts';
import type { ToolDefinition } from '../platform/src/platform/types/tools.ts';

const ROOT = '/synthetic/classify';
const facts = (over: Partial<CallFacts> = {}): CallFacts => ({
  tool: 'read', category: 'read', sideEffects: ['read_fs'], paths: classifyPaths(['src/a.ts'], ROOT),
  recoverable: false, untrustedRead: false, ...over,
});

test('who decides: one row per step of the order', () => {
  const rows: readonly [string, Parameters<typeof classifyCall>[0], CallFacts, string][] = [
    ['input-only surface refuses a change', 'yolo', facts({ category: 'write', surface: 'email' }), 'fact:refuse:code'],
    ['input-only surface still reads', 'safe-jev', facts({ surface: 'email' }), 'fact:allow:code'],
    ['plan refuses a change', 'plan', facts({ category: 'write', sideEffects: ['write_fs'] }), 'fact:refuse:mode'],
    ['yolo runs an undeclared tool', 'yolo', facts({ tool: 'mcp_x', category: 'delegate', sideEffects: undefined, paths: undefined }), 'fact:allow:mode'],
    ['a deny beats everything after it', 'safe-jev', facts({ rule: { effect: 'deny', source: 'user-rule', description: 'r' } }), 'fact:refuse:rule'],
    ['an ask rule goes to the owner', 'safe-jev', facts({ rule: { effect: 'ask', source: 'user-rule', description: 'r' } }), 'owner-only:standing-ask'],
    ['a generic allow never settles an owner-only item', 'safe-jev',
      facts({ ownerOnly: 'grant-access', rule: { effect: 'allow', source: 'session', description: 'r' } }), 'owner-only:grant-access'],
    ['the owner\'s own answer settles it', 'safe-jev',
      facts({ ownerOnly: 'grant-access', rule: { effect: 'allow', source: 'session', description: 'r', ownerOnly: 'grant-access' } }), 'fact:allow:rule'],
    ['an allow rule settles a local call after untrusted text', 'safe-jev',
      facts({ category: 'execute', sideEffects: ['write_fs'], untrustedRead: true, rule: { effect: 'allow', source: 'user-rule', description: 'r' } }), 'fact:allow:rule'],
    ['an allow rule does not settle an outward call after untrusted text', 'safe-jev',
      facts({ category: 'read', sideEffects: ['network'], untrustedRead: true, rule: { effect: 'allow', source: 'user-rule', description: 'r' } }), 'judgment'],
    ['a read inside the directories', 'safe-jev', facts(), 'fact:allow:code'],
    ['a read outside them', 'safe-jev', facts({ paths: classifyPaths(['../elsewhere'], ROOT) }), 'judgment'],
    ['a tool that declared no subjects', 'safe-jev', facts({ paths: undefined }), 'judgment'],
    ['a recoverable write inside', 'safe-owner', facts({ category: 'write', sideEffects: ['write_fs'], recoverable: true }), 'fact:allow:code'],
    ['a write with no undo record', 'safe-owner', facts({ category: 'write', sideEffects: ['write_fs'] }), 'judgment'],
    ['a command', 'safe-jev', facts({ category: 'execute', sideEffects: ['exec'], paths: [] }), 'judgment'],
  ];
  for (const [name, mode, input, expected] of rows) {
    const decided = classifyCall(mode, input);
    const shown = decided.kind === 'fact' ? `fact:${decided.allow ? 'allow' : 'refuse'}:${decided.decision.decidedBy}`
      : decided.kind === 'owner-only' ? `owner-only:${decided.item}` : 'judgment';
    expect(`${name}: ${shown}`).toBe(`${name}: ${expected}`);
    if (decided.kind === 'fact' && !decided.allow) expect(decided.decision.next?.length).toBeGreaterThan(0);
  }
});

test('declared subjects and recoverability are read from argument paths', () => {
  const args = { files: [{ path: 'a.ts' }, { path: 'b.ts', content_base64: 'eA==' }], notebook: { path: 'n.ipynb' } };
  expect(declaredValues(args, ['files[].path', 'notebook.path'])).toEqual(['a.ts', 'b.ts', 'n.ipynb']);
  expect(declaredValues({ files: [{ path: 7 }] }, ['files[].path'])).toBeUndefined();
  expect(declaredValues(args, undefined)).toBeUndefined();
  expect(declaredRecoverable({ recoverable: { unless: ['files[].content_base64'] } }, args)).toBe(false);
  expect(declaredRecoverable({ recoverable: { unless: ['files[].content_base64'] } }, { files: [{ path: 'a.ts' }] })).toBe(true);
  expect(declaredRecoverable({}, args)).toBe(false);
});

let modelRequests = 0;
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  modelRequests = 0;
  const port: JudgmentPort = { model: 'synthetic', async ask() { modelRequests++; throw new Error('no reading is expected'); } };
  previous = installJudgmentPort(port);
});
afterEach(() => { installJudgmentPort(previous); });

function gate(reply: boolean) {
  const permissions = { ...cloneDefaultConfig().permissions, mode: 'safe-jev' as const };
  const config: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions, directory: ROOT, autoApprove: false }),
    getSnapshot: () => ({ permissions }), getWorkingDirectory: () => ROOT, isAutoApproveEnabled: () => false,
  };
  const prompts: PermissionPromptRequest[] = [];
  const manager = new PermissionManager(async (request) => { prompts.push(request); return { approved: reply }; },
    config, new PolicyRuntimeState(), null, null, null, {});
  const registry = new ToolRegistry(manager);
  const ran: string[] = [];
  const tool = (definition: ToolDefinition) => registry.register({ definition,
    execute: async () => { ran.push(definition.name); return { success: true, output: 'ok' }; } });
  tool({ name: 'read', description: 'r', parameters: { type: 'object' }, sideEffects: ['read_fs'], subjects: { paths: ['files[].path'] } });
  tool({ name: 'edit', description: 'e', parameters: { type: 'object' }, sideEffects: ['write_fs'], subjects: { paths: ['edits[].path'] }, recoverable: {} });
  tool({ name: 'mcp', description: 'm', parameters: { type: 'object' }, sideEffects: ['state'] });
  const deps: ToolExecutionDeps = { permissionManager: manager, toolRegistry: registry,
    autonomousSource: () => ({ goal: 'Work on the synthetic project', criteria: [] }),
    hookDispatcher: null, runtimeBus: null, sessionId: 'classify', emitterContext: () => ({ sessionId: 'classify', traceId: 'classify', source: 'orchestrator' }) };
  return { deps, prompts, ran };
}

test('a read and a recoverable edit inside the workspace cost no decision-model request in safe-jev', async () => {
  const { deps, prompts, ran } = gate(false);
  const results = await executeToolCalls(deps, 'turn', [
    { id: 'r', name: 'read', arguments: { files: [{ path: 'src/a.ts' }] } },
    { id: 'e', name: 'edit', arguments: { edits: [{ path: 'src/a.ts', find: 'a', replace: 'b' }] } },
  ]);
  expect(results.map((result) => result.success)).toEqual([true, true]);
  expect(ran).toEqual(['read', 'edit']);
  expect(modelRequests).toBe(0);
  expect(prompts).toHaveLength(0);
});

test('an owner-only call goes to the owner, never to Jev, and its refusal says who decided and what next', async () => {
  const { deps, prompts, ran } = gate(false);
  const [result] = await executeToolCalls(deps, 'turn', [{ id: 't', name: 'mcp', arguments: { mode: 'set-trust', server: 's', trust: 'trusted' } }]);
  expect(modelRequests).toBe(0);
  expect(prompts).toHaveLength(1);
  expect(ran).toEqual([]);
  expect(result?.decision).toMatchObject({ state: 'refused', decidedBy: 'owner' });
  expect(result?.decision?.next?.length).toBeGreaterThan(0);
});
