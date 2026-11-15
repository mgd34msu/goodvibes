import { describe, expect, test } from 'bun:test';
import { LayeredPolicyEvaluator } from '../platform/src/platform/runtime/permissions/evaluator.ts';

function evaluator(): LayeredPolicyEvaluator {
  return new LayeredPolicyEvaluator({ mode: 'default', rules: [], defaultEffect: 'deny' });
}

describe('session override keys', () => {
  test('a remembered allow for one exec call does not approve a different one', () => {
    const perms = evaluator();
    perms.recordSessionOverride('exec', { commands: [{ cmd: 'ls' }] }, true, true);
    const same = perms.evaluate('exec', { commands: [{ cmd: 'ls' }] }, 'read');
    const other = perms.evaluate('exec', { commands: [{ cmd: 'rm -rf /' }] }, 'read');
    expect(same.sourceLayer).toBe('session');
    expect(same.allowed).toBe(true);
    expect(other.sourceLayer).not.toBe('session');
  });

  test('argument key order does not change the remembered call', () => {
    const perms = evaluator();
    perms.recordSessionOverride('fetch', { urls: [{ url: 'http://a', method: 'GET' }] }, true, true);
    const decision = perms.evaluate('fetch', { urls: [{ method: 'GET', url: 'http://a' }] }, 'read');
    expect(decision.sourceLayer).toBe('session');
  });
});
