#!/usr/bin/env bun
/**
 * refresh-contract-artifacts.ts
 *
 * Regenerates the checked-in contract artifacts from live source of truth:
 *
 *   - contracts/artifacts/operator-contract.json
 *   - contracts/artifacts/peer-contract.json
 *   - contracts/src/generated/operator-contract.ts
 *   - contracts/src/generated/operator-method-ids.ts
 *   - contracts/src/generated/peer-contract.ts
 *   - contracts/src/generated/peer-endpoint-ids.ts
 *
 * Source of truth:
 *   - Operator: buildOperatorContract(new GatewayMethodCatalog()), built-in methods/events
 *     auto-registered from the method-catalog-* modules, product.version overridden with
 *     the engine's current VERSION.
 *   - Peer: PEER_CONTRACT_SOURCE in contracts/src/peer-contract-source.ts, the
 *     hand-written definition; generated/peer-contract.ts and the JSON artifact are
 *     rendered from it, so a hand edit to either output is drift.
 *
 * Usage:
 *   bun run scripts/refresh-contract-artifacts.ts
 *   bun run scripts/refresh-contract-artifacts.ts --check   # exit 1 if any artifact drifted
 *
 * `bun run refresh:contracts` finishes by regenerating docs/reference-*.md from
 * the new artifacts, and `validate` fails when they are out of sync.
 * Engine package preparation copies the checked-in contract package artifacts
 * into the published engine dist.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { buildOperatorContract } from '../platform/src/platform/control-plane/operator-contract.ts';
import { PEER_CONTRACT_SOURCE } from '../contracts/src/peer-contract-source.ts';
import { buildMockDaemonFixtureMap } from '../contracts/src/testing/mock-daemon.ts';
import type { OperatorContractManifest } from '../contracts/src/types.ts';
import { isLinearSchemaPattern } from '../transport-http/src/client-plumbing.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = resolve(__dirname, '..');
const CHECK_ONLY = process.argv.includes('--check');

const OPERATOR_JSON_PATH = resolve(ENGINE_ROOT, 'contracts/artifacts/operator-contract.json');
const PEER_JSON_PATH = resolve(ENGINE_ROOT, 'contracts/artifacts/peer-contract.json');
const OPERATOR_TS_PATH = resolve(ENGINE_ROOT, 'contracts/src/generated/operator-contract.ts');
const OPERATOR_METHOD_IDS_PATH = resolve(ENGINE_ROOT, 'contracts/src/generated/operator-method-ids.ts');
const PEER_TS_PATH = resolve(ENGINE_ROOT, 'contracts/src/generated/peer-contract.ts');
const PEER_ENDPOINT_IDS_PATH = resolve(ENGINE_ROOT, 'contracts/src/generated/peer-endpoint-ids.ts');
const FOUNDATION_METADATA_PATH = resolve(ENGINE_ROOT, 'contracts/src/generated/foundation-metadata.ts');
const MOCK_DAEMON_FIXTURES_PATH = resolve(ENGINE_ROOT, 'contracts/src/generated/mock-daemon-fixtures.ts');

/**
 * Stringify that preserves shared DAG references (duplicates them in the
 * output) but flags true cycles. Tracks ancestors on the current descent path
 * via a Set; removes entries on return so siblings don't collide.
 */
function safeStringify(value: unknown): string {
  const ancestors = new Set<object>();
  const clone = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    const obj = v as object;
    // Self-referencing JSON Schema (common pattern for 'any JSON value' types).
    // Replace with empty schema {} which is JSON Schema's idiomatic 'accept anything'.
    if (ancestors.has(obj)) return {};
    ancestors.add(obj);
    let out: unknown;
    if (Array.isArray(v)) {
      out = v.map((item) => clone(item));
    } else {
      const result: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) result[k] = clone(val);
      out = result;
    }
    ancestors.delete(obj);
    return out;
  };
  return JSON.stringify(clone(value), null, 2);
}

function writeIfChanged(path: string, content: string): boolean {
  let current: string | null = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = null;
  }
  if (current === content) return false;
  if (CHECK_ONLY) {
    console.error(`[refresh:contracts] drift: ${path}`);
    return true;
  }
  writeFileSync(path, content, 'utf8');
  console.log(`[refresh:contracts] wrote: ${path}`);
  return true;
}

function renderOperatorContractTs(contract: unknown): string {
  // Compact JSON string parsed once at module load: avoids a 200K-line `as const`
  // object literal that forced TypeScript to allocate >12 GB of heap during tsc.
  const compact = JSON.stringify(JSON.parse(safeStringify(contract)));
  return [
    `import type { OperatorContractManifest } from '../types.js';`,
    `import { freezeGeneratedOperatorContract } from '../freeze-contract.js';`,
    ``,
    `export const OPERATOR_CONTRACT: OperatorContractManifest = freezeGeneratedOperatorContract(`,
    `  JSON.parse(${JSON.stringify(compact)}) as OperatorContractManifest,`,
    `);`,
    ``,
  ].join('\n');
}

function renderPeerContractTs(contract: unknown): string {
  const compact = JSON.stringify(JSON.parse(safeStringify(contract)));
  return [
    `import type { PeerContractManifest } from '../types.js';`,
    ``,
    `export const PEER_CONTRACT: PeerContractManifest = JSON.parse(${JSON.stringify(compact)}) as PeerContractManifest;`,
    ``,
  ].join('\n');
}

function renderMockDaemonFixturesTs(contract: OperatorContractManifest): string {
  const json = safeStringify(buildMockDaemonFixtureMap(contract));
  return [
    `import type { MockDaemonFixtureMap } from '../testing/mock-daemon.js';`,
    ``,
    `/**`,
    ` * GENERATED, do not edit. Regenerate with \`bun run refresh:contracts\`.`,
    ` *`,
    ` * A schema-valid sample response per cataloged operator method, generated`,
    ` * from the contract's own output schemas (see testing/mock-daemon.ts). The`,
    ` * webui Playwright mocks and Home Assistant test fixtures generate from this`,
    ` * instead of hand-authoring a response per method.`,
    ` */`,
    `export const MOCK_DAEMON_FIXTURES: MockDaemonFixtureMap = ${json};`,
    ``,
  ].join('\n');
}

function renderMethodIdsTs(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  const quoted = sorted.map((id) => `  "${id}",`).join('\n');
  return [
    `export const OPERATOR_METHOD_IDS = [`,
    quoted,
    `] as const;`,
    `export type OperatorMethodId = typeof OPERATOR_METHOD_IDS[number];`,
    ``,
  ].join('\n');
}

function renderEndpointIdsTs(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  const quoted = sorted.map((id) => `  "${id}",`).join('\n');
  return [
    `export const PEER_ENDPOINT_IDS = [`,
    quoted,
    `] as const;`,
    `export type PeerEndpointId = typeof PEER_ENDPOINT_IDS[number];`,
    ``,
  ].join('\n');
}

const catalog = new GatewayMethodCatalog();
const operatorContract = buildOperatorContract(catalog);
const operatorMethodIds = operatorContract.operator.methods.map((m) => m.id);
const peerEndpointIds = PEER_CONTRACT_SOURCE.endpoints.map((e) => e.id);

// Every pattern a shipped contract carries must run on the caller's thread:
// the web UI validates synchronously and cannot evaluate any other pattern.
function schemaPatternsOf(value: unknown, found: Set<string>, seen = new Set<object>()): Set<string> {
  if (value === null || typeof value !== 'object' || seen.has(value)) return found;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) schemaPatternsOf(item, found, seen);
    return found;
  }
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (typeof record.pattern === 'string' && (type === 'string' || (Array.isArray(type) && type.includes('string')))) {
    found.add(record.pattern);
  }
  for (const child of Object.values(record)) schemaPatternsOf(child, found, seen);
  return found;
}
const nonLinearPatterns = [...schemaPatternsOf([operatorContract, PEER_CONTRACT_SOURCE], new Set())]
  .filter((pattern) => !isLinearSchemaPattern(pattern));
if (nonLinearPatterns.length > 0) {
  // Name the method or endpoint that carries each pattern, so the fix starts at its schema.
  const owners = new Map<string, string[]>();
  for (const [kind, entries] of [['operator method', operatorContract.operator.methods], ['peer endpoint', PEER_CONTRACT_SOURCE.endpoints]] as const) {
    for (const entry of entries as readonly { readonly id: string }[]) {
      for (const pattern of schemaPatternsOf(entry, new Set())) {
        owners.set(pattern, [...(owners.get(pattern) ?? []), `${kind} ${entry.id}`]);
      }
    }
  }
  console.error('[refresh:contracts] these schema patterns cannot run synchronously; rewrite each so one stretch of text has one way to match:');
  for (const pattern of nonLinearPatterns) {
    console.error(`  ${pattern}  (in ${owners.get(pattern)?.join(', ') ?? 'a contract schema outside any method, such as an event'})`);
  }
  process.exit(1);
}

const operatorJson = safeStringify(operatorContract) + '\n';
const peerJson = safeStringify(PEER_CONTRACT_SOURCE) + '\n';

let drifted = false;
drifted = writeIfChanged(OPERATOR_JSON_PATH, operatorJson) || drifted;
drifted = writeIfChanged(PEER_JSON_PATH, peerJson) || drifted;
drifted = writeIfChanged(OPERATOR_TS_PATH, renderOperatorContractTs(operatorContract)) || drifted;
drifted = writeIfChanged(OPERATOR_METHOD_IDS_PATH, renderMethodIdsTs(operatorMethodIds)) || drifted;
drifted = writeIfChanged(PEER_TS_PATH, renderPeerContractTs(PEER_CONTRACT_SOURCE)) || drifted;
drifted = writeIfChanged(PEER_ENDPOINT_IDS_PATH, renderEndpointIdsTs(peerEndpointIds)) || drifted;
drifted = writeIfChanged(MOCK_DAEMON_FIXTURES_PATH, renderMockDaemonFixturesTs(operatorContract)) || drifted;
drifted = writeIfChanged(
  FOUNDATION_METADATA_PATH,
  `export const FOUNDATION_METADATA = ${JSON.stringify({
    productId: operatorContract.product.id,
    productVersion: operatorContract.product.version,
    operatorMethodCount: operatorMethodIds.length,
    operatorEventCount: operatorContract.operator.events.length,
    peerEndpointCount: peerEndpointIds.length,
  }, null, 2)} as const;\n`,
) || drifted;

if (!CHECK_ONLY) {
  console.log(`[refresh:contracts] product version: ${operatorContract.product.version}`);
  console.log(`[refresh:contracts] operator methods: ${operatorMethodIds.length}`);
  console.log(`[refresh:contracts] operator events:  ${operatorContract.operator.events.length}`);
  console.log(`[refresh:contracts] peer endpoints:   ${peerEndpointIds.length}`);
}

if (CHECK_ONLY && drifted) {
  console.error('[refresh:contracts] drift detected, run `bun run refresh:contracts`');
  process.exit(1);
}

if (!drifted) {
  console.log('[refresh:contracts] artifacts up-to-date');
}
