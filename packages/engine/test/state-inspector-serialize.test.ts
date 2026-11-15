import { describe, expect, test } from 'bun:test';
import { serializeSafe } from '../platform/src/platform/runtime/inspection/state-inspector/serialize.ts';

describe('serializeSafe', () => {
  test('an object referenced twice, without a cycle, is rendered both times', () => {
    const shared = { n: 1 };
    expect(serializeSafe({ a: shared, b: shared, c: [shared] })).toEqual({ a: { n: 1 }, b: { n: 1 }, c: [{ n: 1 }] });
  });

  test('a real cycle is still marked', () => {
    const loop: Record<string, unknown> = { name: 'x' };
    loop['self'] = loop;
    expect(serializeSafe({ loop })).toEqual({ loop: { name: 'x', self: '[Circular]' } });
  });
});
