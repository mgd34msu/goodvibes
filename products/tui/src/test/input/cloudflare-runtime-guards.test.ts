import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerCloudflareRuntimeCommands } from '../../input/commands/cloudflare-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeContext(out: string[]): CommandContext {
  const config: Record<string, unknown> = {
    'controlPlane.host': '127.0.0.1',
    'controlPlane.port': 3421,
    'controlPlane.publicBaseUrl': '',
    'batch.mode': 'off',
    'batch.queueBackend': 'local',
  };
  return {
    workspace: { shellPaths: { homeDirectory: makeProjectTempDir('goodvibes-cloudflare-guard'), workingDirectory: process.cwd() } },
    platform: { configManager: { get: (key: string) => config[key] } },
    print: (text: string) => out.push(text),
  } as unknown as CommandContext;
}

describe('/cloudflare guards', () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: unknown }> = [];

  beforeEach(() => {
    requests.length = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
      requests.push({ url: href, body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null });
      return Response.json({ ok: true, steps: [] });
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  async function run(args: string[]): Promise<string> {
    const registry = new CommandRegistry();
    registerCloudflareRuntimeCommands(registry);
    const out: string[] = [];
    await registry.execute('cloudflare', args, makeContext(out));
    return out.join('\n');
  }

  test('a value flag given without a value is refused and nothing is sent', async () => {
    const text = await run(['validate', '--token-env']);
    expect(text).toContain('--token-env needs a value');
    expect(requests).toHaveLength(0);
  });

  test('disable without --yes describes the effect and sends nothing', async () => {
    const text = await run(['disable']);
    expect(text).toContain('Nothing was changed');
    expect(text).toContain('--yes');
    expect(requests).toHaveLength(0);
  });

  test('disable --yes calls the daemon route and keeps the cron only when asked', async () => {
    await run(['disable', '--yes']);
    expect(requests.at(-1)?.url.endsWith('/api/cloudflare/disable')).toBe(true);
    expect(requests.at(-1)?.body).toMatchObject({ disableCron: true, persistConfig: true });
    await run(['disable', '--keep-cron', '--yes']);
    expect(requests.at(-1)?.body).toMatchObject({ disableCron: false });
  });
});
