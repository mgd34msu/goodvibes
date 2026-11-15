import { afterEach, expect, test } from 'bun:test';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import { installTestNetworkGuard, TestExternalNetworkError } from '../toolchain/src/test-runner/test-network-guard.ts';

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

test('node:http, node:https and node:http2 clients are refused for a non-loopback host before any connection', () => {
  const violations: string[] = [];
  restore = installTestNetworkGuard((diagnostic) => violations.push(diagnostic));
  expect(() => http.get('http://192.0.2.1/')).toThrow(TestExternalNetworkError);
  expect(() => http.request({ host: 'outside.invalid', port: 80 })).toThrow(TestExternalNetworkError);
  expect(() => https.get('https://outside.invalid/private?token=secret')).toThrow(TestExternalNetworkError);
  expect(() => https.request('https://127.0.0.1/', { hostname: 'outside.invalid' })).toThrow(TestExternalNetworkError);
  expect(() => http2.connect('https://outside.invalid')).toThrow(TestExternalNetworkError);
  expect(violations).toHaveLength(5);
  expect(violations.join('\n')).not.toContain('token');
});

test('a node:http client still reaches a loopback fixture server', async () => {
  const violations: string[] = [];
  restore = installTestNetworkGuard((diagnostic) => violations.push(diagnostic));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  try {
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.port, path: '/x' }, (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve(text));
      }).on('error', reject);
    });
    expect(body).toBe('fixture');
    expect(violations).toEqual([]);
  } finally { server.stop(true); }
});

test('removing the guard restores the original node:http entry points', () => {
  const before = http.get;
  const undo = installTestNetworkGuard(() => {});
  expect(http.get).not.toBe(before);
  undo();
  expect(http.get).toBe(before);
});
