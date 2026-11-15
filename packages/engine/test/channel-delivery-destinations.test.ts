/**
 * Where a delivery goes and what it carries: a bridge or webhook address built
 * from a conversation id cannot choose the destination, a reply to a Google
 * Chat space reaches the configured webhook, an over-long message says it was
 * shortened and keeps its attachment lines, a retried send reuses its id, and a
 * rotated Teams password is not served from the old token.
 */
import { afterEach, beforeEach, describe, expect, test, spyOn, type Mock } from 'bun:test';
import {
  createGoogleChatDeliveryStrategy,
  createTelegramDeliveryStrategy,
  createSlackDeliveryStrategy,
  createDiscordDeliveryStrategy,
} from '../platform/src/platform/channels/delivery/strategies-core.ts';
import { createSignalDeliveryStrategy, createWhatsAppDeliveryStrategy } from '../platform/src/platform/channels/delivery/strategies-bridge.ts';
import { createNtfyDeliveryStrategy } from '../platform/src/platform/channels/delivery/strategies-core.ts';
import { createMatrixDeliveryStrategy } from '../platform/src/platform/channels/delivery/strategies-enterprise.ts';
import { resolveMSTeamsAccessToken } from '../platform/src/platform/channels/delivery/shared.ts';
import type { ChannelDeliveryRequest } from '../platform/src/platform/channels/delivery/types.ts';
import type { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ServiceRegistry } from '../platform/src/platform/config/service-registry.ts';
import type { ArtifactStore } from '../platform/src/platform/artifacts/index.ts';

type Call = { url: string; headers: Headers; body: string };
let calls: Call[];
let fetchSpy: Mock<typeof fetch>;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['WHATSAPP_BRIDGE_TOKEN', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_BRIDGE_URL', 'SIGNAL_BRIDGE_URL', 'SIGNAL_BRIDGE_TOKEN', 'GOOGLE_CHAT_WEBHOOK_URL'];

beforeEach(() => {
  calls = [];
  for (const key of ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; }
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : '' });
    if (new URL(String(input)).hostname === 'login.microsoftonline.com') {
      return Response.json({ access_token: `token-${calls.length}`, expires_in: 3600 });
    }
    return Response.json({ id: 'sent-1', ok: true, result: { message_id: 1 } });
  }, { preconnect() {} }));
});

afterEach(() => {
  fetchSpy.mockRestore();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
});

function config(values: Record<string, unknown>): ConfigManager {
  return { get: (key: string) => values[key] } as unknown as ConfigManager;
}

function registry(baseUrls: Record<string, string> = {}): ServiceRegistry {
  return {
    resolveSecret: async () => undefined,
    get: (name: string) => (baseUrls[name] ? { baseUrl: baseUrls[name] } : undefined),
  } as unknown as ServiceRegistry;
}

function artifacts(attachment?: Record<string, unknown>): ArtifactStore {
  return { toAttachment: async () => attachment } as unknown as ArtifactStore;
}

const secrets = { get: async (): Promise<string | null> => null, getGlobalHome: () => '/nonexistent-goodvibes-home' };

function request(surfaceKind: string, address: string | undefined, overrides: Partial<ChannelDeliveryRequest> = {}): ChannelDeliveryRequest {
  return {
    target: { kind: 'surface', surfaceKind, ...(address ? { address } : {}) },
    body: 'hello', title: 'Title', jobId: 'job-1', runId: 'run-1', includeLinks: false,
    ...overrides,
  } as unknown as ChannelDeliveryRequest;
}

describe('a bridge address cannot choose where the bridge token goes', () => {
  const signal = () => createSignalDeliveryStrategy(
    config({ 'surfaces.signal.bridgeUrl': 'https://bridge.example/send', 'surfaces.signal.token': 'bridge-token' }),
    registry(), artifacts(), secrets,
  );

  test('an https recipient from an inbound request is refused and nothing is sent', async () => {
    await expect(signal().deliver(request('signal', 'https://evil.example/x', {
      binding: { id: 'r', surfaceKind: 'signal', surfaceId: 's', externalId: 'https://evil.example/x', metadata: {} },
    }))).rejects.toThrow('not the configured Signal bridge');
    expect(calls).toEqual([]);
  });

  test('an address on the configured bridge origin is still honoured', async () => {
    await signal().deliver(request('signal', 'https://bridge.example/other-path', {
      binding: { id: 'r', surfaceKind: 'signal', surfaceId: 's', externalId: '+15550100', metadata: {} },
    }));
    expect(calls.map((call) => call.url)).toEqual(['https://bridge.example/other-path']);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer bridge-token');
  });

  test('a bridge-mode WhatsApp send uses WHATSAPP_BRIDGE_TOKEN when no token is configured', async () => {
    process.env.WHATSAPP_BRIDGE_TOKEN = 'env-bridge-token';
    const strategy = createWhatsAppDeliveryStrategy(
      config({ 'surfaces.whatsapp.provider': 'bridge' }),
      registry({ whatsapp: 'https://wa-bridge.example/send' }), artifacts(), secrets,
    );
    await strategy.deliver(request('whatsapp', '+15550100'));
    expect(calls[0]!.url).toBe('https://wa-bridge.example/send');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer env-bridge-token');
  });
});

describe('webhook addresses', () => {
  test('a Slack address on a non-public host is refused', async () => {
    const strategy = createSlackDeliveryStrategy(registry(), config({}), artifacts(), secrets);
    await expect(strategy.deliver(request('slack', 'https://localhost/hook'))).rejects.toThrow('explicit HTTPS webhook target');
    expect(calls).toEqual([]);
  });

  test('a Google Chat reply addressed by space name posts to the configured webhook', async () => {
    const webhook = 'https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k&token=t';
    const strategy = createGoogleChatDeliveryStrategy(
      config({ 'surfaces.googleChat.webhookUrl': webhook }), registry(), artifacts(), secrets,
    );
    await strategy.deliver(request('google-chat', 'spaces/AAAA', {
      binding: { id: 'r', surfaceKind: 'google-chat', surfaceId: 's', externalId: 'spaces/AAAA', metadata: {} },
    }));
    expect(calls.map((call) => call.url)).toEqual([webhook]);
  });

  test('a webhook name that resolves to an internal address is refused for Slack, Discord and Google Chat', async () => {
    const resolveHost = async () => [{ address: '169.254.169.254', family: 4 as const }];
    const gchatConfig = config({ 'surfaces.googleChat.webhookUrl': 'https://chat.googleapis.com/v1/spaces/AAAA/messages' });
    const cases = [
      [createSlackDeliveryStrategy(registry(), config({}), artifacts(), secrets, { resolveHost }), 'slack', 'https://hook.attacker.example/x'],
      [createDiscordDeliveryStrategy(registry(), config({}), artifacts(), secrets, { resolveHost }), 'discord', 'https://hook.attacker.example/x'],
      [createGoogleChatDeliveryStrategy(gchatConfig, registry(), artifacts(), secrets, { resolveHost }), 'google-chat', 'https://hook.attacker.example/x'],
    ] as const;
    for (const [strategy, surface, address] of cases) {
      await expect(strategy.deliver(request(surface, address))).rejects.toThrow('169.254.169.254');
    }
    expect(calls).toEqual([]);
  });

  test('a Google Chat address written as a non-https or private-host URL is still refused', async () => {
    const strategy = createGoogleChatDeliveryStrategy(
      config({ 'surfaces.googleChat.webhookUrl': 'https://chat.googleapis.com/v1/spaces/AAAA/messages' }), registry(), artifacts(), secrets,
    );
    await expect(strategy.deliver(request('google-chat', 'http://chat.googleapis.com/x'))).rejects.toThrow('Google Chat');
    await expect(strategy.deliver(request('google-chat', 'https://127.0.0.1/x'))).rejects.toThrow('Google Chat');
    expect(calls).toEqual([]);
  });
});

describe('long messages', () => {
  test('a message over the limit is marked as shortened and its attachment line survives', async () => {
    const attachment = { artifactId: 'a1', filename: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 10, contentUrl: 'https://daemon.example/api/artifacts/a1/content', contentPath: '/api/artifacts/a1/content' };
    const strategy = createTelegramDeliveryStrategy(
      config({ 'surfaces.telegram.botToken': 'tg-token' }), registry(), artifacts(attachment), secrets,
    );
    const result = await strategy.deliver(request('telegram', '42', {
      body: 'x'.repeat(10_000),
      attachments: [{ artifactId: 'a1' }],
    } as Partial<ChannelDeliveryRequest>));
    const text = (JSON.parse(calls[0]!.body) as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(4_096);
    expect(text).toContain('Message shortened');
    expect(text).toContain('https://daemon.example/api/artifacts/a1/content');
    expect(result.truncated).toBe(true);
  });

  test('an attachment with no reachable URL does not print a daemon-relative path', async () => {
    const attachment = { artifactId: 'a1', filename: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 10, contentPath: '/api/artifacts/a1/content' };
    const strategy = createTelegramDeliveryStrategy(
      config({ 'surfaces.telegram.botToken': 'tg-token' }), registry(), artifacts(attachment), secrets,
    );
    const result = await strategy.deliver(request('telegram', '42', { attachments: [{ artifactId: 'a1' }] } as Partial<ChannelDeliveryRequest>));
    const text = (JSON.parse(calls[0]!.body) as { text: string }).text;
    expect(text).not.toContain('/api/');
    expect(text).toContain('report.pdf');
    expect(result.truncated).toBeUndefined();
  });
});

describe('retried sends', () => {
  test('a Matrix send repeated with the same request reuses its transaction id; different text does not', async () => {
    const strategy = createMatrixDeliveryStrategy(
      config({ 'surfaces.matrix.homeserverUrl': 'https://matrix.example', 'surfaces.matrix.accessToken': 'mx-token' }),
      registry(), artifacts(), secrets,
    );
    await strategy.deliver(request('matrix', '!room:example'));
    await strategy.deliver(request('matrix', '!room:example'));
    await strategy.deliver(request('matrix', '!room:example', { body: 'a different message' }));
    const [first, second, third] = calls.map((call) => call.url.split('/').pop());
    expect(first).toBe(second);
    expect(third).not.toBe(first);
  });
});

describe('Microsoft Teams token cache', () => {
  test('a rotated app password is not served from the previous token', async () => {
    const values: Record<string, unknown> = {
      'surfaces.msteams.appId': 'rotation-app', 'surfaces.msteams.tenantId': 'rotation-tenant', 'surfaces.msteams.appPassword': 'first',
    };
    const manager = config(values);
    const first = await resolveMSTeamsAccessToken(manager, registry(), secrets);
    expect(await resolveMSTeamsAccessToken(manager, registry(), secrets)).toBe(first);
    expect(calls).toHaveLength(1);
    values['surfaces.msteams.appPassword'] = 'second';
    const rotated = await resolveMSTeamsAccessToken(manager, registry(), secrets);
    expect(calls).toHaveLength(2);
    expect(rotated).not.toBe(first);
  });
});

describe('ntfy priority', () => {
  test('the configured default priority is sent as the Priority header', async () => {
    const strategy = createNtfyDeliveryStrategy(
      config({ 'surfaces.ntfy.baseUrl': 'https://ntfy.example', 'surfaces.ntfy.topic': 'alerts', 'surfaces.ntfy.defaultPriority': 5 }),
      registry(), artifacts(), secrets,
    );
    await strategy.deliver(request('ntfy', undefined));
    expect(calls[0]!.url).toContain('https://ntfy.example');
    expect(calls[0]!.headers.get('priority')).toBe('5');
  });
});
