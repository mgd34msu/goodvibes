/**
 * Every allowlist the owner set on a channel must admit a message. Listing a
 * group restricts the surface to that group: a stranger's direct message is
 * not taken, a group member who is not on a set user list is not taken, and a
 * listed person is not answered in a group the owner never listed.
 *
 * Real policy manager over its file.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelPolicyManager } from '../platform/src/platform/channels/policy-manager.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function policyWith(lists: { allowlistUserIds?: string[]; allowlistGroupIds?: string[] }): Promise<ChannelPolicyManager> {
  const dir = mkdtempSync(join(tmpdir(), 'gv-allowlist-conjunction-'));
  dirs.push(dir);
  const policy = new ChannelPolicyManager({ storePath: join(dir, 'policies.json') });
  await policy.upsertPolicy('telegram', { ...lists, ownerId: 'U-OWNER' });
  return policy;
}

const admitted = async (policy: ChannelPolicyManager, input: { userId: string; conversationKind: 'direct' | 'group'; groupId: string }) =>
  (await policy.evaluateIngress({ surface: 'telegram', text: 'hi', ...input })).allowed;

test('with only a group listed, a stranger cannot write directly; the owner can', async () => {
  const policy = await policyWith({ allowlistGroupIds: ['G-TEAM'] });
  try {
    expect(await admitted(policy, { userId: 'U-STRANGER', conversationKind: 'direct', groupId: 'U-STRANGER' })).toBe(false);
    expect(await admitted(policy, { userId: 'U-OWNER', conversationKind: 'direct', groupId: 'U-OWNER' })).toBe(true);
    expect(await admitted(policy, { userId: 'U-MEMBER', conversationKind: 'group', groupId: 'G-TEAM' })).toBe(true);
  } finally { await policy.stop(); }
});

test('with a user and a group listed, only that user in that group is taken', async () => {
  const policy = await policyWith({ allowlistUserIds: ['U-OWNER'], allowlistGroupIds: ['G-TEAM'] });
  try {
    expect(await admitted(policy, { userId: 'U-OWNER', conversationKind: 'group', groupId: 'G-TEAM' })).toBe(true);
    expect(await admitted(policy, { userId: 'U-MEMBER', conversationKind: 'group', groupId: 'G-TEAM' })).toBe(false);
    expect(await admitted(policy, { userId: 'U-OWNER', conversationKind: 'group', groupId: 'G-OTHER' })).toBe(false);
    expect(await admitted(policy, { userId: 'U-OWNER', conversationKind: 'direct', groupId: 'U-OWNER' })).toBe(true);
  } finally { await policy.stop(); }
});
