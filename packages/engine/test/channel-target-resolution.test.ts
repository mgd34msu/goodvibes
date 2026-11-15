/**
 * Resolving a typed name to a conversation: only an exact match resolves, a
 * workspace larger than one provider page is fully searched, and a lookup that
 * failed is not reported as "no such conversation".
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  lookupBuiltinDirectory,
  lookupBuiltinProviderDirectory,
  resolveBuiltinTarget,
} from '../platform/src/platform/channels/builtin/targets.ts';
import type { ChannelDirectoryEntry } from '../platform/src/platform/channels/types.ts';
import type { ManagedSurface } from '../platform/src/platform/channels/builtin/shared.ts';

function entry(id: string, label: string, handle?: string): ChannelDirectoryEntry {
  return { id, surface: 'slack', kind: 'user', label, ...(handle ? { handle } : {}), metadata: {} } as ChannelDirectoryEntry;
}

function resolveContext(queryDirectory: (surface: string, options: unknown) => Promise<readonly ChannelDirectoryEntry[]>) {
  return { deps: { channelPlugins: { queryDirectory } } } as never;
}

describe('resolveBuiltinTarget', () => {
  test('a partial name does not resolve to the conversation that merely contains it', async () => {
    const context = resolveContext(async () => [entry('U1', 'alice', '@alice')]);
    const partial = await resolveBuiltinTarget(context, 'slack' as never, { input: '@al' } as never);
    expect(partial?.source).toBe('explicit');
    expect(partial?.to).toBe('al');
    const typo = await resolveBuiltinTarget(context, 'slack' as never, { input: 'alic' } as never);
    expect(typo?.source).toBe('miss');
    expect(typo?.to).toBe('alic');
    const created = await resolveBuiltinTarget(context, 'slack' as never, { input: 'alic', createIfMissing: true } as never);
    expect(created?.source).toBe('synthetic');
    expect(created?.to).toBe('alic');
  });

  test('an exact match still resolves, ignoring a leading @ or #', async () => {
    const context = resolveContext(async () => [entry('U1', 'alice', '@alice')]);
    const exact = await resolveBuiltinTarget(context, 'slack' as never, { input: '@alice' } as never);
    expect(exact?.source).toBe('directory');
    expect(exact?.display).toBe('alice');
  });

  test('a failed directory lookup is named on the target instead of looking like a miss', async () => {
    const context = resolveContext(async () => { throw new Error('invalid_auth'); });
    const target = await resolveBuiltinTarget(context, 'slack' as never, { input: 'general', live: true } as never);
    expect(target?.source).toBe('miss');
    expect(target?.metadata.directoryError).toBe('invalid_auth');
    const explicit = await resolveBuiltinTarget(context, 'slack' as never, { input: 'channel:C12', live: true } as never);
    expect(explicit?.source).toBe('explicit');
    expect(explicit?.metadata.directoryError).toBe('invalid_auth');
  });
});

describe('live provider directory', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function slackContext(routeCount = 0) {
    return {
      deps: {
        configManager: { get: () => '', getCategory: () => ({}) },
        serviceRegistry: { resolveSecret: async () => 'xoxb-test', get: () => undefined },
        secretsManager: { get: () => null, getGlobalHome: () => undefined },
        routeBindings: {
          start: async () => {},
          listBindings: () => Array.from({ length: routeCount }, (_, index) => ({
            id: `route-${index}`,
            surfaceKind: 'slack',
            surfaceId: 'slack',
            externalId: `ext-${index}`,
            channelId: `ext-${index}`,
            title: `Route ${index}`,
            metadata: {},
          })),
        },
      },
    } as never;
  }

  function stubSlack(respond: (method: string, params: URLSearchParams) => unknown): string[] {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split('/api/')[1] ?? '';
      const params = new URLSearchParams(String(init?.body ?? ''));
      calls.push(`${method}:${params.get('cursor') ?? ''}`);
      return new Response(JSON.stringify(respond(method, params)), { status: 200 });
    }) as typeof fetch;
    return calls;
  }

  test('a channel on the second provider page is found with a small limit', async () => {
    const calls = stubSlack((method, params) => {
      if (method !== 'conversations.list') return { ok: true, members: [], response_metadata: { next_cursor: '' } };
      return params.get('cursor') === 'page2'
        ? { ok: true, channels: [{ id: 'C99', name: 'deploys' }], response_metadata: { next_cursor: '' } }
        : { ok: true, channels: Array.from({ length: 50 }, (_, index) => ({ id: `C${index}`, name: `chan-${index}` })), response_metadata: { next_cursor: 'page2' } };
    });
    const found = await lookupBuiltinProviderDirectory(slackContext(), 'slack' as ManagedSurface, '#deploys', { limit: 5, scope: 'channels' });
    expect(found.map((item) => item.id)).toEqual(['C99']);
    expect(calls).toEqual(['conversations.list:', 'conversations.list:page2']);
  });

  test('a token that may list channels but not users still finds the channel in an all-scope lookup', async () => {
    stubSlack((method) => method === 'users.list'
      ? { ok: false, error: 'missing_scope' }
      : { ok: true, channels: [{ id: 'C99', name: 'deploys' }], response_metadata: { next_cursor: '' } });
    const found = await lookupBuiltinProviderDirectory(slackContext(), 'slack' as ManagedSurface, '#deploys', { scope: 'all' });
    expect(found.map((item) => item.id)).toEqual(['C99']);
    stubSlack(() => ({ ok: false, error: 'missing_scope' }));
    await expect(lookupBuiltinProviderDirectory(slackContext(), 'slack' as ManagedSurface, '#deploys', { scope: 'all' }))
      .rejects.toThrow('missing_scope');
  });

  test('a rejected token is raised instead of reported as an empty directory', async () => {
    stubSlack(() => ({ ok: false, error: 'invalid_auth' }));
    await expect(lookupBuiltinProviderDirectory(slackContext(), 'slack' as ManagedSurface, 'deploys', { scope: 'channels' }))
      .rejects.toThrow('invalid_auth');
    await expect(lookupBuiltinDirectory(slackContext(), 'slack' as ManagedSurface, 'deploys', { live: true, scope: 'channels' }))
      .rejects.toThrow('slack directory could not be read');
  });

  test('known conversations are still returned when the provider is unreachable', async () => {
    stubSlack(() => ({ ok: false, error: 'ratelimited' }));
    const entries = await lookupBuiltinDirectory(slackContext(1), 'slack' as ManagedSurface, '', { live: true, scope: 'all' });
    expect(entries.map((item) => item.id)).toEqual(['route-0']);
  });
});
