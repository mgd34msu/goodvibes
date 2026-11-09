import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { GitHubIntegration } from '../platform/src/platform/integrations/github.js';
import { SlackIntegration } from '../platform/src/platform/integrations/slack.js';
import { decodeMessage, encodeMessage } from '../platform/src/platform/cluster/protocol.js';
import { decodeEnvelope, encodeEnvelope, type ClusterKeyring } from '../platform/src/platform/cluster/protocol-envelope.js';
import { checkIdentityClassMessage, checkJoinClassMessage, encodeIdentityClassMessage, encodeJoinClassMessage, GROUP_MESSAGE_TYPES } from '../platform/src/platform/cluster/group-membership.js';
import { generateNodeKeyMaterial } from '../platform/src/platform/cluster/group-crypto.js';

const malformed = ['', 'x', 'a'.repeat(63), 'a'.repeat(65), 'z'.repeat(64), 'a'.repeat(64) + '\n', 'é'.repeat(64)];
const changed = (signature: string) => (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);

test('GitHub rejects impossible encodings without HMAC and retains uppercase byte-hex authentication', () => {
  // RFC4231 case1: independent fixed known vector, not a fixture hash producer.
  const body = 'Hi There', key = Buffer.alloc(20, 0x0b).toString();
  const signature = 'sha256=b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7';
  const mac = spyOn(crypto, 'createHmac');
  try {
    for (const suffix of malformed) expect(GitHubIntegration.verifySignature(body, 'sha256=' + suffix, key)).toBe(false);
    expect(mac).not.toHaveBeenCalled();
    expect(GitHubIntegration.verifySignature(body, signature, key)).toBe(true); expect(mac).toHaveBeenCalledTimes(1);
    expect(GitHubIntegration.verifySignature(body, 'sha256=' + signature.slice(7).toUpperCase(), key)).toBe(true); expect(mac).toHaveBeenCalledTimes(2);
    expect(GitHubIntegration.verifySignature(body, 'sha256=' + changed(signature.slice(7)), key)).toBe(false); expect(mac).toHaveBeenCalledTimes(3);
    expect(GitHubIntegration.verifySignature(body + ' changed', signature, key)).toBe(false); expect(mac).toHaveBeenCalledTimes(4);
  } finally { mac.mockRestore(); }
});

test('Slack rejects impossible ASCII signatures before HMAC and still authenticates viable signatures', () => {
  // Fixed precomputed HMAC of exact v0:1700000000:fixture body with this key.
  const body = 'fixture body', timestamp = '1700000000', key = 'fixture-signing-key';
  const signature = 'v0=1ee4fc7ab8cbcbeb914e1308b34483022e18575c022b8e0b6950a0634945eb0d';
  const slack = new SlackIntegration(), clock = spyOn(Date, 'now').mockReturnValue(1700000000000), mac = spyOn(crypto, 'createHmac');
  try {
    for (const suffix of malformed) expect(slack.verifySignature(body, timestamp, 'v0=' + suffix, key)).toBe(false);
    expect(slack.verifySignature(body, timestamp, 'v1=' + signature.slice(3), key)).toBe(false);
    expect(slack.verifySignature(body, timestamp, 'v0=' + signature.slice(3).toUpperCase(), key)).toBe(false);
    expect(mac).not.toHaveBeenCalled();
    expect(slack.verifySignature(body, timestamp, signature, key)).toBe(true); expect(mac).toHaveBeenCalledTimes(1);
    expect(slack.verifySignature(body, timestamp, 'v0=' + changed(signature.slice(3)), key)).toBe(false); expect(mac).toHaveBeenCalledTimes(2);
    expect(slack.verifySignature(body + ' changed', timestamp, signature, key)).toBe(false); expect(mac).toHaveBeenCalledTimes(3);
  } finally { mac.mockRestore(); clock.mockRestore(); }
});

const key = 'original group key';
const keyring: ClusterKeyring = { groupId: 'gORIGINALGROUP', currentGeneration: 1, acceptedGenerations: () => [1], keyForGeneration: generation => generation === 1 ? key : null };
const draft = { type: 'PROBE', nodeId: 'original-node', nodeVersion: '3.1.2', seq: 1, ts: 1700000000000 };

for (const family of ['v1', 'envelope', 'join'] as const) test(`cluster ${family} rejects impossible HMAC encodings before signing and verifies viable original bytes`, () => {
  // Actual production encoder supplies the signed positive, independently
  // consumed by its real inbound decoder. Spying starts after wire creation.
  const raw = family === 'v1' ? encodeMessage({ ...draft, type: 'PROBE', v: 1, surfaceId: null }, key)
    : family === 'envelope' ? encodeEnvelope(draft, keyring)
      : encodeJoinClassMessage({ ...draft, type: GROUP_MESSAGE_TYPES.join }, keyring.groupId, key);
  const parsed = JSON.parse(raw) as Record<string, unknown> & { sig: string };
  const accepted = (wire: string): boolean => family === 'v1' ? decodeMessage(wire, key).message !== null
    : family === 'envelope' ? decodeEnvelope(wire, keyring).envelope !== null : checkJoinClassMessage(wire, key)?.joinKeyProved === true;
  const mac = spyOn(crypto, 'createHmac');
  try {
    for (const sig of [...malformed, parsed.sig.toUpperCase()]) expect(accepted(JSON.stringify({ ...parsed, sig }))).toBe(false);
    expect(mac).not.toHaveBeenCalled();
    expect(accepted(raw)).toBe(true); expect(mac).toHaveBeenCalledTimes(1);
    expect(accepted(JSON.stringify({ ...parsed, sig: changed(parsed.sig) }))).toBe(false); expect(mac).toHaveBeenCalledTimes(2);
    expect(accepted(JSON.stringify({ ...parsed, nodeId: 'another-node' }))).toBe(false); expect(mac).toHaveBeenCalledTimes(3);
  } finally { mac.mockRestore(); }
});

test('JOIN HMAC encoding restriction preserves actual identity-signed out-of-band messages', () => {
  const identity = generateNodeKeyMaterial().identity;
  const wire = encodeIdentityClassMessage({ ...draft, type: GROUP_MESSAGE_TYPES.rejoin }, keyring.groupId, identity);
  const mac = spyOn(crypto, 'createHmac');
  try {
    expect(checkIdentityClassMessage(wire, identity.publicKey)?.identityProved).toBe(true);
    expect(checkJoinClassMessage(wire, key)).toBeNull();
    expect(mac).not.toHaveBeenCalled();
  } finally { mac.mockRestore(); }
});
