/**
 * TLS posture behaviour of platform/runtime/network that the CA-file tests do
 * not reach: configured listener addresses, direct mode without files, and the
 * localhost opt-out on outbound requests.
 */

import { describe, expect, test } from 'bun:test';
import { inspectInboundTls, resolveInboundTlsContext } from '../platform/src/platform/runtime/network/inbound.js';
import { applyOutboundTlsToFetchInit } from '../platform/src/platform/runtime/network/outbound.js';

function makeConfig(values: Record<string, unknown> = {}) {
  return {
    get: (path: string) => values[path],
    getControlPlaneConfigDir: () => '/nonexistent-goodvibes',
  };
}

describe('platform/runtime/network: behavior', () => {
  test('inbound inspection reports the configured host, port and proxy trust', () => {
    const snapshot = inspectInboundTls(
      makeConfig({ 'controlPlane.host': ' 0.0.0.0 ', 'controlPlane.port': 4000, 'controlPlane.trustProxy': true }),
      'controlPlane',
    );
    expect(snapshot).toMatchObject({ surface: 'controlPlane', host: '0.0.0.0', port: 4000, trustProxy: true, mode: 'off' });
  });

  test('direct mode without certificate files is not ready and refuses to resolve', () => {
    const cfg = makeConfig({ 'httpListener.tls.mode': 'direct' });
    const snapshot = inspectInboundTls(cfg, 'httpListener');
    expect(snapshot.ready).toBe(false);
    expect(snapshot.scheme).toBe('https');
    expect(snapshot.errors.join(' ')).toContain('Certificate file not found');
    expect(() => resolveInboundTlsContext(cfg, 'httpListener')).toThrow('certificate files are not ready');
  });

  test('plain http inbound resolves with no TLS credentials', () => {
    const ctx = resolveInboundTlsContext(makeConfig(), 'controlPlane');
    expect(ctx.mode).toBe('off');
    expect(ctx.tls).toBeUndefined();
  });

  test('allowInsecureLocalhost turns off certificate checks for localhost only', () => {
    const cfg = makeConfig({ 'network.outboundTls.mode': 'bundled', 'network.outboundTls.allowInsecureLocalhost': true });
    const local = applyOutboundTlsToFetchInit('https://localhost:8443/', { method: 'GET' }, cfg);
    expect(local.method).toBe('GET');
    expect(local.tls?.rejectUnauthorized).toBe(false);
    const remote = applyOutboundTlsToFetchInit('https://example.test/', { method: 'GET' }, cfg);
    expect(remote.tls).toBeUndefined();
    const callerInit: RequestInit & { tls: { rejectUnauthorized: boolean } } = { tls: { rejectUnauthorized: true } };
    const explicit = applyOutboundTlsToFetchInit('https://localhost:8443/', callerInit, cfg);
    expect(explicit.tls?.rejectUnauthorized).toBe(true);
  });

  test('a plain http request is passed through untouched even with the localhost opt-out', () => {
    const cfg = makeConfig({ 'network.outboundTls.mode': 'bundled', 'network.outboundTls.allowInsecureLocalhost': true });
    expect(applyOutboundTlsToFetchInit('http://localhost:8080/', { method: 'POST' }, cfg)).toEqual({ method: 'POST' });
  });
});
