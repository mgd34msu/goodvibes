import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { encryptPushPayload } from '../platform/src/platform/push/encryption.js';

test('an oversized push skips all HKDF work while the largest valid record still derives its real encryption keys', () => {
  const receiver = crypto.createECDH('prime256v1');
  receiver.generateKeys();
  const keys = { p256dh: receiver.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') };
  const hmac = spyOn(crypto, 'createHmac');
  try {
    expect(() => encryptPushPayload(keys, Buffer.alloc(4080))).toThrow('Push payload too large for a single aes128gcm record (max 4079 bytes)');
    expect(hmac).toHaveBeenCalledTimes(0);
    expect(() => encryptPushPayload({ ...keys, auth: 'invalid' }, Buffer.alloc(4080))).toThrow('Push subscription auth secret is not 16 bytes');
    expect(hmac).toHaveBeenCalledTimes(0);
    const accepted = encryptPushPayload(keys, Buffer.alloc(4079));
    expect(hmac).toHaveBeenCalledTimes(6);
    expect(accepted.contentEncoding).toBe('aes128gcm');
    expect(accepted.body.readUInt32BE(16)).toBe(4096);
    expect(accepted.body.length).toBe(16 + 4 + 1 + 65 + 4096);
  } finally { hmac.mockRestore(); }
});
