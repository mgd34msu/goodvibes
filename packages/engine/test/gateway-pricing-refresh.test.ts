/** Gateway pricing keeps its good cache through an empty payload and backs off after a failed refresh. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonFileAtomic } from '../platform/src/platform/utils/atomic-json-store.js';
import {
  GatewayPricingService,
  gatewayPricingCachePath,
} from '../platform/src/platform/providers/gateway-pricing.js';

const originalFetch = globalThis.fetch;
let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gateway-pricing-')); });
afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

function seedCache(fetchedAt: number): string {
  const path = gatewayPricingCachePath(dir, 'aihubmix');
  writeJsonFileAtomic(path, {
    version: 1,
    fetchedAt,
    ttlMs: 24 * 3_600_000,
    models: { 'good-model': { prompt: 0.000001, completion: 0.000002 } },
  }, { trailingNewline: false });
  return path;
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('GatewayPricingService refresh', () => {
  test('a 200 with no parseable rates keeps the cached rates in memory and on disk', async () => {
    const path = seedCache(Date.now() - 1000);
    const before = readFileSync(path, 'utf8');
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    const service = new GatewayPricingService({ cacheDir: dir });
    expect(service.getPricing('aihubmix', 'good-model')?.prompt).toBe(0.000001);
    await expect(service.refresh('aihubmix')).rejects.toThrow('no parseable pricing');
    expect(service.getPricing('aihubmix', 'good-model')?.prompt).toBe(0.000001);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('a gateway that is down is fetched once inside the backoff window, and again after it', async () => {
    let fetches = 0;
    globalThis.fetch = (async () => { fetches++; throw new Error('offline'); }) as unknown as typeof fetch;
    let now = 1_000_000;
    const service = new GatewayPricingService({ cacheDir: dir, now: () => now });
    for (let i = 0; i < 50; i++) service.getPricing('aihubmix', 'm');
    await settle();
    for (let i = 0; i < 50; i++) service.getPricing('aihubmix', 'm');
    await settle();
    expect(fetches).toBe(1);
    now += 6 * 60_000;
    service.getPricing('aihubmix', 'm');
    await settle();
    expect(fetches).toBe(2);
  });

  test('inherited object keys are not gateways or models', () => {
    seedCache(Date.now());
    const service = new GatewayPricingService({ cacheDir: dir });
    expect(GatewayPricingService.supports('constructor')).toBe(false);
    expect(service.getPricing('toString', 'm')).toBeNull();
    expect(service.getPricing('aihubmix', 'constructor')).toBeNull();
  });
});
