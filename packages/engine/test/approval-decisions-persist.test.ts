/**
 * Approval decisions persist and generalize; deny is feedback.
 *
 * Acceptance bar:
 *   - a granted command-class rule survives restart and suppresses re-asks
 *   - an edit approval scoped to a path does not authorize other paths
 *   - deny-with-reason yields a continuing-turn structured result
 *   - two concurrent identical asks get one prompt and both resolve
 *   - a remember-tier decision sweeps queued covered asks
 *   - rules are listable/deletable via the permissions.rules.* settings verbs
 */
import { useGateReadings } from './_helpers/gate-readings.ts';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionManager } from '../platform/src/platform/permissions/manager.js';
import type { PermissionConfigReader } from '../platform/src/platform/permissions/manager.js';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.js';
import { UserPermissionRuleStore } from '../platform/src/platform/permissions/user-rule-store.js';
import { buildRememberOptions } from '../platform/src/platform/permissions/approval-rules.js';
import { buildDenialErrorMessage, buildToolDenial } from '../platform/src/platform/permissions/denial.js';
import { ApprovalBroker } from '../platform/src/platform/control-plane/approval-broker.js';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';
import { registerPermissionRulesGatewayMethods } from '../platform/src/platform/control-plane/routes/permission-rules.js';
import { waitFor } from './_helpers/test-timeout.js';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import type { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.js';

useGateReadings();

const WORKSPACE = '/tmp/gv-approval-workspace';

function makeConfigReader(mode: 'prompt' | 'custom' = 'prompt'): PermissionConfigReader {
  return {
    getAutonomousSnapshot: () => ({ permissions: { mode, tools: {} }, autoApprove: false, directory: WORKSPACE }),
    isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => WORKSPACE,
    getSnapshot: () => ({ permissions: { mode, tools: {} } }),
  } as unknown as PermissionConfigReader;
}

const classic = <T>(run: () => Promise<T>): Promise<T> => withDecisionModelPolicy(() => 'Classic - Off', run);

function makePolicyRuntimeState(): Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'> {
  return {
    recordPermissionRequest: () => {},
    recordPermissionDecision: () => {},
    getRegistry: () => ({ getCurrent: () => undefined }) as unknown as ReturnType<PolicyRuntimeState['getRegistry']>,
  };
}

function makeManager(
  store: UserPermissionRuleStore,
  onPrompt: (request: PermissionPromptRequest) => Promise<PermissionPromptDecision>,
): PermissionManager {
  return new PermissionManager(onPrompt, makeConfigReader(), makePolicyRuntimeState(), null, null, store);
}

function execArgs(...cmds: string[]): Record<string, unknown> {
  return { commands: cmds.map((cmd) => ({ cmd })) };
}

describe('durable approval rules', () => {
  test('a granted command-class rule survives restart and suppresses re-asks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-approval-rules-'));
    try {
      const rulePath = join(dir, 'permission-rules.json');
      const store = new UserPermissionRuleStore(rulePath);
      await store.init();

      let prompts = 0;
      const manager = makeManager(store, async () => {
        prompts += 1;
        return { approved: true, rememberTier: 'command-class' };
      });

      await classic(async () => {
        // The owner's one answer is what writes the rule.
        const first = await manager.checkDetailed('exec', execArgs('git commit -m "one"'));
        expect(first).toMatchObject({ approved: true, reasonCode: 'user_approved' });
        expect(prompts).toBe(1);

        // The tenth git command of the session must not re-ask.
        for (const cmd of ['git push', 'git status', 'git log --oneline']) {
          const result = await manager.checkDetailed('exec', execArgs(cmd));
          expect(result).toMatchObject({ approved: true, reasonCode: 'user_rule_allow' });
        }
        expect(prompts).toBe(1);

        // RESTART: a fresh store + manager over the same file.
        const rebornStore = new UserPermissionRuleStore(rulePath);
        await rebornStore.init();
        const reborn = makeManager(rebornStore, async () => {
          throw new Error('re-asked after restart, the durable rule was lost');
        });
        const afterRestart = await reborn.checkDetailed('exec', execArgs('git commit -m "two"'));
        expect(afterRestart.approved).toBe(true);
        expect(afterRestart.sourceLayer).toBe('user_rule');
        expect(afterRestart.reasonCode).toBe('user_rule_allow');

        // Unrelated calls receive no authority from the persisted class grant.
        let asked = 0;
        const askingManager = makeManager(rebornStore, async () => {
          asked += 1;
          return { approved: false };
        });
        const unrelated = await askingManager.checkDetailed('exec', execArgs('npm publish'));
        expect(unrelated).toMatchObject({ approved: false, reasonCode: 'user_denied' });
        expect(asked).toBe(1);

        // A mixed batch (git + non-git) must not ride in on the git grant.
        const mixedManager = makeManager(rebornStore, async () => {
          asked += 1;
          return { approved: false };
        });
        const mixed = await mixedManager.checkDetailed('exec', execArgs('git status', 'curl evil.example'));
        expect(mixed).toMatchObject({ approved: false, reasonCode: 'user_denied' });
        expect(asked).toBe(2);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an edit approval scoped to a path does not authorize other paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-approval-rules-'));
    try {
      const store = new UserPermissionRuleStore(join(dir, 'permission-rules.json'));
      await store.init();

      let prompts = 0;
      const manager = makeManager(store, async () => ++prompts === 1
        ? { approved: true, rememberTier: 'path' }
        : { approved: false });

      await classic(async () => {
        const first = await manager.checkDetailed('edit', {
          edits: [{ path: `${WORKSPACE}/src/a.ts`, find: 'x', replace: 'y' }],
        });
        expect(first).toMatchObject({ approved: true, reasonCode: 'user_approved' });
        expect(prompts).toBe(1);

        // Same directory: covered, no re-ask.
        const sameDir = await manager.checkDetailed('edit', {
          edits: [{ path: `${WORKSPACE}/src/b.ts`, find: 'x', replace: 'y' }],
        });
        expect(sameDir).toMatchObject({ approved: true, reasonCode: 'user_rule_allow' });
        expect(prompts).toBe(1);

        // Different directory: not covered by the persisted path grant, so the owner is asked again.
        const unrelated = await manager.checkDetailed('edit', {
          edits: [{ path: `${WORKSPACE}/secrets/c.ts`, find: 'x', replace: 'y' }],
        });
        expect(unrelated).toMatchObject({ approved: false, reasonCode: 'user_denied' });
        expect(prompts).toBe(2);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the ask payload carries the remember tier options for any surface', () => {
    const options = buildRememberOptions('exec', execArgs('git commit -m "x"'));
    const tiers = options.map((option) => option.tier);
    expect(tiers).toEqual(['exact', 'command-class', 'tool', 'session']);
    expect(options.find((option) => option.tier === 'command-class')?.label).toContain('git');
  });

  test('deny-with-reason yields the structured user-declined result for a continuing turn', async () => {
    const store = new UserPermissionRuleStore(':memory:');
    await store.init();
    const manager = makeManager(store, async () => ({ approved: false, reason: 'use bun, not npm' }));
    const result = await classic(() => manager.checkDetailed('exec', execArgs('npm install')));
    expect(result).toMatchObject({ approved: false, reasonCode: 'user_denied', sourceLayer: 'user_prompt', userReason: 'use bun, not npm' });

    // The exact structured result the model sees on the CONTINUING turn,
    // same shape as the plan-mode prior art, with the user's words on it.
    const denial = buildToolDenial(result);
    expect(denial).toEqual({ denied: true, reason: 'user_denied', scope: 'user_prompt', standing: false, detail: 'use bun, not npm' });
    const message = buildDenialErrorMessage('exec', result);
    expect(message).toContain('use bun, not npm');
  });
});

describe('approval broker coalescing and sweep', () => {
  function makeRequest(callId: string, tool: string, args: Record<string, unknown>): PermissionPromptRequest {
    return {
      callId,
      tool,
      args,
      category: 'execute',
      analysis: { classification: 'generic', riskLevel: 'medium', summary: 's', reasons: [] },
    } as unknown as PermissionPromptRequest;
  }

  test('two concurrent identical asks get one prompt and both resolve', async () => {
    const broker = new ApprovalBroker({ storePath: ':memory:' });
    let prompts = 0;
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    const localPrompt = async (): Promise<PermissionPromptDecision> => {
      prompts += 1;
      await released;
      return { approved: true };
    };

    const args = execArgs('git status');
    const firstAsk = broker.requestApproval({ request: makeRequest('c1', 'exec', args), sessionId: 's1', localPrompt });
    await waitFor(() => prompts === 1);
    const secondAsk = broker.requestApproval({ request: makeRequest('c2', 'exec', args), sessionId: 's1', localPrompt });
    // The in-memory broker does no I/O, so one turn of the event loop lets the second ask attach to the first's record.
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    const [first, second] = await Promise.all([firstAsk, secondAsk]);
    expect(first.approved).toBe(true);
    expect(second.approved).toBe(true);
    expect(prompts).toBe(1);
    // One record, resolved once.
    const records = broker.listApprovals();
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe('approved');
  });

  test('a remember-tier decision sweeps queued asks the rule covers', async () => {
    const broker = new ApprovalBroker({ storePath: ':memory:' });

    // Two DIFFERENT git commands queued (not identical, no coalescing).
    const p1 = broker.requestApproval({ request: makeRequest('c1', 'exec', execArgs('git commit -m "x"')), sessionId: 's1' });
    const p2 = broker.requestApproval({ request: makeRequest('c2', 'exec', execArgs('git push origin main')), sessionId: 's1' });
    // And one non-git ask that the git grant must NOT sweep.
    const p3 = broker.requestApproval({ request: makeRequest('c3', 'exec', execArgs('npm publish')), sessionId: 's1' });

    // Registration is async (store load + persist): wait for the records to land.
    await waitFor(() => broker.listApprovals().filter((record) => record.status === 'pending').length === 3);
    const pending = broker.listApprovals().filter((record) => record.status === 'pending');
    expect(pending).toHaveLength(3);
    const target = pending.find((record) => record.callId === 'c1')!;

    await broker.resolveApproval(target.id, {
      approved: true,
      rememberTier: 'command-class',
      actor: 'operator',
    });

    const first = await p1;
    const second = await p2;
    expect(first.approved).toBe(true);
    expect(second.approved).toBe(true);

    const after = broker.listApprovals();
    expect(after.filter((record) => record.status === 'approved')).toHaveLength(2);
    // The npm ask is still pending, resolve it so nothing dangles.
    const npmAsk = after.find((record) => record.callId === 'c3')!;
    expect(npmAsk.status).toBe('pending');
    await broker.resolveApproval(npmAsk.id, { approved: false, reason: 'not now', actor: 'operator' });
    const third = await p3;
    expect(third.approved).toBe(false);
    expect(third.reason).toBe('not now');
  });
});

describe('permissions.rules.* settings surface', () => {
  test('rules are listable and deletable via the gateway verbs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-approval-rules-'));
    try {
      const store = new UserPermissionRuleStore(join(dir, 'permission-rules.json'));
      await store.init();
      let prompts = 0;
      const manager = makeManager(store, async () => ++prompts === 1
        ? { approved: true, rememberTier: 'command-class' }
        : { approved: false });
      await classic(() => manager.checkDetailed('exec', execArgs('git commit -m "x"')));
      expect(prompts).toBe(1);

      const catalog = new GatewayMethodCatalog();
      registerPermissionRulesGatewayMethods(catalog, { userRuleStore: store });
      expect(catalog.hasHandler('permissions.rules.list')).toBe(true);
      expect(catalog.hasHandler('permissions.rules.delete')).toBe(true);

      const ctx = { context: { admin: true } } as const;
      const listed = await catalog.invoke('permissions.rules.list', { ...ctx, body: {} }) as {
        rules: { id: string; effect: string; tier: string; tool: string }[];
      };
      expect(listed.rules).toHaveLength(1);
      expect(listed.rules[0]!.effect).toBe('allow');
      expect(listed.rules[0]!.tier).toBe('command-class');
      expect(listed.rules[0]!.tool).toBe('exec');

      const deleted = await catalog.invoke('permissions.rules.delete', { ...ctx, body: { ruleId: listed.rules[0]!.id } }) as { deleted: boolean };
      expect(deleted.deleted).toBe(true);
      const relisted = await catalog.invoke('permissions.rules.list', { ...ctx, body: {} }) as { rules: unknown[] };
      expect(relisted.rules).toHaveLength(0);

      // Revocation is live: the same manager must consult the next decision.
      const afterDelete = await classic(() => manager.checkDetailed('exec', execArgs('git commit -m "y"')));
      expect(afterDelete).toMatchObject({ approved: false, reasonCode: 'user_denied' });
      expect(prompts).toBe(2);

      const missing = await catalog.invoke('permissions.rules.delete', { ...ctx, body: { ruleId: 'nope' } }) as { deleted: boolean };
      expect(missing.deleted).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
