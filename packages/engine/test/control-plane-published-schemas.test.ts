import { describe, expect, test } from 'bun:test';
import { JEV_DECISION_BINDING_KEYS } from '@goodvibes-jev/judgment/decisions';
import { firstJsonSchemaFailure } from '../transport-http/src/client-plumbing.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { CONTRACT_DURABLE_ADMISSION_SCHEMA } from '../platform/src/platform/control-plane/operator-contract-schemas-contract-inspection.ts';
import { CONTRACT_VIEW_SCHEMA } from '../platform/src/platform/control-plane/operator-contract-schemas-contracts.ts';
import { KNOWLEDGE_CONNECTOR_INGEST_INPUT_SCHEMA } from '../platform/src/platform/control-plane/operator-contract-schemas-knowledge.ts';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.ts';
import { ROUTE_SURFACE_KINDS } from '../platform/src/events/routes.ts';

const catalog = new GatewayMethodCatalog();
const schemaOf = (id: string, side: 'inputSchema' | 'outputSchema'): Record<string, unknown> => {
  const schema = catalog.get(id)?.[side];
  if (!schema) throw new Error(`${id} declares no ${side}`);
  return schema;
};
const propertySchema = (schema: Record<string, unknown>, name: string): Record<string, unknown> => {
  const found = (schema['properties'] as Record<string, Record<string, unknown>>)[name];
  if (!found) throw new Error(`no property ${name}`);
  return found;
};

describe('verbs that change the host are admin-only at the dispatch gate', () => {
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog } as unknown as DaemonControlPlaneContext);
  for (const id of ['tailscale.serve.run', 'voice.local.install', 'voice.wake.provision']) {
    test(`${id} refuses a non-admin caller that holds its scope and admits an admin`, () => {
      const descriptor = catalog.get(id);
      if (!descriptor) throw new Error(`${id} is not cataloged`);
      const denied = helper.validateGatewayInvocation(descriptor, { scopes: descriptor.scopes, admin: false });
      expect(denied?.status).toBe(403);
      expect(String(denied?.body['error'])).toContain('requires admin access');
      expect(helper.validateGatewayInvocation(descriptor, { scopes: descriptor.scopes, admin: true })).toBeNull();
    });
  }
});

describe('published schemas accept what the daemon serves', () => {
  test('every published automation/route surfaceKind enum lists every route surface kind', () => {
    const found: string[][] = [];
    const seen = new Set<object>();
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const record = node as Record<string, unknown>;
      const surface = (record['properties'] as Record<string, Record<string, unknown>> | undefined)?.['surfaceKind'];
      if (surface && Array.isArray(surface['enum']) && surface['enum'].includes('telegram')) found.push(surface['enum'] as string[]);
      Object.values(record).forEach(walk);
    };
    for (const descriptor of catalog.list()) { walk(descriptor.inputSchema); walk(descriptor.outputSchema); }
    expect(found.length).toBeGreaterThan(0);
    for (const values of found) expect(values).toEqual(expect.arrayContaining([...ROUTE_SURFACE_KINDS]));
  });

  test('stepup.credentials.register accepts several allowed origins', () => {
    const body = { rpId: 'example.com', credentialId: 'c', publicKeyCose: 'k' };
    const schema = schemaOf('stepup.credentials.register', 'inputSchema');
    expect(firstJsonSchemaFailure(schema, { ...body, origin: ['https://a.example.com', 'https://b.example.com'] })).toBeUndefined();
    expect(firstJsonSchemaFailure(schema, { ...body, origin: 'https://a.example.com' })).toBeUndefined();
    expect(firstJsonSchemaFailure(schema, { ...body, origin: [1] })).toBeDefined();
  });

  test('checkpoints.restorePreview no longer advertises a paths filter it ignores', () => {
    expect(Object.keys(schemaOf('checkpoints.restorePreview', 'inputSchema')['properties'] as object)).toEqual(['id']);
  });

  test('update.status reports the filesystem-recovery fence and its retained files', () => {
    const schema = schemaOf('update.status', 'outputSchema');
    const status = {
      armed: false, offReason: 'paused', currentVersion: '3.3.0', releasesUrl: 'https://example.com', checkIntervalMs: null,
      firstCheckDelayMs: null, failedCheckCount: 1, lastCheckFailure: 'x', pendingVersion: null, rejectedVersion: null,
    };
    expect(firstJsonSchemaFailure(schema, status)).toBeUndefined();
    const fenced = {
      ...status, recoveryRequired: true,
      transactionRecovery: {
        operation: 'update', phase: 'commit', committed: false, recoveryRequired: true,
        targets: ['/opt/gv'], recoveryPaths: ['/opt/gv.update-previous'], recoveryErrors: ['rename failed'],
      },
    };
    expect(firstJsonSchemaFailure(schema, fenced)).toBeUndefined();
    expect(firstJsonSchemaFailure(schema, { ...fenced, transactionRecovery: { ...fenced.transactionRecovery, phase: 'bogus' } })).toBeDefined();
  });

  test('contract criteria carry reading rationales and escalations carry failurePause', () => {
    const criteria = propertySchema(CONTRACT_VIEW_SCHEMA, 'criteria');
    const criterion = {
      id: 'c1', text: 'it works', origin: 'stated', serves: [], disposition: 'judged', status: 'unmet',
      readings: [{ checkId: 'k1', at: 1, probabilityUnmet: 0.9, verdict: 'unmet', outcome: 'act', rationale: 'no test output was shown' }],
    };
    expect(firstJsonSchemaFailure(criteria, [criterion])).toBeUndefined();
    const escalations = propertySchema(CONTRACT_VIEW_SCHEMA, 'escalations');
    const escalation = { id: 'e1', at: 1, scope: 'unit', targetId: 'u1', reason: 'stalled', question: 'retry or cancel?', unmetCriterionIds: [], failurePause: true };
    expect(firstJsonSchemaFailure(escalations, [escalation])).toBeUndefined();
    expect(firstJsonSchemaFailure(escalations, [{ ...escalation, failurePause: false }])).toBeDefined();
  });

  test('a durable admission built with a selected model and task evidence validates', () => {
    const reference = (name: string) => `${name}-1`;
    const admission = {
      schemaVersion: 1,
      key: { workId: reference('w'), criteriaId: reference('c'), criteriaRevision: reference('r'), attemptId: reference('a') },
      binding: Object.fromEntries(JEV_DECISION_BINDING_KEYS.map(key => [key, reference(key)])),
      input: {
        ask: 'do it', sessionId: 's1', origin: 'turn', projectRoot: '/work',
        selectedModel: { id: 'm', provider: 'p', registryKey: 'p:m', displayName: 'M' }, taskEvidence: 'evidence',
      },
      contractId: 'ct1', ownerAgentId: 'agent-1', payloadRevision: 'rev1',
    };
    expect(firstJsonSchemaFailure(CONTRACT_DURABLE_ADMISSION_SCHEMA, admission)).toBeUndefined();
  });

  test('knowledge.ingest.connector requires one of input, content or path', () => {
    const schema = KNOWLEDGE_CONNECTOR_INGEST_INPUT_SCHEMA;
    expect(firstJsonSchemaFailure(schema, { connectorId: 'x', path: '/a' })).toBeUndefined();
    expect(firstJsonSchemaFailure(schema, { connectorId: 'x', content: 'hi' })).toBeUndefined();
    expect(firstJsonSchemaFailure(schema, { connectorId: 'x' })).toBeDefined();
    // A bare `{ required }` branch renders as `unknown` for typed consumers: each branch must be a typed object naming its field.
    const branches = schema['anyOf'] as Record<string, unknown>[];
    expect(branches.length).toBeGreaterThan(0);
    for (const branch of branches) {
      const required = branch['required'] as string[];
      expect(branch['type']).toBe('object');
      for (const key of required) expect((branch['properties'] as Record<string, unknown>)[key]).toBeDefined();
    }
  });

  test('paged list verbs publish the cursor envelope next to the legacy body', () => {
    const paged = { items: [], hasMore: false };
    for (const [id, legacy] of [
      ['knowledge.nodes.list', { nodes: [] }],
      ['automation.jobs.list', { jobs: [] }],
      ['automation.runs.list', { runs: [] }],
    ] as const) {
      const schema = schemaOf(id, 'outputSchema');
      expect(firstJsonSchemaFailure(schema, legacy)).toBeUndefined();
      expect(firstJsonSchemaFailure(schema, paged)).toBeUndefined();
      expect(firstJsonSchemaFailure(schema, { items: [] })).toBeDefined();
    }
  });

  test('knowledge paged lists accept the truncation fields a large store adds', () => {
    for (const id of ['knowledge.nodes.list', 'knowledge.sources.list']) {
      const schema = schemaOf(id, 'outputSchema');
      expect(firstJsonSchemaFailure(schema, { items: [], hasMore: true, truncated: true, total: 7000, loaded: 5000 })).toBeUndefined();
    }
  });
});
