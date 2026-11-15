/**
 * An owner's remembered answer is kept and applied to later calls: a session
 * answer by its session key, any other tier as the durable rule the approval
 * broker would match. The call the answer admitted still runs, and a
 * remembered deny is enforced even under an older, broader allow.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useGateReadings } from './_helpers/gate-readings.ts';
import { PermissionManager, type PermissionConfigReader } from '../platform/src/platform/permissions/manager.ts';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.ts';
import { UserPermissionRuleStore } from '../platform/src/platform/permissions/user-rule-store.ts';
import { buildDurableRuleForDecision } from '../platform/src/platform/permissions/approval-rules.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../platform/src/platform/core/orchestrator-tool-runtime.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
import { EXEC_TOOL_SCHEMA } from '../platform/src/platform/tools/exec/schema.ts';

useGateReadings();

const classic = <T>(run: () => Promise<T>): Promise<T> => withDecisionModelPolicy(() => 'Classic - Off', run);
const exec = (cmd: string): Record<string, unknown> => ({ commands: [{ cmd }] });

function manager(store: UserPermissionRuleStore | null, answer: (request: PermissionPromptRequest) => PermissionPromptDecision) {
  const asked: PermissionPromptRequest[] = [];
  const directory = '/synthetic/remembered-answers';
  const config = {
    getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: false, directory }),
    isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => directory,
    getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }),
  } as unknown as PermissionConfigReader;
  const permissions = new PermissionManager(async (request) => { asked.push(request); return answer(request); },
    config, new PolicyRuntimeState(), null, null, store);
  return { permissions, asked };
}

describe('remembered answers', () => {
  test('"allow for session" is applied to the next matching call without asking again', async () => {
    await classic(async () => {
      const { permissions, asked } = manager(null, () => ({ approved: true, remember: true, rememberTier: 'session' }));
      expect(await permissions.checkDetailed('exec', exec('git status'))).toMatchObject({ approved: true, reasonCode: 'user_approved' });
      expect(asked).toHaveLength(1);
      expect(asked[0]!.rememberOptions?.map(option => option.tier)).toEqual(['exact', 'command-class', 'tool', 'session']);
      expect(await permissions.checkDetailed('exec', exec('git status'))).toMatchObject({ approved: true, reasonCode: 'session_cached_allow' });
      expect(asked).toHaveLength(1);
    });
  });

  test('a session grant recorded during an admitted call does not cancel that call, and serves the next one', async () => {
    await classic(async () => {
      const { permissions, asked } = manager(null, () => ({ approved: true, rememberTier: 'session' }));
      const registry = new ToolRegistry();
      const executed: unknown[] = [];
      registry.register({ definition: { name: 'exec', description: 'Intercepted tool; never executes a shell', parameters: EXEC_TOOL_SCHEMA },
        execute: async (input) => { executed.push(input); return { success: true, output: 'intercepted' }; } });
      const deps: ToolExecutionDeps = {
        autonomousSource: () => ({ goal: 'Run the synthetic status check', criteria: ['Run once per call'] }),
        permissionManager: permissions, toolRegistry: registry, hookDispatcher: null, runtimeBus: null, sessionId: 'remembered-answers',
        emitterContext: () => ({ sessionId: 'remembered-answers', traceId: 'synthetic', source: 'orchestrator' }),
      };
      const first = await executeToolCalls(deps, 'turn-1', [{ id: 'call-1', name: 'exec', arguments: exec('git status') }]);
      expect(first[0]?.success).toBe(true);
      const second = await executeToolCalls(deps, 'turn-1', [{ id: 'call-2', name: 'exec', arguments: exec('git status') }]);
      expect(second[0]?.success).toBe(true);
      expect(executed).toHaveLength(2);
      expect(asked).toHaveLength(1);
    });
  });

  test('"deny always" is saved, enforced without asking, and survives a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-remembered-answers-'));
    try {
      const file = join(dir, 'permission-rules.json');
      const store = new UserPermissionRuleStore(file);
      await store.awaitReady();
      await classic(async () => {
        const { permissions, asked } = manager(store, () => ({ approved: false, rememberTier: 'exact' }));
        expect(await permissions.checkDetailed('exec', exec('npm publish'))).toMatchObject({ approved: false, reasonCode: 'user_denied' });
        expect(await permissions.checkDetailed('exec', exec('npm publish'))).toMatchObject({ approved: false, reasonCode: 'user_rule_deny' });
        expect(asked).toHaveLength(1);
      });
      // A rule made in a project is stored apart from `rules`, which an earlier release would apply everywhere.
      expect(JSON.parse(readFileSync(file, 'utf-8')).projectRules).toHaveLength(1);
      const reopened = new UserPermissionRuleStore(file);
      await reopened.awaitReady();
      expect(reopened.rules()).toHaveLength(1);
      expect(reopened.rules()[0]).toMatchObject({ effect: 'deny', exactCommands: ['npm publish'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a later exact deny wins over an older whole-tool allow', async () => {
    const store = new UserPermissionRuleStore(':memory:');
    await store.awaitReady();
    const allow = buildDurableRuleForDecision({ toolName: 'exec', args: exec('ls'), tier: 'tool', effect: 'allow' })!;
    const deny = buildDurableRuleForDecision({ toolName: 'exec', args: exec('npm publish'), tier: 'exact', effect: 'deny' })!;
    await store.add({ rule: allow, tier: 'tool', tool: 'exec', createdAt: 1 });
    await store.add({ rule: deny, tier: 'exact', tool: 'exec', createdAt: 2 });
    await classic(async () => {
      const { permissions, asked } = manager(store, () => ({ approved: true }));
      expect(await permissions.checkDetailed('exec', exec('npm publish'))).toMatchObject({ approved: false, reasonCode: 'user_rule_deny' });
      expect(await permissions.checkDetailed('exec', exec('ls'))).toMatchObject({ approved: true, reasonCode: 'user_rule_allow' });
      expect(asked).toHaveLength(0);
    });
  });

  test('an answer that edited the arguments remembers nothing', async () => {
    await classic(async () => {
      const { permissions, asked } = manager(null, () => ({ approved: true, rememberTier: 'session', modifiedArgs: exec('git status --short') }));
      await permissions.checkDetailed('exec', exec('git status'));
      await permissions.checkDetailed('exec', exec('git status'));
      expect(asked).toHaveLength(2);
    });
  });
});

describe('permission rules file readiness', () => {
  test('an unreadable rules file is named in the refusal and recovers once repaired, without a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-rule-readiness-'));
    try {
      const file = join(dir, 'permission-rules.json');
      writeFileSync(file, '{ not json');
      const store = new UserPermissionRuleStore(file);
      await expect(store.awaitReady()).rejects.toThrow(`Permission rules file ${file} could not be read`);
      const rule = buildDurableRuleForDecision({ toolName: 'exec', args: exec('git status'), tier: 'exact', effect: 'allow' })!;
      writeFileSync(file, JSON.stringify({ version: 1, rules: [{ rule, tier: 'exact', tool: 'exec', createdAt: 1 }] }));
      await store.awaitReady();
      expect(store.rules()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
