import { afterEach, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { DurablePolicyEpochOwner } from '../platform/src/platform/config/durable-policy-epoch.js';
import { GatewayMethodCatalog, type GatewayPolicyRevision } from '../platform/src/platform/control-plane/method-catalog.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'exact-policy-revisions-')); roots.push(root);
  const options = { configDir: root, surfaceRoot: 'daemon' };
  const config = new ConfigManager(options);
  // This fixture supplies only the config root and native settings-sync root.
  // The owner deliberately stores one snapshot beside their sorted first root.
  const snapshotRoot = [config.getConfigPath(), join(root, 'settings-sync.json')].sort()[0];
  if (!snapshotRoot) throw new Error('Actual policy source root is missing');
  const snapshot = snapshotRoot + '.policy-configuration-v3.json';
  return { root, options, config, snapshot, snapshotRoot };
}

test('actual source-backed private settings recover unchanged without hashes or private sidecar copies', () => {
  const f = fixture(), privatePath = join(f.root, 'private-custom-policy-path');
  f.config.set('provider.systemPromptFile', privatePath);
  f.config.set('permissions.tools.exec', 'deny');
  const hash = spyOn(crypto, 'createHash');
  try {
    const issued = f.config.captureDurableConfigurationIncarnation();
    expect(issued).toMatch(/^[0-9a-f-]{36}$/);
    for (let index = 0; index < 8; index++) expect(f.config.getDurableConfigurationIncarnation()).toBe(issued);
    const saved = readFileSync(f.snapshot, 'utf8'); expect(saved).not.toContain(privatePath);
    const reopened = new ConfigManager(f.options);
    expect(reopened.get('provider.systemPromptFile')).toBe(privatePath);
    expect(reopened.get('permissions.tools.exec')).toBe('deny');
    expect(reopened.getDurableConfigurationIncarnation()).toBe(issued);
    expect(readFileSync(f.snapshot, 'utf8')).toBe(saved); expect(hash).not.toHaveBeenCalled();
  } finally { hash.mockRestore(); }
});

for (const kind of ['path', 'object'] as const) test(`an unexplained runtime ${kind} stores only a private expectation and cannot match a different restarted frame`, () => {
  const f = fixture(); f.config.captureDurableConfigurationIncarnation();
  const original = readFileSync(f.snapshot, 'utf8');
  const marker = 'private-overlay-marker';
  if (kind === 'path') f.config.setRuntimeOverride('provider.systemPromptFile', join(f.root, marker));
  else f.config.setRuntimeOverride('provider.decisionRouter', { categories: { custom: { label: marker, description: marker, target: null } }, initialContextChars: 3000, expandedContextChars: 10_000 });
  const issued = f.config.captureDurableConfigurationIncarnation();
  expect(f.config.getDurableConfigurationIncarnation()).toBe(issued);
  const privateSnapshot = readFileSync(f.snapshot, 'utf8');
  expect(privateSnapshot).not.toBe(original); expect(privateSnapshot).not.toContain(marker);
  expect(JSON.parse(privateSnapshot)).toMatchObject({ version: 2, privateFrame: expect.stringMatching(/^[0-9a-f]{64}$/) });
  const reopened = new ConfigManager(f.options);
  expect(reopened.getDurableConfigurationIncarnation()).not.toBe(issued);
  const reissued = reopened.captureDurableConfigurationIncarnation(); expect(reissued).not.toBe(issued);
  expect(new ConfigManager(f.options).getDurableConfigurationIncarnation()).toBe(reissued);
});

test('an unchanged private effective frame recovers its actual saved revision without persisting its values', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-policy-restart-')); roots.push(root);
  const file = join(root, 'settings.json'); writeFileSync(file, '{}');
  const marker = 'unpersisted-private-runtime-value';
  const effective = { provider: { model: marker, effort: 'high' }, permissions: { deny: ['private/tool/path'] } };
  const formats: string[] = [], owner = new DurablePolicyEpochOwner([file], true, format => { formats.push(format); });
  const hash = spyOn(crypto, 'createHash');
  try {
    const issued = owner.capture(effective);
    expect(hash).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 8; index++) expect(owner.current(structuredClone(effective))).toBe(issued);
    expect(hash).toHaveBeenCalledTimes(1);
    const path = file + '.policy-configuration-v3.json', saved = readFileSync(path, 'utf8');
    expect(formats).toContain('configuration-private-policy-snapshots-v1');
    expect(saved).not.toContain(marker); expect(saved).not.toContain('private/tool/path');
    const reopened = new DurablePolicyEpochOwner([file], true);
    expect(reopened.current({ permissions: effective.permissions, provider: { effort: 'high', model: marker } })).toBe(issued);
    expect(hash).toHaveBeenCalledTimes(2);
    expect(reopened.current(effective)).toBe(issued); expect(hash).toHaveBeenCalledTimes(2);
    const changed = new DurablePolicyEpochOwner([file], true);
    expect(changed.current({ ...effective, provider: { ...effective.provider, model: marker + '-changed' } })).not.toBe(issued);
    expect(hash).toHaveBeenCalledTimes(3); expect(readFileSync(path, 'utf8')).toBe(saved);
    // Mutation intent still advances the epoch even if the caller reapplies
    // the same private value; recovery never waives that revocation barrier.
    owner.advance();
    expect(new DurablePolicyEpochOwner([file], true).current(effective)).not.toBe(issued);
    expect(hash).toHaveBeenCalledTimes(3);
  } finally { hash.mockRestore(); }
});

test('private recovery distinguishes negative zero and refuses its new-format publication before effects', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-policy-frame-')); roots.push(root);
  const file = join(root, 'settings.json'); writeFileSync(file, '{}');
  const owner = new DurablePolicyEpochOwner([file], true), issued = owner.capture({ value: -0 });
  expect(new DurablePolicyEpochOwner([file], true).current({ value: 0 })).not.toBe(issued);
  expect(new DurablePolicyEpochOwner([file], true).current({ value: -0 })).toBe(issued);
  const second = join(root, 'other.json'); writeFileSync(second, '{}');
  const refused = new DurablePolicyEpochOwner([second], true, format => {
    if (format === 'configuration-private-policy-snapshots-v1') throw new Error('private reader floor refused');
  });
  expect(() => refused.capture({ secret: 'not persisted' })).toThrow('private reader floor refused');
  expect(existsSync(second + '.policy-configuration-v3.json')).toBe(false);
});

test('a native catalog larger than the revision field recovers via exact public snapshot and bounded ordinary ID', () => {
  const f = fixture(), catalog = new GatewayMethodCatalog();
  const owner = catalog.attachScopePolicyOwner(() => f.config.invalidateExternalPolicy(), data => f.config.getDurableGatewayPolicyRevision(data));
  const unissued = owner.current(); expect(unissued.revision.length).toBeLessThan(100);
  const hash = spyOn(crypto, 'createHash');
  try {
    f.config.captureDurableConfigurationIncarnation();
    const issued = owner.current(); expect(issued.revision).toBe(unissued.revision);
    const path = f.snapshotRoot + '.policy-gateway-v3.json';
    const source = readFileSync(path, 'utf8'); expect(source.length).toBeGreaterThan(4096);
    const nextConfig = new ConfigManager(f.options), nextCatalog = new GatewayMethodCatalog();
    const nextOwner = nextCatalog.attachScopePolicyOwner(() => nextConfig.invalidateExternalPolicy(), data => nextConfig.getDurableGatewayPolicyRevision(data));
    expect(nextOwner.current()).toEqual(issued); expect(readFileSync(path, 'utf8')).toBe(source);
    expect(hash).not.toHaveBeenCalled(); nextOwner.close();
  } finally { hash.mockRestore(); owner.close(); }
});

test('a foreign same-byte snapshot replacement retires the original owner rather than adopting its old revision', () => {
  const f = fixture(); f.config.captureDurableConfigurationIncarnation();
  const original = readFileSync(f.snapshot), replacement = f.snapshot + '.replacement';
  writeFileSync(replacement, original); renameSync(replacement, f.snapshot);
  expect(() => f.config.getDurableConfigurationIncarnation()).toThrow('ownership is unavailable');
  expect(readFileSync(f.snapshot)).toEqual(original);
});

test('the actual new-format writer refusal precedes any snapshot publication', () => {
  const root = mkdtempSync(join(tmpdir(), 'policy-snapshot-floor-')); roots.push(root);
  const file = join(root, 'settings.json'); writeFileSync(file, '{}');
  const formats: string[] = [], owner = new DurablePolicyEpochOwner([file], true, format => {
    formats.push(format); if (format === 'configuration-policy-snapshots-v3') throw new Error('actual reader floor refused');
  });
  expect(() => owner.capture({}, { code: 1 })).toThrow('actual reader floor refused');
  expect(formats).toContain('configuration-policy-snapshots-v3');
  expect(existsSync(file + '.policy-configuration-v3.json')).toBe(false);
});

test('asynchronous revision callbacks cannot publish a catalog snapshot or leak rejected work', async () => {
  const catalog = new GatewayMethodCatalog({ includeBuiltins: false }), unhandled: unknown[] = [];
  const observe = (error: unknown) => { unhandled.push(error); }; process.on('unhandledRejection', observe);
  const revision = (() => Promise.reject(new Error('borrowed revision rejected'))) as unknown as GatewayPolicyRevision;
  const owner = catalog.attachScopePolicyOwner(() => {}, revision);
  try {
    expect(() => owner.current()).toThrow('bounded synchronous');
    await new Promise<void>(resolve => setImmediate(resolve)); expect(unhandled).toEqual([]);
  } finally { owner.close(); process.off('unhandledRejection', observe); }
});
