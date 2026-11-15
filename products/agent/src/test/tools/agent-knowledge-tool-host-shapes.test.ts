import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { createShellPathService } from '@/runtime/index.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import { createAgentKnowledgeTool } from '../../tools/agent-knowledge-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

type ShellPaths = ShellPathService;

function shellPaths(withToken = true): ShellPaths {
  const root = makeProjectTempDir('goodvibes-agent-knowledge-tool');
  if (withToken) {
    mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'agent-knowledge-tool-token' }));
  }
  return createShellPathService({ workingDirectory: root, homeDirectory: root });
}

function configManager(paths: ShellPaths): ConfigManager {
  return new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT),
    workingDir: paths.workingDirectory,
    homeDir: paths.homeDirectory,
  });
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function withFetch<T>(handler: (url: string) => Response, body: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(async (input) => handler(inputUrl(input)));
  try { return await body(); } finally { globalThis.fetch = originalFetch; }
}

describe('agent_knowledge against the host shapes', () => {
  test('lists sources from the paginated envelope the host answers when a limit is sent', async () => {
    const paths = shellPaths(), tool = createAgentKnowledgeTool(paths, configManager(paths));
    // The real host answers { items, nextCursor, hasMore } whenever the request carries a limit.
    const result = await withFetch((url) => (new URL(url).searchParams.has('limit')
      ? json({ items: [{ id: 'src-alpha', title: 'Agent source', sourceType: 'url', canonicalUri: 'https://example.test/source' }], nextCursor: 'c1', hasMore: true })
      : json({ sources: [] })), () => tool.execute({ action: 'sources', limit: 1 }));
    expect(result.success, result.error).toBe(true);
    expect(result.output).toContain('Agent source');
    expect(result.output).toContain('partial');
    expect(result.output).not.toContain('--limit');
  });

  test('search says when it printed fewer rows than the host returned', async () => {
    const paths = shellPaths(), tool = createAgentKnowledgeTool(paths, configManager(paths));
    const items = Array.from({ length: 12 }, (_, index) => ({ id: `node-${index}`, title: `Result ${index}`, kind: 'fact', score: 1 - index / 100 }));
    const result = await withFetch(() => json({ items }), () => tool.execute({ action: 'search', query: 'result', limit: 12 }));
    expect(result.success, result.error).toBe(true);
    expect(result.output).toContain('Showing the first 10 of 12 results returned');
  });

  test('a missing operator token is reported without a file path', async () => {
    const paths = shellPaths(false), tool = createAgentKnowledgeTool(paths, configManager(paths));
    const result = await tool.execute({ action: 'status' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No connected-host operator token found');
    expect(result.error).not.toContain(paths.homeDirectory);
  });
});
