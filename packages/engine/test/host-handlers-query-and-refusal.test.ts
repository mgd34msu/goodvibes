import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { assertConfirmed, HandlerError, registerCatalogHandler } from '../platform/src/platform/control-plane/host-handlers.ts';
import { BOOLEAN_SCHEMA, methodDescriptor, objectSchema, STRING_SCHEMA } from '../platform/src/platform/control-plane/method-catalog-shared.ts';

const METHOD_ID = 'test.host.handlers.probe';

function catalogWithProbe(): GatewayMethodCatalog {
  const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
  catalog.register(methodDescriptor({
    id: METHOD_ID,
    title: 'Probe',
    description: 'A handler-registered verb used to observe how the registration wrapper reads input and refusals.',
    category: 'sessions',
    transport: ['ws'],
    scopes: [],
    access: 'public',
    inputSchema: objectSchema({ status: STRING_SCHEMA, limit: { type: 'integer' }, strict: BOOLEAN_SCHEMA, confirm: BOOLEAN_SCHEMA }, []),
  }), async () => ({}));
  return catalog;
}

describe('registerCatalogHandler', () => {
  test('a filter sent in the query reaches the handler as a typed body field, and the body wins a clash', async () => {
    const catalog = catalogWithProbe();
    let seen: unknown;
    registerCatalogHandler(catalog, METHOD_ID, async ({ body }) => { seen = body; return {}; });
    await catalog.invoke(METHOD_ID, { query: { status: 'sent', limit: '5', strict: 'true' }, context: {} });
    expect(seen).toEqual({ status: 'sent', limit: 5, strict: true });
    await catalog.invoke(METHOD_ID, { query: { status: 'sent' }, body: { status: 'draft' }, context: {} });
    expect(seen).toEqual({ status: 'draft' });
  });

  test('a value that does not parse as its declared type is passed through for the handler to refuse', async () => {
    const catalog = catalogWithProbe();
    let seen: unknown;
    registerCatalogHandler(catalog, METHOD_ID, async ({ body }) => { seen = body; return {}; });
    await catalog.invoke(METHOD_ID, { query: { limit: 'many' }, context: {} });
    expect(seen).toEqual({ limit: 'many' });
  });

  test('a confirm in the query never confirms a mutation', async () => {
    const catalog = catalogWithProbe();
    registerCatalogHandler(catalog, METHOD_ID, async ({ body, context: handlerContext }) => { assertConfirmed(body, handlerContext); return { done: true }; });
    const refused = await catalog.invoke(METHOD_ID, { query: { confirm: 'true' }, context: { metadata: { explicitUserRequest: true } } }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HandlerError);
    expect(refused).toMatchObject({ code: 'REQUIRE_CONFIRM', status: 403 });
    const allowed = await catalog.invoke(METHOD_ID, { body: { confirm: true }, context: { metadata: { explicitUserRequest: true } } });
    expect(allowed).toEqual({ done: true });
  });

  test('a service error carrying a status and a code reaches the caller as that refusal, not as a server fault', async () => {
    const catalog = catalogWithProbe();
    registerCatalogHandler(catalog, METHOD_ID, () => {
      throw Object.assign(new Error('That draft was already sent.'), { code: 'ALREADY_SENT', status: 409, field: 'status' });
    });
    const refused = await catalog.invoke(METHOD_ID, { context: {} }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HandlerError);
    expect(refused).toMatchObject({ code: 'ALREADY_SENT', status: 409, field: 'status', message: 'That draft was already sent.' });
  });

  test('a plain error is still reported as a handler failure', async () => {
    const catalog = catalogWithProbe();
    registerCatalogHandler(catalog, METHOD_ID, () => { throw new Error('boom'); });
    const refused = await catalog.invoke(METHOD_ID, { context: {} }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'HANDLER_FAILED', status: 500 });
  });
});
