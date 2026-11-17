/**
 * Remembered authority keeps its chosen scope and follows live revocation.
 * Explicit owner rules are exercised through live permission and registry consumers.
 * No command is executed: the real registry/admission path ends at a counter.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useGateReadings } from './_helpers/gate-readings.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { createPermissionConfigReader, PermissionManager } from '../platform/src/platform/permissions/manager.ts';
import type { PermissionRequestHandler } from '../platform/src/platform/permissions/prompt.ts';
import { buildDurableRuleForDecision } from '../platform/src/platform/permissions/approval-rules.ts';
import { UserPermissionRuleStore } from '../platform/src/platform/permissions/user-rule-store.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { registerPermissionRulesGatewayMethods } from '../platform/src/platform/control-plane/routes/permission-rules.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';

useGateReadings([['git wipe-fixture', { catastrophic: true }]]);

const execArgs = (...commands: string[]): Record<string, unknown> => ({
  commands: commands.map((cmd) => ({ cmd })),
});
const commit = execArgs('git commit -m one');
const push = execArgs('git push');

const settingsDir = mkdtempSync(join(tmpdir(), 'gv-remembered-scope-'));
afterAll(() => { rmSync(settingsDir, { recursive: true, force: true }); });
/** The real settings, at their shipped defaults, behind every permission consumer here. */
const settings = createPermissionConfigReader(new ConfigManager({
  surfaceRoot: 'agent', workingDir: join(settingsDir, 'workspace'), homeDir: join(settingsDir, 'home'), configDir: join(settingsDir, 'config'),
}));

function manager(handler: PermissionRequestHandler, store: UserPermissionRuleStore | null, surfaceId?: string): PermissionManager {
  return new PermissionManager(handler, settings, new PolicyRuntimeState(), null, null, store, { surfaceOf: () => surfaceId });
}

async function revoke(store: UserPermissionRuleStore): Promise<void> {
  const catalog = new GatewayMethodCatalog();
  registerPermissionRulesGatewayMethods(catalog, { userRuleStore: store });
  const invocation = { context: { admin: true } } as const;
  const listed = await catalog.invoke('permissions.rules.list', { ...invocation, body: {} }) as { rules: { id: string }[] };
  expect(listed.rules).toHaveLength(1);
  expect(await catalog.invoke('permissions.rules.delete', {
    ...invocation, body: { ruleId: listed.rules[0]!.id },
  })).toEqual({ deleted: true });
  expect(store.rules()).toHaveLength(0);
}

async function remember(store: UserPermissionRuleStore, args: Record<string, unknown>, tier: 'exact' | 'command-class', effect: 'allow' | 'deny' = 'allow') {
  const rule = buildDurableRuleForDecision({ toolName: 'exec', args, tier, effect });
  if (!rule) throw new Error('Expected a durable rule');
  await store.add({ rule, tier, createdAt: 1, tool: 'exec' });
}

describe('remembered exec scope', () => {
  test.each(['deny'] as const)('an exact %s rule applies only to its literal command and live deletion removes it', async effect => {
    const store = new UserPermissionRuleStore(':memory:');
    await remember(store, commit, 'exact', effect);
    let asks = 0;
    const permissions = manager(async () => { asks++; return { approved: false }; }, store);
    const otherConsumer = manager(async () => { asks++; return { approved: false }; }, store);
    for (const consumer of [permissions, otherConsumer]) {
      expect(await consumer.checkDetailed('exec', commit)).toMatchObject({ approved: false, persisted: true, sourceLayer: 'user_rule' });
      expect(await consumer.checkDetailed('exec', push)).toMatchObject({ approved: true, persisted: false, sourceLayer: 'stakes_preset' });
    }
    await revoke(store);
    for (const consumer of [permissions, otherConsumer]) expect(await consumer.checkDetailed('exec', commit)).toMatchObject({ approved: true, persisted: false, sourceLayer: 'stakes_preset' });
    expect(asks).toBe(0);
  });
  test('a command-class grant covers the class and deletion takes effect for both consumers', async () => {
    const store = new UserPermissionRuleStore(':memory:'); await remember(store, commit, 'command-class');
    const consumers = [manager(async () => ({ approved: false }), store), manager(async () => ({ approved: false }), store)];
    for (const consumer of consumers) expect(await consumer.checkDetailed('exec', push)).toMatchObject({ sourceLayer: 'user_rule', approved: true });
    await revoke(store);
    for (const consumer of consumers) expect(await consumer.checkDetailed('exec', push)).toMatchObject({ sourceLayer: 'stakes_preset', persisted: false });
  });
  test('declared input-only surfaces refuse effects even with a stored grant', async () => {
    const store = new UserPermissionRuleStore(':memory:'); await remember(store, commit, 'command-class');
    const permissions = manager(async () => ({ approved: true }), store, 'email');
    expect(await permissions.checkDetailed('exec', commit)).toMatchObject({ approved: false, sourceLayer: 'boundary', reasonCode: 'boundary_surface_authority' });
  });
});

describe('literal exact command authority', () => {
  const original = 'git add src/README.md';

  test('an explicit command-class grant keeps its broad case and whitespace behavior', async () => {
    const store = new UserPermissionRuleStore(':memory:'); await remember(store, execArgs(original), 'command-class');
    const permissions = manager(async () => { throw new Error('Unexpected prompt'); }, store);
    for (const command of [original, 'git', ' GIT ', ' GIT ADD src/readme.md ', 'git push']) {
      expect(await permissions.checkDetailed('exec', execArgs(command))).toMatchObject({ approved: true, sourceLayer: 'user_rule' });
    }
    expect(await permissions.checkDetailed('exec', execArgs('gitfoo push'))).toMatchObject({ sourceLayer: 'stakes_preset', persisted: false });
  });

  test('literal exact commands preserve their bytes after serialization and reopening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-literal-exact-'));
    try {
      const path = join(dir, 'rules.json');
      const command = ' git add src/README.md\n';
      const store = new UserPermissionRuleStore(path);
      const rule = buildDurableRuleForDecision({ toolName: 'exec', args: execArgs(command), tier: 'exact', effect: 'allow' })!;
      await store.add({ rule, createdAt: 1, tier: 'exact', tool: 'exec' });
      const reopened = new UserPermissionRuleStore(path);
      await reopened.init();
      expect(reopened.rules()[0]).toMatchObject({ exactCommands: [command] });
      let asks = 0;
      const permissions = manager(async () => { asks++; return { approved: false }; }, reopened);
      expect((await permissions.checkDetailed('exec', execArgs(command))).approved).toBe(true);
      for (const changed of [command.trim(), command.toLowerCase(), command.toUpperCase()]) {
        expect((await permissions.checkDetailed('exec', execArgs(changed))).sourceLayer).toBe('stakes_preset');
      }
      expect(asks).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
