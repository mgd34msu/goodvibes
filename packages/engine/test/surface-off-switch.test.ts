// Proves: A surface the owner switched off still takes messages or sends replies.
// Red when: decideIngress admits a sender while the policy has the surface disabled, or surface-policy treats a stored credential as "on" after the owner set enabled to false.
/**
 * Off is what the owner reaches for when a channel account is compromised. A
 * channel policy switched off admits nobody, the owner included; a surface
 * switched off in settings neither receives nor sends although its credential
 * is still stored.
 *
 * Real policy manager over its file and real settings manager over its
 * directory. The call site in the daemon router is not exercised here.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelPolicyManager } from '../platform/src/platform/channels/policy-manager.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { isSurfaceDeliveryEnabled, isSurfaceIngressEnabled } from '../platform/src/platform/daemon/surface-policy.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'gv-surface-off-')); dirs.push(dir); return dir; };

test('a channel policy switched off refuses its own owner', async () => {
  const policy = new ChannelPolicyManager({ storePath: join(scratch(), 'policies.json') });
  await policy.upsertPolicy('telegram', { allowlistUserIds: ['owner-1'] });
  const ownerWrites = () => policy.evaluateIngress({
    surface: 'telegram', userId: 'owner-1', channelId: 'owner-1', conversationKind: 'direct', text: 'hello', mentioned: true,
  });
  expect((await ownerWrites()).allowed).toBe(true);

  await policy.upsertPolicy('telegram', { enabled: false });
  expect(await ownerWrites()).toMatchObject({ allowed: false, reason: 'surface-disabled' });
});

test('a surface the owner switched off in settings neither receives nor sends while its credential stays stored', () => {
  const dir = scratch();
  const config = new ConfigManager({ configDir: join(dir, 'config'), daemonTierPath: join(dir, 'daemon', 'settings.json'), ownsDaemonTier: true });
  const owner = { kind: 'owner', surface: 'fixture' } as const;
  // A credential-only install: each surface has its credential (or its target) and `enabled` was never set.
  config.setMany([
    { key: 'surfaces.telegram.botToken' as ConfigKey, value: 'goodvibes://secrets/goodvibes/TELEGRAM_BOT_TOKEN' },
    { key: 'surfaces.googleChat.spaceId' as ConfigKey, value: 'spaces/owner-space' },
  ], owner);
  const state = () => ({
    telegram: [isSurfaceIngressEnabled(config, 'telegram'), isSurfaceDeliveryEnabled(config, 'telegram')],
    googleChat: [isSurfaceIngressEnabled(config, 'google-chat'), isSurfaceDeliveryEnabled(config, 'google-chat')],
  });
  expect(state()).toEqual({ telegram: [true, true], googleChat: [true, true] });

  config.setMany([
    { key: 'surfaces.telegram.enabled' as ConfigKey, value: false },
    { key: 'surfaces.googleChat.enabled' as ConfigKey, value: false },
  ], owner);
  expect(state()).toEqual({ telegram: [false, false], googleChat: [false, false] });
});
