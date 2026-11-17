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
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { firstJsonSchemaFailure, firstJsonSchemaFailureAsync, isLinearSchemaPattern } from '../transport-http/src/client-plumbing.ts';
import { LayeredPolicyEvaluator } from '../platform/src/platform/runtime/permissions/evaluator.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

/** Patterns whose backtracking cost grows faster than the input: nested, overlapping, and adjacent bounded repeats. */
const STALLING = [
  '^(a+)+$',
  '^(a|aa)*$',
  '^(?:a|a)?(?:a|a)?(?:a|a)?$',
  '^a{0,255}a{0,255}$',
  '^a{1,64}a{1,64}a{1,64}$',
  '^[a-z]{0,40}[a-f]{0,40}$',
  '^\\w{1,100}\\d{1,100}$',
  '^(?:a{1,30}){1,30}$',
  '(.*a){12}',
];

/** The patterns the shipped contracts carry, and the shapes like them. */
const SHIPPED = ['^[a-f0-9]{64}$', '^[!-~][ -~]{0,255}$', '[^!-~]', '\\S', '^\\d+(?:\\.\\d{1,3})?$', '^[a-z]{1,40}-[0-9]{1,8}$'];

describe('a stalling pattern does not run on the calling thread', () => {
  test('the linearity proof refuses nested, overlapping and adjacent bounded repeats, and admits the shipped patterns', () => {
    for (const source of STALLING) expect(isLinearSchemaPattern(source), source).toBe(false);
    for (const source of SHIPPED) expect(isLinearSchemaPattern(source), source).toBe(true);
  });

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

describe('the fast path is exact for the shipped contract patterns', () => {
  test('every verdict equals the native one, for the pattern and its negation, sync and async', async () => {
    const cases = [
      ['^[a-f0-9]{64}$', /^[a-f0-9]{64}$/],
      ['^[!-~][ -~]{0,255}$', /^[!-~][ -~]{0,255}$/],
      ['[^!-~]', /[^!-~]/],
      ['\\S', /\S/],
    ] as const;
    const values = ['', 'abc', 'a'.repeat(64), 'a'.repeat(65), 'a'.repeat(256), 'a'.repeat(257),
      'x\n', 'x\r', 'x\r\n', 'x ', 'x ', ' ', '﻿', '🙂', 'a'.repeat(64) + '\n'];
    for (const [source, literal] of cases) for (const value of values) {
      const schema = { type: 'string', pattern: source };
      expect(firstJsonSchemaFailure(schema, value) === undefined).toBe(literal.test(value));
      expect(await firstJsonSchemaFailureAsync(schema, value) === undefined).toBe(literal.test(value));
      expect(firstJsonSchemaFailure({ not: schema }, value) === undefined).toBe(!literal.test(value));
    }
  });

  test('refs, not, allOf, anyOf, oneOf and dictionaries are all applied', async () => {
    const schema = { type: 'object', $defs: { tag: { type: 'string', pattern: '^ok$' } },
      additionalProperties: { allOf: [{ $ref: '#/$defs/tag' }], not: { pattern: '^bad$' }, anyOf: [{ pattern: '^ok$' }, { const: 'alternate' }], oneOf: [{ pattern: '^ok$' }, { const: 'other' }] } };
    expect(await firstJsonSchemaFailureAsync(schema, { first: 'ok', second: 'ok' })).toBeUndefined();
    expect((await firstJsonSchemaFailureAsync(schema, { first: 'bad' }))?.path).toBe('$.first');
  });

  test('a deep schema is validated to the bottom and a cyclic reference fails rather than passing', async () => {
    let schema: Record<string, unknown> = { type: 'string', pattern: '^required$' };
    let value: unknown = 'wrong';
    for (let i = 0; i < 100; i++) { schema = { type: 'object', properties: { child: schema } }; value = { child: value }; }
    expect(await firstJsonSchemaFailureAsync(schema, value)).toBeDefined();
    expect(firstJsonSchemaFailure({ $ref: '#' }, 'value')).toBeDefined();
  });
});

test('an owner deny rule with a pattern matcher denies with no judgment service', async () => {
  const rule = { type: 'arg-shape' as const, id: 'deny', origin: 'user' as const, effect: 'deny' as const, toolPattern: 'read', argMatchers: { path: '/private/' } };
  const evaluator = new LayeredPolicyEvaluator({ mode: 'default', rules: [rule], defaultEffect: 'allow' });
  expect((await evaluator.evaluateAsync('read', { path: 'private' }, 'read')).allowed).toBe(false);
  expect((await evaluator.evaluateAsync('read', { path: 'public' }, 'read')).allowed).toBe(true);
});
