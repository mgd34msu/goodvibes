import { expect, test } from 'bun:test';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { captureOwnedJson } from '../sdk/src/platform/gate/judgment-input.js';
import {
  captureDecisionModelPolicyOperation, decisionOrClassic, rememberDecisionRefusal, wasDecisionRefused, withDecisionModelPolicy,
  type RefusedDecisionAction,
} from '../sdk/src/platform/runtime/decision-policy.js';

function action(args: Readonly<Record<string, unknown>>, directory = '/workspace'): RefusedDecisionAction {
  return { tool: 'write', args, directory };
}

test('refusal indexing preserves the previous exact snapshot comparison at JSON edge cases', () => {
  const sparse = new Array(2);
  sparse[1] = 'last';
  const extra = ['first'];
  Object.defineProperty(extra, 'note', { value: 'hidden in the caller, captured on an array' });
  const cases = [
    action({}), action({ value: undefined }), action({ value: null }), action({ value: 0 }), action({ value: -0 }),
    action({ value: false }), action({ value: 'false;' }), action({ value: 'undefined;' }),
    action({ value: [] }), action({ value: new Array(1) }), action({ value: [undefined] }), action({ value: [null] }),
    action({ value: sparse }), action({ value: [undefined, 'last'] }), action({ value: ['last'] }),
    action({ value: extra }), action({ value: ['first'] }), action({ value: { length: 1, '0': 'first' } }),
    action({ value: Object.assign(Object.create(null) as Record<string, unknown>, { x: 1 }) }),
    action({ value: { x: 1 } }), action({ value: { x: 1, y: 2 } }), action({ value: { y: 2, x: 1 } }),
    action({ value: { 'a"b': '\u0000object:1:"key"', toJSON: 'literal data' } }),
    action({ value: 1 }, '/another-workspace'),
  ];
  for (const remembered of cases) {
    withDecisionModelPolicy(() => 'Preferred', () => {
      rememberDecisionRefusal(remembered);
      for (const candidate of cases) {
        const expected = isDeepStrictEqual(captureOwnedJson(remembered), captureOwnedJson(candidate));
        expect(wasDecisionRefused(candidate)).toBe(expected);
      }
    });
  }
});

test('every refusal survives more than 1024 subsequent entries and Preferred availability fallback', async () => {
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const first = action({ path: 'first.txt', content: 'Original refused content' });
    rememberDecisionRefusal(first);
    for (let index = 0; index < 1200; index++) {
      rememberDecisionRefusal(action({ path: `file-${index}.txt`, content: `contents ${index}` }));
      if (index % 13 === 0) rememberDecisionRefusal(`opaque action ${index}`);
    }
    await decisionOrClassic(async () => { throw new JudgmentError('unavailable', 'Synthetic exhausted chain'); }, () => undefined);
    expect(wasDecisionRefused(first)).toBe(true);
    expect(wasDecisionRefused('opaque action 0')).toBe(true);
    for (let index = 0; index < 1200; index++) expect(wasDecisionRefused(action({ content: `contents ${index}`, path: `file-${index}.txt` }))).toBe(true);
    expect(wasDecisionRefused(action({ path: 'first.txt', content: 'Changed content' }))).toBe(false);
  });
  expect(wasDecisionRefused(action({ path: 'first.txt', content: 'Original refused content' }))).toBe(false);
});

test('captured policy events retain their own refusal index without leaking into another operation', async () => {
  const refused = action({ path: 'owned.txt' });
  const enter = withDecisionModelPolicy(() => 'Preferred', () => {
    rememberDecisionRefusal(refused);
    return captureDecisionModelPolicyOperation();
  });
  await Promise.resolve();
  withDecisionModelPolicy(() => 'Preferred', () => {
    expect(wasDecisionRefused(refused)).toBe(false);
    expect(enter(() => wasDecisionRefused(refused))).toBe(true);
    rememberDecisionRefusal(action({ path: 'other.txt' }));
    expect(enter(() => wasDecisionRefused(action({ path: 'other.txt' })))).toBe(false);
  });
  expect(enter(() => wasDecisionRefused(refused))).toBe(true);
});

test('deep captured refusal data does not require a recursive encoder', () => {
  let nested: Record<string, unknown> = { leaf: 'original' };
  for (let depth = 0; depth < 8000; depth++) nested = { child: nested };
  withDecisionModelPolicy(() => 'Preferred', () => {
    rememberDecisionRefusal(action(nested));
    expect(wasDecisionRefused(action(nested))).toBe(true);
  });
});

test('an older append-only writer remains visible after the new index has been read', async () => {
  // The old linear writer and the indexed reader share the same v1 host Set.
  // Inspect that private state only in a child; no new production debug API.
  const policy = resolve(import.meta.dir, '../sdk/src/platform/runtime/decision-policy.ts');
  const input = resolve(import.meta.dir, '../sdk/src/platform/gate/judgment-input.ts');
  const script = `
    import { strict as assert } from 'node:assert';
    import { isDeepStrictEqual } from 'node:util';
    const policy = await import(${JSON.stringify(policy)});
    const { captureOwnedJson } = await import(${JSON.stringify(input)});
    const host = Object.getOwnPropertyDescriptor(globalThis, Symbol.for('goodvibes-jev.engine.decision-policy.host.v1')).value;
    policy.withDecisionModelPolicy(() => 'Preferred', () => {
      const refusals = host.scopes.getStore().state.refusals;
      const first = { tool: 'read', args: { path: 'first.txt' }, directory: '/workspace' };
      assert.equal(policy.wasDecisionRefused(first), false);
      const rememberOriginal = action => {
        const captured = captureOwnedJson(action);
        for (const previous of refusals) if (isDeepStrictEqual(previous, captured)) return;
        refusals.add(captured);
      };
      rememberOriginal(first);
      assert.equal(policy.wasDecisionRefused(first), true);
      for (let index = 0; index < 40; index++) {
        const next = { tool: 'read', args: { path: index + '.txt' }, directory: '/workspace' };
        if (index % 2) rememberOriginal(next); else policy.rememberDecisionRefusal(next);
        assert.equal(policy.wasDecisionRefused(next), true);
      }
      assert.equal([...refusals].filter(value => typeof value === 'object').length, 41);
      policy.rememberDecisionRefusal(first);
      assert.equal(refusals.size, 41);
    });
  `;
  const child = Bun.spawn([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
});
