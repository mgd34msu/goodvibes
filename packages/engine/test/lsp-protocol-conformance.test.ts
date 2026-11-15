/**
 * The client side of the language-server protocol: answering the server's own
 * requests, opening documents before asking about them, and reading the
 * diagnostics for the text just sent rather than an older one.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LspClient } from '../platform/src/platform/intelligence/lsp/client.js';
import { CodeIntelligence, pathToUri } from '../platform/src/platform/intelligence/facade.js';
import type { LspService } from '../platform/src/platform/intelligence/lsp/service.js';

function dispatch(client: LspClient, payload: unknown): void {
  (client as unknown as { _dispatchMessage(body: string): void })._dispatchMessage(JSON.stringify(payload));
}

/** A real client whose process is a recorder: every frame it writes is kept. */
function recordingClient(answer: (method: string, id: number, client: LspClient) => void = () => {}) {
  const client = new LspClient('unused', []);
  const sent: Array<{ method: string; params?: unknown }> = [];
  (client as unknown as { proc: unknown }).proc = {
    exitCode: null,
    stdin: {
      write: (frame: string) => {
        const message = JSON.parse(frame.slice(frame.indexOf('\r\n\r\n') + 4)) as { id?: number; method?: string; params?: unknown };
        if (!message.method) return;
        sent.push({ method: message.method, params: message.params });
        if (typeof message.id === 'number') queueMicrotask(() => answer(message.method!, message.id!, client));
      },
    },
  };
  return { client, sent };
}

function facadeOver(client: LspClient): CodeIntelligence {
  const lsp = {
    resolveClient: async () => ({ status: 'ok', client }),
    runningClient: () => client,
    serverFor: () => undefined,
    shutdown: async () => {},
  } as unknown as LspService;
  return new CodeIntelligence({ lsp });
}

describe('LspClient server requests', () => {
  test('a request from the server is answered and never resolves a client request with the same id', () => {
    const client = new LspClient('unused', []);
    const written: string[] = [];
    (client as unknown as { proc: unknown }).proc = { stdin: { write: (frame: string) => { written.push(frame); } } };
    let resolved = false;
    (client as unknown as { pendingRequests: Map<number, unknown> }).pendingRequests.set(1, {
      resolve: () => { resolved = true; }, reject: () => {}, timer: setTimeout(() => {}, 0),
    });

    dispatch(client, { jsonrpc: '2.0', id: 1, method: 'workspace/configuration', params: { items: [{}, {}] } });

    expect(resolved).toBe(false);
    expect(written).toHaveLength(1);
    const reply = JSON.parse(written[0]!.slice(written[0]!.indexOf('\r\n\r\n') + 4)) as { id: number; result: unknown[] };
    expect(reply.id).toBe(1);
    expect(reply.result).toEqual([null, null]);
    clearTimeout((client as unknown as { pendingRequests: Map<number, { timer: ReturnType<typeof setTimeout> }> }).pendingRequests.get(1)!.timer);
  });
});

describe('CodeIntelligence language server use', () => {
  test('a document is opened before the first request about it, and only once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lsp-open-'));
    try {
      const file = join(dir, 'a.tsx');
      writeFileSync(file, 'export const a = 1;\n');
      const { client, sent } = recordingClient((_method, id, c) => dispatch(c, { jsonrpc: '2.0', id, result: null }));
      const intelligence = facadeOver(client);
      await intelligence.getHover(file, 0, 7);
      await intelligence.getHover(file, 0, 7);
      expect(sent.map((entry) => entry.method)).toEqual([
        'textDocument/didOpen', 'textDocument/hover', 'textDocument/hover',
      ]);
      // The protocol's language id for TSX, not the internal one.
      expect((sent[0]!.params as { textDocument: { languageId: string } }).textDocument.languageId).toBe('typescriptreact');
      writeFileSync(file, 'export const a = 2;\n');
      await intelligence.getHover(file, 0, 7);
      expect(sent.slice(3).map((entry) => entry.method)).toEqual(['textDocument/didChange', 'textDocument/hover']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('diagnostics are the ones published for the text just sent, not the previous version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lsp-diag-'));
    try {
      const file = join(dir, 'a.ts');
      writeFileSync(file, 'let x\n');
      const { client } = recordingClient();
      const intelligence = facadeOver(client);
      const uri = pathToUri(file);
      client.syncDocument(uri, 'typescript', 'let x\n');
      dispatch(client, { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, version: 1, diagnostics: [{ message: 'old' }] } });

      const pending = intelligence.lookupDiagnostics(file, { content: 'let x: number = "a";\n', waitMs: 2_000 });
      setTimeout(() => dispatch(client, {
        jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, version: 2, diagnostics: [{ message: 'new' }] },
      }), 20);
      const result = await pending;
      expect(result.status).toBe('ok');
      expect(result.items.map((d) => d.message)).toEqual(['new']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an empty answer says why: no server is not the same as none found', async () => {
    const lsp = {
      resolveClient: async () => ({ status: 'no-server', reason: 'No language server for rust: rust-analyzer is not installed.', next: ['Install it'] }),
      serverFor: () => undefined,
      shutdown: async () => {},
    } as unknown as LspService;
    const result = await new CodeIntelligence({ lsp }).lookupReferences('/p/main.rs', 0, 0);
    expect(result.status).toBe('no-server');
    expect(result.items).toEqual([]);
  });
});
