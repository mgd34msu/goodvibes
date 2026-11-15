/**
 * What a remembered answer covers: the project it was made in, the session that gave it, the exact
 * command (not what follows a shell operator), and never above an administrator's deny.
 */
import { describe, expect, test } from 'bun:test';
import { useGateReadings } from './_helpers/gate-readings.ts';
import { PermissionManager, type PermissionConfigReader } from '../platform/src/platform/permissions/manager.ts';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.ts';
import { UserPermissionRuleStore, type StoredUserPermissionRule } from '../platform/src/platform/permissions/user-rule-store.ts';
import { buildDurableRuleForDecision, buildRememberOptions } from '../platform/src/platform/permissions/approval-rules.ts';
import { TurnHookOwner } from '../platform/src/platform/hooks/turn-ownership.ts';
import type { PolicyRuntimeState as PolicyRuntime } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.ts';
import { evaluatePrefixRule } from '../platform/src/platform/runtime/permissions/rules/prefix.ts';
import { LayeredPolicyEvaluator } from '../platform/src/platform/runtime/permissions/evaluator.ts';
import type { PolicyRule, PrefixRule } from '../platform/src/platform/runtime/permissions/types.ts';

useGateReadings();

const classic = <T>(run: () => Promise<T>): Promise<T> => withDecisionModelPolicy(() => 'Classic - Off', run);
const exec = (cmd: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ commands: [{ cmd, ...extra }] });

function manager(store: UserPermissionRuleStore | null, answer: (request: PermissionPromptRequest) => PermissionPromptDecision, directory = '/synthetic/project-a') {
  const asked: PermissionPromptRequest[] = [];
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

const owner = (sessionId: string) => new TurnHookOwner(sessionId, 'turn-1', new AbortController().signal);

describe('a remembered rule belongs to the project it was made in', () => {
  test('made in one project it is not applied in another; a rule with no project key still applies everywhere', async () => {
    const store = new UserPermissionRuleStore(':memory:');
    await store.awaitReady();
    await classic(async () => {
      const a = manager(store, () => ({ approved: true, rememberTier: 'tool' }), '/synthetic/project-a');
      expect(await a.permissions.checkDetailed('exec', exec('git status'))).toMatchObject({ approved: true, reasonCode: 'user_approved' });
      expect(await a.permissions.checkDetailed('exec', exec('git log'))).toMatchObject({ reasonCode: 'user_rule_allow' });
      const b = manager(store, () => ({ approved: false }), '/synthetic/project-b');
      expect(await b.permissions.checkDetailed('exec', exec('git log'))).toMatchObject({ approved: false, reasonCode: 'user_denied' });
      expect(b.asked).toHaveLength(1);

      const legacy = buildDurableRuleForDecision({ toolName: 'exec', args: exec('ls'), tier: 'tool', effect: 'allow' })!;
      await store.add({ rule: legacy, tier: 'tool', tool: 'exec', createdAt: 1 });
      expect(await b.permissions.checkDetailed('exec', exec('ls'))).toMatchObject({ approved: true, reasonCode: 'user_rule_allow' });
    });
  });

  test('a relative path rule remembered in one project does not cover the same path in another', async () => {
    const store = new UserPermissionRuleStore(':memory:');
    await store.awaitReady();
    await classic(async () => {
      const edit = { path: 'src/a.ts', content: 'x' };
      const a = manager(store, () => ({ approved: true, rememberTier: 'path' }), '/synthetic/project-a');
      await a.permissions.checkDetailed('write', edit);
      expect(await a.permissions.checkDetailed('write', edit)).toMatchObject({ reasonCode: 'user_rule_allow' });
      const b = manager(store, () => ({ approved: false }), '/synthetic/project-b');
      expect(await b.permissions.checkDetailed('write', edit)).toMatchObject({ approved: false, reasonCode: 'user_denied' });
    });
  });
});

describe('a session answer stays with the session that gave it', () => {
  test('one hosted session approving a class does not approve it in another, and the prompt says what it grants', async () => {
    await classic(async () => {
      const { permissions, asked } = manager(null, () => ({ approved: true, rememberTier: 'session' }));
      await permissions.checkDetailed('exec', exec('git status'), undefined, { hookOwner: owner('session-1') });
      expect(asked[0]!.rememberOptions!.find(option => option.tier === 'session')!.label).toBe('every git command this session');
      expect(await permissions.checkDetailed('exec', exec('git log'), undefined, { hookOwner: owner('session-1') })).toMatchObject({ reasonCode: 'session_cached_allow' });
      expect(asked).toHaveLength(1);
      expect(await permissions.checkDetailed('exec', exec('git log'), undefined, { hookOwner: owner('session-2') })).toMatchObject({ reasonCode: 'user_approved' });
      expect(asked).toHaveLength(2);
    });
  });

  test('a session answer about a simple command never covers a compound one', async () => {
    await classic(async () => {
      const { permissions, asked } = manager(null, () => ({ approved: true, rememberTier: 'session' }));
      await permissions.checkDetailed('exec', exec('git status'));
      await permissions.checkDetailed('exec', exec('git status; rm -rf ~'));
      expect(asked).toHaveLength(2);
      expect(asked[1]!.rememberOptions!.find(option => option.tier === 'session')!.label).toBe('this exact command this session');
    });
  });

  test('the session option names the tool when the key is the whole tool', () => {
    expect(buildRememberOptions('fetch', { urls: [{ url: 'https://example.test' }] }).find(option => option.tier === 'session')!.label)
      .toBe('every fetch call this session');
  });
});

const classRule = buildDurableRuleForDecision({ toolName: 'exec', args: exec('git status'), tier: 'command-class', effect: 'allow' }) as PrefixRule;
const exactRule = (args: Record<string, unknown>, effect: 'allow' | 'deny' = 'allow') =>
  buildDurableRuleForDecision({ toolName: 'exec', args, tier: 'exact', effect }) as PrefixRule;
const matches = (rule: PrefixRule, args: Record<string, unknown>) => evaluatePrefixRule(rule, 'exec', args).matched;

describe('a remembered command allow covers only what was approved', () => {
  test('a class rule matches simple commands and never one that runs something else', () => {
    expect(matches(classRule, exec('git status --short'))).toBe(true);
    for (const cmd of ['git status; rm -rf ~', 'git status && rm x', 'git status || rm x', 'git log | sh', 'git log & rm x', 'git log `rm x`',
      'git log $(rm x)', 'git log > /etc/passwd', 'git log < /etc/passwd', 'git log\nrm x', 'git log "unterminated']) {
      expect(matches(classRule, exec(cmd))).toBe(false);
    }
  });

  test('every segment matching the class on its own is enough; quoted operators are data', () => {
    expect(matches(classRule, exec('git status && git log'))).toBe(true);
    expect(matches(classRule, exec('git commit -m "fix; tidy | up"'))).toBe(true);
    expect(matches(classRule, exec('git status && rm x'))).toBe(false);
  });

  test('joining output streams or discarding output is covered; writing a file is not', () => {
    for (const cmd of ['git status 2>&1', 'git log >/dev/null 2>&1', 'git fetch 2> /dev/null && git status']) {
      expect(matches(classRule, exec(cmd))).toBe(true);
    }
    for (const cmd of ['git log >&out.txt', 'git log > /dev/nullx', 'git log 2>&1 | sh', 'git log &> out.txt']) {
      expect(matches(classRule, exec(cmd))).toBe(false);
    }
  });

  test('a deny matches when any segment does', () => {
    const deny = buildDurableRuleForDecision({ toolName: 'exec', args: exec('rm x'), tier: 'command-class', effect: 'deny' }) as PrefixRule;
    expect(matches(deny, exec('echo hi && rm x'))).toBe(true);
  });

  test('an exact allow matches only the environment, directory and detachment it was approved with', () => {
    const approved = exact('make build', { env: { CI: '1' }, working_dir: '/work/a' });
    expect(matches(approved, exec('make build', { env: { CI: '1' }, working_dir: '/work/a' }))).toBe(true);
    expect(matches(approved, exec('make build', { env: { CI: '0' }, working_dir: '/work/a' }))).toBe(false);
    expect(matches(approved, exec('make build', { env: { CI: '1' }, working_dir: '/work/b' }))).toBe(false);
    expect(matches(approved, exec('make build', { env: { CI: '1' }, working_dir: '/work/a', background: true }))).toBe(false);
    expect(matches(approved, exec('make build'))).toBe(false);
    const plain = exact('make build');
    expect(matches(plain, exec('make build'))).toBe(true);
    expect(matches(plain, exec('make build', { env: { PATH: '/evil' } }))).toBe(false);
    expect(matches(plain, { commands: [{ cmd: 'make build' }], working_dir: '/elsewhere' })).toBe(false);
  });

  test('an exact deny applies whatever the context', () => {
    expect(matches(exactRule(exec('make build'), 'deny'), exec('make build', { env: { A: '1' } }))).toBe(true);
  });

  test('an exact rule saved before the context was recorded matches a call that fixes none', () => {
    const { exactContext: _omitted, ...saved } = exactRule(exec('make build'));
    expect(matches(saved as PrefixRule, exec('make build'))).toBe(true);
    expect(matches(saved as PrefixRule, exec('make build', { working_dir: '/x' }))).toBe(false);
  });
});

function exact(cmd: string, extra: Record<string, unknown> = {}): PrefixRule { return exactRule(exec(cmd, extra)); }

describe('an administrator deny outranks any user allow', () => {
  const userAllow: PolicyRule = { type: 'prefix', id: 'user-allow', origin: 'user', effect: 'allow', toolPattern: 'exec' };
  const managedDeny: PolicyRule = { type: 'prefix', id: 'managed-deny', origin: 'managed', effect: 'deny', toolPattern: 'exec', commandPrefixes: ['curl '] };
  const decide = (rules: PolicyRule[], command: string) => new LayeredPolicyEvaluator({ mode: 'default', rules, defaultEffect: 'deny' })
    .evaluate('exec', exec(command), 'escalation');

  test('the user allow does not lift the managed deny, and still applies elsewhere', () => {
    expect(decide([userAllow, managedDeny], 'curl https://x.test')).toMatchObject({ allowed: false, reason: 'RULE_DENY_MANAGED' });
    expect(decide([userAllow, managedDeny], 'ls')).toMatchObject({ allowed: true, reason: 'RULE_ALLOW_USER' });
  });
});

describe('a remembered allow cannot lift a managed deny through the manager', () => {
  test('the managed deny holds over a remembered allow for the same call', async () => {
    const store = new UserPermissionRuleStore(':memory:');
    await store.awaitReady();
    const allow = buildDurableRuleForDecision({ toolName: 'exec', args: exec('curl https://x.test'), tier: 'tool', effect: 'allow' })!;
    await store.add({ rule: allow, tier: 'tool', tool: 'exec', createdAt: 1 });
    const managedDeny: PolicyRule = { type: 'prefix', id: 'managed-deny', origin: 'managed', effect: 'deny', toolPattern: 'exec', commandPrefixes: ['curl '] };
    const policy = { recordPermissionRequest() {}, recordPermissionDecision() {}, getRegistry: () => ({ getCurrent: () => ({ rules: [managedDeny] }) }) };
    const config = { isAutoApproveEnabled: () => false, getWorkingDirectory: () => '/synthetic/project-a',
      getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }) } as unknown as PermissionConfigReader;
    const permissions = new PermissionManager(async () => ({ approved: true }), config, policy as unknown as PolicyRuntime, null, { isEnabled: () => true }, store);
    await classic(async () => {
      expect(await permissions.checkDetailed('exec', exec('curl https://x.test'))).toMatchObject({ approved: false, reasonCode: 'managed_policy_deny' });
    });
  });
});

describe('a choice that could not be saved says so', () => {
  test('a failed save applies the answer to this call and tells the surface why', async () => {
    const store = new UserPermissionRuleStore(':memory:');
    await store.awaitReady();
    store.remember = async (_record: StoredUserPermissionRule) => { throw new Error('disk full'); };
    await classic(async () => {
      const { permissions } = manager(store, () => ({ approved: false, rememberTier: 'exact' }));
      const result = await permissions.checkDetailed('exec', exec('npm publish'));
      expect(result).toMatchObject({ approved: false, reasonCode: 'user_denied' });
      expect(result.detail).toContain('was not saved (disk full)');
      expect(result.detail).toContain('this call only');
    });
  });
});
