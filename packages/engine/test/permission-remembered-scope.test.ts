// Proves: A remembered rule covers more than was granted, a remembered deny is not enforced, or a deleted rule keeps applying.
// Red when: A remembered exact deny is not enforced or outlives its deletion, a class grant misses a consumer or covers `gitfoo`, a stored grant lets an input-only surface run a command, or an exact rule is normalised when stored.
// Proves: A rule remembered in one project applies in another, including a repository just cloned.
// Red when: The rule store stops comparing a remembered rule's project with the working directory of the check, so a grant made in one project settles the same command in another.
/**
 * Remembered authority keeps its chosen scope and follows live revocation.
 * Explicit owner rules are exercised through live permission and registry consumers.
 * No command is executed: the real registry/admission path ends at a counter.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useGateReadings } from './_helpers/gate-readings.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { createPermissionConfigReader, PermissionManager } from '../platform/src/platform/permissions/manager.ts';
import type { PermissionRequestHandler } from '../platform/src/platform/permissions/prompt.ts';
import { buildDurableRuleForDecision } from '../platform/src/platform/permissions/approval-rules.ts';
import { projectIdentity, UserPermissionRuleStore } from '../platform/src/platform/permissions/user-rule-store.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { registerPermissionRulesGatewayMethods } from '../platform/src/platform/control-plane/routes/permission-rules.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { withOwnerInput } from '../platform/src/platform/security/turn-input-party.ts';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';

useGateReadings([['git wipe-fixture', { catastrophic: true }], ['git push --force origin', { irreversible: true }]]);

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

/**
 * Every check is made in the owner's own turn, as the product marks an owner's turn: a call outside any turn is someone
 * else's and only reads, refused before any remembered rule is read.
 */
function ownersTurn(permissions: PermissionManager): PermissionManager {
  const check = permissions.checkDetailed.bind(permissions);
  permissions.checkDetailed = ((...args: Parameters<PermissionManager['checkDetailed']>) => withOwnerInput(() => check(...args))) as PermissionManager['checkDetailed'];
  return permissions;
}

function manager(handler: PermissionRequestHandler, store: UserPermissionRuleStore | null, surfaceId?: string): PermissionManager {
  return ownersTurn(new PermissionManager(handler, settings, new PolicyRuntimeState(), null, null, store, { surfaceOf: () => surfaceId }));
}

async function revoke(store: UserPermissionRuleStore): Promise<void> {
  const catalog = new GatewayMethodCatalog();
  registerPermissionRulesGatewayMethods(catalog, { userRuleStore: store });
  // The user's own signed-in session: a caller with no actor is no one the daemon established and reaches
  // no rule (control-plane/caller-reach.ts).
  const invocation = { context: { admin: true, credentialKind: 'user-session', actor: localOwnerActor() } } as const;
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

describe('remembered rules stay in their project', () => {
  test('a grant remembered in one project is asked again in another; a rule with no project applies in both', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-rule-project-'));
    try {
      const store = new UserPermissionRuleStore(join(dir, 'rules.json'));
      await store.init();
      const [projectA, projectB] = [join(dir, 'project-a'), join(dir, 'cloned-b')];
      // project-a is a repository: a program opened in its subfolder is in project-a; a repository nested inside it is
      // a project of its own (workspace/project-identity.ts).
      const [inSubfolder, nestedRepository] = [join(projectA, 'src', 'deep'), join(projectA, 'vendor', 'nested')];
      for (const folder of [join(projectA, '.git'), inSubfolder, join(nestedRepository, '.git'), projectB]) mkdirSync(folder, { recursive: true });
      // The owner's remembered answer to a forced push, a deletion only the owner decides: the grant that must never leak to another project.
      const forcePush = execArgs('git push --force origin');
      const grant = buildDurableRuleForDecision({ toolName: 'exec', args: forcePush, tier: 'command-class', effect: 'allow', ownerOnly: 'unrecoverable-delete' })!;
      await store.remember({ rule: grant, tier: 'command-class', tool: 'exec', createdAt: 1, project: projectIdentity(projectA) });
      const everywhere = buildDurableRuleForDecision({ toolName: 'exec', args: execArgs('npm run build'), tier: 'command-class', effect: 'allow' })!;
      await store.add({ rule: everywhere, tier: 'command-class', tool: 'exec', createdAt: 2 });
      let asks = 0;
      const managerIn = (project: string) => ownersTurn(new PermissionManager(async () => { asks++; return { approved: false }; },
        createPermissionConfigReader(new ConfigManager({ surfaceRoot: 'agent', workingDir: project, homeDir: join(dir, 'home'), configDir: join(dir, 'config') })),
        new PolicyRuntimeState(), null, null, store));
      const [inA, inB] = [managerIn(projectA), managerIn(projectB)];
      expect(await inA.checkDetailed('exec', forcePush)).toMatchObject({ approved: true, sourceLayer: 'user_rule' });
      expect(asks).toBe(0);
      const inProjectB = await inB.checkDetailed('exec', forcePush);
      expect(inProjectB.sourceLayer).not.toBe('user_rule');
      expect(inProjectB.approved).toBe(false);
      // The same project from its subfolder; not in the repository nested inside it.
      expect(await managerIn(inSubfolder).checkDetailed('exec', forcePush)).toMatchObject({ approved: true, sourceLayer: 'user_rule' });
      const inNested = await managerIn(nestedRepository).checkDetailed('exec', forcePush);
      expect(`${inNested.sourceLayer === 'user_rule' ? 'rule' : 'no rule'} ${inNested.approved}`).toBe('no rule false');
      for (const consumer of [inA, inB]) {
        expect(await consumer.checkDetailed('exec', execArgs('npm test'))).toMatchObject({ approved: true, sourceLayer: 'user_rule' });
      }
      expect(asks).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
