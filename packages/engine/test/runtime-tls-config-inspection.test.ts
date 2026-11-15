import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectInboundTls, resolveInboundTlsContext } from '../platform/src/platform/runtime/network/inbound.ts';
import { inspectInboundTls as inspectInboundTlsForProducts } from '../platform/src/platform/runtime/inspection.ts';
import { applyOutboundTlsToFetchInit, inspectOutboundTls } from '../platform/src/platform/runtime/network/outbound.ts';

function config(values: Record<string, unknown>, dir = '/nonexistent-goodvibes') {
  return { get: (path: string) => values[path], getControlPlaneConfigDir: () => dir };
}

describe('inbound TLS inspection with an unset or unknown mode', () => {
  test('unset values fall back to plain http on the documented host and port', () => {
    const snapshot = inspectInboundTls(config({}), 'httpListener');
    expect(snapshot).toMatchObject({ mode: 'off', scheme: 'http', host: '127.0.0.1', port: 3422, ready: true, trustProxy: false });
    expect(inspectInboundTls(config({}), 'controlPlane').port).toBe(3421);
  });

  test('an unknown mode is reported not ready and refuses to resolve instead of serving plain http', () => {
    const cfg = config({ 'httpListener.tls.mode': 'direct-ish' });
    const snapshot = inspectInboundTls(cfg, 'httpListener');
    expect(snapshot.ready).toBe(false);
    expect(snapshot.errors.join(' ')).toContain("Unknown httpListener.tls.mode 'direct-ish'");
    expect(() => resolveInboundTlsContext(cfg, 'httpListener')).toThrow('TLS configuration is invalid');
  });

  test('the inspection entry the products re-export reports an unknown mode not ready too', () => {
    const snapshot = inspectInboundTlsForProducts(config({ 'httpListener.tls.mode': 'direct-ish' }), 'httpListener');
    expect(snapshot.ready).toBe(false);
    expect(snapshot.scheme).toBe('http');
  });

  test('proxy mode is ready and reports https', () => {
    expect(inspectInboundTls(config({ 'controlPlane.tls.mode': 'proxy' }), 'controlPlane')).toMatchObject({ mode: 'proxy', scheme: 'https', ready: true });
  });
});

describe('outbound TLS with a custom CA', () => {
  test('bundled+custom with a missing CA file refuses the request instead of trusting only the bundled CAs', () => {
    const cfg = config({
      'network.outboundTls.mode': 'bundled+custom',
      'network.outboundTls.customCaFile': '/nonexistent/corp-ca.pem',
    });
    expect(() => applyOutboundTlsToFetchInit('https://api.example.test/x', undefined, cfg)).toThrow('could not be loaded');
    expect(inspectOutboundTls(cfg).errors.join(' ')).toContain('Custom CA file not found');
  });

  test('a custom CA path that cannot be read as a file is reported, not thrown raw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tls-ca-'));
    try {
      writeFileSync(join(dir, 'ok.pem'), 'PEM');
      const cfg = config({ 'network.outboundTls.mode': 'custom', 'network.outboundTls.customCaFile': dir }, dir);
      expect(inspectOutboundTls(cfg).errors.join(' ')).toContain('could not be read');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('bundled+custom with a readable CA file adds it to the trust list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tls-ca-'));
    try {
      writeFileSync(join(dir, 'corp.pem'), 'CORP-CA');
      const cfg = config({ 'network.outboundTls.mode': 'bundled+custom', 'network.outboundTls.customCaFile': join(dir, 'corp.pem') }, dir);
      const init = applyOutboundTlsToFetchInit('https://api.example.test/x', undefined, cfg);
      expect((init.tls?.ca as string[]).includes('CORP-CA')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
