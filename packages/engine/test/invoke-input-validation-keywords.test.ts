import { describe, expect, test } from 'bun:test';
import { classifyInputSchema, validateInvocationInput } from '../platform/src/platform/control-plane/invoke-input-validation.ts';
import { methodDescriptor } from '../platform/src/platform/control-plane/method-catalog-shared.ts';

function check(inputSchema: Record<string, unknown>, params: unknown) {
  const descriptor = methodDescriptor({ id: 'test.keywords', title: 'Keywords', description: 'Input gate probe.', category: 'sessions', transport: ['ws'], scopes: [], access: 'public', inputSchema });
  return validateInvocationInput(descriptor, params);
}

describe('the invoke input gate enforces the combinator and constant keywords the published schemas use', () => {
  const confirmed = { type: 'object', properties: { confirm: { const: true }, name: { type: 'string' } }, required: ['confirm'] };

  test('const', () => {
    expect(check(confirmed, { confirm: false })).toMatchObject({ code: 'INVALID_INPUT' });
    expect(check(confirmed, { confirm: true })).toBeNull();
  });

  test('oneOf at the root', () => {
    const either = { oneOf: [
      { type: 'object', properties: { purchaseId: { type: 'string' } }, required: ['purchaseId'] },
      { type: 'object', properties: { callId: { type: 'string' } }, required: ['callId'] },
    ] };
    expect(classifyInputSchema(either)).toBe('validated');
    expect(check(either, {})).toMatchObject({ code: 'INVALID_INPUT' });
    expect(check(either, { purchaseId: 'p1' })).toBeNull();
    expect(check(either, { purchaseId: 'p1', callId: 'c1' })).toMatchObject({ code: 'INVALID_INPUT' });
  });

  test('allOf and not', () => {
    const schema = { type: 'object', properties: { limit: { type: 'integer' } }, allOf: [{ type: 'object', required: ['limit'] }], not: { type: 'object', properties: { limit: { const: 0 } }, required: ['limit'] } };
    expect(check(schema, {})).toMatchObject({ code: 'INVALID_INPUT' });
    expect(check(schema, { limit: 0 })).toMatchObject({ code: 'INVALID_INPUT' });
    expect(check(schema, { limit: 3 })).toBeNull();
  });

  test('a list of types', () => {
    const schema = { type: 'object', properties: { id: { type: ['string', 'integer'] } } };
    expect(check(schema, { id: 'x' })).toBeNull();
    expect(check(schema, { id: 7 })).toBeNull();
    expect(check(schema, { id: true })).toMatchObject({ code: 'INVALID_INPUT' });
  });
});
