// Proves: A change of credentials, rules or conversation goes unnoticed by code that decides from a remembered copy.
// Red when: A rule change, a conversation append or undo, a device revoke or rename, or a session, password or user change does not move its store's revision, or another app's change is not taken in.
/**
 * The revision contract every owner of a fact implements: a captured token is
 * stale after any source moves and the refusal names that source, and each
 * owner moves its revision on every change of its fact (including another
 * process's write it took in) and not on reads.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RevisionSource } from '../platform/src/platform/utils/revision.ts';
import { UserPermissionRuleStore } from '../platform/src/platform/permissions/user-rule-store.ts';
import { buildDurableRuleForDecision } from '../platform/src/platform/permissions/approval-rules.ts';
import { ConversationManager } from '../platform/src/platform/core/conversation.ts';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.ts';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.ts';

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

describe('owners move their revision on every change and not on reads', () => {
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
    await store.diskChangeHeard();
    expect(revision.moved()).toBe(true);
    expect(store.rememberedRules().map(rule => rule.id)).toContain(elsewhere.rule.id);
    expect(revision.moved()).toBe(false);

    expect(await store.delete(added.rule.id)).toBe(true);
    expect(revision.moved()).toBe(true);
    expect(await store.delete('no-such-rule')).toBe(false);
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

  test('device pairings: mint, rename and revoke move it; a last-seen stamp does not; another process minting does once read', async () => {
    const file = join(tempRoot(), 'pairing.json');
    const pairing = new PairingTokenManager(file);
    const revision = watch(pairing.revisionSource);
    const minted = pairing.mint({ name: 'Synthetic device' });
    expect(revision.moved()).toBe(true);
    // The first use claims the offer, which changes who may authenticate.
    expect(pairing.authenticate(minted.token)?.id).toBe(minted.id);
    expect(revision.moved()).toBe(true);
    expect(pairing.authenticate(minted.token)?.id).toBe(minted.id);
    expect(pairing.list()[0]?.lastSeenAt).toBeDefined();
    expect(revision.moved()).toBe(false);

    const other = new PairingTokenManager(file);
    const second = other.mint({ name: 'Synthetic second device' });
    other.authenticate(second.token);
    expect(revision.moved()).toBe(false);
    expect(pairing.list()).toHaveLength(2);
    expect(revision.moved()).toBe(true);

    expect(await pairing.rename(minted.id, 'Renamed device')).toBe(true);
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
});
