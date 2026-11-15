import { describe, expect, test } from 'bun:test';
import { runtimePrimaryConfigSettings, runtimeSecondaryConfigSettings } from '../platform/src/platform/config/schema-domain-runtime.js';
import { surfaceConfigSettings } from '../platform/src/platform/config/schema-domain-surfaces.js';
import { updateConfigSettings } from '../platform/src/platform/config/schema-domain-update.js';
import { voiceWakeConfigSettings } from '../platform/src/platform/config/schema-domain-voice-wake.js';
import type { ConfigSettingDefinition } from '../platform/src/platform/config/schema-shared.js';

const all: readonly ConfigSettingDefinition[] = [
  ...runtimePrimaryConfigSettings, ...runtimeSecondaryConfigSettings, ...surfaceConfigSettings, ...updateConfigSettings, ...voiceWakeConfigSettings,
];

function accepts(key: string, value: unknown): boolean {
  const setting = all.find((entry) => entry.key === key);
  if (!setting?.validate) throw new Error(`${key} has no validator`);
  return setting.validate(value);
}

describe('settings that reach files, processes or other routes', () => {
  test('the release feed must be a github.com https URL with no credentials; empty turns the loop off', () => {
    expect(accepts('update.releasesUrl', 'https://github.com/owner/repo/releases/latest')).toBe(true);
    expect(accepts('update.releasesUrl', '')).toBe(true);
    expect(accepts('update.releasesUrl', 'http://attacker.example/x/releases/latest')).toBe(false);
    expect(accepts('update.releasesUrl', 'https://attacker.example/x/releases/latest')).toBe(false);
    expect(accepts('update.releasesUrl', 'https://github.com.attacker.example/x/releases/latest')).toBe(false);
    expect(accepts('update.releasesUrl', 'https://user:pass@example.test/releases/latest')).toBe(false);
    expect(accepts('update.releasesUrl', 'not a url')).toBe(false);
  });

  test('the release feed may be plain http only on a loopback host', () => {
    expect(accepts('update.releasesUrl', 'http://127.0.0.1:4010/releases/latest')).toBe(true);
    expect(accepts('update.releasesUrl', 'http://localhost:4010/releases/latest')).toBe(true);
    expect(accepts('update.releasesUrl', 'http://[::1]:4010/releases/latest')).toBe(true);
    expect(accepts('update.releasesUrl', 'http://127.0.0.1.attacker.example/releases/latest')).toBe(false);
    expect(accepts('update.releasesUrl', 'http://user:pass@127.0.0.1:4010/releases/latest')).toBe(false);
    expect(accepts('update.releasesUrl', 'http://0.0.0.0:4010/releases/latest')).toBe(false);
  });

  test('a wake model id cannot name a path outside the custom model directory', () => {
    expect(accepts('voice.wake.models', 'hey_goodvibes, my-model.v2')).toBe(true);
    expect(accepts('voice.wake.models', '')).toBe(true);
    expect(accepts('voice.wake.models', '../../etc/x')).toBe(false);
    expect(accepts('voice.wake.models', 'hey_goodvibes,/abs/model')).toBe(false);
    expect(accepts('voice.wake.models', '..')).toBe(false);
  });

  test('the OpenAI-compatible prefix cannot be / or an empty segment', () => {
    expect(accepts('controlPlane.openaiCompatible.pathPrefix', '/v1')).toBe(true);
    expect(accepts('controlPlane.openaiCompatible.pathPrefix', '/api/v1')).toBe(true);
    expect(accepts('controlPlane.openaiCompatible.pathPrefix', '/')).toBe(false);
    expect(accepts('controlPlane.openaiCompatible.pathPrefix', '//x')).toBe(false);
    expect(accepts('controlPlane.openaiCompatible.pathPrefix', '/v1/')).toBe(false);
  });

  test('the companion chat limit is a whole number, 0 meaning unset', () => {
    expect(accepts('runtime.companionChatLimiter.perSessionLimit', 25)).toBe(true);
    expect(accepts('runtime.companionChatLimiter.perSessionLimit', 0)).toBe(true);
    expect(accepts('runtime.companionChatLimiter.perSessionLimit', -1)).toBe(false);
    expect(accepts('runtime.companionChatLimiter.perSessionLimit', 2.5)).toBe(false);
  });

  test('inbox identities are checked when set, not when the inbox starts', () => {
    expect(accepts('surfaces.discord.inboxChannelIds', '123456789012345678,223456789012345678')).toBe(true);
    expect(accepts('surfaces.discord.inboxChannelIds', '')).toBe(true);
    expect(accepts('surfaces.discord.inboxChannelIds', '123,123')).toBe(false);
    expect(accepts('surfaces.discord.inboxChannelIds', 'not-an-id')).toBe(false);
    expect(accepts('surfaces.discord.inboxBotUserId', '0123')).toBe(false);
    expect(accepts('surfaces.slack.inboxUserId', 'U012EXPLICIT')).toBe(true);
    expect(accepts('surfaces.slack.inboxUserId', 'has spaces')).toBe(false);
    expect(accepts('surfaces.slack.inboxUserId', ' U012EXPLICIT')).toBe(false);
    expect(accepts('surfaces.slack.inboxUserId', 'U012EXPLICIT\n')).toBe(false);
  });
});
