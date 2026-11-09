import { describe, expect, test, spyOn } from 'bun:test';
import { readBearerOrHeaderToken, readTextBodyWithinLimit, verifySha256HmacSignature } from '@goodvibes-jev/engine/platform/platform/adapters';
import { createHmac } from 'node:crypto';
import * as crypto from 'node:crypto';

describe('adapter helpers', () => {
  test('extracts explicit adapter tokens before bearer auth', () => {
    const req = new Request('http://goodvibes.local/webhook/test', {
      headers: {
        'x-goodvibes-test-token': 'adapter-token',
        Authorization: 'Bearer bearer-token',
      },
    });
    expect(readBearerOrHeaderToken(req, 'x-goodvibes-test-token')).toBe('adapter-token');
  });

  test('enforces request body limits before parsing webhook payloads', async () => {
    const req = new Request('http://goodvibes.local/webhook/test', {
      method: 'POST',
      headers: {
        'content-length': '1000001',
      },
      body: 'ignored',
    });
    const result = await readTextBodyWithinLimit(req);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });

  test('verifies sha256 hmac signatures for signed webhook providers', () => {
    const rawBody = JSON.stringify({ hello: 'world' });
    const signature = `sha256=${createHmac('sha256', 'secret').update(rawBody).digest('hex')}`;
    expect(verifySha256HmacSignature(rawBody, 'secret', signature)).toBe(true);
    expect(verifySha256HmacSignature(rawBody, 'wrong', signature)).toBe(false);
  });

  test('impossible webhook signatures perform no HMAC while viable signatures still authenticate', () => {
    // RFC 4231 case 2 gives an independent expected value without fixture hashing.
    const rawBody = 'what do ya want for nothing?', secret = 'Jefe';
    const signature = 'sha256=5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843';
    const hash = spyOn(crypto, 'createHmac');
    try {
      for (const header of ['', 'sha256=', 'sha256=x', `sha256=${'a'.repeat(63)}`, `sha256=${'a'.repeat(65)}`, `sha256=${'a'.repeat(63)}z`, `${signature}\n`]) {
        expect(verifySha256HmacSignature(rawBody, secret, header)).toBe(false);
      }
      expect(hash).not.toHaveBeenCalled();
      expect(verifySha256HmacSignature(rawBody, secret, signature)).toBe(true);
      expect(hash).toHaveBeenCalledTimes(1);
      expect(verifySha256HmacSignature(`${rawBody}!`, secret, signature)).toBe(false);
      expect(hash).toHaveBeenCalledTimes(2);
    } finally { hash.mockRestore(); }
  });
});
