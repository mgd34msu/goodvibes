import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { createShellPathService } from '@/runtime/index.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import {
  createAgentKnowledgeIngestTool,
  registerAgentKnowledgeIngestTool,
} from '../../tools/agent-knowledge-ingest-tool.ts';
import { admitLocalState } from '../helpers/local-state-admission.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

type ShellPaths = ShellPathService;

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
}

interface IngestPayload {
  readonly path?: string;
  readonly artifactId?: string;
  readonly url?: string;
  readonly title?: string;
  readonly tags?: readonly string[];
  readonly connectorId?: string;
  readonly allowPrivateHosts?: boolean;
  readonly input?: unknown;
  readonly content?: string;
  readonly metadata?: {
    readonly originSurface?: string;
    readonly explicitUserRequest?: string;
  };
}

function shellPaths(withToken = true): ShellPaths {
  const root = makeProjectTempDir('goodvibes-agent-knowledge-ingest-tool');
  if (withToken) {
    mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'agent-knowledge-ingest-token' }));
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

function admittedTool(paths: ShellPaths) {
  const config = configManager(paths), tool = createAgentKnowledgeIngestTool(paths, config);
  return { definition: tool.definition, execute: (args: Record<string, unknown>) => admitLocalState(
    registry => registerAgentKnowledgeIngestTool(registry, paths, config), tool.definition.name, args,
    { directory: paths.workingDirectory }),
  };
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function ingestResponse(): Response {
  return Response.json({
    source: {
      id: 'source-agent-docs',
      canonicalUri: 'https://example.com/agent-docs',
    },
  });
}


function ingestFile(paths: ShellPaths, name = 'notes.txt'): string {
  const path = join(paths.workingDirectory, name);
  writeFileSync(path, 'Release notes.');
  return path;
}

async function withFetch<T>(handler: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>, body: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(handler);
  try { return await body(); } finally { globalThis.fetch = originalFetch; }
}

describe('agent_knowledge_ingest argument and path handling', () => {
  test('a file outside the workspace is refused as an argument problem, before any host call', async () => {
    const paths = shellPaths(), tool = admittedTool(paths);
    let calls = 0;
    const result = await withFetch(async () => { calls += 1; return ingestResponse(); },
      () => tool.execute({ sourceKind: 'file', path: '/etc/hostname' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid');
    expect(result.error).toContain('The path must be inside the workspace.');
    expect(result.error).not.toContain('unavailable');
    expect(calls).toBe(0);
  });

  test.each([
    ['a missing path field', { sourceKind: 'file' }, 'path is required.'],
    ['a file that does not exist', { sourceKind: 'file', path: 'absent.txt' }, 'The path does not name an existing file.'],
    ['an unknown source kind', { sourceKind: 'telepathy' }, 'sourceKind must be one of'],
    ['a url that is not http(s)', { sourceKind: 'url', url: 'ftp://example.com/file' }, 'requires an http(s) URL'],
    ['a url that does not parse', { sourceKind: 'url', url: 'not a url' }, 'url must be a valid http(s) URL.'],
    ['a negative window', { sourceKind: 'browser_history', sinceDays: -7 }, 'sinceDays must be a positive whole number'],
  ])('%s is reported as a problem with the arguments, naming which one, not a host outage', async (_name, args, specific) => {
    const paths = shellPaths(), tool = admittedTool(paths);
    const result = await tool.execute(args);
    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid');
    expect(result.error).toContain(specific);
    expect(result.error).not.toContain('unavailable');
  });

  test('allowPrivateHosts cannot be set by the model', async () => {
    const paths = shellPaths(), tool = createAgentKnowledgeIngestTool(paths, configManager(paths));
    const result = await tool.execute({ url: 'http://192.168.1.5/page', allowPrivateHosts: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('allowPrivateHosts cannot be set by the model');
  });

  test('execute names the specific argument problem instead of a generic message', async () => {
    const paths = shellPaths(), tool = createAgentKnowledgeIngestTool(paths, configManager(paths));
    expect((await tool.execute({ sourceKind: 'browser_history', sinceDays: -7 })).error).toContain('sinceDays must be a positive whole number');
    expect((await tool.execute({ sourceKind: 'browser_history', limit: 0 })).error).toContain('limit must be a positive whole number');
    expect((await tool.execute({ sourceKind: 'urls_file' })).error).toContain('path is required');
  });

  test('a url ingest forwards folderPath and leaves a blank title out', async () => {
    const paths = shellPaths(), tool = admittedTool(paths);
    const bodies: string[] = [];
    const result = await withFetch(async (_input, init) => { bodies.push(String(init?.body)); return ingestResponse(); },
      () => tool.execute({ url: 'https://example.com/agent-docs', folderPath: 'docs/agent' }));
    expect(result.success, result.error).toBe(true);
    const payload = JSON.parse(bodies[0] ?? '{}') as { title?: string; folderPath?: string };
    expect(payload.folderPath).toBe('docs/agent');
    expect(payload).not.toHaveProperty('title');
  });

  test('a browser-history limit above the host maximum is capped and the result says so', async () => {
    const paths = shellPaths(), tool = admittedTool(paths);
    const bodies: string[] = [];
    const result = await withFetch(async (_input, init) => { bodies.push(String(init?.body)); return Response.json({ imported: 3, sources: [] }); },
      () => tool.execute({ sourceKind: 'browser_history', limit: 5000, sinceDays: 7 }));
    expect(result.success, result.error).toBe(true);
    expect((JSON.parse(bodies[0] ?? '{}') as { limit?: number; sinceMs?: number })).toMatchObject({ limit: 500, sinceMs: 7 * 86_400_000 });
    expect(result.output).toContain('capped at 500');
  });

  test('a file edited while the host is ingesting is reported as ingested: the bytes read once are what was sent', async () => {
    const paths = shellPaths(), tool = admittedTool(paths), path = ingestFile(paths);
    const result = await withFetch(async () => { appendFileSync(path, ' Edited meanwhile.'); return ingestResponse(); },
      () => tool.execute({ sourceKind: 'file', path }));
    expect(result.success, result.error).toBe(true);
  });

  test('a file above the size limit is refused before it is read', async () => {
    const paths = shellPaths(), tool = admittedTool(paths), path = ingestFile(paths, 'huge.bin');
    truncateSync(path, 65 * 1024 * 1024);
    let calls = 0;
    const result = await withFetch(async () => { calls += 1; return ingestResponse(); }, () => tool.execute({ sourceKind: 'file', path }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid');
    expect(result.error).toContain('larger than the 64 MiB limit');
    expect(calls).toBe(0);
  });

  test('a browser profile home outside the workspace is refused', async () => {
    const paths = shellPaths(), tool = admittedTool(paths);
    const result = await tool.execute({ sourceKind: 'browser_history', homeOverride: '/etc' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid');
    expect(result.error).toContain('homeOverride must be inside the workspace.');
  });
});
