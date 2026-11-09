import { expect, test } from 'bun:test';
import { SpawnTokenManager } from '../platform/src/platform/security/spawn-tokens.js';

test('serialized grants resolve only under the original manager', () => {
  const owner = new SpawnTokenManager('session:with:colons');
  const token = owner.createOrchestratorToken();
  const copy = JSON.parse(JSON.stringify(token));
  expect(copy.sessionId).toBe('session:with:colons');
  expect(owner.validate(copy).valid).toBe(true);
  expect(new SpawnTokenManager('session:with:colons').validate(copy).valid).toBe(false);
});

test('editing the returned token cannot change the retained grant', () => {
  const owner = new SpawnTokenManager('session');
  const token = owner.createOrchestratorToken(); const original = { ...token };
  token.maxDepth = 100; token.canGenerate = false;
  expect(owner.validate(token).valid).toBe(false);
  expect(owner.validate(original).valid).toBe(true);
  const child = owner.generateAgentToken(original, 'child');
  expect(child?.maxDepth).toBe(1); expect(child?.canGenerate).toBe(false);
  expect(owner.generateAgentToken(child!, 'grandchild')).toBeNull();
});

test('revocation and expiry retire the exact issued grant', () => {
  const owner = new SpawnTokenManager('session');
  const token = owner.createOrchestratorToken(); const other = owner.createOrchestratorToken();
  expect(token.id).not.toBe(other.id);
  expect(owner.revoke(token.id)).toBe(true);
  expect(owner.validate(token).valid).toBe(false);
  expect(owner.validate(other).valid).toBe(true);
  expect(owner.validate(owner.createOrchestratorToken(-1)).valid).toBe(false);
});

test('accessor fields cannot impersonate the saved data properties', () => {
  const owner = new SpawnTokenManager('session'); const token = owner.createOrchestratorToken();
  let reads = 0;
  Object.defineProperty(token, 'maxDepth', { get() { reads++; return 1; } });
  expect(owner.validate(token).valid).toBe(false); expect(reads).toBe(0);
});

test('registry membership does not override recursion, capacity or issued depth', () => {
  const owner = new SpawnTokenManager('session');
  const root = owner.createOrchestratorToken(), child = owner.generateAgentToken(root, 'child')!;
  const policy = { recursionEnabled: true, maxDepth: 1, maxActiveAgents: 2 };
  expect(owner.canSpawn(child, policy, 1).allowed).toBe(true);
  expect(owner.canSpawn(child, { ...policy, recursionEnabled: false }, 0).allowed).toBe(false);
  expect(owner.canSpawn(child, policy, 2).allowed).toBe(false);
  expect(owner.canSpawn(child, { ...policy, maxDepth: 0 }, 0).allowed).toBe(false);
});
