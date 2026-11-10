/** Released v3.1.1 bootstrap compatibility fixture; authored and UNRUN.
 * The independent HMAC below deliberately reproduces that released wire/KDF
 * representation, rather than using the implementation under verification.
 */
import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { deriveJoinSalt, deriveJoinVerifier, generateGroupId, generateNodeKeyMaterial } from '../platform/src/platform/cluster/group-crypto.ts';
import { createGroup, rotateGroupKey } from '../platform/src/platform/cluster/group-operations.ts';
import { encodeJoinClassMessage, GROUP_MESSAGE_TYPES, openGrant } from '../platform/src/platform/cluster/group-membership.ts';
import { addGroupNode, createGroupWorld, destroyGroupWorld, settle, stopGroupWorld } from './cluster-group-harness.ts';
function releasedSalt(id: string) {
  // Exact original public-label protocol, not a local identity/checksum hash.
  return createHmac('sha256', 'goodvibes-join-salt-v1').update(id).digest().subarray(0, 16).toString('base64url');
}
test('newly minted group IDs retain the released pre-JOIN salt and verifier bytes', async () => {
  const id = generateGroupId(); expect(id).toMatch(/^g[0-9A-HJKMNP-TV-Z]{16}$/);
  const currentSalt = deriveJoinSalt(id), oldSalt = releasedSalt(id);
  expect(currentSalt).toBe(oldSalt);
  const key = 'fixture owner-selected join phrase';
  expect(await deriveJoinVerifier(key, currentSalt)).toBe(await deriveJoinVerifier(key, oldSalt));
});
test('a released-style first JOIN authenticates to a newly created group, and rotation preserves bootstrap material', async () => {
  const world = createGroupWorld();
  try {
    const owner = await addGroupNode(world, 'current-owner', { version: '3.1.2' });
    const created = await createGroup(owner.context, {}); if (!created.ok) throw Error(created.error);
    const id = created.data.groupId, key = created.data.joinKey, peerKeys = generateNodeKeyMaterial();
    const oldSalt = releasedSalt(id), oldVerifier = await deriveJoinVerifier(key, oldSalt);
    const peer = world.bus.createTransport('released-peer'), replies: string[] = [];
    await peer.start(raw => { const value: unknown = JSON.parse(raw); if (typeof value === 'object' && value !== null && 'type' in value && value.type === GROUP_MESSAGE_TYPES.joinAccept) replies.push(raw); });
    await peer.send(encodeJoinClassMessage({ type: GROUP_MESSAGE_TYPES.join, nodeId: 'released-peer', nodeVersion: '3.1.1', seq: 1, ts: world.clock.now(),
      body: { displayName: 'released peer', identityKey: peerKeys.identity.publicKey, agreementKey: peerKeys.agreement.publicKey } }, id, oldVerifier));
    await settle(); expect(replies).toHaveLength(1);
    const response = JSON.parse(replies[0]!) as { body: { sealed: unknown } };
    const accepted = openGrant(peerKeys, response.body.sealed, 'join'); expect(accepted?.state.groupId).toBe(id);
    expect(accepted?.joinSalt).toBe(oldSalt); expect(accepted?.joinVerifier).toBe(oldVerifier);
    const rotated = await rotateGroupKey(owner.context); expect(rotated.ok).toBe(true);
    expect(owner.runtime.keyMaterial?.joinSalt).toBe(oldSalt); expect(owner.runtime.keyMaterial?.joinVerifier).toBe(oldVerifier);
    await peer.stop();
  } finally { await stopGroupWorld(world); destroyGroupWorld(world); }
});
