/**
 * The operator contract the daemon publishes lists exactly the methods and
 * events of the catalog it is built from, keeps the auth modes clients log in
 * with, and keeps the session record readable from a mixed-version daemon.
 */
import { describe, expect, test } from 'bun:test';
import { buildOperatorContract } from '../platform/src/platform/control-plane/operator-contract.js';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';

function asRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeTruthy();
  expect(typeof value, label).toBe('object');
  return value as Record<string, unknown>;
}

function propertySchema(schema: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
  let current: Record<string, unknown> = schema;
  for (const segment of path) {
    const properties = asRecord(current.properties, `${segment} parent properties`);
    current = asRecord(properties[segment], `${segment} schema`);
  }
  return current;
}

// ---------------------------------------------------------------------------
// Helper: create a catalog with known counts
// ---------------------------------------------------------------------------

function makeMinimalCatalog(options: { methods: number; events: number }): GatewayMethodCatalog {
  // includeBuiltins: false, clean slate so we control the exact counts
  const catalog = new GatewayMethodCatalog({ includeBuiltins: false });

  for (let i = 0; i < options.methods; i++) {
    catalog.register({
      id: `test.method.${i}`,
      title: `Test Method ${i}`,
      description: `Synthetic method for testing`,
      category: 'test',
      source: 'plugin',
      access: 'authenticated',
      transport: ['http'],
      scopes: ['read'],
      pluginId: 'test-plugin',
    });
  }

  for (let i = 0; i < options.events; i++) {
    catalog.registerEvent({
      id: `test.event.${i}`,
      title: `Test Event ${i}`,
      description: `Synthetic event for testing`,
      category: 'test',
      source: 'plugin',
      transport: ['sse'],
      scopes: ['read:events'],
      pluginId: 'test-plugin',
    });
  }

  return catalog;
}

describe('buildOperatorContract', () => {
  test('lists exactly the methods and events of the catalog it is given', () => {
    const catalog = makeMinimalCatalog({ methods: 4, events: 7 });
    const contract = buildOperatorContract(catalog);
    expect(contract.operator.methods.map((method) => method.id).sort()).toEqual(catalog.list().map((method) => method.id).sort());
    expect(contract.operator.events.map((event) => event.id).sort()).toEqual(catalog.listEvents().map((event) => event.id).sort());
    expect(contract.operator.schemaCoverage.methods).toBe(4);
    expect(contract.operator.eventCoverage.events).toBe(7);
    const empty = buildOperatorContract(makeMinimalCatalog({ methods: 0, events: 0 }));
    expect([empty.operator.methods.length, empty.operator.events.length]).toEqual([0, 0]);
  });

  test('keeps the product id and the auth modes clients log in with', () => {
    const contract = buildOperatorContract(makeMinimalCatalog({ methods: 0, events: 0 }));
    expect(contract.product.id).toBe('goodvibes');
    expect(contract.auth.modes).toEqual(['shared-bearer', 'session-login']);
  });
});

describe('built-in operator contract method schemas', () => {
  test('sessions.create output matches the shared session record returned by daemon routes', () => {
    const catalog = new GatewayMethodCatalog();
    const contract = buildOperatorContract(catalog);
    const method = contract.operator.methods.find((entry) => entry.id === 'sessions.create');
    expect(method).toBeTruthy();

    const outputSchema = asRecord(method?.outputSchema, 'sessions.create outputSchema');
    const sessionSchema = propertySchema(outputSchema, ['session']);
    const sessionProperties = asRecord(sessionSchema.properties, 'session properties');
    const required = sessionSchema.required;

    // Per docs/decisions/2026-07-05-session-wire-mixed-version.md (the enum leg),
    // the READ record's `kind` is an OPEN enum: a plain string with NO enum
    // constraint, so response validation tolerates a mixed-version daemon emitting
    // a kind this reader does not model (the normalizer backfills display). The
    // strict enum lives on the WRITE path (sessions.register input) only.
    expect(sessionProperties.kind).toMatchObject({ type: 'string' });
    expect(asRecord(sessionProperties.kind, 'kind schema').enum).toBeUndefined();
    expect(sessionProperties.lastActivityAt).toMatchObject({ type: 'number' });
    // `project` is still a real, typed field on the record...
    expect(sessionProperties.project).toMatchObject({ type: 'string' });
    expect(Array.isArray(required) ? required : []).toEqual(expect.arrayContaining(['kind', 'lastActivityAt']));
    // ...but per docs/decisions/2026-07-05-session-wire-mixed-version.md, readers must
    // tolerate a mixed-version daemon that omits it, so it is NOT contractually
    // required on the wire response, the schema-level gate must not preempt
    // normalizeSharedSessionRecord's backfill to 'unknown'.
    expect(Array.isArray(required) ? required : []).not.toContain('project');
  });
});
