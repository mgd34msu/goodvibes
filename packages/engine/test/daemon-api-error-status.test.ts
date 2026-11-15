/**
 * Which HTTP status a daemon route answers with when the service it called
 * fails, how the artifact bytes are served, and how an unwanted upload body is
 * discarded. A fixed 400 or 404 over a thrown service error told clients that a
 * full disk or a provider outage was a mistake in their own request.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyFailure,
  createHttpStatusError,
  formatRefusal,
  GoodVibesError,
  installJudgmentPort,
  JudgmentPortMissingError,
  readRefusal,
  refusal,
  RefusalError,
  toRefusal,
} from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment/decisions';
import {
  buildErrorResponseBody,
  readErrorResponseBody,
  readJsonErrorResponse,
  readServiceErrorResponse,
  serviceFailureStatus,
} from '../daemon-api/src/error-response.js';
import { createDaemonMediaRouteHandlers } from '../daemon-api/src/media-routes.js';
import { createArtifactFromUploadRequest } from '../daemon-api/src/artifact-upload.js';
import type { DaemonMediaRouteContext } from '../daemon-api/src/media-route-types.js';
import { ArtifactStore } from '../platform/src/platform/artifacts/store.js';
import { WebSearchProviderRegistry } from '../platform/src/platform/web-search/provider-registry.js';
import { WebSearchService } from '../platform/src/platform/web-search/service.js';
import { MemoryEmbeddingProviderRegistry } from '../platform/src/platform/state/memory-embeddings.js';

type Json = Record<string, unknown>;

/** A port that records every touch, so a test can prove an error was answered without asking a model. */
function countingPort(): { readonly port: JudgmentPort; readonly touches: () => number } {
  let touches = 0;
  const port = new Proxy({}, {
    get() { touches += 1; throw new JudgmentPortMissingError('test'); },
  }) as unknown as JudgmentPort;
  return { port, touches: () => touches };
}

let restorePort: (() => void) | undefined;
afterEach(() => { restorePort?.(); restorePort = undefined; });

function withPort(port: JudgmentPort | undefined): void {
  const previous = installJudgmentPort(port);
  restorePort = () => { installJudgmentPort(previous); };
}

describe('answering an error never rejects', () => {
  test('with no usable decision model the status and message still come back', async () => {
    withPort(undefined);
    // No status anywhere, so the summary could be a connection failure and the wording would be read.
    const response = await readJsonErrorResponse(new Error('boom'));
    expect(response.status).toBe(500);
    expect((await response.json() as Json).error).toBe('boom');
    const body = await readErrorResponseBody(new Error('boom'));
    expect(body.error).toBe('boom');
  });

  test('a refused request that carries its status is answered without asking a model', async () => {
    const { port, touches } = countingPort();
    withPort(port);
    const refusal = new GoodVibesError('Multipart upload is missing a boundary.', { category: 'bad_request', source: 'runtime' });
    const response = await readJsonErrorResponse(refusal, { status: 400 });
    expect(response.status).toBe(400);
    expect(touches()).toBe(0);
  });

  test('a structured body re-served to an unprivileged caller keeps its retry wait and request id', () => {
    const body = buildErrorResponseBody({ error: 'slow down', status: 429, retryAfterMs: 5, requestId: 'r-1' });
    expect(body.retryAfterMs).toBe(5);
    expect(body.requestId).toBe('r-1');
  });
});

describe('one refusal shape from the daemon to the client', () => {
  test('a refusal crosses the wire with state, reason and next intact, and asks no model', async () => {
    const { port, touches } = countingPort();
    withPort(port);
    const refused = refusal({
      code: 'SESSION_CLOSED',
      state: 'the session is closed',
      reason: 'Messages cannot be added to a closed session',
      next: ['Start a new session with /new', 'Reopen it with /resume'],
      status: 409,
    });
    const response = await readJsonErrorResponse(new RefusalError(refused));
    expect(touches()).toBe(0);
    expect(response.status).toBe(409);
    const body = await response.json() as Json;
    expect(body).toMatchObject({ error: refused.reason, code: 'SESSION_CLOSED', state: refused.state, next: refused.next, hint: refused.next[0], recoverable: false });
    const received = readRefusal(createHttpStatusError(409, 'http://daemon.test/x', 'POST', body));
    expect(received).toEqual(refused);
    expect(formatRefusal(received!)).toBe('Messages cannot be added to a closed session. Start a new session with /new');
  });

  test('a daemon error that names its own category asks no model, with or without a status', async () => {
    const { port, touches } = countingPort();
    withPort(port);
    await readErrorResponseBody(new GoodVibesError('The knowledge store is still opening.', { category: 'service', source: 'runtime' }));
    await readErrorResponseBody(Object.assign(new Error('upstream closed'), { code: 'ECONNRESET' }));
    await readErrorResponseBody({ message: 'already exists', status: 409 });
    expect(touches()).toBe(0);
  });

  test('classifyFailure decides from fields and tables only', () => {
    expect(classifyFailure(new Error('no fields'))).toBeUndefined();
    expect(classifyFailure({ status: 503 })).toEqual({ category: 'service', retryable: true });
    expect(classifyFailure({ status: 404 })).toEqual({ category: 'not_found', retryable: false });
    expect(classifyFailure({ status: 429, retryAfterMs: 2000 })).toEqual({ category: 'rate_limit', retryable: true, retryAfterMs: 2000 });
    expect(classifyFailure(Object.assign(new Error('x'), { cause: { code: 'ETIMEDOUT' } }))).toEqual({ category: 'timeout', retryable: true });
    expect(classifyFailure(new GoodVibesError('bad', { category: 'config' }))).toEqual({ category: 'config', retryable: false });
  });

  test('a failure that carries no refusal becomes one with the caller\'s state and next', () => {
    const made = toRefusal(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3421'), { code: 'ECONNREFUSED' }), {
      state: 'no daemon is running',
      next: ['Start it with goodvibes-daemon start'],
    });
    expect(made).toMatchObject({ code: 'ECONNREFUSED', state: 'no daemon is running', retryable: true, next: ['Start it with goodvibes-daemon start'] });
  });
});

describe('serviceFailureStatus', () => {
  test('an error with its own status keeps it', () => {
    expect(serviceFailureStatus(Object.assign(new Error('x'), { status: 429 }))).toBe(429);
  });
  test('a retryable error is 503', () => {
    expect(serviceFailureStatus(Object.assign(new Error('retry the operation'), { retryable: true }))).toBe(503);
  });
  test('a category the client can act on maps to its client status', () => {
    expect(serviceFailureStatus(new GoodVibesError('bad input', { category: 'bad_request' }))).toBe(400);
  });
  test('an unknown failure is a server fault, or the fallback a service asks for', () => {
    expect(serviceFailureStatus(new Error('SQLITE_FULL'))).toBe(500);
    expect(serviceFailureStatus(new Error('refused'), 400)).toBe(400);
  });
  test('the response carries the chosen status', async () => {
    const response = await readServiceErrorResponse(new Error('Deepgram transcription failed: HTTP 503'));
    expect(response.status).toBe(500);
    expect((await response.json() as Json).category).not.toBe('bad_request');
  });
});

interface Stubs {
  readonly context: DaemonMediaRouteContext;
  readonly calls: { analyze: Json[]; multimodal: Json[] };
}

function mediaContext(overrides: Partial<DaemonMediaRouteContext> = {}, admin = true): Stubs {
  const calls = { analyze: [] as Json[], multimodal: [] as Json[] };
  const context: DaemonMediaRouteContext = {
    artifactStore: {
      list: () => [],
      create: async () => ({ id: 'a1' }),
      get: (id: string) => (id === 'known' || id === 'html' || id === 'png' ? { id, mimeType: id === 'png' ? 'image/png' : 'text/html' } : null),
      readContent: async (id: string) => ({
        record: { mimeType: id === 'png' ? 'image/png' : 'text/html', filename: 'file.bin' },
        buffer: new TextEncoder().encode('<script>alert(1)</script>'),
      }),
    },
    configManager: { get: () => false },
    mediaProviders: {
      status: async () => ({}),
      findProvider: () => ({
        analyze: async (input: Json) => { calls.analyze.push(input); return { ok: true }; },
      }),
    },
    multimodalService: {
      getStatus: async () => ({}),
      listProviders: async () => [],
      analyze: async (input: Json) => { calls.multimodal.push(input); return { id: 'analysis-1' }; },
      buildPacket: () => ({}),
      writeBackAnalysis: async () => ({ stored: true }),
    },
    parseJsonBody: async (req: Request) => await req.json() as Json,
    requireAdmin: () => (admin ? null : new Response('Denied', { status: 403 })),
    voiceService: {
      getStatus: async () => ({ providers: [] }),
      listVoices: async () => [],
      synthesize: async () => ({}),
      synthesizeStream: async () => { throw new Error('unused'); },
      transcribe: async () => ({}),
      openRealtimeSession: async () => ({}),
    },
    webSearchService: { getStatus: async () => ({ providers: [] }), search: async () => ({ results: [] }) },
    ...overrides,
  };
  return { context, calls };
}

function post(path: string, body: Json): Request {
  return new Request(`http://daemon.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('artifact content is served so a stored page cannot run on the daemon origin', () => {
  test('html is an attachment under nosniff and a sandbox policy, even with download=0', async () => {
    const { context } = mediaContext();
    const handlers = createDaemonMediaRouteHandlers(context);
    const response = await handlers.getArtifactContent('html', new Request('http://daemon.test/api/artifacts/html/content?download=0'));
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toStartWith('attachment');
  });

  test('an image still previews inline when asked', async () => {
    const { context } = mediaContext();
    const handlers = createDaemonMediaRouteHandlers(context);
    const response = await handlers.getArtifactContent('png', new Request('http://daemon.test/api/artifacts/png/content?download=0'));
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('only an unknown id is 404; a failure reading a known artifact is a server fault', async () => {
    const { context } = mediaContext({
      artifactStore: {
        list: () => [],
        create: async () => ({}),
        get: (id: string) => (id === 'known' ? { id } : null),
        readContent: async () => { throw new Error('The saved artifact checksum does not match its original content.'); },
      },
    });
    const handlers = createDaemonMediaRouteHandlers(context);
    const damaged = await handlers.getArtifactContent('known', new Request('http://daemon.test/api/artifacts/known/content'));
    expect(damaged.status).toBe(500);
    const unknown = await handlers.getArtifactContent('nope', new Request('http://daemon.test/api/artifacts/nope/content'));
    expect(unknown.status).toBe(404);
  });

  test('artifact list, record and content are refused to a caller that is not an admin', async () => {
    const { context } = mediaContext({}, false);
    const handlers = createDaemonMediaRouteHandlers(context);
    const request = new Request('http://daemon.test/api/artifacts');
    expect((await handlers.getArtifacts(request)).status).toBe(403);
    expect((await handlers.getArtifact('known', request)).status).toBe(403);
    expect((await handlers.getArtifactContent('known', request)).status).toBe(403);
  });
});

describe('a failing service is not reported as a bad request', () => {
  test('a text-to-speech provider outage is not a 400', async () => {
    const { context } = mediaContext({
      voiceService: {
        getStatus: async () => ({ providers: [] }),
        listVoices: async () => [],
        synthesize: async () => { throw new Error('Deepgram transcription failed: HTTP 503'); },
        synthesizeStream: async () => { throw new Error('unused'); },
        transcribe: async () => ({}),
        openRealtimeSession: async () => ({}),
      },
    });
    const response = await createDaemonMediaRouteHandlers(context).postVoiceTts(post('/api/voice/tts', { text: 'hello' }));
    expect(response.status).toBe(500);
    expect((await response.json() as Json).category).not.toBe('bad_request');
  });

  test('web search keeps the status the provider error carries and treats an unknown failure as 5xx', async () => {
    const limited = mediaContext({ webSearchService: { getStatus: async () => ({ providers: [] }), search: async () => { throw Object.assign(new Error('slow down'), { status: 429 }); } } });
    expect((await createDaemonMediaRouteHandlers(limited.context).postWebSearch(post('/api/web-search/query', { query: 'q' }))).status).toBe(429);
    const down = mediaContext({ webSearchService: { getStatus: async () => ({ providers: [] }), search: async () => { throw new Error('timeout'); } } });
    expect((await createDaemonMediaRouteHandlers(down.context).postWebSearch(post('/api/web-search/query', { query: 'q' }))).status).toBeGreaterThanOrEqual(500);
  });

  test('an artifact write that fails on disk is 500, while a body with no content is the caller\'s 400', async () => {
    const full = mediaContext({ artifactStore: { list: () => [], create: async () => { throw new Error('ENOSPC: no space left on device'); }, get: () => null, readContent: async () => { throw new Error('unused'); } } });
    const handlers = createDaemonMediaRouteHandlers(full.context);
    expect((await handlers.postArtifact(post('/api/artifacts', { text: 'hello' }))).status).toBe(500);
    expect((await handlers.postArtifact(post('/api/artifacts', { filename: 'a.txt' }))).status).toBe(400);
  });

  test('analyzing by artifact id hands the provider the stored mime type and answers a provider failure', async () => {
    const { context, calls } = mediaContext();
    const handlers = createDaemonMediaRouteHandlers(context);
    const ok = await handlers.postMediaAnalyze(post('/api/media/analyze', { artifactId: 'png' }));
    expect(ok.status).toBe(200);
    expect((calls.analyze[0]!.artifact as Json).mimeType).toBe('image/png');
    expect((await handlers.postMediaAnalyze(post('/api/media/analyze', { artifactId: 'ghost' }))).status).toBe(404);

    const failing = mediaContext({ mediaProviders: { status: async () => ({}), findProvider: () => ({ analyze: async () => { throw new Error('vision provider down'); } }) } });
    const response = await createDaemonMediaRouteHandlers(failing.context).postMediaAnalyze(post('/api/media/analyze', { artifactId: 'png' }));
    expect(response.status).toBe(500);
  });
});

describe('multimodal analyze', () => {
  test('a caller-supplied fetch mode cannot bypass the private-host gate', async () => {
    const { context, calls } = mediaContext();
    const handlers = createDaemonMediaRouteHandlers(context);
    const response = await handlers.postMultimodalAnalyze(post('/api/multimodal/analyze', {
      artifact: { uri: 'http://10.0.0.5/x', fetchMode: 'allow-private-hosts', allowPrivateHosts: 1 },
    }));
    expect(response.status).toBe(201);
    const artifact = calls.multimodal[0]!.artifact as Json;
    expect(artifact.uri).toBe('http://10.0.0.5/x');
    expect(artifact.fetchMode).toBeUndefined();
    expect(artifact.allowPrivateHosts).toBeUndefined();
  });

  test('a write-back that fails after a finished analysis still returns the analysis, marked partial', async () => {
    const { context } = mediaContext({
      multimodalService: {
        getStatus: async () => ({}),
        listProviders: async () => [],
        analyze: async () => ({ id: 'analysis-1' }),
        buildPacket: () => ({}),
        writeBackAnalysis: async () => { throw new Error('knowledge store is closed'); },
      },
    });
    const response = await createDaemonMediaRouteHandlers(context).postMultimodalAnalyze(post('/api/multimodal/analyze', { artifactId: 'known', writeback: true }));
    expect(response.status).toBe(207);
    const body = await response.json() as Json;
    expect(body.analysis).toEqual({ id: 'analysis-1' });
    expect(body.writeback).toBeUndefined();
    expect(String(body.writebackError)).toContain('knowledge store is closed');
  });

  test('a provider outage keeps the status the provider error carries', async () => {
    const { context } = mediaContext({
      multimodalService: {
        getStatus: async () => ({}),
        listProviders: async () => [],
        analyze: async () => { throw Object.assign(new Error('vision provider unavailable'), { status: 503 }); },
        buildPacket: () => ({}),
        writeBackAnalysis: async () => ({}),
      },
    });
    const response = await createDaemonMediaRouteHandlers(context).postMultimodalAnalyze(post('/api/multimodal/analyze', { artifactId: 'known' }));
    expect(response.status).toBe(503);
  });
});

describe('uploads', () => {
  const store = { create: async () => ({ id: 'a1' }) } as Parameters<typeof createArtifactFromUploadRequest>[0];

  test('a multipart upload with no boundary is a prompt 400 and asks no model', async () => {
    const { port, touches } = countingPort();
    withPort(port);
    const request = new Request('http://daemon.test/api/artifacts', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data' },
      body: 'not multipart',
    });
    const response = await createArtifactFromUploadRequest(store, request);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
    expect(touches()).toBe(0);
  });

  test('a raw upload whose metadata is not JSON is refused instead of stored without it', async () => {
    const request = new Request('http://daemon.test/api/artifacts?filename=a.bin&metadata=%7Bbroken', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3]),
    });
    const response = await createArtifactFromUploadRequest(store, request);
    expect((response as Response).status).toBe(400);
    expect(String(((await (response as Response).json()) as Json).error)).toContain('metadata');
  });

  test('a retention that is not a number is refused', async () => {
    const request = new Request('http://daemon.test/api/artifacts?retentionMs=abc', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array([1]),
    });
    expect(((await createArtifactFromUploadRequest(store, request)) as Response).status).toBe(400);
  });

  test('a sender that never stops is cut off: the 413 arrives and the stream is cancelled', async () => {
    let pulls = 0;
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    });
    const sized = { create: async () => ({ id: 'a1' }), getMaxBytes: () => 1024 } as Parameters<typeof createArtifactFromUploadRequest>[0];
    const request = new Request('http://daemon.test/api/artifacts', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(10 * 1024 * 1024 * 1024) },
      body: endless,
      duplex: 'half',
    } as RequestInit);
    const response = await createArtifactFromUploadRequest(sized, request);
    expect((response as Response).status).toBe(413);
    expect(cancelled).toBe(true);
    // The drain stops at its byte bound (1 MiB of 64 KiB chunks) instead of reading forever.
    expect(pulls).toBeLessThan(64);
  });
});

describe('a service refusing the caller\'s own input keeps a 400 without hiding real faults', () => {
  test('web search with an unregistered or unconfigured provider is the caller\'s 400', async () => {
    const registry = new WebSearchProviderRegistry({ env: {}, serviceRegistry: { get: () => null } });
    registry.register({
      id: 'idle', label: 'Idle', capabilities: ['search'],
      descriptor: () => ({ id: 'idle', label: 'Idle', configured: false, capabilities: ['search'] }),
      search: async () => ({ results: [], metadata: {} }),
    } as never, { replace: true });
    const { context } = mediaContext({ webSearchService: new WebSearchService(registry) as never });
    const handlers = createDaemonMediaRouteHandlers(context);
    expect((await handlers.postWebSearch(post('/api/web-search/query', { query: 'q', providerId: 'nope' }))).status).toBe(400);
    expect((await handlers.postWebSearch(post('/api/web-search/query', { query: 'q', providerId: 'idle' }))).status).toBe(400);
  });

  test('an artifact create with a bad scheme, a malformed uri, or a missing file is 400; the disk-full case stays 500', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'artifact-status-'));
    try {
      const store = new ArtifactStore({ rootDir: join(dir, 'artifacts') });
      const { context } = mediaContext({ artifactStore: store as never });
      const handlers = createDaemonMediaRouteHandlers(context);
      expect((await handlers.postArtifact(post('/api/artifacts', { uri: 'ftp://example.com/a.txt' }))).status).toBe(400);
      expect((await handlers.postArtifact(post('/api/artifacts', { uri: 'not a url' }))).status).toBe(400);
      expect((await handlers.postArtifact(post('/api/artifacts', { uri: 'http://127.0.0.1/x' }))).status).toBe(400);
      expect((await handlers.postArtifact(post('/api/artifacts', { path: join(dir, 'missing.txt') }))).status).toBe(400);
      expect((await handlers.postArtifact(post('/api/artifacts', { text: 'hello' }))).status).toBe(201);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('naming an embedding provider that is not registered is a 400 from the registry itself', () => {
    const registry = new MemoryEmbeddingProviderRegistry({ configManager: { get: () => '' } as never });
    let caught: unknown;
    try { registry.setDefaultProvider('typo'); } catch (error) { caught = error; }
    expect(serviceFailureStatus(caught)).toBe(400);
  });
});
