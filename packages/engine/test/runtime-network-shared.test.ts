import { describe, expect, test } from 'bun:test';
import { extractForwardedClientIp } from './_helpers/runtime-seam.ts';

function requestWith(headers: Record<string, string>): Request {
  return new Request('http://example.test', { headers });
}

describe('runtime/network shared helpers', () => {
  test('forwarded headers are ignored unless the proxy is trusted', () => {
    const req = requestWith({ 'x-forwarded-for': '203.0.113.10', 'x-real-ip': '203.0.113.11' });
    expect(extractForwardedClientIp(req, false)).toBeUndefined();
  });

  test('the address the trusted proxy appended wins over client-supplied entries', () => {
    const req = requestWith({ 'x-forwarded-for': '1.1.1.1, 9.9.9.9' });
    expect(extractForwardedClientIp(req, true)).toBe('9.9.9.9');
  });

  test('a configured chain of proxies skips that many entries from the right', () => {
    const req = requestWith({ 'x-forwarded-for': '1.1.1.1, 9.9.9.9, 10.0.0.5' });
    expect(extractForwardedClientIp(req, true, 2)).toBe('9.9.9.9');
  });

  test('a header shorter than the proxy chain yields no address', () => {
    const req = requestWith({ 'x-forwarded-for': '9.9.9.9' });
    expect(extractForwardedClientIp(req, true, 2)).toBeUndefined();
  });

  test('x-real-ip alone is not believed', () => {
    const req = requestWith({ 'x-real-ip': '203.0.113.11' });
    expect(extractForwardedClientIp(req, true)).toBeUndefined();
  });
});
