// Proves: The Agent does an act that is the owner's alone through its operator tools: approves or answers a purchase, writes a standing authorisation, answers an approval put to the owner, mints a device token, approves a peer, revokes the shared token, deletes a saved rule.
// Red when: An owner-only operator method reaches the host from agent_operator_method or agent_operator_action, or is put to Jev or the owner's prompt instead of being refused, because the method lost its owner-only mark or a tool stopped honouring it.
/**
 * The Agent's two operator tools, registered as a daemon-hosted Agent turn
 * registers them (with their input projectors and the in-process host), in a
 * real tool registry bound to a real PermissionManager in jev-decides. The
 * stand-ins are what is outside the product: the host's request path, which
 * records every request, and the decision model, which answers act to
 * everything; the owner's prompt would approve too. Every owner act is
 * refused with nothing sent; payments.checkout.begin reaching the host is the
 * control.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../platform/src/platform/core/orchestrator-tool-runtime.ts';
import { createPermissionConfigReader, PermissionManager } from '../platform/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { createShellPathService } from '../platform/src/platform/runtime/shell-paths.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
import { createAgentInProcessHost } from '../terminal-shell/src/agent-turn/in-process-host.ts';
import { registerAgentOperatorActionTool } from '../terminal-shell/src/agent-turn/operator-action-tool.ts';
import { registerAgentOperatorMethodTool } from '../terminal-shell/src/agent-turn/operator-method-tool.ts';
import { forgetGateReadings, gateReadingsPort } from './_helpers/gate-readings.ts';

let dir: string;
let restorePort: () => void;
let jevDispositions = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-agent-owner-acts-'));
  jevDispositions = 0;
  forgetGateReadings();
  const readings = gateReadingsPort();
  const disposition = fakePort((name, question) => {
    if (name !== 'disposition') throw new Error(`unexpected question ${name}`);
    jevDispositions++;
    return choiceAnswer(question, 'act', 0.97);
  });
  const log = new SqliteDecisionLog(':memory:');
  const port: JudgmentPort = { model: 'fixture-model', ask: (request) =>
    request.context?.site === 'engine.gate.autonomous-tool' ? disposition.port.ask(request) : readings.port.ask(request) };
  const previous = installJudgmentPort(withDecisionLog(port, log));
  restorePort = () => { installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings(); };
});
afterEach(() => { restorePort(); rmSync(dir, { recursive: true, force: true }); });

test('every owner act is refused by both operator tools with nothing sent and nobody asked; a purchase begin reaches the host', async () => {
  const home = join(dir, 'home');
  const workspace = join(dir, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: workspace, homeDir: home, configDir: join(home, '.goodvibes', 'agent'), ownsDaemonTier: true });
  expect(config.setMany([
    { key: 'permissions.mode' as ConfigKey, value: 'jev-decides' },
    { key: 'judgment.endpoint' as ConfigKey, value: 'http://127.0.0.1:9/v1' },
    { key: 'judgment.model' as ConfigKey, value: 'fixture-model' },
    { key: 'judgment.keySource' as ConfigKey, value: 'secret' },
  ], { kind: 'owner', surface: 'fixture' }).ok).toBe(true);
  let ownerPrompts = 0;
  const manager = new PermissionManager(async () => { ownerPrompts++; return { approved: true }; },
    createPermissionConfigReader(config), new PolicyRuntimeState(), null, null, null, {});
  const registry = new ToolRegistry(manager);
  const sent: string[] = [];
  const host = createAgentInProcessHost({
    baseUrl: 'http://127.0.0.1:3421', homeDirectory: home,
    requests: { serve: async (request) => { sent.push(`${request.method} ${new URL(request.url).pathname}`); return Response.json({ ok: true }); },
      operatorToken: () => 'synthetic-operator-token' },
  });
  const shellPaths = createShellPathService({ workingDirectory: workspace, homeDirectory: home });
  registerAgentOperatorMethodTool(registry, shellPaths, config, host);
  registerAgentOperatorActionTool(registry, shellPaths, config, host);
  const deps: ToolExecutionDeps = { permissionManager: manager, toolRegistry: registry,
    autonomousSource: () => ({ goal: 'Look after the owner\'s purchases and devices', criteria: [] }),
    hookDispatcher: null, runtimeBus: null, sessionId: 'agent-turn', emitterContext: () => ({ sessionId: 'agent-turn', traceId: 'agent-turn', source: 'orchestrator' }) };
  let calls = 0;
  const run = async (name: string, args: Record<string, unknown>) =>
    (await executeToolCalls(deps, `turn-${++calls}`, [{ id: `call-${calls}`, name, arguments: args }]))[0]!;
  // A call the registry refuses before preparing it (an action the tool's schema does not offer) throws; nothing ran.
  const call = (name: string, args: Record<string, unknown>) => run(name, { confirm: true, ...args })
    .catch((error: unknown) => { if (error instanceof Error && error.message.includes('Nothing was executed')) return { success: false }; throw error; });
  // The model loads both tools' parameters first, as it does for a tool listed in one line.
  expect((await run('tool_schema', { names: ['agent_operator_method', 'agent_operator_action'] })).success).toBe(true);

  const ownerActs: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['payments.checkout.approve', { merchant: 'shop.example', item: 'gift', maxMinorUnits: 999999 }],
    ['payments.purchase.approve', { purchaseId: 'p-1' }],
    ['payments.purchase.deny', { purchaseId: 'p-1' }],
    ['payments.purchase.reconcile', { purchaseId: 'p-1', finding: 'not-placed' }],
    ['payments.purchase.securityCode', { purchaseId: 'p-1', code: '123' }],
    ['payments.standing.create', { merchant: 'shop.example', item: 'coffee', maxMinorUnits: 999999 }],
    ['payments.standing.delete', { id: 's-1' }],
    ['inbox.answer', { itemId: 'i-1', answer: 'yes' }],
    ['approvals.approve', { approvalId: 'a-1' }],
    ['pairing.tokens.create', { name: 'the agent\'s own phone' }],
    ['pairing.tokens.revokeShared', {}],
    ['remote.pair.requests.approve', { requestId: 'r-1' }],
    ['permissions.rules.delete', { ruleId: 'deny-1' }],
  ];
  for (const [methodId, input] of ownerActs) {
    const result = await call('agent_operator_method', { methodId, input });
    expect(`${methodId}: ${result.success ? 'ran' : 'refused'}, ${sent.length} sent`).toBe(`${methodId}: refused, 0 sent`);
  }
  const action = await call('agent_operator_action', { action: 'approvals.approve', approvalId: 'a-1' });
  expect(`approvals.approve as an action: ${action.success ? 'ran' : 'refused'}, ${sent.length} sent`).toBe('approvals.approve as an action: refused, 0 sent');
  expect(`${jevDispositions} Jev dispositions, ${ownerPrompts} owner prompts`).toBe('0 Jev dispositions, 0 owner prompts');

  // The control: a purchase begin is the Agent's to send, and it reaches the host.
  await call('agent_operator_method', { methodId: 'payments.checkout.begin', input: { merchant: 'shop.example', items: [{ name: 'gift', quantity: 1 }], requestId: 'begin-1' } });
  expect(sent.some((request) => request.includes('/payments/checkout'))).toBe(true);
});
