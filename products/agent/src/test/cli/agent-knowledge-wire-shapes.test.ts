import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { handleAgentKnowledgeCommand, handleDelegateCommand } from '../../cli/agent-knowledge-command.ts';
import { formatMap } from '../../cli/agent-knowledge-format.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimeFor(argv: readonly string[]) {
  const root = makeProjectTempDir('gv-agent-knowledge-shapes');
  roots.push(root);
  const workingDirectory = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  mkdirSync(join(homeDirectory, '.goodvibes', 'daemon'), { recursive: true });
  mkdirSync(workingDirectory, { recursive: true });
  writeFileSync(join(homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'test-token' }));
  return {
    cli: parseGoodVibesCli([...argv, '--json']),
    configManager: new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, workingDir: workingDirectory, homeDir: homeDirectory }),
    workingDirectory,
    homeDirectory,
  };
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const SOURCE = { id: 'src-1', connectorId: 'manual', sourceType: 'url', title: 'Agent Manual', canonicalUri: 'https://example.test/a', tags: [], status: 'ready', metadata: {}, createdAt: 1, updatedAt: 1 };

describe('delegate', () => {
  function stubHost(capture: { messageBodies: string[] }, options: { readonly failMessage?: boolean } = {}) {
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = inputUrl(input);
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url.endsWith('/api/sessions')) return json({ session: { id: 'sess-1' } });
      if (method === 'POST' && url.includes('/api/sessions/sess-1/messages')) {
        capture.messageBodies.push(typeof init?.body === 'string' ? init.body : '');
        if (options.failMessage) return json({ error: 'refused' }, 403);
        return json({ messageId: 'msg-1', body: capture.messageBodies.at(-1) });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    });
  }

  test('a task that mentions Home Assistant is delegated, not reported as scope contamination', async () => {
    const capture = { messageBodies: [] as string[] };
    stubHost(capture);
    const result = await handleDelegateCommand(runtimeFor(['delegate', 'fix the Home Assistant integration tests']));
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.output) as { readonly ok: boolean; readonly data: { readonly sessionId: string } };
    expect(body.ok).toBe(true);
    expect(body.data.sessionId).toBe('sess-1');
    expect(capture.messageBodies).toHaveLength(1);
  });

  test('a refused task message names the session that was already created', async () => {
    const capture = { messageBodies: [] as string[] };
    stubHost(capture, { failMessage: true });
    const result = await handleDelegateCommand(runtimeFor(['delegate', 'fix the tests']));
    expect(result.exitCode).toBe(1);
    const body = JSON.parse(result.output) as { readonly ok: boolean; readonly sessionId?: string };
    expect(body.ok).toBe(false);
    expect(body.sessionId).toBe('sess-1');
  });
});

describe('list and map read the shapes the host sends', () => {
  test('sources and nodes answer the paginated envelope when a limit is sent', async () => {
    globalThis.fetch = mockFetch(async (input) => {
      const url = inputUrl(input);
      if (url.includes('/sources')) return json({ items: [SOURCE], nextCursor: 'c1', hasMore: true });
      throw new Error(`unexpected request ${url}`);
    });
    const text = await handleAgentKnowledgeCommand({ ...runtimeFor(['knowledge', 'sources', '--limit', '1']), cli: parseGoodVibesCli(['knowledge', 'sources', '--limit', '1']) });
    expect(text.exitCode).toBe(0);
    expect(text.output).toContain('Agent Manual');
    expect(text.output).toContain('the host has more records');
    expect(text.output).not.toContain('no records');
  });

  test('map counts sources, nodes and issues by recordKind and shows the totals', () => {
    const output = formatMap({
      nodes: [{ recordKind: 'source' }, { recordKind: 'node' }, { recordKind: 'node' }, { recordKind: 'issue' }],
      edges: [{}],
      totalNodeCount: 9,
      totalEdgeCount: 1,
    });
    expect(output).toContain('sources: 1');
    expect(output).toContain('nodes: 2');
    expect(output).toContain('issues: 1');
    expect(output).toContain('entries: 4 of 9 (partial');
    expect(output).toContain('edges: 1');
  });

  test('map asks the host for issues so they can be counted', async () => {
    const urls: string[] = [];
    globalThis.fetch = mockFetch(async (input) => {
      urls.push(inputUrl(input));
      return json({ nodes: [], edges: [] });
    });
    await handleAgentKnowledgeCommand(runtimeFor(['knowledge', 'map']));
    expect(urls[0]).toContain('includeIssues=true');
  });
});

describe('lookup failures', () => {
  test('an unknown item id is not found, not an outdated host', async () => {
    globalThis.fetch = mockFetch(async (input) => {
      const url = inputUrl(input);
      if (url.includes('/items/')) return json({ error: 'Unknown knowledge item' }, 404);
      if (url.endsWith('/status')) return json({ ok: true });
      throw new Error(`unexpected request ${url}`);
    });
    const result = await handleAgentKnowledgeCommand(runtimeFor(['knowledge', 'get', 'nope']));
    expect(result.exitCode).toBe(1);
    expect((JSON.parse(result.output) as { readonly kind: string }).kind).toBe('not_found');
  });

  test('a missing route on a host that answers status is still an incompatible host', async () => {
    globalThis.fetch = mockFetch(async (input) => {
      const url = inputUrl(input);
      if (url.includes('/items/')) return json({ error: 'Not found' }, 404);
      if (url.endsWith('/status')) return json({ ok: true });
      throw new Error(`unexpected request ${url}`);
    });
    const result = await handleAgentKnowledgeCommand(runtimeFor(['knowledge', 'get', 'nope']));
    expect((JSON.parse(result.output) as { readonly kind: string }).kind).toBe('connected_host_incompatible');
  });

  test('an unknown --mode is refused instead of replaced by standard', async () => {
    const result = await handleAgentKnowledgeCommand(runtimeFor(['knowledge', 'ask', 'what', '--mode', 'consice']));
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Unknown --mode consice');
  });
});

describe('ingest paths', () => {
  test('a relative file path is sent as an absolute path from the working directory', async () => {
    const bodies: string[] = [];
    globalThis.fetch = mockFetch(async (_input, init) => {
      bodies.push(typeof init?.body === 'string' ? init.body : '');
      return json({ ok: true });
    });
    const runtime = runtimeFor(['knowledge', 'ingest-file', './docs/guide.md', '--yes']);
    await handleAgentKnowledgeCommand(runtime);
    const sent = JSON.parse(bodies[0] ?? '{}') as { readonly path?: string };
    expect(sent.path).toBe(join(runtime.workingDirectory, 'docs', 'guide.md'));
  });

  test('a relative connector path is sent as an absolute path from the working directory', async () => {
    const bodies: string[] = [];
    globalThis.fetch = mockFetch(async (_input, init) => {
      bodies.push(typeof init?.body === 'string' ? init.body : '');
      return json({ ok: true });
    });
    const runtime = runtimeFor(['knowledge', 'ingest-connector', 'notes', '--path', './docs/guide.md', '--yes']);
    await handleAgentKnowledgeCommand(runtime);
    const sent = JSON.parse(bodies[0] ?? '{}') as { readonly path?: string };
    expect(sent.path).toBe(join(runtime.workingDirectory, 'docs', 'guide.md'));
  });
});
