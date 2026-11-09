/** Real admin route -> registered built-in action -> actual ingress/storage.
 * Only the external Telegram HTTP replies are scripted. */
import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BuiltinChannelRuntime } from '../platform/src/platform/channels/builtin-runtime.js';
import { ChannelPluginRegistry } from '../platform/src/platform/channels/plugin-registry.js';
import { createTelegramSourceAccountOwner } from '../platform/src/platform/channels/telegram/source-account.js';
import { createDaemonChannelRouteHandlers } from '../daemon-api/src/channel-routes.js';
import { readTelegramCursorPreview, readTelegramCursorMigrationResult } from '../platform/src/platform/channels/telegram/cursor-migration-data.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

test('the actual channel action route checks admin access and migrates the verified original queue through its real runtime', async () => {
  const originalFetch = globalThis.fetch, root = makeProjectTempDir('telegram-cursor-http'), file = join(root, 'cursor.json');
  const original = JSON.stringify({ version: 1, offset: 501, updatedAt: '2026-11-08T12:00:00.000Z' }); writeFileSync(file, original);
  const config: Record<string, unknown> = { 'surfaces.telegram.enabled': true, 'surfaces.telegram.mode': 'polling',
    'surfaces.telegram.botToken': '111:private-native-fixture', 'surfaces.telegram.botUsername': 'original_bot' };
  const offsets: unknown[] = [], calls: string[] = [];
  const plugins = new ChannelPluginRegistry();
  let declared = 0, admin = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
    const method = path.split('/').at(-1); calls.push(String(method));
    if (method === 'getMe') return Response.json({ ok: true, result: { id: 111, username: 'original_bot', is_bot: true } });
    if (method === 'getUpdates') {
      offsets.push((JSON.parse(String(init?.body)) as Record<string, unknown>)['offset']);
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('stopped', 'AbortError'));
        if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    return Response.json({ ok: true, result: true });
  }) as typeof fetch;
  const runtime = new BuiltinChannelRuntime({ channelPlugins: plugins, telegramOffsetPath: file,
    telegramSourceAccounts: createTelegramSourceAccountOwner(), beforeTelegramCursorWrite: () => { declared++; },
    configManager: { get: (key: string) => config[key], set: (key: string, value: unknown) => { config[key] = value; }, subscribe: () => () => {} },
    secretsManager: { get: () => null, getGlobalHome: () => undefined, resolveLocalSecretSync: () => ({ state: 'absent' }), onDidChange: () => () => {} },
    serviceRegistry: { get: () => null, resolveSecret: async () => null }, buildSurfaceAdapterContext: () => ({}),
  } as never);
  try {
    runtime.registerPlugins(); await runtime.startIngress(); expect(offsets).toEqual([]);
    const handlers = createDaemonChannelRouteHandlers({ channelPlugins: plugins,
      requireAdmin: () => admin ? null : Response.json({ error: 'Admin required' }, { status: 403 }),
      parseOptionalJsonBody: (request: Request) => request.json(),
    } as never);
    const request = (body: unknown) => new Request('https://daemon.invalid/api/channels/actions/telegram/cursor-migration-preview', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const denied = await handlers.postChannelAction('telegram', 'cursor-migration-preview', request({}));
    expect(denied?.status).toBe(403); expect(calls).not.toContain('getMe'); expect(declared).toBe(0);
    admin = true;
    const response = await handlers.postChannelAction('telegram', 'cursor-migration-preview', request({}));
    const wire = await response?.json() as { readonly result: unknown };
    const preview = readTelegramCursorPreview(wire.result); if (preview.state !== 'unbound') throw new Error();
    expect(readFileSync(file, 'utf8')).toBe(original); expect(declared).toBe(0);
    const confirmed = await handlers.postChannelAction('telegram', 'cursor-migration-commit', request({ previewId: preview.previewId, confirm: true }));
    const result = readTelegramCursorMigrationResult((await confirmed?.json() as { readonly result: unknown }).result);
    expect(result).toMatchObject({ state: 'migrated', accountId: '111', offset: 501, running: true });
    expect(offsets).toEqual([501]); expect(declared).toBe(1);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 2, accounts: [{ accountId: '111', offset: 501, updatedAt: '2026-11-08T12:00:00.000Z' }] });
  } finally { await runtime.stopIngress(); globalThis.fetch = originalFetch; }
});
