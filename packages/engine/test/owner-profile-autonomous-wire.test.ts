import { useSecurityReadings } from './helpers/security-readings.ts';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { registerOwnerProfileGatewayMethods } from '../platform/src/platform/control-plane/routes/owner-profile.ts';
import { OwnerProfileStore, renderProvenanceSuffix } from '../platform/src/platform/owner-profile/index.ts';
import { firstJsonSchemaFailure } from '../transport-http/src/index.js';
import { resetProcessUntrustedContentLedgerForTests } from '../platform/src/platform/security/untrusted-content.ts';

useSecurityReadings();
beforeEach(() => { resetProcessUntrustedContentLedgerForTests(); });

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const autonomous = renderProvenanceSuffix({
  origin: 'autonomous', surface: 'agent', date: '2026-07-20', said: '',
  source: { goal: 'keep the shipping address current', criteria: ['the owner confirmed it twice'] },
});

test('profile.get, person and provenance validate for a line written under autonomous authority', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gv-profile-autonomous-'));
  dirs.push(dir);
  const path = join(dir, 'owner-profile.md');
  writeFileSync(path, [
    '# Profile', '',
    '## Commerce', '',
    `shipping address: 401 Home St, Lansing, MI 48933, US${autonomous}`, '',
    '## People', '',
    `- Sarah, sister, sarah@example.com${autonomous}`, '',
  ].join('\n'), 'utf-8');
  const store = new OwnerProfileStore({ path, now: () => new Date('2026-07-27T12:00:00Z') });
  await store.load();
  const catalog = new GatewayMethodCatalog();
  registerOwnerProfileGatewayMethods(catalog, store);
  const ctx = { context: { admin: true } } as const;

  const checks: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['profile.get', { fieldId: 'commerce.shippingAddress' }],
    ['profile.person', { name: 'Sarah' }],
    ['profile.provenance', { fieldId: 'commerce.shippingAddress' }],
    ['profile.read', {}],
  ];
  for (const [id, body] of checks) {
    const result = await catalog.invoke(id, { ...ctx, body });
    expect(firstJsonSchemaFailure(catalog.get(id)!.outputSchema!, result), id).toBeUndefined();
  }
  const provenance = await catalog.invoke('profile.provenance', { ...ctx, body: { fieldId: 'commerce.shippingAddress' } }) as {
    provenance: { origin?: string; source?: { goal: string } } | null;
  };
  expect(provenance.provenance).toMatchObject({ origin: 'autonomous', source: { goal: 'keep the shipping address current' } });
});
