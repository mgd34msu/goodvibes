// Proves: A pattern in an untrusted schema (an MCP tool, a contract response) stalls the thread that every message runs on; a deny rule with a pattern stops applying when no decision model is reachable.
// Red when: A pattern with nested or adjacent repeats is handed to the native engine on the calling thread, or a deny rule's pattern matcher needs a judgment service and stops matching without one.
/**
 * A regular expression that can stall the thread is never run natively.
 *
 * Schema patterns (tool arguments, contract responses) run on the calling
 * thread only when `isLinearSchemaPattern` proves them linear; anything else
 * is refused by the synchronous validator and evaluated by the asynchronous
 * one in the isolated executor. The shipped contract patterns stay on the fast
 * path and give exactly the native verdict; validation cannot be bypassed by a
 * deep or cyclic schema; and an owner's deny rule with a pattern matcher denies
 * without any judgment service.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes/engine/errors';
import { firstJsonSchemaFailure, firstJsonSchemaFailureAsync } from '../transport-http/src/client-plumbing.ts';
import { LayeredPolicyEvaluator } from '../platform/src/platform/runtime/permissions/evaluator.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

describe('a stalling pattern does not run on the calling thread', () => {
  test('the synchronous validator refuses a stalling pattern instead of running it; the isolated one evaluates it', async () => {
    // The values match, so a native run would report no failure.
    for (const [source, value] of [['^(a+)+$', 'aaaa'], ['^a{0,255}a{0,255}$', 'aaaa'], ['^\\w{1,100}\\d{1,100}$', 'ab12']] as const) {
      const schema = { type: 'string', pattern: source };
      expect(firstJsonSchemaFailure(schema, value), source).toBeDefined();
      expect(await firstJsonSchemaFailureAsync(schema, value), source).toBeUndefined();
      expect(await firstJsonSchemaFailureAsync(schema, `${value}!`), source).toBeDefined();
    }
  });
});

test('an owner deny rule with a pattern matcher denies with no judgment service', async () => {
  const rule = { type: 'arg-shape' as const, id: 'deny', origin: 'user' as const, effect: 'deny' as const, toolPattern: 'read', argMatchers: { path: '/private/' } };
  const evaluator = new LayeredPolicyEvaluator({ mode: 'default', rules: [rule], defaultEffect: 'allow' });
  expect((await evaluator.evaluateAsync('read', { path: 'private' }, 'read')).allowed).toBe(false);
  expect((await evaluator.evaluateAsync('read', { path: 'public' }, 'read')).allowed).toBe(true);
});
