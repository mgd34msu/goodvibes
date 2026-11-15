/**
 * The revision contract every owner of a fact implements: a captured token is
 * stale after any source moves and the refusal names that source, and each
 * owner moves its revision on every change of its fact (including another
 * process's write it took in) and not on reads.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCurrent, captureRevisions, isCurrent, revisionSource, StaleError, type RevisionSource } from '../platform/src/platform/utils/revision.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { SecretsManager } from '../platform/src/platform/config/secrets.ts';
import { UserPermissionRuleStore } from '../platform/src/platform/permissions/user-rule-store.ts';
import { buildDurableRuleForDecision } from '../platform/src/platform/permissions/approval-rules.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
import { ConversationManager } from '../platform/src/platform/core/conversation.ts';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.ts';
import { PolicyRegistry, createUnsignedBundle } from '../platform/src/platform/runtime/permissions/index.ts';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.ts';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.ts';
import { UntrustedContentLedger } from '../platform/src/platform/security/untrusted-content.ts';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.ts';
import { RouteBindingManager } from '../platform/src/platform/channels/route-manager.ts';
import { AutomationRouteStore } from '../platform/src/platform/automation/store/routes.ts';
import { PersistentStore } from '../platform/src/platform/state/persistent-store.ts';

const roots: string[] = [];
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-revision-contract-'));
  roots.push(root);
  return root;
}

/** moved() is true when the source moved since the last call; it never moves down. */
function watch(source: RevisionSource): { moved(): boolean } {
  let last = source.revision();
  return {
    moved() {
      const now = source.revision();
      expect(now).toBeGreaterThanOrEqual(last);
      const moved = now !== last;
      last = now;
      return moved;
    },
  };
}

describe('revision token', () => {
  test('is current until any source moves, and the refusal names the source that moved', () => {
    let a = 0, b = 0;
    const token = captureRevisions([revisionSource('first', () => a), revisionSource('second', () => b)]);
    expect(isCurrent(token)).toBe(true);
    assertCurrent(token);
    b += 1;
    expect(isCurrent(token)).toBe(false);
    let refusal: unknown;
    try { assertCurrent(token); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(StaleError);
    const stale = refusal as StaleError;
    expect(stale.sourceId).toBe('second');
    expect([stale.capturedRevision, stale.currentRevision]).toEqual([0, 1]);
    expect(stale.recoverable).toBe(true);
    a += 1;
    expect(() => assertCurrent(token)).toThrow(StaleError);
  });

  test('a cancelled call refuses as cancelled, not as stale', () => {
    const controller = new AbortController();
    const token = captureRevisions([revisionSource('only', () => 0)]);
    controller.abort(new Error('no longer wanted'));
    expect(() => assertCurrent(token, controller.signal)).toThrow('no longer wanted');
  });
});

describe('owners move their revision on every change and not on reads', () => {
  test('settings: set, save, profile fallback, and a settings file another process wrote', () => {
    const root = tempRoot();
    const config = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir: join(root, 'config') });
    const revision = watch(config.revisionSource);
    config.set('display.theme', 'nord');
    expect(revision.moved()).toBe(true);
    expect(config.get('display.theme')).toBe('nord');
    expect(revision.moved()).toBe(false);
    config.save();
    expect(revision.moved()).toBe(true);
    const fallback = (): unknown => undefined;
    config.attachProfileFallback(fallback);
    expect(revision.moved()).toBe(true);
    config.attachProfileFallback(fallback);
    expect(revision.moved()).toBe(false);

    cleanups.push(config.watchConfigFiles({ intervalMs: 2 ** 30 }));
    writeFileSync(join(root, 'config', 'settings.json'), JSON.stringify({ display: { theme: 'dracula' } }));
    config.flushConfigFileChanges();
    expect(config.get('display.theme')).toBe('dracula');
    expect(revision.moved()).toBe(true);
  });

  test('permission rules: add, remember, delete, and another process adding a rule', async () => {
    const file = join(tempRoot(), 'rules.json');
    const store = new UserPermissionRuleStore(file);
    await store.awaitReady();
    const revision = watch(store.revisionSource);
    const ruleFor = (cmd: string) => {
      const rule = buildDurableRuleForDecision({ toolName: 'exec', args: { commands: [{ cmd }] }, tier: 'exact', effect: 'allow' });
      if (!rule) throw new Error('Expected a durable rule');
      return { rule, tier: 'exact' as const, createdAt: 1, tool: 'exec' };
    };
    const added = ruleFor('git status');
    await store.add(added);
    expect(revision.moved()).toBe(true);
    expect(store.rules()).toHaveLength(1);
    expect(revision.moved()).toBe(false);
    await store.remember(ruleFor('git log'));
    expect(revision.moved()).toBe(true);

    const other = new UserPermissionRuleStore(file);
    await other.awaitReady();
    const elsewhere = ruleFor('git diff');
    await other.add(elsewhere);
    expect(revision.moved()).toBe(true);
    expect(store.rememberedRules().map(rule => rule.id)).toContain(elsewhere.rule.id);
    expect(revision.moved()).toBe(false);

    expect(await store.delete(added.rule.id)).toBe(true);
    expect(revision.moved()).toBe(true);
    expect(await store.delete('no-such-rule')).toBe(false);
    expect(revision.moved()).toBe(false);
  });

  test('tool registry: register and unregister', () => {
    const registry = new ToolRegistry();
    const revision = watch(registry.revisionSource);
    const tool = {
      definition: { name: 'synthetic_tool', description: 'A synthetic tool.', parameters: { type: 'object' as const, properties: {} } },
      async execute() { return { success: true, output: 'done' }; },
    };
    registry.register(tool);
    expect(revision.moved()).toBe(true);
    expect(registry.has('synthetic_tool')).toBe(true);
    expect(registry.list()).toHaveLength(1);
    expect(revision.moved()).toBe(false);
    expect(registry.unregister('synthetic_tool')).toBe(true);
    expect(revision.moved()).toBe(true);
    expect(registry.unregister('synthetic_tool')).toBe(false);
    expect(revision.moved()).toBe(false);
  });

  test('conversation: append, undo and reset move it; reads and the title do not', () => {
    const conversation = new ConversationManager();
    const revision = watch(conversation.revisionSource);
    conversation.addUserMessage('Synthetic request.');
    expect(revision.moved()).toBe(true);
    conversation.addAssistantMessage('Synthetic answer.');
    expect(revision.moved()).toBe(true);
    conversation.getMessagesForLLM();
    conversation.getMessageSnapshot();
    conversation.title = 'Synthetic title';
    expect(revision.moved()).toBe(false);
    expect(conversation.undo()).toBe(true);
    expect(revision.moved()).toBe(true);
    conversation.resetAll();
    expect(revision.moved()).toBe(true);
  });

  test('knowledge store: a write, and a write by another store on the same file once adopted', async () => {
    const dbPath = join(tempRoot(), 'knowledge.sqlite');
    const store = new KnowledgeStore({ dbPath });
    cleanups.push(() => store.close());
    await store.init();
    const revision = watch(store.revisionSource);
    await store.upsertSource({ id: 'local', connectorId: 'synthetic', sourceType: 'document', title: 'Local', summary: 'Local source.', status: 'indexed', metadata: {} });
    expect(revision.moved()).toBe(true);
    expect(store.getSource('local')?.title).toBe('Local');
    store.listSources();
    expect(revision.moved()).toBe(false);

    const other = new KnowledgeStore({ dbPath });
    cleanups.push(() => other.close());
    await other.init();
    await other.upsertSource({ id: 'elsewhere', connectorId: 'synthetic', sourceType: 'document', title: 'Elsewhere', summary: 'Written by another store.', status: 'indexed', metadata: {} });
    expect(await store.refreshIfChanged()).toBe(true);
    expect(revision.moved()).toBe(true);
    expect(store.getSource('elsewhere')?.title).toBe('Elsewhere');
  });

  test('policy bundle: load and simulate move it; a refused promotion and an empty rollback do not', () => {
    const registry = new PolicyRegistry();
    const revision = watch(registry.revisionSource);
    expect(registry.loadCandidate(createUnsignedBundle('synthetic', { version: 1, rules: [], description: 'Synthetic bundle' })).ok).toBe(true);
    expect(revision.moved()).toBe(true);
    expect(registry.promote().ok).toBe(false);
    expect(registry.rollback().ok).toBe(false);
    expect(revision.moved()).toBe(false);
    registry.markSimulating();
    expect(revision.moved()).toBe(true);
  });

  test('device pairings: mint, rename and revoke move it; a last-seen stamp does not; another process minting does once read', () => {
    const file = join(tempRoot(), 'pairing.json');
    const pairing = new PairingTokenManager(file);
    const revision = watch(pairing.revisionSource);
    const minted = pairing.mint({ name: 'Synthetic device' });
    expect(revision.moved()).toBe(true);
    expect(pairing.authenticate(minted.token)?.id).toBe(minted.id);
    expect(pairing.list()[0]?.lastSeenAt).toBeDefined();
    expect(revision.moved()).toBe(false);

    const other = new PairingTokenManager(file);
    other.mint({ name: 'Synthetic second device' });
    expect(revision.moved()).toBe(false);
    expect(pairing.list()).toHaveLength(2);
    expect(revision.moved()).toBe(true);

    expect(pairing.rename(minted.id, 'Renamed device')).toBe(true);
    expect(revision.moved()).toBe(true);
    expect(pairing.revoke(minted.id)).toBe(true);
    expect(revision.moved()).toBe(true);
    expect(pairing.revoke(minted.id)).toBe(false);
    expect(revision.moved()).toBe(false);
  });

  test('local auth: sessions, password rotation, and a user another process added', () => {
    const root = tempRoot();
    const config = { bootstrapFilePath: join(root, 'auth-users.json'), bootstrapCredentialPath: join(root, 'auth-bootstrap.txt'),
      scryptParams: { N: 1024, r: 8, p: 1 } };
    const auth = new UserAuthManager(config);
    const revision = watch(auth.revisionSource);
    const session = auth.createSession('admin');
    expect(revision.moved()).toBe(true);
    expect(auth.validateSession(session.token)?.id).toBe(session.id);
    auth.listUsers();
    expect(revision.moved()).toBe(false);
    expect(auth.revokeSession(session.id)).toBe(true);
    expect(revision.moved()).toBe(true);
    expect(auth.revokeSession(session.id)).toBe(false);
    expect(revision.moved()).toBe(false);

    new UserAuthManager(config).addUser('synthetic-operator', 'synthetic-password', ['admin']);
    expect(revision.moved()).toBe(false);
    expect(auth.authenticate('synthetic-operator', 'synthetic-password').ok).toBe(true);
    expect(revision.moved()).toBe(true);

    auth.rotatePassword('synthetic-operator', 'another-synthetic-password');
    expect(revision.moved()).toBe(true);
  });

  test('credentials: set and delete move it; reads do not; another process writing the store does once read', async () => {
    const root = tempRoot();
    const options = { projectRoot: join(root, 'work'), globalHome: join(root, 'home'), surfaceRoot: 'goodvibes', policy: 'preferred_secure' as const };
    const secrets = new SecretsManager(options);
    const revision = watch(secrets.revisionSource);
    await secrets.set('SYNTHETIC_TOKEN', 'synthetic-value', { scope: 'user', medium: 'secure' });
    expect(revision.moved()).toBe(true);
    expect(await secrets.get('SYNTHETIC_TOKEN')).toBe('synthetic-value');
    expect(await secrets.get('SYNTHETIC_TOKEN')).toBe('synthetic-value');
    expect(revision.moved()).toBe(false);

    await new SecretsManager(options).set('SYNTHETIC_TOKEN', 'changed-elsewhere', { scope: 'user', medium: 'secure' });
    expect(revision.moved()).toBe(false);
    expect(await secrets.get('SYNTHETIC_TOKEN')).toBe('changed-elsewhere');
    expect(revision.moved()).toBe(true);

    await secrets.delete('SYNTHETIC_TOKEN');
    expect(revision.moved()).toBe(true);
    expect(await secrets.get('SYNTHETIC_TOKEN')).toBeNull();
    expect(revision.moved()).toBe(false);

    expect(await secrets.getOrCreateDaemonSecret('SYNTHETIC_DAEMON_KEY', () => 'created-once')).toBe('created-once');
    expect(revision.moved()).toBe(true);
    expect(await secrets.getOrCreateDaemonSecret('SYNTHETIC_DAEMON_KEY', () => 'never-used')).toBe('created-once');
    expect(revision.moved()).toBe(false);
  });

  test('shared sessions: create and close move it; reads and closing an unknown session do not', async () => {
    const root = tempRoot();
    const broker = new SharedSessionBroker({
      store: new PersistentStore(join(root, 'sessions.json')) as never,
      routeBindings: new RouteBindingManager({ store: new AutomationRouteStore(join(root, 'bindings.json')) }),
      agentStatusProvider: { getStatus: () => null },
      messageSender: { send: () => false },
    });
    cleanups.push(() => broker.stop());
    await broker.start();
    const revision = watch(broker.revisionSource);
    const session = await broker.createSession({ title: 'Synthetic session' });
    expect(revision.moved()).toBe(true);
    expect(broker.getSession(session.id)?.id).toBe(session.id);
    broker.listSessions();
    expect(revision.moved()).toBe(false);
    expect((await broker.closeSession(session.id))?.status).toBe('closed');
    expect(revision.moved()).toBe(true);
    expect(await broker.closeSession('no-such-session')).toBeNull();
    expect(revision.moved()).toBe(false);
  });

  test('untrusted content: a recorded read and a turn start move it; queries do not', () => {
    const ledger = new UntrustedContentLedger();
    const revision = watch(ledger.revisionSource);
    ledger.record({ surface: 'email', origin: 'synthetic.example', at: new Date(0).toISOString(), content: 'Synthetic untrusted text.' });
    expect(revision.moved()).toBe(true);
    expect(ledger.hasIngestedThisTurn()).toBe(true);
    ledger.originsThisTurn();
    expect(revision.moved()).toBe(false);
    ledger.startTurn();
    expect(revision.moved()).toBe(true);
  });
});
