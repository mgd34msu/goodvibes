import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runReferenceHttpClientExample } from '../../../examples/reference-http-client/index.ts';
import {
  createFixtureDaemonFetch,
  runReferenceOperatorClientExample,
  type FixtureDaemonRequest,
} from '../../../examples/reference-operator-client/index.ts';

const EXAMPLES_DIR = join(import.meta.dir, '..', '..', '..', 'examples');

describe('reference client examples', () => {
  test('import nothing but the published engine entry points, so they can be copied out', () => {
    for (const example of ['reference-http-client', 'reference-operator-client']) {
      const source = readFileSync(join(EXAMPLES_DIR, example, 'index.ts'), 'utf8');
      const specifiers = [...source.matchAll(/^import[^;]*?from\s+'([^']+)'/gm)].map((match) => match[1]);
      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        expect(specifier).toMatch(/^(@goodvibes-jev\/engine\/|node:)/);
      }
    }
  });

  test('the HTTP client reads its summary over a recorded transport', async () => {
    const requests: FixtureDaemonRequest[] = [];
    const summary = await runReferenceHttpClientExample({
      baseUrl: 'http://127.0.0.1:3421',
      authToken: 'operator-token',
      fetch: createFixtureDaemonFetch(requests),
    });

    expect(Object.keys(summary).sort()).toEqual([
      'activeClients',
      'pairedPeers',
      'peerContractBasePath',
      'peerContractTransport',
      'pendingPairRequests',
      'providerCount',
    ]);
    expect(requests.map((request) => request.methodId).sort()).toEqual([
      'control.snapshot',
      'providers.list',
      'remote.node_host.contract',
      'remote.snapshot',
    ]);
    expect(requests.every((request) => request.authorization === 'Bearer operator-token')).toBe(true);
  });

  test('the operator client makes the same calls against the fixture daemon', async () => {
    const requests: FixtureDaemonRequest[] = [];
    const summary = await runReferenceOperatorClientExample(requests);

    expect(Object.keys(summary).sort()).toEqual([
      'activeClients',
      'pairedPeers',
      'peerContractBasePath',
      'providerCount',
      'sessionId',
    ]);
    expect(requests.map((request) => request.methodId)).not.toContain(null);
    expect(requests[0]?.methodId).toBe('sessions.create');
  });
});
